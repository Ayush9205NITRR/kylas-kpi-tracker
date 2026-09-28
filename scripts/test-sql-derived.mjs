/* THE DERIVED KPI FIELDS, AGAINST HAND-COMPUTED ANSWERS.
 *
 * Every expectation here was worked out from docs/kpi-spec.md by hand, not
 * read back out of the thing being tested. That is the point: a test that
 * asks the views what they say and then asserts they said it proves nothing.
 *
 * The case this file exists for is §5 — a GRANDCHILD changes and the
 * company's number has to move. Airtable recomputes; a stored column would
 * not; a view does. Everything else here is the supporting cast.
 *
 * Run: node scripts/test-sql-derived.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived, VIEW_FOR } from "./sql-derived.mjs";
import { FOLLOWUPS } from "./schema.mjs";
import { columnName } from "./sql-schema.mjs";
import { MILESTONE } from "./stages.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) => ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
db.exec(sqlSchema());
db.exec(sqlDerived());

const run = (sql, ...a) => db.prepare(sql).run(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

/* ── 1. every derived field has somewhere to live ──────────────────── */
console.log("1. no derived field was left behind");
const viewCols = (v) => new Set(db.prepare(`PRAGMA table_info("${v}")`).all().map((c) => c.name));
const have = { v_contacts: viewCols("v_contacts"), v_companies: viewCols("v_companies") };
const childDerived = FOLLOWUPS.filter((f) => f.field && f.field.type !== "multipleRecordLinks"
  && VIEW_FOR[f.table]);
for (const f of childDerived) {
  const view = VIEW_FOR[f.table];
  ok(`${f.table}.${f.field.name} → ${view}.${columnName(f.field.name)}`,
    have[view].has(columnName(f.field.name)), `${view} has no such column`);
}
/* Event Rows and Call Log derive only on their own row, so they have no view
   and must not have been given one by mistake. */
ok("Event Rows and Call Log need no view",
  !VIEW_FOR["Event Rows"] && !VIEW_FOR["Call Log"]);

/* ── fixtures ──────────────────────────────────────────────────────── */
run(`INSERT INTO companies (kylas_company_id, name) VALUES ('900','Acme')`);
run(`INSERT INTO companies (kylas_company_id, name) VALUES ('901','Globex')`);
const coId = (k) => one(`SELECT id FROM companies WHERE kylas_company_id=?`, k).id;
const ctId = (k) => one(`SELECT id FROM contacts WHERE kylas_contact_id=?`, k).id;

/* Hema: one complete event row, two calls (one measured), rank 19 at a known
   instant. Shipra: signal only, no calls. Raj: nothing at all. */
run(`INSERT INTO contacts (kylas_contact_id,name,company_id,kpi_rank,kpi_rank_at,ever_picked)
     VALUES ('700','Hema',?,19,'2026-09-20T10:00:00.000Z',1)`, coId('900'));
run(`INSERT INTO contacts (kylas_contact_id,name,company_id,kpi_rank)
     VALUES ('701','Shipra',?,14)`, coId('900'));
run(`INSERT INTO contacts (kylas_contact_id,name,company_id) VALUES ('702','Raj',?)`, coId('901'));

run(`INSERT INTO event_rows (row_key,contact_id,budget,timeline,pax)
     VALUES ('700-a',?, '9L','Q4','80')`, ctId('700'));
run(`INSERT INTO event_rows (row_key,contact_id,budget) VALUES ('701-a',?,'40L')`, ctId('701'));

run(`INSERT INTO call_log (key,contact_id,called_at,duration,duration_source)
     VALUES ('k1',?,'2026-09-18T09:00:00.000Z',120,'dialed')`, ctId('700'));
run(`INSERT INTO call_log (key,contact_id,called_at,duration,duration_source)
     VALUES ('k2',?,'2026-09-20T09:30:00.000Z',300,'estimated')`, ctId('700'));
run(`INSERT INTO stage_transitions (key,contact_id,changed_at,to_stage)
     VALUES ('s1',?,'2026-09-20T10:00:00.000Z','DISCOVERY_CALL_BOOKED')`, ctId('700'));

const C = (k) => one(`SELECT * FROM v_contacts WHERE kylas_contact_id=?`, k);
const CO = (k) => one(`SELECT * FROM v_companies WHERE kylas_company_id=?`, k);

/* ── 2. contact rollups ────────────────────────────────────────────── */
console.log("\n2. what a contact's children add up to");
is("a complete row sets both flags", `${C('700').has_signal}${C('700').has_complete_row}`, "11");
is("budget alone is signal, not complete", `${C('701').has_signal}${C('701').has_complete_row}`, "10");
is("no event rows at all", `${C('702').has_signal}${C('702').has_complete_row}`, "00");
is("call count counts every call", C('700').call_count, 2);
is("last call is the latest", C('700').last_call_at, '2026-09-20T09:30:00.000Z');
is("first call is the earliest", C('700').first_call_at, '2026-09-18T09:00:00.000Z');
/* An estimated duration counts as zero seconds but still as a call — which is
   why avg is 60 and not 210. */
is("only measured seconds are summed", C('700').talk_seconds, 120);
is("average is over ALL calls", C('700').avg_call_seconds, 60);
is("a contact with no calls has none", C('702').call_count, 0);
is("...and no last call rather than an epoch", C('702').last_call_at, null);
is("...and zero talk seconds, not null", C('702').talk_seconds, 0);
is("the company's kylas id rides along", C('700').company_kylas_id, '900');
is("stage change times roll up", C('700').last_stage_change_at, '2026-09-20T10:00:00.000Z');

console.log("\n3. the names that roll into the company");
is("a qualifying contact contributes its name", C('700').right_poc_name, 'Hema');
is("a complete one contributes to discovery too", C('700').discovery_name, 'Hema');
is("signal only contributes to Right POC", C('701').right_poc_name, 'Shipra');
is("...and blank to discovery", C('701').discovery_name, '');
is("nothing contributes nothing", C('702').right_poc_name, '');

console.log("\n4. the KPI score packs a rank and a moment");
const epochSecs = Math.floor(Date.parse('2026-09-20T10:00:00.000Z') / 1000);
is("score = rank * 1e10 + seconds", C('700').kpi_score, 19 * 10000000000 + epochSecs);
is("no timestamp → just the rank", C('701').kpi_score, 14 * 10000000000);
is("no rank at all → zero", C('702').kpi_score, 0);
is("the stage name comes off the ladder", C('700').kpi_stage, '19 · Discovery Call Booked');
is("rank 14", C('701').kpi_stage, '14 · MQL (Marketing Qualified Lead)');

console.log("\n5. company rollups, over its contacts");
is("best rank of any contact wins", CO('900').kpi_rank, 19);
is("...and the stage matches", CO('900').kpi_stage, '19 · Discovery Call Booked');
is("the moment is read back out of the score",
  CO('900').kpi_stage_at, '2026-09-20T10:00:00Z');
is("calls are summed across contacts", CO('900').call_count, 2);
is("talk seconds too", CO('900').talk_seconds, 120);
is("contacts are counted", CO('900').contact_count, 2);
is("reached, because somebody was called", CO('900').reached, 1);
is("phone picked, because a contact picked up", CO('900').phone_picked, 1);
is("right poc lists every qualifying name", CO('900').right_poc_contacts, 'Hema, Shipra');
is("discovery lists only the complete one", CO('900').discovery_contacts, 'Hema');
is("right poc flag follows the list", CO('900').right_poc, 1);
is("discovery flag follows its list", CO('900').successful_discovery, 1);

console.log("\n6. a company nobody has worked");
is("no calls", CO('901').call_count, 0);
is("not reached", CO('901').reached, 0);
is("no right poc", CO('901').right_poc, 0);
is("rank zero", CO('901').kpi_rank, 0);
is("...and no stage-at rather than 1970", CO('901').kpi_stage_at, null);
is("last call is unknown, not an epoch", CO('901').last_call_at, null);

console.log("\n7. the milestones are floors, and only rise");
is(`booked needs rank >= ${MILESTONE.sqlMeetingBooked.floor}`, CO('900').sql_meeting_booked, 0);
run(`UPDATE contacts SET kpi_rank=? WHERE kylas_contact_id='700'`, MILESTONE.sqlMeetingBooked.floor);
is("at the floor it is booked", CO('900').sql_meeting_booked, 1);
is("...but not done", CO('900').sql_meeting_done, 0);
is("...and not SQL", CO('900').sql, 0);
run(`UPDATE contacts SET kpi_rank=? WHERE kylas_contact_id='700'`, MILESTONE.sql.floor);
is("at SQL, all three are true",
  `${CO('900').sql_meeting_booked}${CO('900').sql_meeting_done}${CO('900').sql}`, "111");
run(`UPDATE contacts SET kpi_rank=19 WHERE kylas_contact_id='700'`);

/* ── THE CASE THIS FILE EXISTS FOR ─────────────────────────────────── */
console.log("\n8. a grandchild changes and the company follows");
is("before: Globex has no signal", CO('901').right_poc, 0);
/* Raj's event row is TWO levels below the company: company → contact → event
   row. Nothing on the company or the contact is written here. A stored
   generated column would still read 0 after this; the view does not. */
run(`INSERT INTO event_rows (row_key,contact_id,budget) VALUES ('702-a',?,'12L')`, ctId('702'));
is("adding an event row makes the company a Right POC", CO('901').right_poc, 1);
is("...and names the contact", CO('901').right_poc_contacts, 'Raj');
is("...without discovery, since only budget is filled", CO('901').successful_discovery, 0);
run(`UPDATE event_rows SET timeline='Q1', pax='40' WHERE row_key='702-a'`);
is("filling the rest makes it a discovery", CO('901').successful_discovery, 1);
run(`DELETE FROM event_rows WHERE row_key='702-a'`);
is("removing it again takes both back", `${CO('901').right_poc}${CO('901').successful_discovery}`, "00");

console.log("\n9. a call two levels down moves the company's totals");
is("Globex has no calls", CO('901').call_count, 0);
run(`INSERT INTO call_log (key,contact_id,called_at,duration,duration_source)
     VALUES ('k3',?,'2026-09-25T09:00:00.000Z',60,'dialed')`, ctId('702'));
is("one call arrives", CO('901').call_count, 1);
is("and its seconds", CO('901').talk_seconds, 60);
is("and the company is now reached", CO('901').reached, 1);

console.log("\n10. a contact with no company does not become one");
run(`INSERT INTO contacts (kylas_contact_id,name) VALUES ('703','Orphan')`);
is("it still appears as a contact", C('703').kylas_contact_id, '703');
is("with no company id", C('703').company_id, null);
is("and no company gained a contact",
  CO('900').contact_count + CO('901').contact_count, 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
