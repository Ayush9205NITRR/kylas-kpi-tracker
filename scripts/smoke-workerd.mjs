#!/usr/bin/env node
/* STORE=d1 ON CLOUDFLARE'S OWN RUNTIME — workerd and a real (local) D1.
 *
 *   node scripts/smoke-workerd.mjs [--wrangler <path to wrangler>]     (~2 minutes)
 *
 * Everything else about the D1 store is tested on node:sqlite, which is the
 * same SQLite but not the same host. This runs the actual Worker under
 * `wrangler dev --local` — workerd, Miniflare's D1, the real bindings — with
 * STORE = "d1", and walks the path a day of dialling takes:
 *
 *   1. the first lap exactly as production will get it: a SQLite file →
 *      sqlite-to-d1.mjs → `wrangler d1 execute --local --file`
 *   2. /health, /companies, /company, /contact, /report, /rca, /queue, /focus
 *   3. a /save — then the contact, the call and the dashboard show it
 *   4. the minute cron (the read copy's upkeep) runs clean
 *   5. the D1 tables follow the code: a column dropped from the import is
 *      added back on the first query (d1-schema-sync.mjs)
 *
 * Mock Kylas on 9900 stands in for Kylas; nothing real is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const WRANGLER = arg("--wrangler", "npx wrangler");
const PORT = 8799;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const dir = mkdtempSync(join(tmpdir(), "smoke-workerd-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : ` — ${String(x).slice(0, 220)}`}`); };
const kids = [];
const cleanup = () => { kids.forEach((p) => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } }); };
process.on("exit", cleanup);
if (existsSync(REPO + "/.save-journal.json")) unlinkSync(REPO + "/.save-journal.json");

/* ── 1 · data, and the first lap as production will do it ───────────── */
console.log("1. the first lap: SQLite → sqlite-to-d1.mjs → wrangler d1 execute --local");
const file = join(dir, "kpi.sqlite");
{
  const db = new DatabaseSync(file);
  db.exec(sqlSchema({ looseSelects: true })); db.exec(sqlDerived());
  db.exec("BEGIN");
  const rid = (p, i) => "rec" + p + String(i).padStart(11, "0");
  const co = db.prepare(`INSERT INTO companies (airtable_id, kylas_company_id, name, owner, kylas_owner_id) VALUES (?,?,?,?,?)`);
  ["1776620", "1778327", "903", ...Array.from({ length: 60 }, (_, i) => String(200000 + i))]
    .forEach((k, i) => co.run(rid("COM", i), k, `Co ${k}`, "Enout Super Admin", "74725"));
  const ct = db.prepare(`INSERT INTO contacts (airtable_id, kylas_contact_id, name, company_id, owner, kpi_rank, kpi_rank_at, first_worked_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 400; i++) ct.run(rid("CON", i), i === 0 ? "112936" : String(500000 + i), `Person ${i}`, 1 + (i % 63), "Enout Super Admin",
    i % 5 ? null : 9 + (i % 18), i % 5 ? null : "2026-10-20T10:00:00.000Z", "2026-10-01T00:00:00.000Z");
  const cl = db.prepare(`INSERT INTO call_log (airtable_id, key, contact_id, called_at, owner, outcome, duration, duration_source) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 900; i++) cl.run(rid("CAL", i), `k${i}`, 1 + (i % 400), new Date(Date.now() - (i % 200) * 3600_000).toISOString(),
    "Enout Super Admin", "No answer", 20, i % 2 ? "dialed" : "estimated");
  db.prepare(`INSERT INTO schema_migrations (airtable_id, key, note, applied_at) VALUES (?,?,?,?)`).run(rid("SCM", 0), "last-sync",
    JSON.stringify({ at: new Date().toISOString(), kylas: { reportedTotal: 63 } }), new Date().toISOString());
  db.exec("COMMIT");
  /* An older copy: one column the code now has is missing from the import,
     so step 5 can watch it come back. */
  db.exec(`ALTER TABLE contacts DROP COLUMN first_discovery_at`);
  db.close();
}
const importSql = join(dir, "d1-import.sql");
const conv = spawnSync("node", ["scripts/sqlite-to-d1.mjs", "--db", file, "--out", importSql], { cwd: REPO, encoding: "utf8" });
ok("sqlite-to-d1.mjs writes the import", conv.status === 0, conv.stderr || conv.stdout);
/* The import carries the CURRENT schema's CREATE TABLE, so drop the column
   from it too — the point is a D1 that predates the field. */
{
  const { readFileSync } = await import("node:fs");
  writeFileSync(importSql, readFileSync(importSql, "utf8").replace(/\n\s*, "first_discovery_at"[^\n]*/, ""));
}
const config = join(dir, "wrangler.toml");
writeFileSync(config, `name = "smoke-d1"
main = "${REPO}/worker/index.mjs"
compatibility_date = "2026-09-23"
compatibility_flags = ["nodejs_compat"]
[[d1_databases]]
binding = "DB"
database_name = "smoke-mirror"
database_id = "00000000-0000-0000-0000-000000000001"
[[d1_databases]]
binding = "KPI_DB"
database_name = "smoke-kpi"
database_id = "00000000-0000-0000-0000-000000000002"
[vars]
STORE = "d1"
AUTH = "none"
ALLOWED_ORIGIN = "${ORIGIN}"
KYLAS_KEY = "x"
KYLAS_BASE = "http://127.0.0.1:9900"
AIRTABLE_BASE = "appMOCK"
VERSION = "smoke-d1"
CRON_MAINTAIN = "* * * * *"
`);
const sh = (cmd) => spawnSync("bash", ["-lc", cmd], { cwd: dir, encoding: "utf8", timeout: 300_000 });
const ex = sh(`${WRANGLER} d1 execute smoke-kpi --local --persist-to ${dir}/state --config ${config} --file ${importSql} 2>&1`);
ok("wrangler d1 execute --local loads it", ex.status === 0, ex.stdout.slice(-400));

/* ── the Worker, on workerd ──────────────────────────────────────────── */
const mk = spawn("node", ["scripts/mock-kylas.mjs"], { cwd: REPO, stdio: "ignore", detached: true, env: { ...process.env, MOCK_MANY: "60" } });
kids.push(mk);
const wd = spawn("bash", ["-lc", `${WRANGLER} dev --local --port ${PORT} --persist-to ${dir}/state --config ${config} --test-scheduled 2>&1`],
  { cwd: dir, detached: true });
kids.push(wd);
let wlog = "";
wd.stdout.on("data", (d) => { wlog += d; });
for (let i = 0; i < 120 && !/Ready on/i.test(wlog); i++) await sleep(1000);
ok("wrangler dev is up (workerd)", /Ready on/i.test(wlog), wlog.slice(-300));
const get = async (path, init = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { Origin: ORIGIN, ...(init.headers || {}) } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
};

console.log("\n2. the console's reads, on D1");
const h = await get("/health");
ok("/health", h.status === 200, h.t);
/* the cron builds the read copy, as the minute trigger does in production */
for (let i = 0; i < 25; i++) {
  await get("/__scheduled?cron=*+*+*+*+*");
  const cs = await get("/cache-status");
  if (!(cs.j?.mirror || []).some((t) => !t.built)) break;
  await sleep(1000);
}
const cos = await get("/companies?owner=all");
ok("/companies serves the D1 data", cos.status === 200 && (cos.j?.companies || []).length >= 60,
  `${cos.status} ${cos.j?.companies?.length} ${JSON.stringify({...cos.j, companies: undefined, picklists: undefined, owners: undefined}).slice(0,600)} · ${wlog.split("\n").filter((l) => /no such|SQLITE|d1 schema|rror/i.test(l)).slice(-8).join(" | ")}`);
if (!((cos.j?.companies || []).length >= 60)) {
  const kd = await get("/kpi-debug");
  console.log("     kpi-debug:", kd.t.slice(0, 200));
  console.log("     log:", wlog.split("\n").filter((l) => /companies/.test(l) && !/AUTH/.test(l)).slice(0, 12).join("\n"));
  const cs = await get("/cache-status");
  console.log("     cache-status:", JSON.stringify(cs.j?.sync ?? cs.j).slice(0, 600));
}
for (const p of ["/company?id=1776620", "/contact?id=112936", "/history?id=112936", "/report?period=week&owner=all",
                 "/rca?owner=74725", "/queue?owner=74725", "/focus", "/snapshots?days=7"]) {
  const r = await get(p);
  ok(`${p.split("?")[0]} answers 200`, r.status === 200, `${r.status} ${r.t.slice(0, 160)}`);
}
const rep0 = (await get("/report?period=day&owner=all")).j;

console.log("\n3. a save lands in D1, and shows");
const sv = await get("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  contact: { lid: "", kid: "112936", pocName: "Person 0", companyId: "1776620", company: "seats", owner: "Enout Super Admin", ownerId: 74725,
    phones: [{ type: "MOBILE", cc: "+91", value: "9800004321", primary: true }], emails: [], stage: "MQL_MARKETING_QUALIFIED_LEAD", past: [],
    remarks: "smoke on workerd", current: [{ rowKey: "smoke-row-1", eventType: "Offsite", budget: "8L", timeline: "Mar", pax: "40", remarks: "" }] },
  call: { at: new Date().toISOString(), outcome: "Connected", duration: 61, durationSource: "dialed", createdHere: true } }) });
ok("/save answers 200 with the Airtable leg written", sv.status === 200 && !sv.j?.airtableError, `${sv.status} ${sv.t.slice(0, 300)}`);
const q = (sql) => sh(`${WRANGLER} d1 execute smoke-kpi --local --persist-to ${dir}/state --config ${config} --json --command "${sql}" 2>/dev/null`);
let rows = null;
for (let i = 0; i < 10 && !rows?.length; i++) {
  try { rows = JSON.parse(q(`SELECT budget FROM event_rows WHERE row_key = 'smoke-row-1'`).stdout)[0].results; } catch {}
  if (!rows?.length) await sleep(1000);
}
ok("the event row is in D1", rows?.[0]?.budget === "8L", JSON.stringify(rows));
const calls = JSON.parse(q(`SELECT COUNT(*) n FROM call_log WHERE duration = 61`).stdout || "[{}]")[0]?.results?.[0]?.n;
ok("the call is in D1", Number(calls) === 1, calls);
let rep1 = null;
for (let i = 0; i < 20; i++) {
  rep1 = (await get("/report?period=day&owner=all")).j;
  if ((rep1?.totals?.calls ?? 0) > (rep0?.totals?.calls ?? 0)) break;
  await sleep(500);
}
ok("the dashboard counts it", (rep1?.totals?.calls ?? 0) > (rep0?.totals?.calls ?? 0), `${rep0?.totals?.calls} → ${rep1?.totals?.calls}`);
const ct = (await get("/contact?id=112936")).j;
ok("the contact reads back after the save", !!ct && !ct.error, JSON.stringify(ct).slice(0, 200));

console.log("\n4. the minute cron on D1");
const cr = await get("/__scheduled?cron=*+*+*+*+*");
await sleep(2000);
ok("it runs clean", cr.status === 200 && !/FAILED/.test(wlog.split("cron * * * * *").pop() || ""), wlog.split("\n").filter((l) => /FAILED|Error/.test(l)).slice(-3).join(" | "));

console.log("\n5. the D1 tables follow the code");
const cols = JSON.parse(q(`SELECT name FROM pragma_table_info('contacts')`).stdout || "[{}]")[0]?.results?.map((r) => r.name) || [];
ok("the column the import lacked was added on the first query", cols.includes("first_discovery_at"), cols.length + " columns");

console.log(`\n${pass} passed, ${fail} failed`);
const errs = wlog.split("\n").filter((l) => /✘|Uncaught|TypeError|ReferenceError/.test(l));
if (errs.length) console.log("worker errors seen:\n  " + errs.slice(0, 8).join("\n  "));
cleanup();
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
