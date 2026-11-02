#!/usr/bin/env node
/* The Airtable client, pointed at D1 — does it behave like Airtable?
 *
 *   node scripts/test-airtable-d1.mjs
 *
 * Drives createAirtable({ d1 }) through the calls the console actually makes
 * and checks the replies have Airtable's shape and Airtable's numbers.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { createAirtable, listTolerant, upsertTolerant } from "./airtable.mjs";
import { formulaToSql, airtableOverD1 } from "./airtable-d1.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : ` — ${extra}`}`); };
const is = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = async (name, fn, re) => { try { await fn(); ok(name, false, "did not throw"); } catch (e) { ok(name, re.test(e.message), e.message.slice(0, 160)); } };

const db = fakeD1();
await db.exec(sqlSchema({ looseSelects: true }));
await db.exec(sqlDerived());
const at = createAirtable("pat_x", "appKPI", { d1: db, log: () => {} });

console.log("\n1. writes come back as Airtable records");
is("the client says which store it is", at.store, "d1");
const co = await at.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "900", Name: "Curebay" });
ok("a new record has a rec… id", /^rec[0-9A-Za-z]{14}$/.test(co.id), co.id);
ok("createdTime is an ISO instant", /^\d{4}-\d\d-\d\dT.*Z$/.test(co.createdTime), co.createdTime);
const co2 = await at.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "900", Owner: "Muskan" });
is("an upsert on the same key updates the same record", co2.id, co.id);
is("…and keeps the fields it was not sent", co2.fields.Name, "Curebay");
const ct = await at.upsert("Contacts", "Kylas Contact ID", {
  "Kylas Contact ID": "700", Name: "Anshika", Company: [co.id], "KPI Rank": "19",
  "KPI Rank At": "2026-10-22T10:00:00Z", "Next Call Date": "2026-11-05T09:30:00+05:30",
  "Current Stage": "A_STAGE_KYLAS_ADDED_LAST_WEEK", "Ever Picked": true,
  "First Picked At": "2026-10-22T10:00:00.000Z" });
is("a link comes back as [rec id]", ct.fields.Company, [co.id]);
is("typecast: \"19\" is the number 19", ct.fields["KPI Rank"], 19);
is("a date-time is normalised to Airtable's form", ct.fields["KPI Rank At"], "2026-10-22T10:00:00.000Z");
is("a date-time sent to a date field keeps the day", ct.fields["Next Call Date"], "2026-11-05");
is("a select option the schema never listed is accepted, as typecast does", ct.fields["Current Stage"], "A_STAGE_KYLAS_ADDED_LAST_WEEK");
is("a ticked box reads true", ct.fields["Ever Picked"], true);
ok("an unticked box is absent, not false", !("Flagged" in ct.fields));
ok("a blank field is absent", !("Email" in ct.fields));
is("the rollup across the link is there", ct.fields["Company Kylas ID"], "900");

console.log("\n2. the computed fields are Airtable's");
await at.upsertMany("Event Rows", "Row Key", [
  { "Row Key": "700-a", Contact: [ct.id], Budget: "8L", Timeline: "Q4", Pax: "80" },
  { "Row Key": "700-b", Contact: [ct.id], Budget: "40L", "Removed At": "2026-10-23T10:00:00Z" },
]);
await at.create("Call Log", [
  { Key: "c1", Contact: [ct.id], "Called At": "2026-10-22T10:00:00Z", Duration: 120, "Duration Source": "dialed" },
  { Key: "c2", Contact: [ct.id], "Called At": "2026-10-23T10:00:00Z", Duration: 60, "Duration Source": "estimated" },
]);
const c = await at.find("Contacts", "{Kylas Contact ID} = '700'");
is("Call Count", c.fields["Call Count"], 2);
is("Talk Seconds counts only measured time", c.fields["Talk Seconds"], 120);
is("Last Call At", c.fields["Last Call At"], "2026-10-23T10:00:00.000Z");
is("Is Discovery (one complete row)", c.fields["Is Discovery"], 1);
const removed = await at.find("Event Rows", "{Row Key} = '700-b'");
is("a removed row has no signal (IF({Removed At}, 0, …))", removed.fields["Has Any Signal"], 0);
const cmp = await at.find("Companies", "{Kylas Company ID} = '900'");
is("company Right POC", cmp.fields["Right POC"], 1);
is("company KPI Rank comes up from the contact", cmp.fields["KPI Rank"], 19);
is("company Phone Picked reads First Picked At", cmp.fields["Phone Picked"], 1);
is("company Reached", cmp.fields.Reached, 1);
is("Right POC Contacts", cmp.fields["Right POC Contacts"], "Anshika");

/* Ever Right POC holds the rung after the row that earned it is gone. */
const c2 = await at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "701", Name: "Raj", Company: [co.id], "Ever Right POC": true });
is("Ever Right POC alone makes a Right POC", c2.fields["Is Right POC"], 1);
const cmp2 = await at.find("Companies", "{Kylas Company ID} = '900'");
is("…and the company lists both", cmp2.fields["Right POC Contacts"], "Anshika, Raj");
const lonely = await at.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "901", Name: "Ghost" });
await at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "702", Name: "Old", Company: [lonely.id], "KPI Rank": 9, "KPI Rank At": "2026-03-01T00:00:00Z" });
const ghost = await at.find("Companies", "{Kylas Company ID} = '901'");
is("a stage with no call log still reads Reached", ghost.fields.Reached, 1);
ok("…and no Last Call At", !("Last Call At" in ghost.fields));

console.log("\n3. the formulas the code sends");
const n = async (t, f) => (await at.listAll(t, { formula: f })).length;
is("{F} = 'x'", await n("Contacts", "{Kylas Contact ID} = '701'"), 1);
is("a quoted value with an escaped quote", await n("Companies", "{Name} = 'O\\'Brien'"), 0);
is("OR of keys", await n("Contacts", "OR({Kylas Contact ID} = '700', {Kylas Contact ID} = '702')"), 2);
is("the Event Rows lookup", await n("Event Rows", "{Kylas Contact ID (from Contact)} = '700'"), 2);
is("NOT({F} = '') is 'is filled'", await n("Contacts", "NOT({Ever Right POC} = '')"), 1);
is("IS_AFTER on a date-time", await n("Call Log", "IS_AFTER({Called At}, '2026-10-22T12:00:00.000Z')"), 1);
is("IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE(…))", await n("Contacts", "IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('2000-01-01T00:00:00Z'))"), 3);
is("IF({KPI Rank} >= n, 1, 0) on a computed rank", await n("Companies", "IF({KPI Rank} >= 10, 1, 0)"), 1);
is("{Company Kylas ID} = '900' (the rollup)", await n("Contacts", "{Company Kylas ID} = '900'"), 2);
is("a number field compared to a quoted number", await n("Contacts", "{KPI Rank} = '19'"), 1);
is("an empty-string test matches the blank ones", await n("Contacts", "{Email} = ''"), 3);
const big = `OR(${Array.from({ length: 250 }, (_, i) => `{Key} = 'k${i}'`).join(", ")})`;
is("an OR of 250 keys (D1 allows 100 parameters — literals are inlined)", await n("Call Log", big), 0);
await throws("an unknown field is Airtable's 422", () => at.listAll("Contacts", { formula: "{Nope} = 'x'" }), /422.*INVALID_FILTER_BY_FORMULA.*nope/);
await throws("an unsupported function says so, never matches nothing", () => at.listAll("Contacts", { formula: "FIND('a', {Name})" }), /FIND\(\) is not supported/);
is("a quote in a value stays inside the value (no SQL injection)",
  await n("Contacts", "{Name} = 'x\\' ; DROP TABLE contacts; --'"), 0);
is("…and the table is still there", await n("Contacts", ""), 3);
ok("the translator inlines the quote doubled",
  formulaToSql(airtableOverD1(db).model("Contacts"), "{Name} = 'a\\'b'").includes("'a''b'"));

console.log("\n4. projection, sort, paging");
const proj = await at.listAll("Contacts", { fields: ["Name"] });
ok("fields[] returns only those fields", proj.every((r) => Object.keys(r.fields).every((k) => k === "Name")));
await throws("an unknown projected field is UNKNOWN_FIELD_NAME", () => at.listAll("Contacts", { fields: ["Nope"] }), /UNKNOWN_FIELD_NAME/);
const tol = await listTolerant(at, "Contacts", { fields: ["Name", "Nope"] });
is("listTolerant drops the unknown field and carries on", tol.length, 3);
const sorted = await at.listAll("Contacts", { sort: [{ field: "Name", direction: "desc" }] });
is("sort desc", sorted.map((r) => r.fields.Name), ["Raj", "Old", "Anshika"]);
const byRank = await at.listAll("Contacts", { sort: [{ field: "KPI Rank", direction: "asc" }] });
is("blank sorts first ascending, as on Airtable", byRank.map((r) => r.fields.Name), ["Raj", "Old", "Anshika"]);
await at.create("Call Log", Array.from({ length: 230 }, (_, i) => ({ Key: `p${i}`, "Called At": "2026-10-01T00:00:00Z" })));
is("listAll follows the offset across pages", (await at.listAll("Call Log", { pageSize: 100 })).length, 232);
is("list() is one page, as on Airtable (maxRecords 150 → 100)", (await at.list("Call Log", "", 150)).length, 100);
is("maxRecords below a page caps it", (await at.list("Call Log", "", 7)).length, 7);
let threw = null;
try { await at.listAll("Call Log", { pageSize: 100, maxPages: 2, throwIfMore: true }); } catch (e) { threw = e; }
ok("throwIfMore still fires past maxPages", threw?.status === 503);

console.log("\n5. errors the tolerant wrappers rely on");
await throws("writing an unknown field", () => at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "700", Bogus: 1 }), /UNKNOWN_FIELD_NAME.*Bogus/);
const t2 = await upsertTolerant(at, "Contacts", "Kylas Contact ID", { "Kylas Contact ID": "700", Bogus: 1, Designation: "CFO" });
is("upsertTolerant drops it and saves the rest", [t2.dropped, t2.rec.fields.Designation], [["Bogus"], "CFO"]);
await throws("writing a computed field", () => at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "700", "Call Count": 4 }), /computed/);
await throws("linking a record that does not exist", () => at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "700", Company: ["recDOESNOTEXIST1"] }), /ROW_DOES_NOT_EXIST/);
await throws("an unknown table", () => at.listAll("No Such Table"), /404/);

console.log("\n6. update by id, delete, metadata");
const patched = await at.call("PATCH", `/${encodeURIComponent("Contacts")}`, { records: [{ id: ct.id, fields: { Designation: "CEO" } }] });
is("PATCH by record id (the migrations)", patched.records[0].fields.Designation, "CEO");
const one = await at.call("GET", `/Contacts/${ct.id}`);
is("GET one record by id", one.fields.Name, "Anshika");
await at.remove("Companies", [lonely.id]);
const orphan = await at.find("Contacts", "{Kylas Contact ID} = '702'");
ok("deleting a parent unlinks its children, as Airtable does", orphan && !orphan.fields.Company);
ok("upserting twice in one request with one new key makes one row", await (async () => {
  const r = await at.upsertMany("Focus", "Kylas Company ID", [{ "Kylas Company ID": "55", Owner: "A" }, { "Kylas Company ID": "55", Owner: "B" }]);
  return r.length === 2 && r[0].id === r[1].id && r[1].fields.Owner === "B" && (await n("Focus", "{Kylas Company ID} = '55'")) === 1;
})());

console.log("\n7. cost");
const q0 = db.queries();
await at.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "700", Remarks: "x" });
const used = db.queries() - q0;
ok(`one upsert is a handful of D1 queries (${used})`, used <= 4);
const q1 = db.queries();
await at.listAll("Contacts", { formula: "{Kylas Contact ID} = '700'" });
is("one read is one query", db.queries() - q1, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
