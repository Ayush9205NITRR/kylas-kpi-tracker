#!/usr/bin/env node
/* The accounts list's Last call: the newest of every call kept.
 *   node scripts/test-last-call.mjs
 */
import { lastCallsByCompany, withLastCall } from "./last-call.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${d}`}`); };

const prog = {
  byCompany: new Map([
    ["100", { lastCallAt: null, dialLastAt: "2026-09-25T10:00:00Z" }],      /* only a 40-day-old dialler call */
    ["200", { lastCallAt: "2026-11-02T09:00:00Z", dialLastAt: "2026-10-01T09:00:00Z" }],
  ]),
  dialByContact: new Map([["555", "2026-10-30T12:00:00Z"]]),             /* a contact the base no longer holds */
};
const index = { contacts: { 555: ["300", "CNC_COULD_NOT_CONNECT"] } };
const calls = lastCallsByCompany(prog, index);

const zydus = withLastCall({ id: "100", lastCalledAt: "2026-07-13" }, calls);
ok("a 40-day-old Kylas call beats the stale Kylas field (the Zydus case)", zydus.lastCalledAt === "2026-09-25T10:00:00Z" && zydus.lastCallSource === "dialler", JSON.stringify(zydus));
ok("the console's own call wins when it is newest", withLastCall({ id: "200" }, calls).lastCallSource === "console");
const pruned = withLastCall({ id: "300", lastCalledAt: "2026-08-01" }, calls);
ok("a call to a contact no longer in Airtable still dates its company (contact index)", pruned.lastCalledAt === "2026-10-30T12:00:00Z", JSON.stringify(pruned));
ok("the Kylas field is used when it is the only thing known", withLastCall({ id: "400", lastCalledAt: "2026-08-01" }, calls).lastCallSource === "kylas");
ok("no calls anywhere reads Never (null)", withLastCall({ id: "500" }, calls).lastCalledAt === null);
ok("a newer Kylas field is not overridden by an older call", withLastCall({ id: "100", lastCalledAt: "2026-10-31" }, calls).lastCalledAt === "2026-10-31");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
