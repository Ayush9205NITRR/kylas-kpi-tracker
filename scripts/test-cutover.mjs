#!/usr/bin/env node
/* The switch, end to end, on two databases: "Airtable" (the Airtable-shaped
 * engine over one) and "Cloudflare" (an empty D1).
 *
 *   node scripts/test-cutover.mjs
 *
 * --check on an empty D1 must copy everything and read READY; --after must
 * bring the last-minute Airtable saves across WITHOUT overwriting a contact
 * that was saved again on Cloudflare after the cut.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { createAirtable } from "./airtable.mjs";
import { run } from "./cutover.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : ` — ${x}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

const atDb = fakeD1();
await atDb.exec(sqlSchema({ looseSelects: true })); await atDb.exec(sqlDerived());
const A = createAirtable("x", "appKPI", { d1: atDb, log: quiet });          /* stands in for Airtable */
const co = await A.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "1", Name: "One", Owner: "Sejal" });
const c1 = await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "10", Name: "Neha", Company: [co.id], "KPI Rank": 9, "KPI Rank At": "2026-10-01T00:00:00Z" });
await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "11", Name: "Ola", Company: [co.id] });
await A.upsert("Event Rows", "Row Key", { "Row Key": "10-a", Contact: [c1.id], Budget: "5L" });
await A.create("Call Log", [{ Key: "k1", Contact: [c1.id], "Called At": "2026-10-02T10:00:00Z" }]);

const cf = fakeD1();                                                       /* an empty Cloudflare D1 */
const check = await run({ log: quiet, d1: cf, airtable: A });
ok("--check on an empty D1 copies everything and reads READY", check.ok, JSON.stringify(check.parity.tables.filter((t) => t.differ || t.onlyAirtable)));
ok("…every table, row for row", check.parity.tables.find((t) => t.table === "Contacts").cloudflare === 2);

/* The last minute: a save lands in Airtable just before the deploy… */
await sleep(20);
await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "10", Designation: "CFO (Airtable, before the cut)" });
await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "11", Designation: "Head HR" });
await sleep(20);
const cut = new Date().toISOString();
await sleep(20);
/* …and the same contact is saved again on Cloudflare after it, plus a new one. */
const C = createAirtable("x", "appKPI", { d1: cf, log: quiet });
await C.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "10", Designation: "CEO (Cloudflare, after the cut)" });
await C.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "12", Name: "New", Company: [co.id] });

const after = await run({ log: quiet, d1: cf, airtable: A, after: true, cut });
const neha = await C.find("Contacts", "{Kylas Contact ID} = '10'");
const ola = await C.find("Contacts", "{Kylas Contact ID} = '11'");
ok("the save Cloudflare made after the cut is NOT overwritten by Airtable's older one", neha.fields.Designation === "CEO (Cloudflare, after the cut)", neha.fields.Designation);
ok("the last-minute Airtable save to another contact IS brought across", ola.fields.Designation === "Head HR", ola.fields.Designation);
ok("the contact born on Cloudflare after the cut is still there", !!(await C.find("Contacts", "{Kylas Contact ID} = '12'")));
ok("--after reads SWITCHED: rows written after the cut are expected, not differences", after.ok, JSON.stringify(after.parity.tables.filter((t) => t.differ || t.onlyAirtable || t.onlyCloudflare).map((t) => [t.table, t.fields, t.onlyCloudflare])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
