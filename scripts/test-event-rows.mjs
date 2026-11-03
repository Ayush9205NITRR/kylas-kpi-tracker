#!/usr/bin/env node
/* A contact's event rows on a base WITHOUT the "(from Contact)" lookup — the
 * live base. Until 1.81.2 that read was refused and the card came back empty.
 *
 *   node scripts/test-event-rows.mjs
 */
import { eventRowsOf, readContact } from "./airtable.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${String(d).slice(0, 200)}`}`); };

const ROWS = [
  { id: "ev1", fields: { "Row Key": "k1", Period: "Current", "Event Type": "Offsite", Budget: "8L", Pax: "120", Contact: ["recC"] } },
  { id: "ev2", fields: { "Row Key": "k2", Period: "Past", "Event Type": "Townhall", Timeline: "Dec", Contact: ["recC"] } },
  { id: "ev3", fields: { "Row Key": "k3", Period: "Current", "Event Type": "Offsite", Contact: ["recOther"] } },
];
const CONTACT = { id: "recC", fields: { "Kylas Contact ID": "555", Name: "Muskan's POC", "Event Rows": ["ev1", "ev2"] } };
const asked = [];
/* Answers like the live base: the lookup field does not exist. */
const at = {
  async list(table, formula) {
    asked.push(formula);
    if (/\(from Contact\)/.test(formula)) throw new Error('422 INVALID_FILTER_BY_FORMULA: Unknown field names: kylas contact id (from contact)');
    const ids = [...formula.matchAll(/RECORD_ID\(\) = '([^']+)'/g)].map((m) => m[1]);
    return ROWS.filter((r) => ids.includes(r.id));
  },
  async find(table, formula) { return table === "Contacts" && /'555'/.test(formula) ? CONTACT : null; },
  async listAll() { return [{ id: "recCo", fields: { "Kylas Company ID": "9", Name: "getflits" } }]; },
};

const rows = await eventRowsOf(at, CONTACT);
ok("both of the contact's rows come back, by their ids", rows.map((r) => r.id).sort().join() === "ev1,ev2", JSON.stringify(rows));
ok("the missing lookup is never asked", !asked.some((f) => /\(from Contact\)/.test(f)), asked.join(" | "));
ok("another contact's row is not included", !rows.some((r) => r.id === "ev3"));
ok("a contact with no rows asks nothing", (await eventRowsOf(at, { id: "x", fields: { "Event Rows": [] } })).length === 0);

const card = await readContact(at, "555");
const evs = [...(card?.current || []), ...(card?.past || [])];
ok("the contact card carries Muskan's rows (budget, pax, timeline)",
   evs.some((e) => e.budget === "8L" && e.pax === "120") && evs.some((e) => e.timeline === "Dec"), JSON.stringify(card).slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
