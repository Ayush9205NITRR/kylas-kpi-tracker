#!/usr/bin/env node
/* Every field the dashboard asks Airtable for must exist on the table.
 *
 *   node scripts/test-kpi-fields.mjs
 *
 * Airtable rejects a `fields[]` entry it does not recognise — the whole read,
 * not just that field. KPI_FIELDS carried "Owner", which is not on Companies
 * (a company's owner lives in Kylas), so every KPI read failed and the console
 * quietly fell back to computing them in the browser. One wrong string.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";
import { KPI_FIELDS } from "./airtable.mjs";

const on = (table) => new Set([
  ...TABLES.find((t) => t.name === table).fields.map((f) => f.name),
  ...FOLLOWUPS.filter((s) => s.table === table).map((s) => s.field.name),
  /* the reverse half of any link pointing at this table */
  ...FOLLOWUPS.filter((s) => s.field.options?.linkedTable === table && s.reverse).map((s) => s.reverse),
]);

const companies = on("Companies");
const missing = KPI_FIELDS.filter((f) => !companies.has(f));

if (missing.length) {
  console.log(`FAIL — asked Airtable for ${missing.length} field(s) not on Companies:`);
  missing.forEach((f) => console.log(`  ${f}`));
  console.log(`\nAirtable fails the whole read for one unknown name, so this would`);
  console.log(`show as "Airtable unavailable" with no other clue.`);
  process.exit(1);
}
console.log(`${KPI_FIELDS.length} KPI field(s) all exist on Companies.`);
