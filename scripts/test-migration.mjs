/* GATE 1, END TO END: backfill then reconcile, against the mock Airtable.
 *
 * Starts its own mock, seeds it, copies it into SQLite, and then plants the
 * four faults a migration actually produces to prove the reconciler names
 * each one. A reconciler that reports "clean" is worth nothing unless it has
 * been shown to report dirty — so most of this file is making it fail.
 *
 * Run: node scripts/test-migration.mjs
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = 9931;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/claude-0/test-migration.sqlite";
const env = { ...process.env, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK",
              AIRTABLE_BASE_URL: BASE_URL };

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const run = (file, args) => new Promise((res) => {
  const p = spawn(process.execPath, [file, ...args], { env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => res({ code, out }));
});
/* The mock enforces Airtable's five-a-second, as it should — so the fixtures
   this test writes have to wait like anything else talking to it. */
const H = { Authorization: "Bearer pat_mock", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE_URL}/v0/appMOCK/${path}`,
      { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (/RATE_LIMIT_REACHED/.test(text)) { await sleep(400); continue; }
    throw new Error(`${method} ${path}: ${text.slice(0, 200)}`);
  }
  throw new Error(`${method} ${path}: still rate limited after 12 tries`);
}
const post = async (table, rows) =>
  (await call("POST", encodeURIComponent(table), { records: rows.map((fields) => ({ fields })) })).records;
/* Airtable's own shapes: a patch is a records array on the table, and a
   delete names the ids in the query string. */
const patch = (table, id, fields) =>
  call("PATCH", encodeURIComponent(table), { records: [{ id, fields }] });
const del = (table, id) =>
  call("DELETE", `${encodeURIComponent(table)}?records[]=${encodeURIComponent(id)}`);
const list = (table) => call("GET", encodeURIComponent(table));

rmSync(DB, { force: true });
const mock = spawn(process.execPath, ["scripts/mock-airtable.mjs"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));

try {
  console.log("1. seed the base, then copy it");
  const cos = await post("Companies", [
    { Name: "Acme", "Kylas Company ID": "900", Owner: "Enout Super Admin", "Kylas Owner ID": "74725" },
    { Name: "Globex", "Kylas Company ID": "901", Owner: "Priya Deshmukh", "Kylas Owner ID": "74726" },
  ]);
  const cts = await post("Contacts", [
    { Name: "Hema", "Kylas Contact ID": "700", Company: [cos[0].id], "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD",
      "KPI Rank": 14, "Ever Picked": true, "Next Call Date": "2026-10-02" },
    { Name: "Shipra", "Kylas Contact ID": "701", Company: [cos[1].id], "Current Stage": "CNC_COULD_NOT_CONNECT" },
  ]);
  await post("Event Rows", [
    { "Row Key": "700-now-1", Period: "Current", "Event Type": "Employee offsites",
      Budget: "9L", Timeline: "Q4", Pax: "80", Contact: [cts[0].id] },
  ]);
  await post("Call Log", [
    { Key: "k1", "Called At": "2026-09-28T11:20:34.648Z", Outcome: "Right POC", Owner: "Enout Super Admin",
      Duration: 120, "Duration Source": "dialed", Contact: [cts[0].id] },
  ]);
  await post("Team", [{ Name: "Enout Super Admin", Role: "BD", "In Funnel": true }]);

  let r = await run("scripts/backfill.mjs", ["--db", DB]);
  ok("the backfill runs", r.code === 0, r.out.slice(-300));
  ok("it reports the rows it copied", /Companies\s+2 read/.test(r.out), r.out.slice(0, 400));

  console.log("\n2. a fresh copy agrees with the base");
  r = await run("scripts/reconcile.mjs", ["--db", DB]);
  ok("reconcile is clean", r.code === 0 && /Every table agrees/.test(r.out), r.out.slice(-500));

  console.log("\n3. the copy is what it says it is");
  const db = new DatabaseSync(DB, { readOnly: true });
  const hema = db.prepare(`SELECT * FROM contacts WHERE kylas_contact_id='700'`).get();
  ok("a contact points at its company",
    db.prepare(`SELECT kylas_company_id k FROM companies WHERE id=?`).get(hema.company_id)?.k === "900");
  ok("a checkbox that was ticked is 1", hema.ever_picked === 1);
  ok("a checkbox never ticked is 0",
    db.prepare(`SELECT service_offering s FROM contacts WHERE kylas_contact_id='700'`).get().s === 0);
  ok("a number nobody filled stays NULL",
    db.prepare(`SELECT kpi_rank k FROM contacts WHERE kylas_contact_id='701'`).get().k === null);
  ok("a select arrived as its name", hema.current_stage === "MQL_MARKETING_QUALIFIED_LEAD");
  ok("a date arrived as ISO", hema.next_call_date === "2026-10-02");
  /* The generated columns are computed by SQLite, not copied from Airtable. */
  ok("a complete event row computes both flags",
    db.prepare(`SELECT has_any_signal s, is_complete c FROM event_rows WHERE row_key='700-now-1'`).get().s === 1);
  ok("a dialed call keeps its seconds",
    db.prepare(`SELECT measured_seconds m FROM call_log WHERE key='k1'`).get().m === 120);
  db.close();

  console.log("\n4. running it again changes nothing");
  const before = new DatabaseSync(DB, { readOnly: true });
  const counts = () => Object.fromEntries(["companies", "contacts", "event_rows", "call_log", "team"]
    .map((t) => [t, before.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
  const c1 = counts(); before.close();
  r = await run("scripts/backfill.mjs", ["--db", DB]);
  const after = new DatabaseSync(DB, { readOnly: true });
  const c2 = Object.fromEntries(Object.keys(c1).map((t) =>
    [t, after.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n])); after.close();
  ok("a second pass inserts nothing new", JSON.stringify(c1) === JSON.stringify(c2), `${JSON.stringify(c1)} vs ${JSON.stringify(c2)}`);
  r = await run("scripts/reconcile.mjs", ["--db", DB]);
  ok("and it still agrees", r.code === 0 && /Every table agrees/.test(r.out));

  console.log("\n5. the reconciler catches what it is for");

  /* A row added to Airtable and not yet copied. */
  await post("Companies", [{ Name: "Initech", "Kylas Company ID": "902", Owner: "Enout Super Admin" }]);
  r = await run("scripts/reconcile.mjs", ["--db", DB, "--only", "Companies"]);
  ok("a row the copy has not seen", r.code === 1 && /not copied yet\s*: 902/.test(r.out), r.out.slice(-300));

  /* A field edited in Airtable after the copy. */
  await run("scripts/backfill.mjs", ["--db", DB, "--only", "Companies"]);
  await patch("Companies", cos[0].id, { Owner: "Somebody Else" });
  r = await run("scripts/reconcile.mjs", ["--db", DB, "--only", "Companies"]);
  ok("a field that changed underneath", r.code === 1 && /disagrees\s*: 900 — Owner/.test(r.out), r.out.slice(-300));

  /* A date-time written the same instant a different way must NOT read as
     drift — the thing that would make a real reconciler cry wolf daily. */
  await run("scripts/backfill.mjs", ["--db", DB, "--only", "Companies"]);
  await patch("Call Log", (await list("Call Log")).records[0].id,
    { "Called At": "2026-09-28T11:20:34.648+00:00" });
  r = await run("scripts/reconcile.mjs", ["--db", DB, "--only", "Call Log"]);
  ok("the same instant written differently is not drift", r.code === 0, r.out.slice(-400));

  /* A row deleted in Airtable that the copy still holds. */
  await del("Companies", cos[1].id);
  r = await run("scripts/reconcile.mjs", ["--db", DB, "--only", "Companies"]);
  ok("a row only the copy still has", r.code === 1 && /only in SQL\s*: 901/.test(r.out), r.out.slice(-300));

  console.log("\n6. it fails loudly rather than reporting a prefix");
  r = await run("scripts/reconcile.mjs", ["--db", "/tmp/claude-0/does-not-exist.sqlite", "--only", "Team"]);
  ok("a missing database is an error, not 'clean'", r.code === 1, r.out.slice(-200));
} finally {
  mock.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
