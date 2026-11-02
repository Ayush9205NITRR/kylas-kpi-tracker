#!/usr/bin/env node
/* parity-live.mjs catches what it exists to catch.
 *
 *   node scripts/test-parity-live.mjs
 *
 * "Airtable" here is one database behind the Airtable-shaped engine and
 * "Cloudflare" a copy of it. Identical copies must read 0 differences; one
 * changed value, one missing row and one changed KPI must each be named.
 */
import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { createAirtable } from "./airtable.mjs";
import { run } from "./parity-live.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : ` — ${x}`}`); };
const fa = join(tmpdir(), `pl-a-${process.pid}.sqlite`), fb = join(tmpdir(), `pl-b-${process.pid}.sqlite`);
rmSync(fa, { force: true }); rmSync(fb, { force: true });
const dbA = fakeD1(fa);
await dbA.exec(sqlSchema({ looseSelects: true })); await dbA.exec(sqlDerived());
const A = createAirtable("x", "appKPI", { d1: dbA, log: () => {} });
const co = await A.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "1", Name: "One", Owner: "Sejal" });
const co2 = await A.upsert("Companies", "Kylas Company ID", { "Kylas Company ID": "2", Name: "Two", Owner: "Mayra" });
const ct = await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "10", Name: "Neha", Company: [co.id], "KPI Rank": 26, "KPI Rank At": "2026-10-01T00:00:00Z" });
await A.upsert("Contacts", "Kylas Contact ID", { "Kylas Contact ID": "11", Name: "Ola", Company: [co2.id] });
await A.upsert("Event Rows", "Row Key", { "Row Key": "10-a", Contact: [ct.id], Budget: "5L", Timeline: "Q4", Pax: "40" });
await A.create("Call Log", [{ Key: "k1", Contact: [ct.id], "Called At": "2026-10-02T10:00:00Z" }]);
copyFileSync(fa, fb);
const dbB = fakeD1(fb);
const B = createAirtable("x", "appKPI", { d1: dbB, log: () => {} });
const quiet = { log: () => {}, airtable: A, d1: dbB };

const same = await run(quiet);
ok("two identical stores read 0 differences", same.ok, JSON.stringify(same.tables.filter((t) => t.differ || t.onlyAirtable || t.onlyCloudflare)));
ok("…computed fields included (Companies carry KPI Rank, SQL)", same.kpi.airtable.All.SQL === 1 && same.kpi.cloudflare.All.SQL === 1);

await dbB.exec(`UPDATE contacts SET designation = 'CEO' WHERE kylas_contact_id = '11'`);
await dbB.exec(`DELETE FROM call_log WHERE key = 'k1'`);
await dbB.exec(`UPDATE contacts SET kpi_rank = 9 WHERE kylas_contact_id = '10'`);
const diff = await run(quiet);
const t = (n) => diff.tables.find((x) => x.table === n);
ok("a changed stored value is named, with the field", t("Contacts").fields.Designation === 1);
ok("a row missing on Cloudflare is counted", t("Call Log").onlyAirtable === 1);
ok("a computed field that moved because of it is named too", (t("Contacts").fields["Call Count"] || 0) === 1 && (t("Companies").fields["KPI Rank"] || 0) === 1);
ok("the dashboard totals show the owner whose numbers differ", diff.kpiDiffers.includes("Sejal") && diff.kpiDiffers.includes("All") && !diff.kpiDiffers.includes("Mayra"));
ok("and the verdict is not 0", !diff.ok);

const cutIso = new Date(Date.now() - 1000).toISOString();
const after = await run({ ...quiet, cut: cutIso, tables: ["Contacts"] });
ok("with --cut, rows Cloudflare changed after the switch are expected, not differences", after.tables[0].differ === 0 && after.tables[0].changedAfterCut >= 2);

rmSync(fa, { force: true }); rmSync(fb, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
