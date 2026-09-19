#!/usr/bin/env node
/* Who owes an explanation.
 *
 *   node scripts/test-rca.mjs
 *
 * gateFor() decides which contacts the console asks about, and it had no test
 * at all — including through the change that moved the SQL-meeting floors off
 * their stand-ins, which is precisely the kind of change that silences a gate
 * without anything going red.
 */
import { gateFor, RCA_GATES, RCA_GATE, RCA_LABEL } from "./rca.mjs";
import { MILESTONE, STAGE_RUNG } from "./stages.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

const DAY = 86400000;
const NOW = Date.parse("2026-09-19T12:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
/* A contact as readRcaDue builds it: flags per rung, plus when the rank rose. */
const who = (f) => ({ reached: false, picked: false, right: false, discovery: false,
                      booked: false, done: false, sql: false, ...f });

console.log("the gates that exist");
eq("three of them, in funnel order", RCA_GATES.map((g) => g.key),
   ["rightNoDiscovery", "discoveryNoBooking", "doneNoSql"]);
ok("each faces forwards and has a patience", RCA_GATES.every((g) => g.days >= 1));
ok("every reason code has a label", RCA_GATES.every((g) => g.reasons.every((r) => RCA_LABEL[r.code])));

console.log("\nfiring");
eq("right POC, no discovery call, past 30 days",
   gateFor(who({ reached: 1, right: 1, rankAt: ago(31) }), NOW)?.gate, "rightNoDiscovery");
eq("and not a day early",
   gateFor(who({ reached: 1, right: 1, rankAt: ago(29) }), NOW), null);
eq("discovery done, nothing booked, past 21 days",
   gateFor(who({ reached: 1, right: 1, discovery: 1, rankAt: ago(22) }), NOW)?.gate, "discoveryNoBooking");
eq("meeting held, not qualified, past 14 days",
   gateFor(who({ reached: 1, right: 1, discovery: 1, booked: 1, done: 1, rankAt: ago(15) }), NOW)?.gate,
   "doneNoSql");
eq("days are reported, so the list can be worst-first",
   gateFor(who({ reached: 1, right: 1, rankAt: ago(45) }), NOW)?.days, 45);

console.log("\nstaying quiet");
eq("a contact that got there is not asked why it did not",
   gateFor(who({ reached: 1, right: 1, discovery: 1, rankAt: ago(99) }), NOW)?.gate, "discoveryNoBooking");
eq("one that has qualified owes nothing",
   gateFor(who({ reached: 1, right: 1, discovery: 1, booked: 1, done: 1, sql: 1, rankAt: ago(99) }), NOW), null);
/* No arrival date means it has never been seen to move. Dating it to the epoch
   would report it as 20,000 days overdue and put every untouched contact at the
   top of the list. */
eq("no rank date, no question", gateFor(who({ reached: 1, right: 1, rankAt: "" }), NOW), null);
eq("an unparseable one is the same", gateFor(who({ reached: 1, right: 1, rankAt: "soon" }), NOW), null);
eq("a contact that has not reached the from-rung is not at the gate",
   gateFor(who({ reached: 1, rankAt: ago(99) }), NOW), null);

console.log("\nthe first gate that matches wins");
/* Stuck at right POC for a year matches only the first gate — the later ones
   need rungs it has not reached. */
eq("furthest-back stall is the one asked",
   gateFor(who({ reached: 1, right: 1, rankAt: ago(365) }), NOW)?.gate, "rightNoDiscovery");

console.log("\nthe floors the gates lean on");
/* THE REGRESSION. `booked` is computed as rank >= sqlMeetingBooked.floor. While
   that floor was Discovery Call Booked (19) and discovery done sat at 22, every
   contact that had done a discovery call already counted as booked — so
   discoveryNoBooking skipped exactly the contacts it exists to ask about. The
   floor has to sit ABOVE the discovery stage for the gate to be reachable. */
ok("the SQL-meeting-booked floor is past the discovery-done stage",
   MILESTONE.sqlMeetingBooked.floor > STAGE_RUNG.DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS);
ok("and done is past booked", MILESTONE.sqlMeetingDone.floor > MILESTONE.sqlMeetingBooked.floor);
ok("and SQL is past done", MILESTONE.sql.floor > MILESTONE.sqlMeetingDone.floor);
eq("booked floors on the Active Requirement call, not the discovery call",
   MILESTONE.sqlMeetingBooked.stage, "ACTIVE_REQUIREMENT_CALL_BOOKED");

console.log("\nthe gates are addressable by key");
eq("RCA_GATE is keyed", RCA_GATE.doneNoSql?.to, "sql");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
