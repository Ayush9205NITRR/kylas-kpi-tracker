/* GATE 2: the shadow keeps up, and cannot hurt anything.
 *
 * Runs the real sync against the mock Airtable and a real SQLite standing in
 * for D1, then checks the three properties the design rests on:
 *
 *   it catches up          — a row written to Airtable appears in the copy
 *   it is idempotent       — running it again does not duplicate anything
 *   it cannot be turned on by accident — no binding, no shadow, no effect
 *
 * Run: node scripts/test-shadow.mjs
 */
import { spawn } from "node:child_process";
import { fakeD1 } from "./d1-fake.mjs";
import { createAirtable } from "./airtable.mjs";
import { createShadow, splitStatements } from "./shadow.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";

const PORT = 9932, BASE_URL = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) => ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: "Bearer pat_mock", "Content-Type": "application/json" };
async function call(method, path, body) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE_URL}/v0/appMOCK/${path}`,
      { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
    const t = await r.text();
    if (r.ok) return t ? JSON.parse(t) : null;
    if (/RATE_LIMIT_REACHED/.test(t)) { await sleep(400); continue; }
    throw new Error(`${method} ${path}: ${t.slice(0, 160)}`);
  }
  throw new Error("still rate limited");
}
const post = async (t, rows) => (await call("POST", encodeURIComponent(t),
  { records: rows.map((fields) => ({ fields })) })).records;
const patch = (t, id, fields) => call("PATCH", encodeURIComponent(t), { records: [{ id, fields }] });

/* ── the splitter, before anything depends on it ───────────────────── */
console.log("1. the schema splits into statements D1 can take");
const stmts = splitStatements(sqlSchema() + "\n" + sqlDerived());
ok("every statement is non-empty", stmts.every((s) => s.length > 0));
ok("none carries a stray semicolon", stmts.every((s) => !s.includes(";")));
ok("the tables and both views are all there",
  stmts.filter((s) => /^CREATE TABLE/.test(s)).length === 13 &&
  stmts.filter((s) => /^CREATE VIEW/.test(s)).length === 2,
  `${stmts.filter((s) => /^CREATE TABLE/.test(s)).length} tables, ${stmts.filter((s) => /^CREATE VIEW/.test(s)).length} views`);

console.log("\n2. no binding, no shadow");
is("without a database it is null", createShadow({ db: null, at: {} }), null);
is("without an Airtable client it is null", createShadow({ db: {}, at: null }), null);

const mock = spawn(process.execPath, ["scripts/mock-airtable.mjs"],
  { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
await sleep(1200);

try {
  const at = createAirtable("pat_mock", "appMOCK", { log: () => {}, apiUrl: BASE_URL });
  const db = fakeD1();
  const shadow = createShadow({ db, at, log: () => {} });
  ok("with both, it exists", !!shadow);

  const cos = await post("Companies", [{ Name: "Acme", "Kylas Company ID": "900", Owner: "Enout Super Admin" }]);
  const cts = await post("Contacts", [{ Name: "Hema", "Kylas Contact ID": "700",
    Company: [cos[0].id], "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD", "KPI Rank": 14 }]);
  await post("Event Rows", [{ "Row Key": "700-a", Contact: [cts[0].id],
    Budget: "9L", Timeline: "Q4", Pax: "80" }]);

  console.log("\n3. a first pass copies a table whole");
  const n = async (t) => (await db.prepare(`SELECT COUNT(*) n FROM "${t}"`).first()).n;
  /* One table per tick, parent-first, so it takes a few laps to catch up —
     which is the behaviour, not a limitation to work around. */
  for (let i = 0; i < 16; i++) await shadow.tick();
  is("companies arrived", await n("companies"), 1);
  is("contacts arrived", await n("contacts"), 1);
  is("event rows arrived", await n("event_rows"), 1);

  const contact = await db.prepare(`SELECT * FROM contacts WHERE kylas_contact_id='700'`).first();
  const company = await db.prepare(`SELECT id FROM companies WHERE kylas_company_id='900'`).first();
  is("the contact points at its company", contact.company_id, company.id);

  console.log("\n4. the views read through the copy");
  const co = await db.prepare(`SELECT * FROM v_companies WHERE kylas_company_id='900'`).first();
  is("the company is a Right POC", co.right_poc, 1);
  is("...and a discovery", co.successful_discovery, 1);
  is("...named after its contact", co.right_poc_contacts, 'Hema');
  is("...at the contact's rank", co.kpi_rank, 14);

  console.log("\n5. it picks up a change without being told");
  await patch("Contacts", cts[0].id, { "KPI Rank": 19 });
  /* The watermark is set two minutes back on purpose, so a row modified a
     moment ago is inside the window. */
  for (let i = 0; i < 16; i++) await shadow.tick();
  is("the new rank is in the copy",
    (await db.prepare(`SELECT kpi_rank k FROM contacts WHERE kylas_contact_id='700'`).first()).k, 19);
  is("...and the company followed it",
    (await db.prepare(`SELECT kpi_rank k FROM v_companies WHERE kylas_company_id='900'`).first()).k, 19);

  console.log("\n6. running it again duplicates nothing");
  const before = [await n("companies"), await n("contacts"), await n("event_rows")];
  for (let i = 0; i < 16; i++) await shadow.tick();
  const after = [await n("companies"), await n("contacts"), await n("event_rows")];
  is("the counts do not move", after.join(","), before.join(","));

  console.log("\n7. it says where it has got to");
  const st = await shadow.status();
  ok("every table has a watermark", st.tables.length >= 3, `${st.tables.length} recorded`);
  ok("and no table reports an error", st.tables.every((t) => !t.last_error),
    st.tables.filter((t) => t.last_error).map((t) => `${t.tbl}: ${t.last_error}`).join("; "));
  is("the counts are reported", st.counts.Contacts, 1);

  console.log("\n8. a table that cannot be written does not stop the rest");
  /* Airtable has rows for it and the SQL side has nowhere to put them — the
     shape of "somebody added a table to the base". The pass must record the
     failure against that table and let the next tick carry on with another,
     rather than throwing out of the cron. */
  await post("No Such Table", [{ Name: "surprise" }]);
  const out = await shadow.tick({ tables: ["No Such Table"] });
  ok("the failure is reported, not thrown", !!out[0]?.error, JSON.stringify(out[0]));
  const st2 = await shadow.status();
  ok("...and recorded against that table",
    st2.tables.some((t) => t.tbl === "No Such Table" && t.last_error),
    JSON.stringify(st2.tables.find((t) => t.tbl === "No Such Table")));
  const after2 = await shadow.tick();
  ok("the next pass still runs", !after2[0]?.error, JSON.stringify(after2[0]));
  is("and the copy is untouched by it", await n("contacts"), 1);
} finally {
  mock.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
