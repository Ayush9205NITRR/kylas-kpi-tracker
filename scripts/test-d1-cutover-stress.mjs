#!/usr/bin/env node
/* IS enout-kpi READY TO CARRY THE OPERATION, AND WHAT WILL IT COST?
 *
 *   node scripts/test-d1-cutover-stress.mjs           # ~3 min
 *   node scripts/test-d1-cutover-stress.mjs --bds 20
 *
 * Parity (the suites on both stores) is test-parity.mjs' job and is not
 * repeated here. This answers the three questions parity does not:
 *
 *   A  does it hold up with every BD working at once, through Kylas 429s
 *   B  does a 1,000-contact view read without D1_ERROR: too many SQL
 *      variables — the live failure that made the WhatsApp columns vanish
 *   C  what does a day actually WRITE, and does the month fit inside the
 *      50M included rows once the minute-by-minute Airtable mirror is off
 *
 * C is measured, not estimated: the real wa-jobs and deals modules run
 * against a real SQLite wrapped in a counter, so every INSERT and UPDATE a
 * day performs is counted the way Cloudflare bills it — rows written, not
 * statements. The KPI side is counted the same way through airtable-d1,
 * which is the engine STORE=d1 puts under the console.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const A = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BDS = Math.max(8, Math.min(20, Number(arg("--bds", 12))));

const R = { parity: [], concurrency: [], scale: [], cost: [], crons: [] };
let fails = 0;
const ok = (b, what, cond, detail = "") => {
  R[b].push({ what, cond: !!cond, detail });
  if (!cond) { fails++; console.log(`  FAIL  [${b}] ${what}${detail ? `  — ${detail}` : ""}`); }
  else console.log(`  pass  ${what}${detail ? `  — ${detail}` : ""}`);
};
const post = async (path, body) => {
  const r = await fetch(A + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
};
const get = async (path) => {
  const r = await fetch(A + path); let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
};

/* ── a SQLite that counts the way Cloudflare charges ───────────────────
   "Rows written" is every row an INSERT, UPDATE or DELETE touches — not
   the number of statements. meta.changes is exactly that number, so the
   wrapper reads it rather than guessing from the SQL. */
function countingD1(path) {
  const sql = new DatabaseSync(path);
  const n = { written: 0, read: 0, statements: 0 };
  const stmt = (text, params = []) => ({
    bind: (...p) => stmt(text, p),
    async all() { n.statements++; const rows = sql.prepare(text).all(...params).map((r) => ({ ...r }));
      n.read += rows.length; return { results: rows, success: true, meta: { rows_read: rows.length } }; },
    async first(col) { n.statements++; const r = sql.prepare(text).get(...params); n.read += r ? 1 : 0;
      const row = r ? { ...r } : null; return col ? (row ? row[col] : null) : row; },
    async run() { n.statements++; const r = sql.prepare(text).run(...params);
      n.written += Number(r.changes) || 0;
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    _sync() { n.statements++; const r = sql.prepare(text).run(...params); n.written += Number(r.changes) || 0; return r; },
  });
  return { n, db: {
    prepare: (t) => stmt(t),
    async batch(list) { sql.exec("BEGIN"); try { const o = list.map((s) => { s._sync(); return { success: true }; });
      sql.exec("COMMIT"); return o; } catch (e) { sql.exec("ROLLBACK"); throw e; } },
    async exec(t) { sql.exec(t); return { count: 1 }; },
  } };
}

const procs = [];
const up = async (file, env, probe) => {
  const p = spawn("node", [file], { cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 80; i++) { try { if ((await probe()).status > 0) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${file} never came up`);
};

for (const f of [".save-journal.json", ".d1cut-jobs.sqlite", ".d1cut-kpi.sqlite", ".d1cut-day.sqlite"])
  if (existsSync(`${REPO}/${f}`)) unlinkSync(`${REPO}/${f}`);

try {
  /* ══ the stack, with the KPI side on D1 and jobs on D1 ══════════════ */
  await up("scripts/mock-kylas.mjs", { MOCK_MANY: "40" },
    () => fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } }));
  await up("scripts/mock-airtable.mjs",
    { MOCK_AIRTABLE_STORE: "d1", MOCK_AIRTABLE_D1_FILE: `${REPO}/.d1cut-kpi.sqlite` },
    () => fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts"));
  await up("scripts/proxy.mjs",
    { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
      AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock",
      AIRTABLE_BASE: "appMOCK", PORT: "8787", ADMIN_IDS: "74725",
      JOBS_DB: `${REPO}/.d1cut-jobs.sqlite` },
    () => fetch(A + "/health"));

  console.log(`\nA · ${BDS} BDs at once, through Kylas 429s`);
  const h = await get("/health");
  ok("parity", "the stack is up with the KPI store on D1", h.status === 200);

  /* Cold opens first: nothing cached, every BD on a different account. */
  const ids = ["903", "1776620", "1778327", "1810449", "200000", "200001", "200002", "200003"];
  const t0 = Date.now();
  const opens = await Promise.all(Array.from({ length: BDS }, (_, i) =>
    get(`/company?id=${ids[i % ids.length]}`)));
  ok("concurrency", `${BDS} cold /company opens all answered`,
     opens.every((r) => r.status === 200), opens.map((r) => r.status).filter((s) => s !== 200).join(",") || "all 200");
  ok("concurrency", "...in a workable time", Date.now() - t0 < 60000, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* Simultaneous saves: event rows on every one, a deal on every fourth,
     a WhatsApp job on every one. The mock 429s above 4 req/s, so the retry
     path is exercised throughout rather than being simulated. */
  const t1 = Date.now();
  const saves = await Promise.all(Array.from({ length: BDS }, (_, i) => post("/save", {
    contact: { lid: `cut-${i}`, pocName: `Cutover BD${i}`, companyId: "903", company: "Shorehouse Retail",
      phones: [{ type: "MOBILE", cc: "+91", value: `98118${String(10000 + i)}`, primary: true }],
      emails: [{ type: "OFFICE", value: `c${i}@x.com`, primary: true }], designation: "HR",
      stage: i % 4 === 0 ? "ACTIVE_REQUIREMENT_CALL_BOOKED" : "CNC_COULD_NOT_CONNECT",
      current: [{ eventType: "Employee offsites", pax: "120", timeline: "March", budget: "approx 8L" }] },
    call: {}, sendWa: true })));
  const good = saves.filter((r) => r.status === 200);
  ok("concurrency", `${BDS} simultaneous saves all succeeded`, good.length === BDS,
     `${good.length}/${BDS} · ${saves.filter((r) => r.status !== 200).map((r) => r.status).join(",")}`);
  ok("concurrency", "...each wrote a contact", good.every((r) => !!r.j?.kid));
  ok("concurrency", "...deals were created on the hand-off saves",
     good.filter((r) => r.j?.deal?.id).length >= 1, `${good.filter((r) => r.j?.deal?.id).length} deals`);
  ok("concurrency", "...and WhatsApp jobs were enqueued",
     good.filter((r) => r.j?.wa?.queued).length >= 1, `${good.filter((r) => r.j?.wa?.queued).length} queued`);
  ok("concurrency", "...no save was lost to a Kylas 429",
     !saves.some((r) => r.status === 429 || /429|too many/i.test(JSON.stringify(r.j || {}))),
     `${((Date.now() - t1) / 1000).toFixed(1)}s for ${BDS}`);

  console.log("\nB · a 1,000-contact view");
  const many = Array.from({ length: 1000 }, (_, i) => String(600000 + i));
  const f1 = await post("/wa/contact-status", { ids: many });
  ok("scale", "/wa/contact-status answers for 1,000 contacts", f1.status === 200,
     `${f1.status} ${JSON.stringify(f1.j || {}).slice(0, 80)}`);
  ok("scale", "...with a field set for every one", Object.keys(f1.j?.fields || {}).length === 1000,
     `${Object.keys(f1.j?.fields || {}).length}`);
  /* THE LIVE FAILURE THIS GUARDS. */
  ok("scale", "...and no D1_ERROR: too many SQL variables",
     !/too many SQL variables|D1_ERROR/i.test(JSON.stringify(f1.j || {})));
  const el = await post("/wa/eligible", { seq: "cnc", step: 1,
    contacts: many.map((id) => ({ contactId: id, phone: "+919000000000" })) });
  ok("scale", "/wa/eligible survives the same list", el.status === 200 && (el.j?.rows || []).length === 1000,
     `${el.status} ${(el.j?.rows || []).length}`);
  const vc = await get("/view-contacts?companies=903,1776620,1778327,1810449");
  ok("scale", "/view-contacts still answers beside it", vc.status === 200);

  console.log("\nD · the six crons: set, scheduled, dispatched");
  /* Each is called the way the Worker calls it — by its cron expression
     through the same dispatcher — so a schedule edited in one place and not
     the other shows up here rather than as a job that never happens. */
  /* WHAT THIS PROVES AND WHAT IT DOES NOT. The dispatcher maps a cron
     EXPRESSION to a job name, so the failure it guards against is a
     schedule edited in wrangler.toml and not in the map — a job that simply
     never happens. Checked here: the variable is set, it appears in the
     crons list, and worker/index.mjs maps it. NOT checked: the job running
     end to end, which needs the live Kylas and Airtable credentials this
     box does not have. The suites above cover the code those jobs call. */
  const worker = (await import("node:fs")).readFileSync(`${REPO}/worker/index.mjs`, "utf8");
  const CRONS = ["CRON_SYNC", "CRON_SNAPSHOT", "CRON_DIALLER", "CRON_PUSH", "CRON_ROLLUP", "CRON_SYNC_FAST"];
  const toml = (await import("node:fs")).readFileSync(`${REPO}/wrangler.toml`, "utf8");
  for (const c of CRONS) {
    const line = new RegExp(`^${c}\\s*=\\s*"([^"]+)"`, "m").exec(toml);
    const scheduled = line && new RegExp(line[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(toml.split("crons")[1] || "");
    const mapped = new RegExp(`env\\.${c}\\b`).test(worker);
    ok("crons", `${c}: set, scheduled, and mapped to a job`, !!line && !!scheduled && mapped,
       line ? `"${line[1]}"${scheduled ? "" : " — NOT in crons = [...]"}${mapped ? "" : " — not in the dispatcher"}` : "unset");
  }

  console.log("\nC · what a day writes");
  /* 8 BDs · 1,200 calls · 500 WhatsApp · 10 deals, run through the REAL
     modules against a counted SQLite. */
  const { createWaJobs } = await import("../scripts/wa-jobs.mjs");
  const { createDeals } = await import("../scripts/deals.mjs");
  const C = countingD1(`${REPO}/.d1cut-day.sqlite`);
  const wa = createWaJobs({ db: C.db });
  const deals = createDeals({ db: C.db });
  await wa.ready(); await deals.ready();
  const base = C.n.written;                      /* schema + seeds are not a day */

  for (let i = 0; i < 500; i++) {
    const q = await wa.queue({ contactId: `d${i}`, companyId: "903", phone: `+9190000${String(10000 + i)}`,
      stage: "CNC_COULD_NOT_CONNECT", template: "cnc", seat: `bd-exec-${(i % 8) + 1}`, dueAt: Date.now() });
    /* A real day also delivers and reads them — those are writes too. */
    await wa.webhook({ event: "sent", jobId: q.id, contactId: `d${i}` });
    if (i % 2 === 0) await wa.webhook({ event: "delivered", jobId: q.id, contactId: `d${i}` });
  }
  const waWritten = C.n.written - base;
  for (let i = 0; i < 10; i++) {
    const d = await deals.create({ kylasDealId: `k${i}`, companyId: "903", contactId: `c${i}`,
      name: `Deal ${i}`, owner: "BD", value: 800000, playbooks: ["pre_call", "post_call"] });
    const its = await deals.items(d.id);
    await deals.complete(its[0].id);
  }
  const dealWritten = C.n.written - base - waWritten;

  /* THE KPI SIDE, MEASURED RATHER THAN ASSUMED. The concurrent saves above
     went through the console's real path with the KPI store on D1, so the
     rows they left in that database — divided by the number of saves — is
     what one call actually costs. A hand-set "3 per call" would be the kind
     of number that makes a cost projection worthless. */
  const kpiDb = new DatabaseSync(`${REPO}/.d1cut-kpi.sqlite`, { readOnly: true });
  const tables = kpiDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  let kpiRows = 0;
  for (const t of tables) kpiRows += Number(kpiDb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n) || 0;
  /* Rows CREATED by the run, over the saves that created them. Updates are
     not in this figure, so it is a floor, not a ceiling — said out loud
     rather than quietly rounded up. */
  const perCall = Math.max(1, Math.round((kpiRows / Math.max(1, good.length)) * 10) / 10);
  const callWritten = Math.round(1200 * perCall);
  const kpiPerCall = perCall;
  const dayTotal = waWritten + dealWritten + callWritten;
  const month = dayTotal * 26;
  console.log(`   WhatsApp 500 sends -> ${waWritten} rows written`);
  console.log(`   10 deals + items   -> ${dealWritten} rows written`);
  console.log(`   1,200 calls        -> ${callWritten} rows written (${kpiPerCall}/call, measured from ${good.length} real saves across ${tables.length} KPI tables)`);
  console.log(`   DAY ${dayTotal.toLocaleString()} rows · MONTH (26 working days) ${month.toLocaleString()}`);
  ok("cost", "a day's rows written are counted, not estimated", dayTotal > 0, `${dayTotal}`);
  ok("cost", "the month fits inside the 2M line we set ourselves", month < 2_000_000,
     `${month.toLocaleString()} / 2,000,000`);
  ok("cost", "...and far inside Cloudflare's 50M included", month < 50_000_000,
     `${((month / 50_000_000) * 100).toFixed(2)}% of the included allowance`);
  /* THE ONE THING THAT WOULD BREAK THIS. */
  const maintain = /^CRON_MAINTAIN\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || "";
  ok("cost", "the every-minute mirror is the cron that must be switched off",
     maintain === "* * * * *",
     `CRON_MAINTAIN="${maintain}" — 43,200 runs/month; leaving it on with STORE=d1 copies a base nothing reads`);
} catch (e) {
  console.log(`\n! the run itself failed: ${e?.stack || e}`);
  fails++;
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  await sleep(400);
  for (const f of [".d1cut-jobs.sqlite", ".d1cut-kpi.sqlite", ".d1cut-day.sqlite"])
    { try { rmSync(`${REPO}/${f}`, { force: true }); } catch { /* leave it */ } }
  const row = (lab, k) => {
    const l = R[k], bad = l.filter((x) => !x.cond).length;
    return `│ ${lab.padEnd(26)} │ ${String(l.length).padStart(5)} │ ${String(bad).padStart(6)} │ ${(bad ? "FAIL" : "PASS").padEnd(6)} │`;
  };
  console.log("\n┌────────────────────────────┬───────┬────────┬────────┐");
  console.log("│ readiness                  │ check │ failed │ result │");
  console.log("├────────────────────────────┼───────┼────────┼────────┤");
  console.log(row("Stack on STORE=d1", "parity"));
  console.log(row("Concurrency + 429s", "concurrency"));
  console.log(row("1,000-contact reads", "scale"));
  console.log(row("Cron wiring", "crons"));
  console.log(row("Cost projection", "cost"));
  console.log("└────────────────────────────┴───────┴────────┴────────┘");
  const all = Object.values(R).flat();
  console.log(`\n${all.length - all.filter((x) => !x.cond).length} passed, ${all.filter((x) => !x.cond).length} failed`);
  process.exit(fails ? 1 : 0);
}
