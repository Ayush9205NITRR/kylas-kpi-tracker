#!/usr/bin/env node
/* THE 1.81.x ROUND, STRESSED BEFORE ROLL-OUT (Ayush, 2026-11-04: "for all cases
 * listed — ek baar stress test karo, will roll out accordingly").
 *
 *   node scripts/stress-roundup.mjs            # part P: the logic at production size
 *   node scripts/stress-roundup.mjs --worker   # part W: the real Worker against the mocks
 *
 * P runs the new code paths on production-sized inputs and checks each answer
 * against a brute-force reference, with timings:
 *   I  last call      9,500 companies · 37,000 indexed contacts · 5,000 dialler calls
 *   E  compaction     4,000 transitions, gate identical
 *   B  prune plan     37,000 contacts
 *   A  D1 rows/day    a working day of saves and syncs through the D1 engine
 * W drives the Worker (worker/index.mjs) over mock Kylas and mock Airtable:
 *   F  re-assignment  20 companies through the allot job, under Kylas' 429s
 *   H  owner dropdown 30 cold instances at once, user list on and off
 *   D  event rows     saves with rows, then opens on a base without the lookup
 *   C  Who            each owner's report against the team's
 *   G  Boolean post   the accounts list, Kylas field over Airtable
 */
import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const rows = [];
const ok = (cas, n, c, d = "") => { c ? pass++ : fail++; rows.push([cas, n, c, d]); console.log(`  ${c ? "PASS" : "FAIL"}  [${cas}] ${n}${d ? `  — ${String(d).slice(0, 220)}` : ""}`); };
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`;
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const isoAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

if (!process.argv.includes("--worker")) {
  console.log("\nP · the logic at production size");

  /* ── I · last call ── */
  {
    const { lastCallsByCompany, withLastCall } = await import("./last-call.mjs");
    const C = 9500, byCompany = new Map(), index = { contacts: {} }, dialByContact = new Map(), kylasField = new Map();
    for (let i = 0; i < C; i++) {
      const id = String(10000 + i);
      if (rnd() < 0.4) byCompany.set(id, { lastCallAt: rnd() < 0.5 ? isoAgo(Math.floor(rnd() * 30)) : null,
                                           dialLastAt: rnd() < 0.5 ? isoAgo(Math.floor(rnd() * 120)) : null });
      if (rnd() < 0.6) kylasField.set(id, isoAgo(30 + Math.floor(rnd() * 200)).slice(0, 10));
    }
    for (let k = 0; k < 37000; k++) index.contacts[String(500000 + k)] = [String(10000 + Math.floor(rnd() * C)), "CNC_COULD_NOT_CONNECT"];
    for (let d = 0; d < 5000; d++) {
      const kid = String(500000 + Math.floor(rnd() * 37000)), at = isoAgo(rnd() * 150);
      if (!dialByContact.has(kid) || at > dialByContact.get(kid)) dialByContact.set(kid, at);
    }
    const t = performance.now();
    const calls = lastCallsByCompany({ byCompany, dialByContact }, index);
    const got = new Map();
    for (let i = 0; i < C; i++) { const id = String(10000 + i); got.set(id, withLastCall({ id, lastCalledAt: kylasField.get(id) || null }, calls)); }
    const took = ms(t);
    /* brute force: the newest of every source, by hand */
    let bad = 0;
    for (let i = 0; i < C; i++) {
      const id = String(10000 + i), p = byCompany.get(id) || {};
      const cands = [p.lastCallAt, p.dialLastAt, kylasField.get(id)];
      for (const [kid, at] of dialByContact) if (index.contacts[kid]?.[0] === id) cands.push(at);
      const want = cands.filter(Boolean).sort().pop() || null;
      const have = got.get(id).lastCalledAt;
      if (String(want || "") !== String(have || "")) bad++;
    }
    ok("I", `newest call per company, 9,500 companies vs brute force (${took})`, bad === 0, `${bad} mismatched`);
    ok("I", "the whole book is computed in well under a second", performance.now() - t < 60_000 && Number(took.split(" ")[0]) < 1000, took);
  }

  /* ── E · compaction ── */
  {
    const { compactTransitions, gate } = await import("./compact-history.mjs");
    const { STAGE_RUNG } = await import("./stages.mjs");
    const STAGES = Object.keys(STAGE_RUNG), OWN = ["Sejal Agrawal", "Muskan Rajpoot", "Mayra Singh", "Gurnoor Kaur", "Anjali Athya"];
    const companyOf = new Map(); for (let i = 0; i < 3000; i++) companyOf.set(`recC${i}`, `recCo${i % 1200}`);
    const trs = [];
    for (let i = 0; i < 4000; i++) trs.push({ id: `t${i}`, fields: { "Changed At": isoAgo(rnd() * 120), Owner: OWN[i % 5],
      "To Stage": STAGES[Math.floor(rnd() * STAGES.length)], Contact: [`recC${Math.floor(rnd() * 3000)}`] } });
    const t = performance.now();
    const { keep, drop } = compactTransitions(trs, companyOf, { days: 30 });
    const diffs = gate(trs, keep, companyOf);
    ok("E", `4,000 transitions: gate identical, ${drop.length} repeats removable (${ms(t)})`, diffs.length === 0, diffs[0] || "");
  }

  /* ── B · prune plan at 37k ── */
  {
    const { plan } = await import("./prune-contacts.mjs");
    const companies = Array.from({ length: 9500 }, (_, i) => ({ id: `co${i}`, fields: { "Kylas Company ID": String(i) } }));
    const contacts = Array.from({ length: 37000 }, (_, i) => ({ id: `c${i}`, fields: { "Kylas Contact ID": String(i), Company: [`co${i % 9500}`],
      ...(i % 9500 < 4000 && i < 9500 ? { "KPI Rank": 6 } : {}) } }));
    const at = { listAll: async (t) => (t === "Contacts" ? contacts : t === "Companies" ? companies : t === "Focus" ? [] : []) };
    const t = performance.now();
    const p = await plan(at, { log: () => {} });
    const keptCos = new Set(contacts.filter((r) => !p.drop.some((d) => d.id === r.id)).map((r) => r.fields.Company[0]));
    const whole = [...keptCos].every((co) => contacts.filter((r) => r.fields.Company[0] === co).every((r) => !p.drop.includes(r)));
    ok("B", `prune plan on 37,000 contacts: worked companies kept whole (${ms(t)})`, p.workedCompanies === 4000 && whole && p.keep + p.drop.length === 37000, `worked ${p.workedCompanies}, keep ${p.keep}, drop ${p.drop.length}`);
  }

  /* ── A · D1 rows written in a day, through the real engine ── */
  {
    const { d1FromEnv } = await import("./d1-node.mjs");
    const { createAirtable, syncContact } = await import("./airtable.mjs");
    const file = join(tmpdir(), `stress-roundup-${process.pid}.sqlite`); rmSync(file, { force: true });
    const db = d1FromEnv({ D1_SQLITE: file });
    const at = createAirtable("x", "appX", { d1: db, log: () => {} });
    const tc = async () => Number((await db.prepare("SELECT total_changes() AS n").first()).n);
    const idx = Math.max(0, ...((await db.prepare("SELECT tbl_name t, COUNT(*) n FROM sqlite_master WHERE type='index' GROUP BY tbl_name").all()).results.map((r) => r.n)));
    await at.upsertMany("Companies", "Kylas Company ID", Array.from({ length: 300 }, (_, i) => ({ "Kylas Company ID": String(9000 + i), Name: `Co ${i}` })));
    const t0 = await tc();
    for (let i = 0; i < 200; i++) {
      const kid = String(500000 + (i % 150));
      await syncContact(at, { kid, pocName: `P ${kid}`, owner: "Sejal", ownerId: 1, companyId: String(9000 + (i % 300)), company: "x",
        stage: "CNC_COULD_NOT_CONNECT", phones: [{ value: "98" + i }],
        current: [{ rowKey: `rk${kid}`, eventType: "Offsite", budget: "5L", pax: "50" }] },
        { at: new Date(Date.now() + i * 60000).toISOString(), outcome: "Connected", duration: 60 });
    }
    for (let h = 0; h < 24; h++) {
      await at.upsertMany("Contacts", "Kylas Contact ID", Array.from({ length: 80 }, (_, i) => ({ "Kylas Contact ID": String(500000 + ((h * 80 + i) % 150)), Name: `P${h}` })));
      await at.upsertMany("Dialler Calls", "Key", Array.from({ length: 40 }, (_, i) => ({ Key: `d${h}-${i}`, "Called At": new Date().toISOString(), Owner: "Sejal", Duration: 40 })));
    }
    const day = (await tc()) - t0, month = day * (1 + idx) * 30;
    ok("A", `D1 rows written: ${day}/day → ≤ ${(month / 1e6).toFixed(2)}M/month with every index (50M included)`, month < 10e6, `${month}`);
    rmSync(file, { force: true });
  }
} else {
  /* ─────────── W · the Worker against the mocks ─────────── */
  const { spawn } = await import("node:child_process");
  const { fakeD1 } = await import("./d1-fake.mjs");
  const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const sleep = (m) => new Promise((r) => setTimeout(r, m));
  const kids = [];
  const up = async (userList) => {
    kids.splice(0).forEach((p) => p.kill("SIGKILL")); await sleep(800);
    kids.push(spawn("node", ["scripts/mock-kylas.mjs"], { cwd: REPO, stdio: "ignore", env: { ...process.env, MOCK_MANY: "40", ...(userList ? { MOCK_USER_LIST: "1" } : {}) } }));
    kids.push(spawn("node", ["scripts/mock-airtable.mjs"], { cwd: REPO, stdio: "ignore", env: { ...process.env } }));
    for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } }); await fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts", { headers: { Authorization: "Bearer x" } }); return; } catch { await sleep(300); } }
    throw new Error("mocks never came up");
  };
  process.on("exit", () => kids.forEach((p) => { try { p.kill("SIGKILL"); } catch {} }));
  const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const db = fakeD1();
  const ENV = { KYLAS_KEY: "x", KYLAS_BASE: "http://127.0.0.1:9900", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK",
    AIRTABLE_BASE_URL: "http://127.0.0.1:9901", VERSION: "stress", ALLOWED_ORIGIN: ORIGIN, AUTH: "none", DB: db };
  let n = 0;
  const cold = async () => (await import(`../worker/index.mjs?stress=${n++}`)).default;
  const call = async (method, path, body) => {
    const held = [];
    const r = await (await cold()).fetch(new Request(`https://bd.enout.website${path}`, { method, headers: { Origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined }), ENV, { waitUntil: (p) => held.push(p) });
    const j = await r.json().catch(() => ({})); await Promise.allSettled(held);
    return { status: r.status, body: j };
  };
  const atWrites = async () => (await (await fetch("http://127.0.0.1:9901/__writes", { headers: { Authorization: "Bearer x" } })).json()).writes;
  const ky = async () => (await (await fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } })).json()).writes;

  for (const userList of [false, true]) {
    await up(userList);
    console.log(`\nW · the Worker (Kylas user list ${userList ? "ON" : "OFF"})`);
    /* Warm, as production is: the minute cron builds the company crawl and the copies. */
    {
      const w = await cold(); const quiet = console.log; console.log = () => {};
      try { for (let i = 0; i < 12; i++) { const waits = [];
        await w.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, { ...ENV, CRON_MAINTAIN: "* * * * *" }, { waitUntil: (p) => waits.push(p) });
        await Promise.allSettled(waits);
        if (i >= 5) { const l = await call("GET", "/companies?owner=all"); if ((l.body.companies || []).length > 20) break; } } } finally { console.log = quiet; }
    }
    /* Eight associates, not thirty at the same instant: waves of five. */
    const waves = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 5) { out.push(...await Promise.all(Array.from({ length: Math.min(5, n - i) }, (_, j) => fn(i + j)))); await sleep(400); } return out; };

    /* H · 30 cold instances open a company at once */
    {
      const t = performance.now();
      const all = await waves(30, () => call("GET", "/company?id=903"));
      const okAll = all.every((r) => r.status === 200 && (r.body.owners || []).some((o) => String(o.id) === "74726")
        && !(r.body.owners || []).some((o) => ["74725", "74727"].includes(String(o.id))));
      ok("H", `30 cold /company in waves of 5: current owner always listed, never API/deactivated (${ms(t)})`, okAll,
         all.filter((r) => r.status !== 200).map((r) => r.status).join(",") || JSON.stringify(all[0].body.owners));
    }

    /* D · saves with event rows, then opens */
    {
      const w0 = (await atWrites()).length;
      const saved = [];
      for (let i = 0; i < 12; i++) {
        const kid = i % 2 ? "38470" : "112936";
        const r = await call("POST", "/save", { contact: { kid, pocName: i % 2 ? "Devanshi Kalro" : "Shipra", companyId: i % 2 ? "903" : "1776620", company: "x",
          owner: "Priya Deshmukh", ownerId: 74726, stage: "MQL_MARKETING_QUALIFIED_LEAD", phones: [{ type: "MOBILE", cc: "+91", value: i % 2 ? "9920477103" : "9811122233", primary: true }],
          current: [{ rowKey: `stress-${kid}`, eventType: "Offsite", budget: `${i}L`, timeline: "Dec", pax: "80", remarks: "" }] },
          call: { at: new Date(Date.now() + i * 1000).toISOString(), outcome: "Connected", duration: 60 } });
        saved.push(r.status);
      }
      const opens = await waves(20, (i) => call("GET", `/contact?id=${i % 2 ? "38470" : "112936"}`));
      const withRows = opens.filter((r) => [...(r.body.contact?.current || []), ...(r.body.contact?.past || [])].some((e) => e.pax === "80")).length;
      const deletes = (await atWrites()).slice(w0).filter((x) => x.method === "DELETE" && /Event/.test(x.table || "")).length;
      ok("D", `12 saves with event rows, 20 opens: rows on every card that came from Airtable`, saved.every((s) => s === 200) && withRows === opens.filter((r) => r.body.source === "airtable").length,
         `saves ${saved.join(",")} · ${withRows} with rows of ${opens.length} (${opens.filter((r) => r.body.source === "airtable").length} from Airtable)`);
      ok("D", "no save deleted a row it did not send", deletes === 0, `${deletes} deletes`);
    }

    /* F · re-assignment of 20 companies through the job, the way the cron drains it */
    {
      const list = await call("GET", "/companies?owner=all");
      const ids = (list.body.companies || []).filter((c) => String(c.ownerId) !== "74726").slice(0, 20).map((c) => c.id);
      const job = await call("POST", "/allot-jobs", { kind: "company", items: ids.map((id) => ({ companyId: id, to: 74726 })) });
      if (!job.body.job) console.log(`    (job not started: ${job.status} ${JSON.stringify(job.body).slice(0, 160)} · ${ids.length} ids)`);
      const t = performance.now(); let steps = 0, last = null;
      while (steps < 60) { last = await call("POST", "/allot-jobs/step", { id: job.body.job?.id }); steps++; if (last.body.job?.finished) break; }
      const k = await ky();
      const movedContacts = k.filter((x) => /owner/.test(x.kind || "") || /\/owner/.test(x.path || "")).length;
      ok("F", `${ids.length} companies re-assigned through the job in ${steps} step(s) under Kylas' 4 req/s (${ms(t)})`,
         last?.body.job?.finished === true && (last.body.job.failed || 0) === 0, JSON.stringify(last?.body.job || last?.body).slice(0, 200));
      const atw = (await atWrites()).filter((x) => x.fields?.["Kylas Owner ID"] === "74726");
      ok("F", "the copy (Airtable) carries the new owner for the moved contacts it holds", atw.length > 0 || movedContacts === 0, `${atw.length} owner write(s), ${movedContacts} Kylas owner change(s)`);
    }

    /* C · each owner's report against the team's */
    {
      const team = await call("GET", "/report?period=month&owner=all");
      const per = team.body.byOwner || team.body.team || [];
      let bad = 0;
      for (const o of (team.body.byOwner || []).slice(0, 8)) {
        const id = Object.entries(team.body.ownerIds || {}).find(([, nme]) => nme === o.owner)?.[0];
        if (!id) continue;
        const one = await call("GET", `/report?period=month&owner=${id}`);
        if ((one.body.totals?.calls ?? -1) !== o.calls) bad++;
      }
      ok("C", "a person's report equals their row in the team's (period: month)", team.status === 200 && bad === 0, `${bad} differ of ${per.length}`);
    }

    /* G · Boolean post on the accounts list */
    {
      const list = await call("GET", "/companies?owner=all");
      const temp = (list.body.companies || []).find((c) => String(c.id) === "1810449");
      ok("G", "the Kylas Boolean post reaches the accounts list", temp?.enrich?.bp === "https://www.linkedin.com/posts/temp-offsite-activity-1", JSON.stringify(temp?.enrich || null));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
