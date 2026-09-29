/* THE SIX CALL BUCKETS (Ayush, 2026-09-29).
 *
 * The board groups accounts by these, on the account's CALCULATED stage. The
 * table lives in docs/stages.json `families` and gen-stages.mjs already
 * refuses to build if a stage is left out of it — so what this file asserts is
 * the part a generator cannot check: that stages which are easy to file by
 * their rung, or by the sound of their name, are filed by what you would
 * actually do with them.
 *
 * THE BUCKETS ARE NOT THE LADDER. The 26 rungs are a funnel order; these are
 * an action order, and the two disagree on purpose. Discovery Call No-Show is
 * rung 20 and needs a call today. Not Interested is rung 10 and never needs
 * one again. Anything that sorts the board by rung has misunderstood it.
 *
 * Run: node scripts/test-buckets.mjs
 */
import { STAGE_FAMILIES, FAMILY_OF, STAGE_RUNG, STAGE_LABEL } from "./stages.mjs";

let pass = 0, fail = 0;
const is = (what, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

console.log("1. six buckets, and every stage in exactly one");
is("bucket count", STAGE_FAMILIES.length, 6);
is("the order they appear on the board",
  STAGE_FAMILIES.map((f) => f.key).join(" → "),
  "new → cnc → active → meeting → newpoc → closed");
const all = Object.keys(STAGE_RUNG);
is("every stage is placed", all.filter((c) => !FAMILY_OF[c]).length, 0);
const counts = {};
for (const c of all) counts[FAMILY_OF[c]] = (counts[FAMILY_OF[c]] || 0) + 1;
is("and placed once", STAGE_FAMILIES.reduce((n, f) => n + f.stages.length, 0), all.length);
console.log(`        ${STAGE_FAMILIES.map((f) => `${f.label} ${counts[f.key]}`).join(" · ")}`);

console.log("\n2. the ones that are easy to file wrongly");
/* Rung 20, and the name reads like a loss. It is Kylas' label for a discovery
   call the prospect did not turn up to, so the next action is to re-book it —
   which is Meeting in play, not Closed. Its code says one thing and its label
   says another, and the label is the truth. */
is(`GHOSTED is "${STAGE_LABEL.GHOSTED}"`, FAMILY_OF.GHOSTED, "meeting");
is("...and it outranks most of Activation and above", STAGE_RUNG.GHOSTED > STAGE_RUNG.ACTIVATION, true);
/* Nobody failed to connect — they asked to be called later. Same action
   though: dial again, no conversation to resume. */
is("Connect Later sits with CNC", FAMILY_OF.CONNECT_LATER, "cnc");
/* Rungs 11 and 12, below Activation's 13, so "Activation and above" read as a
   rung rule would drop them — but a conversation happened, and the account is
   live. Filed by what it is, not by where it sits. */
is("Offsite Delayed is a live conversation", FAMILY_OF.OFFSITE_DELAYED, "active");
is("...as is Offsite Done (Late Reachout)", FAMILY_OF.OFFSITE_DONE_LATE_REACHOUT, "active");
ok("...though both rank below Activation",
  STAGE_RUNG.OFFSITE_DELAYED < STAGE_RUNG.ACTIVATION && STAGE_RUNG.OFFSITE_DONE_LATE_REACHOUT < STAGE_RUNG.ACTIVATION);
/* A meeting nobody attended is still a meeting to re-book. */
is("Active Requirement Call No-Show stays in Meeting in play",
  FAMILY_OF.ACTIVE_REQUIREMENT_CALL_NO_SHOW, "meeting");
/* THE SPLIT THAT EARNS ITS OWN COLUMN. These three are about the PERSON. The
   company is still callable — somebody just has to find another contact there.
   In Closed they die silently, and that is live pipeline going quiet. */
for (const c of ["DISQUALIFIED_WRONG_POC", "NOT_A_DECISION_MAKER_NDM", "POC_ORGANIZATION_CHANGED"])
  is(`${c} needs a new POC, it is not closed`, FAMILY_OF[c], "newpoc");
/* Closed is only the three where there is no call left to make anywhere. */
is("Closed holds exactly three", counts.closed, 3);
for (const c of ["NOT_INTERESTED", "INVALID_CONTACT", "CLOSING_LOOPS_LOW_VALUE"])
  is(`${c} is closed`, FAMILY_OF[c], "closed");

console.log("\n3. the top and the bottom");
is("SQL is a live account, not a meeting", FAMILY_OF.SQL_SALES_QUALIFIED_LEAD, "active");
is("the bottom rung is Not started", FAMILY_OF.YET_TO_BE_MINED, "new");
is("...and it is the only one there", counts.new, 1);
/* Every CNC-numbered stage together, or a pile splits in three. */
for (const c of ["CNC_COULD_NOT_CONNECT", "CNC_COULD_NOT_CONNECT_2", "CNC_COULD_NOT_CONNECT_3", "FOLLOWUP_CNC"])
  is(`${c} is in the CNC pile`, FAMILY_OF[c], "cnc");

console.log("\n4. a bucket is not a rung range");
/* Stated as an assertion because it is the thing a later edit would quietly
   undo: if every bucket held a contiguous run of rungs, somebody would be
   right to replace the table with two comparisons — and the board would then
   put Discovery Call No-Show next to Not Interested. */
const contiguous = STAGE_FAMILIES.filter((f) => {
  const rs = f.stages.map((c) => STAGE_RUNG[c]).sort((a, b) => a - b);
  return rs.length > 1 && rs[rs.length - 1] - rs[0] === rs.length - 1;
});
ok("at least one bucket spans a broken range of rungs",
  contiguous.length < STAGE_FAMILIES.filter((f) => f.stages.length > 1).length,
  "every bucket is a contiguous rung range — the table could be replaced by a comparison, and should not be");

console.log("\n5. every bucket says what it is for");
for (const f of STAGE_FAMILIES) {
  ok(`${f.label} has a hint`, !!f.hint && f.hint.length > 8, JSON.stringify(f.hint));
  ok(`...and stages`, f.stages.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
