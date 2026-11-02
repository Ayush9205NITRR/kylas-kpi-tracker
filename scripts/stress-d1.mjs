#!/usr/bin/env node
/* THE D1 MOVE, STRESSED BEFORE IT CARRIES THE OPERATION (2026-11-03).
 *
 * Ayush: "before deploy and shifting off Airtable, stress test — my entire
 * operation depends on it. Mimic, stress test and fill all the gaps."
 *
 * Runs the REAL scripts against the mock Airtable (its 5 req/s ceiling on) and
 * a real SQLite standing in for D1, at production size and beyond:
 *
 *   S1  seed       1,000 companies · 35,000 contacts · 20,000 call logs …
 *   S2  first lap  backfill.mjs → sqlite-to-d1.mjs → import; every table's
 *                  count equals Airtable's; links resolve; views answer
 *   S3  a day      300 saves' worth of writes land in Airtable while the
 *                  minute cron (shadow.tick) runs; the copy catches up
 *   S4  failure    Airtable dies mid-lap → the watermark does not move, the
 *                  copy recovers when it is back, nothing is lost
 *   S5  per tick   Airtable requests and D1 statements one cron run costs
 *   S6  reads      the console's SQL reads at 35k contacts and at 1M calls,
 *                  p50 / p95
 *
 *   node scripts/stress-d1.mjs            # ~6–8 minutes
 *   node scripts/stress-d1.mjs --quick    # 1/10 the size
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fakeD1 } from "./d1-fake.mjs";
import { createAirtable } from "./airtable.mjs";
import { createShadow } from "./shadow.mjs";
import { readCompaniesSql, progressInputsSql } from "./sql-read.mjs";
import { BACKFILL_ORDER } from "./sql-store.mjs";
import { tableName } from "./sql-schema.mjs";

const QUICK = process.argv.includes("--quick");
const K = QUICK ? 0.1 : 1;
const N = { companies: Math.round(1000 * K), perCompany: 35, calls: Math.round(20000 * K),
            transitions: Math.round(3000 * K), events: Math.round(1500 * K),
            dialler: Math.round(5000 * K), notes: Math.round(2000 * K) };
const PORT = 9941, URL0 = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "stress-d1-"));
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = () => performance.now();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const mock = spawn(process.execPath, ["scripts/mock-airtable.mjs"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
let mockErr = ""; mock.stderr.on("data", (d) => (mockErr += d)); mock.on("exit", (c) => { if (c) console.log(`\n! mock Airtable exited ${c}: ${mockErr.slice(-600)}`); });
const cleanup = () => { try { mock.kill(); } catch {} ; rmSync(dir, { recursive: true, force: true }); };
process.on("exit", cleanup);
for (let i = 0; i < 50; i++) { try { await fetch(`${URL0}/__count`); break; } catch { await sleep(100); } }

const AUTH = { Authorization: "Bearer pat_mock" };
const bulk = (table, count, fields) => fetch(`${URL0}/__bulk`, { method: "POST",
  headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ table, count, fields }) }).then((r) => r.json());
/* Retried: a keep-alive socket left idle through the backfill can be closed
   under us, which is the harness's problem, not the copy's. */
const getJSON = async (path) => { for (let i = 0; ; i++) { try { return await (await fetch(`${URL0}${path}`, { headers: AUTH })).json(); } catch (e) { if (i > 4) throw e; await sleep(200); } } };
const counts = () => getJSON("/__count");
const AT_ENV = { ...process.env, AIRTABLE_BASE_URL: URL0, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK" };
const at = createAirtable("pat_mock", "appMOCK", { log: () => {}, apiUrl: URL0 });

/* ── S1 · seed at production size ─────────────────────────────────── */
console.log(`\nS1  seeding (${QUICK ? "quick" : "full"} size)`);
let s = t0();
const STAGES = ["CNC_COULD_NOT_CONNECT", "MQL_MARKETING_QUALIFIED_LEAD", "FOLLOW_UP_1", "SQL_SALES_QUALIFIED_LEAD", "NOT_INTERESTED"];
for (let c = 0; c < N.companies; c++)
  await bulk("Companies", 1, { Name: `Company ${c}`, "Kylas Company ID": String(1700000 + c), Owner: ["Sejal Agrawal", "Muskan Rajpoot", "Aditi saini"][c % 3] });
for (let c = 0; c < N.companies; c++)
  await bulk("Contacts", N.perCompany, { Name: "Person #", "Kylas Contact ID": "5#", Company: [`recCom${c}`],
    Owner: ["Sejal Agrawal", "Muskan Rajpoot", "Aditi saini"][c % 3], "Current Stage": STAGES[c % STAGES.length], "KPI Rank": (c % 26) + 1 });
const contactsTotal = N.companies * N.perCompany;
for (let i = 0; i < N.calls; i += 10)
  await bulk("Call Log", 10, { Key: "call-#", "Called At": new Date(Date.now() - (i % 900) * 864e5 / 30).toISOString(),
    Owner: "Sejal Agrawal", Outcome: "Right POC", Duration: 60, "Duration Source": "dialed", Contact: [`recCon${(i * 7) % contactsTotal}`] });
for (let i = 0; i < N.transitions; i += 10)
  await bulk("Stage Transitions", 10, { Key: "tr-#", "From Stage": "CNC_COULD_NOT_CONNECT", "To Stage": "MQL_MARKETING_QUALIFIED_LEAD",
    "Changed At": new Date().toISOString(), Owner: "Muskan Rajpoot", Source: "Console", Contact: [`recCon${(i * 13) % contactsTotal}`] });
for (let i = 0; i < N.events; i += 10)
  await bulk("Event Rows", 10, { "Row Key": "row-#", Period: "Current", "Event Type": "Employee offsites", Budget: "8L", Timeline: "Q1", Pax: "60",
    Contact: [`recCon${(i * 17) % contactsTotal}`] });
await bulk("Dialler Calls", N.dialler, { Key: "d-#", "Called At": new Date().toISOString(), Owner: "Aditi saini", Duration: 45, "Contact Kylas ID": "5#" });
await bulk("Call Notes", N.notes, { Key: "n-#", "Called At": new Date().toISOString(), Owner: "Aditi saini", Note: "Asked to call after Diwali #", "Contact Kylas ID": "5#", Source: "dialler" });
const seeded = await counts();
console.log(`    ${Object.entries(seeded).map(([k, v]) => `${k} ${v}`).join(" · ")}  (${((t0() - s) / 1000).toFixed(1)}s)`);
ok("seeded at size", seeded.Contacts === contactsTotal && seeded["Call Log"] >= N.calls);

/* ── S2 · the first lap, exactly as Ayush will run it ─────────────── */
console.log("\nS2  first lap: backfill.mjs → sqlite-to-d1.mjs → import");
const local = join(dir, "kpi.sqlite"), sqlFile = join(dir, "d1-import.sql"), d1path = join(dir, "d1.sqlite");
s = t0();
let r = spawnSync(process.execPath, ["scripts/backfill.mjs", "--db", local], { env: AT_ENV, encoding: "utf8", maxBuffer: 64e6 });
const backfillSecs = (t0() - s) / 1000;
ok("backfill.mjs finished", r.status === 0, r.status ? r.stderr.slice(-300) : `${backfillSecs.toFixed(0)}s against the 5 req/s ceiling`);
s = t0();
r = spawnSync(process.execPath, ["scripts/sqlite-to-d1.mjs", "--db", local, "--out", sqlFile], { encoding: "utf8", maxBuffer: 64e6 });
ok("sqlite-to-d1.mjs wrote the import", r.status === 0, r.status ? r.stderr.slice(-300) : `${(readFileSync(sqlFile).length / 1e6).toFixed(1)} MB`);
s = t0();
const d1raw = new DatabaseSync(d1path);
try { d1raw.exec(readFileSync(sqlFile, "utf8")); ok("import ran on a fresh database", true, `${((t0() - s) / 1000).toFixed(1)}s`); }
catch (e) { ok("import ran on a fresh database", false, e.message.slice(0, 200)); }
const after = await counts();
for (const t of BACKFILL_ORDER) {
  if (after[t] == null) continue;
  const n = d1raw.prepare(`SELECT count(*) n FROM "${tableName(t)}"`).get().n;
  ok(`${t}: ${n} in D1 = ${after[t]} in Airtable`, n === after[t]);
}
const orphan = d1raw.prepare(`SELECT count(*) n FROM "contacts" WHERE "company_id" IS NULL`).get().n;
ok("every seeded contact kept its company link", orphan === 0, `${orphan} without`);
const callOrphan = d1raw.prepare(`SELECT count(*) n FROM "call_log" WHERE "contact_id" IS NULL`).get().n;
ok("every call kept its contact link", callOrphan === 0, `${callOrphan} without`);
const st = d1raw.prepare("SELECT count(*) n, min(since) s FROM shadow_state").get();
ok("watermarks seeded for the Worker to carry on from", st.n >= 10, `${st.n} tables, since ${st.s}`);
d1raw.close();

/* ── S3 · a working day, with the minute cron running ─────────────── */
console.log("\nS3  a day's writes while the cron runs");
const raw = fakeD1(d1path);
/* Counts what a Worker pays for: one D1 call per run/first/all, one per batch. */
let d1Calls = 0;
const db = { ...raw, queries: () => d1Calls,
  batch: async (st) => { d1Calls++; return raw.batch(st); },
  prepare: (t) => { const wrap = (st) => ({ bind: (...p) => wrap(st.bind(...p)), _sync: st._sync,
      all: () => { d1Calls++; return st.all(); }, first: (c) => { d1Calls++; return st.first(c); }, run: () => { d1Calls++; return st.run(); } });
    return wrap(raw.prepare(t)); } };
const shadow = createShadow({ db, at, log: () => {} });
await sleep(1100);
const H = { Authorization: "Bearer pat_mock", "Content-Type": "application/json" };
const post = async (table, rows) => {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${URL0}/v0/appMOCK/${encodeURIComponent(table)}`, { method: "POST", headers: H,
      body: JSON.stringify({ records: rows.map((fields) => ({ fields })), typecast: true }) });
    if (res.ok) return res.json();
    await sleep(250);
  }
  throw new Error("rate limited");
};
const SAVES = QUICK ? 30 : 300;
const writer = (async () => {
  for (let i = 0; i < SAVES; i += 10) {
    await post("Call Log", Array.from({ length: 10 }, (_, j) => ({ Key: `live-${i + j}`, "Called At": new Date().toISOString(),
      Owner: "Muskan Rajpoot", Outcome: "No answer", Contact: [`recCon${(i + j) * 3}`] })));
    await post("Contacts", Array.from({ length: 2 }, (_, j) => ({ Name: `New ${i}-${j}`, "Kylas Contact ID": `9${i}${j}`, Company: ["recCom1"] })));
  }
})();
const tickCost = [];
let ticks = 0;
const deadline = Date.now() + (QUICK ? 60e3 : 240e3);
let writerDone = false; writer.then(() => (writerDone = true));
while (Date.now() < deadline) {
  const q0 = db.queries(); const r0 = (await getJSON("/__reads")).reads;
  const ts = t0(); const out = await shadow.tick(); const ms = t0() - ts;
  const r1 = (await getJSON("/__reads")).reads;
  tickCost.push({ ms, d1: db.queries() - q0, at: r1 - r0, out });
  ticks++;
  if (writerDone) {
    const live = await counts();
    const inD1 = (await db.prepare(`SELECT count(*) n FROM "call_log"`).first()).n;
    const cIn = (await db.prepare(`SELECT count(*) n FROM "contacts"`).first()).n;
    if (inD1 === live["Call Log"] && cIn === live.Contacts) break;
  }
  await sleep(300);
}
await writer;
const live = await counts();
const callsD1 = (await db.prepare(`SELECT count(*) n FROM "call_log"`).first()).n;
const contactsD1 = (await db.prepare(`SELECT count(*) n FROM "contacts"`).first()).n;
ok(`Call Log caught up: ${callsD1} in D1 = ${live["Call Log"]} in Airtable`, callsD1 === live["Call Log"], `after ${ticks} cron runs`);
ok(`Contacts caught up: ${contactsD1} = ${live.Contacts}`, contactsD1 === live.Contacts);
const dupes = (await db.prepare(`SELECT count(*) n FROM (SELECT airtable_id FROM "call_log" GROUP BY airtable_id HAVING count(*) > 1)`).first()).n;
ok("no row copied twice", dupes === 0, `${dupes} duplicates`);
const liveLinked = (await db.prepare(`SELECT count(*) n FROM "call_log" WHERE "key" LIKE 'live-%' AND "contact_id" IS NOT NULL`).first()).n;
ok("live calls point at their contacts", liveLinked === SAVES, `${liveLinked}/${SAVES}`);

/* ── S3b · a new contact and its first call in the same minute ────── */
console.log("\nS3b a contact made a minute ago, its call copied first");
const made = await post("Contacts", [{ Name: "Brand New", "Kylas Contact ID": "777001", Company: ["recCom2"] }]);
const newId = made.records[0].id;
await post("Call Log", [{ Key: "first-call-777001", "Called At": new Date().toISOString(), Owner: "Sejal Agrawal", Contact: [newId] }]);
await sleep(1100);
await shadow.tick({ tables: ["Call Log"] });
const fc = await db.prepare(`SELECT contact_id FROM "call_log" WHERE key = 'first-call-777001'`).first();
ok("the call is linked to its brand-new contact even though Call Log went first", fc?.contact_id != null, JSON.stringify(fc));

/* ── S4 · Airtable dies mid-lap ───────────────────────────────────── */
console.log("\nS4  Airtable unreachable for a while");
const wmBefore = (await db.prepare(`SELECT since FROM shadow_state WHERE tbl = 'Call Log'`).first()).since;
const deadAt = createAirtable("pat_mock", "appMOCK", { log: () => {}, apiUrl: "http://127.0.0.1:9" });
const deadShadow = createShadow({ db, at: deadAt, log: () => {} });
let deadErrors = 0;
for (let i = 0; i < 4; i++) { const o = await deadShadow.tick({ tables: ["Call Log"] }).catch(() => [{ error: "threw" }]); if (o.some((x) => x.error)) deadErrors++; }
const wmAfter = (await db.prepare(`SELECT since FROM shadow_state WHERE tbl = 'Call Log'`).first()).since;
ok("a failed pass is reported, not hidden", deadErrors === 4);
ok("a failed pass does not move the watermark", wmBefore === wmAfter, `${wmBefore} → ${wmAfter}`);
await post("Call Log", [{ Key: "during-outage", "Called At": new Date().toISOString(), Owner: "Sejal Agrawal", Contact: ["recCon5"] }]);
await sleep(1100);
for (let i = 0; i < 20; i++) { await shadow.tick({ tables: ["Call Log"] }); if (await db.prepare(`SELECT 1 FROM "call_log" WHERE key = 'during-outage'`).first()) break; }
ok("the call written during the outage arrives once Airtable is back",
   !!(await db.prepare(`SELECT 1 FROM "call_log" WHERE key = 'during-outage'`).first()));

/* ── S5 · what one cron run costs ─────────────────────────────────── */
console.log("\nS5  cost of one cron run (steady state)");
const steady = tickCost.slice(2);
const maxAt = Math.max(...steady.map((x) => x.at)), maxD1 = Math.max(...steady.map((x) => x.d1));
for (const x of steady.filter((x) => x.ms > 3000)) console.log(`    slow run ${x.ms.toFixed(0)} ms — ${JSON.stringify(x.out).slice(0, 160)}`);
console.log(`    ${steady.length} runs · Airtable pages max ${maxAt} · D1 statements max ${maxD1} · time p95 ${pct(steady.map((x) => x.ms), 0.95).toFixed(0)} ms`);
ok("a steady-state run stays inside the Worker's 50-subrequest budget for Airtable", maxAt <= 40, `max ${maxAt} Airtable requests`);
ok("a steady-state run makes few D1 calls (busy minute included)", maxD1 <= 300, `max ${maxD1}`);
const good = steady.filter((x) => !x.out.some((o) => o.error));
const bad = steady.filter((x) => x.out.some((o) => o.error));
ok("a successful run is quick", pct(good.map((x) => x.ms), 0.95) < 5000, `p95 ${pct(good.map((x) => x.ms), 0.95).toFixed(0)} ms over ${good.length} runs`);
/* A run that hit Airtable's rate limit (the writers here hammer it on
   purpose) gives up, says so and leaves the watermark — S4 proves the rows
   still arrive. It must stay well inside a scheduled Worker's wall time. */
ok("a rate-limited run gives up cleanly", bad.every((x) => x.ms < 60000), `${bad.length} such run(s)`);

/* ── S6 · the console's reads, at this size and at 1M calls ───────── */
console.log("\nS6  read latency from the copy");
const time = async (fn, n = 15) => { const a = []; for (let i = 0; i < n; i++) { const x = t0(); await fn(); a.push(t0() - x); } return a; };
let a = await time(() => readCompaniesSql(db));
console.log(`    companies list (${(await readCompaniesSql(db)).length} rows)   p50 ${pct(a, .5).toFixed(0)} ms · p95 ${pct(a, .95).toFixed(0)} ms`);
ok("companies list p95 < 1500 ms at production size", pct(a, .95) < 1500);
a = await time(() => progressInputsSql(db), 5);
console.log(`    progress inputs                 p50 ${pct(a, .5).toFixed(0)} ms · p95 ${pct(a, .95).toFixed(0)} ms`);
ok("progress inputs p95 < 3000 ms", pct(a, .95) < 3000);
/* 1M calls: written straight into SQLite — the question is the query, not the copy. */
const big = new DatabaseSync(d1path);
const target = QUICK ? 100000 : 1000000;
const have = big.prepare(`SELECT count(*) n FROM "call_log"`).get().n;
s = t0();
big.exec("BEGIN");
const ins = big.prepare(`INSERT INTO "call_log" ("airtable_id","key","called_at","owner","outcome","duration","contact_id") VALUES (?,?,?,?,?,?,?)`);
const cids = big.prepare(`SELECT id FROM "contacts"`).all().map((r) => r.id);
for (let i = have; i < target; i++) ins.run(`recBig${i}`, `big-${i}`, new Date(Date.now() - (i % 365) * 864e5).toISOString(), "Sejal Agrawal", "No answer", 30, cids[i % cids.length]);
big.exec("COMMIT"); big.close();
console.log(`    grew Call Log to ${target.toLocaleString()} rows (${((t0() - s) / 1000).toFixed(0)}s)`);
a = await time(() => readCompaniesSql(db), 5);
console.log(`    companies list at ${target.toLocaleString()} calls  p50 ${pct(a, .5).toFixed(0)} ms · p95 ${pct(a, .95).toFixed(0)} ms`);
ok(`companies list p95 < 3000 ms at ${target.toLocaleString()} calls`, pct(a, .95) < 3000);
a = await time(() => db.prepare(`SELECT count(*) n FROM "call_log" WHERE "called_at" >= ?`).bind(new Date(Date.now() - 864e5).toISOString()).first(), 15);
console.log(`    today's calls (indexed range)   p50 ${pct(a, .5).toFixed(1)} ms · p95 ${pct(a, .95).toFixed(1)} ms`);
ok("a day's calls p95 < 50 ms", pct(a, .95) < 50);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
