#!/usr/bin/env node
/* The way back (d1-to-airtable.mjs), proven before the way forward is taken.
 *
 *   node scripts/test-d1-rollback.mjs
 *
 * "Airtable" here is a second database behind the same Airtable-shaped engine
 * the parity suites check against the mock — so this tests the copy-back's
 * own logic: what it picks, the order, and links between rows born in D1.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { createAirtable } from "./airtable.mjs";
import { run } from "./d1-to-airtable.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : ` — ${x}`}`); };
const fresh = async () => { const db = fakeD1(); await db.exec(sqlSchema({ looseSelects: true })); await db.exec(sqlDerived()); return db; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const d1 = await fresh(), atDb = await fresh();
const D = createAirtable("x", "appKPI", { d1, log: () => {} });
const A = createAirtable("x", "appKPI", { d1: atDb, log: () => {} });

/* Before the cut: the same company in both (it came over in the copy). */
const oldCo = await A.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "1", Name: "Old Co" });
await d1.exec(`INSERT INTO companies (airtable_id, kylas_company_id, name, synced_at) VALUES ('${oldCo.id}', '1', 'Old Co', '2026-11-01T00:00:00.000Z')`);
await sleep(5);
const cut = new Date().toISOString();
await sleep(5);

/* After the cut, D1 only: a new company, a new contact linked to it, a contact
   on the old company, an event row and a call on the new contact. */
const nco = await D.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "2", Name: "New Co" });
const nct = await D.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "20", Name: "Neha", Company: [nco.id], "KPI Rank": 9 });
await D.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "10", Name: "Ola", Company: [oldCo.id] });
await D.upsert("Event Rows", "Row Key", { "Row Key": "20-a", Contact: [nct.id], Budget: "5L" });
await D.create("Call Log", [{ Key: "k1", Contact: [nct.id], "Called At": "2026-11-04T10:00:00Z", Outcome: "Right POC" }]);

const dry = await run({ since: cut, d1, airtable: A, log: () => {} });
ok("a dry run counts what changed since the cut", dry.total === 5, JSON.stringify(dry.report.filter((r) => r.changed)));
ok("…and writes nothing", (await A.listAll("Contacts")).length === 0);

await run({ since: cut, d1, airtable: A, apply: true, log: () => {} });
const co2 = await A.find("Companies", "{Kylas Company ID} = '2'");
const neha = await A.find("Contacts", "{Kylas Contact ID} = '20'");
const ola = await A.find("Contacts", "{Kylas Contact ID} = '10'");
ok("a company born in D1 is created in Airtable", !!co2);
ok("a contact born in D1 is linked to the AIRTABLE id of its new company", neha?.fields.Company?.[0] === co2?.id, JSON.stringify(neha?.fields.Company));
ok("a contact on a company that was copied over links to the original record", ola?.fields.Company?.[0] === oldCo.id);
ok("the event row follows its contact", (await A.find("Event Rows", "{Row Key} = '20-a'"))?.fields.Contact?.[0] === neha?.id);
ok("Airtable recomputes the rollups from what came back", neha?.fields["Call Count"] === 1 && neha?.fields["Is Right POC"] === 1);
ok("the unchanged company was not rewritten", (await A.find("Companies", "{Kylas Company ID} = '1'"))?.fields.Name === "Old Co");

await run({ since: cut, d1, airtable: A, apply: true, log: () => {} });
ok("running it twice makes no second copy",
  (await A.listAll("Contacts")).length === 2 && (await A.listAll("Call Log")).length === 1 && (await A.listAll("Companies")).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
