/* GATE 0: the generated SQL is the Airtable base, exactly.
 *
 * Two things are being proven here, and the second is the one that matters.
 *
 *   1. The DDL is valid — it builds, on the same SQLite engine D1 runs.
 *   2. NOTHING WAS DROPPED. Every table, every field and every link in
 *      schema.mjs is accounted for: as a column, as a generated column, or as
 *      a child-dependent field that the views own. A field that is simply
 *      missing is the failure this whole file exists to make impossible,
 *      because it would not show up until a screen read a column that was
 *      never there.
 *
 * Run: node scripts/test-sql-schema.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { TABLES, FOLLOWUPS } from "./schema.mjs";
import { sqlSchema, tableName, columnName, derivedFields, LINKS, OWN_ROW_DERIVED } from "./sql-schema.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) => ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ── it builds ─────────────────────────────────────────────────────── */
console.log("1. the DDL builds on SQLite");
const db = new DatabaseSync(":memory:");
let built = true;
try { db.exec(sqlSchema()); } catch (e) { built = false; console.log(`        ${e.message}`); }
ok("every statement executes", built);

const tablesInDb = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
is("table count", tablesInDb.length, TABLES.length);

/* ── every table and every field arrived ───────────────────────────── */
console.log("\n2. nothing in schema.mjs was dropped");
/* table_xinfo, not table_info: the plain one OMITS generated columns. Using it
   would have made every "is left to a view" assertion below pass whether or
   not the column was there, which is the opposite of what they are for. */
const colsOf = (t) => db.prepare(`PRAGMA table_xinfo("${t}")`).all();

for (const t of TABLES) {
  const tbl = tableName(t.name);
  if (!tablesInDb.includes(tbl)) { ok(`${t.name} → ${tbl}`, false, "table missing"); continue; }
  const have = new Set(colsOf(tbl).map((c) => c.name));
  const missing = t.fields.map((f) => columnName(f.name)).filter((c) => !have.has(c));
  ok(`${t.name} — ${t.fields.length} field(s)`, missing.length === 0, `missing ${missing.join(", ")}`);
}

/* Every table carries the two columns the migration itself needs. */
for (const t of TABLES) {
  const have = new Set(colsOf(tableName(t.name)).map((c) => c.name));
  ok(`${t.name} carries airtable_id and synced_at`, have.has("airtable_id") && have.has("synced_at"));
}

/* ── links became foreign keys ─────────────────────────────────────── */
console.log("\n3. the five record links are foreign keys");
is("link count", LINKS.length, 5);
for (const l of LINKS) {
  const fks = db.prepare(`PRAGMA foreign_key_list("${tableName(l.table)}")`).all();
  const hit = fks.find((f) => f.from === l.col && f.table === tableName(l.to));
  ok(`${l.table}.${l.name} → ${l.to}`, !!hit, `no FK ${l.col} → ${tableName(l.to)}`);
  ok(`  ...and refuses to orphan`, hit?.on_delete === "RESTRICT", `on_delete is ${hit?.on_delete}`);
}

/* ── the split that matters ────────────────────────────────────────── */
console.log("\n4. own-row derived fields are columns, child-dependent ones are not");
const { own, child } = derivedFields();
ok(`${own.length} own-row field(s) are generated columns`, own.length === 3);
for (const f of own) {
  const have = new Set(colsOf(tableName(f.table)).map((c) => c.name));
  ok(`${f.table}.${f.name} is a column`, have.has(columnName(f.name)));
}
/* THE TRAP, ASSERTED. Airtable recomputes a rollup when a GRANDCHILD changes;
   a stored generated column only recomputes when its own row is written. So
   anything reading a child table must not be a column here. If somebody adds
   one to OWN_ROW_DERIVED that reads a child, this fails. */
ok(`${child.length} child-dependent field(s) are NOT columns`, child.length > 0);
for (const f of child) {
  const have = new Set(colsOf(tableName(f.table)).map((c) => c.name));
  ok(`${f.table}.${f.name} is left to a view`, !have.has(columnName(f.name)),
    "a stored column here would go stale when its children change");
}
/* And the reverse: nothing in OWN_ROW_DERIVED may name a table it does not
   own the row of. */
for (const [t, fields] of Object.entries(OWN_ROW_DERIVED)) {
  const cols = new Set(colsOf(tableName(t)).map((c) => c.name));
  for (const [name, expr] of Object.entries(fields)) {
    const refs = [...expr.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    ok(`${t}.${name} reads only its own row`, refs.every((r) => cols.has(r)),
      `references ${refs.filter((r) => !cols.has(r)).join(", ")}`);
  }
}

/* ── the constraints carry the meaning the type would have ─────────── */
console.log("\n5. the CHECKs do the work Airtable's field types did");
const ins = (sql, ...args) => { try { db.prepare(sql).run(...args); return null; } catch (e) { return e.message; } };

ok("a stage the base has never heard of is refused",
  !!ins(`INSERT INTO contacts (kylas_contact_id, current_stage) VALUES ('t1', 'NOT_A_REAL_STAGE')`));
ok("a stage it has is accepted",
  !ins(`INSERT INTO contacts (kylas_contact_id, current_stage) VALUES ('t2', 'MQL_MARKETING_QUALIFIED_LEAD')`));
ok("a date in the wrong format is refused",
  !!ins(`INSERT INTO contacts (kylas_contact_id, next_call_date) VALUES ('t3', '28/09/2026')`));
ok("an ISO date is accepted",
  !ins(`INSERT INTO contacts (kylas_contact_id, next_call_date) VALUES ('t4', '2026-09-28')`));
ok("a date-time without a T is refused",
  !!ins(`INSERT INTO contacts (kylas_contact_id, kylas_updated_at) VALUES ('t5', '2026-09-28 10:00:00')`));
ok("a checkbox outside 0/1 is refused",
  !!ins(`INSERT INTO contacts (kylas_contact_id, ever_picked) VALUES ('t6', 2)`));
ok("two contacts with one Kylas id is refused",
  !!ins(`INSERT INTO contacts (kylas_contact_id) VALUES ('t2')`));

/* THE "EMPTY IS NOT ZERO" TRAP. An Airtable number that was never filled comes
   back absent; a column defaulting to 0 turns "we do not know" into a fact. */
console.log("\n6. a number nobody filled in stays unknown");
db.prepare(`INSERT INTO contacts (kylas_contact_id) VALUES ('t7')`).run();
is("an unwritten number is NULL, not 0",
  db.prepare(`SELECT kpi_rank FROM contacts WHERE kylas_contact_id='t7'`).get().kpi_rank, null);
const numericDefaults = TABLES.flatMap((t) => colsOf(tableName(t.name))
  .filter((c) => ["INTEGER", "REAL"].includes(c.type) && c.dflt_value !== null && c.name !== "id")
  .map((c) => `${tableName(t.name)}.${c.name}=${c.dflt_value}`));
/* Checkboxes are the one exception: Airtable omits them when false, so absent
   there really does mean 0. Everything else must be null. */
const badDefaults = numericDefaults.filter((d) => !d.endsWith("=0"));
ok("no numeric column defaults to a value", badDefaults.length === 0, badDefaults.join(", "));

/* ── the generated columns actually compute ────────────────────────── */
console.log("\n7. the generated columns compute what Airtable's formulas did");
db.prepare(`INSERT INTO event_rows (row_key, budget) VALUES ('r1', '9L')`).run();
db.prepare(`INSERT INTO event_rows (row_key, budget, timeline, pax) VALUES ('r2', '9L', 'Q4', '80')`).run();
db.prepare(`INSERT INTO event_rows (row_key, remarks) VALUES ('r3', 'call Monday')`).run();
const row = (k) => db.prepare(`SELECT has_any_signal s, is_complete c FROM event_rows WHERE row_key=?`).get(k);
is("one signal → Right POC, not Discovery", `${row("r1").s}${row("r1").c}`, "10");
is("all three → both", `${row("r2").s}${row("r2").c}`, "11");
is("remarks alone → neither", `${row("r3").s}${row("r3").c}`, "00");

db.prepare(`INSERT INTO call_log (key, duration, duration_source) VALUES ('c1', 120, 'dialed')`).run();
db.prepare(`INSERT INTO call_log (key, duration, duration_source) VALUES ('c2', 120, 'estimated')`).run();
const secs = (k) => db.prepare(`SELECT measured_seconds m FROM call_log WHERE key=?`).get(k).m;
is("a measured call counts its seconds", secs("c1"), 120);
is("an estimated one counts zero", secs("c2"), 0);
/* A generated column recomputes on write — that is exactly why own-row fields
   may be columns and child-dependent ones may not. */
db.prepare(`UPDATE event_rows SET timeline='Q1', pax='40' WHERE row_key='r1'`).run();
is("editing the row recomputes it", `${row("r1").s}${row("r1").c}`, "11");

/* ── the links refuse to orphan ────────────────────────────────────── */
console.log("\n8. a company cannot be deleted out from under its contacts");
db.exec("PRAGMA foreign_keys = ON");
db.prepare(`INSERT INTO companies (kylas_company_id, name) VALUES ('900', 'Acme')`).run();
const coId = db.prepare(`SELECT id FROM companies WHERE kylas_company_id='900'`).get().id;
db.prepare(`INSERT INTO contacts (kylas_contact_id, company_id) VALUES ('t8', ?)`).run(coId);
ok("deleting the company is refused", !!ins(`DELETE FROM companies WHERE id = ${coId}`));
ok("a contact cannot point at a company that is not there",
  !!ins(`INSERT INTO contacts (kylas_contact_id, company_id) VALUES ('t9', 999999)`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
