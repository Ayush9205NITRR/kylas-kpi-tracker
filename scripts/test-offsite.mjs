#!/usr/bin/env node
/* Offsite Timeline, derived from what the associate wrote on the event rows.
 *
 *   node scripts/test-offsite.mjs
 */
import { quartersOf, offsiteOf } from "./offsite.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log("\n1. what the Timeline text says");
const CASES = [
  ["Q3", ["JUL_SEP"]], ["q1", ["JAN_MAR"]], ["Q4 FY27", ["JAN_MAR"]], ["FY26 Q1", ["APR_JUN"]],
  ["Feb 2026", ["JAN_MAR"]], ["March end", ["JAN_MAR"]], ["sept", ["JUL_SEP"]], ["Dec.", ["OCT_DEC"]],
  ["Oct–Dec", ["OCT_DEC"]], ["Oct-Nov", ["OCT_DEC"]], ["dec to feb", ["JAN_MAR", "OCT_DEC"]],
  ["jan or feb", ["JAN_MAR"]], ["Jun / Jul", ["APR_JUN", "JUL_SEP"]],
  ["H2", ["JUL_SEP", "OCT_DEC"]], ["H1 FY27", ["APR_JUN", "JUL_SEP"]],
  ["15/02/2026", ["JAN_MAR"]], ["2026-11", ["OCT_DEC"]],
  ["May", ["APR_JUN"]], ["may be in Q3", ["JUL_SEP"]],
  ["not decided", []], ["decided later", []], ["marketing budget first", []], ["junior team", []],
  ["", []], [null, []], ["approx 8L", []],
];
for (const [t, want] of CASES) eq(JSON.stringify(t), quartersOf(t), want);

console.log("\n2. which rows count");
eq("offsite rows, Past and Now together",
   offsiteOf({ past: [{ eventType: "Employee offsites", timeline: "Feb" }],
               current: [{ eventType: "Employee offsites", timeline: "Q3" }] }), ["JAN_MAR", "JUL_SEP"]);
eq("a row with no event type yet counts", offsiteOf({ current: [{ eventType: "", timeline: "Nov" }] }), ["OCT_DEC"]);
eq("a product launch does not", offsiteOf({ current: [{ eventType: "Product launch", timeline: "Q3" }] }), []);
eq("nothing at all", offsiteOf({}), []);

/* ── the old chips and the new picker mean the same thing ───────────────
   Until 1.29 the timeline chips offered FINANCIAL-year quarters — "Q2 FY27",
   "Q3 FY27" — and every event row saved before then holds one. The picker
   writes CALENDAR quarters now, because those are the four buckets Kylas'
   Offsite Timeline field holds and the four the accounts filter counts.

   NOTHING NEEDS MIGRATING, and this is why: the quarter is never stored. It
   is derived from the Timeline text every time it is asked for, and the
   parser reads FY quarters as FY quarters. So a row that says "Q2 FY27" and
   a row that says "Jul-Sep" land in the same bucket, and push-kylas.mjs
   sends the same value for both. If this section ever fails, every event row
   written before 1.29 has silently moved one quarter. */
console.log("\n3. what the old FY chips derive, beside what the new picker writes");
const PAIRS = [
  ["Q2 FY27", "Jul-Sep", "JUL_SEP"],
  ["Q3 FY27", "Oct-Dec", "OCT_DEC"],
  ["Q4 FY27", "Jan-Mar", "JAN_MAR"],
  ["Q1 FY28", "Apr-Jun", "APR_JUN"],
];
for (const [old, now, want] of PAIRS) {
  eq(`"${old}" (old chip)`, quartersOf(old), [want]);
  eq(`"${now}" (new chip)`, quartersOf(now), [want]);
}
/* The months and weeks the picker drills down to, which a financial year has
   no opinion about at all. */
eq('"Aug" alone', quartersOf("Aug"), ["JUL_SEP"]);
eq('"Aug, week 2"', quartersOf("Aug, week 2"), ["JUL_SEP"]);
/* And what an associate types beside a chip, which must not add a quarter. */
eq('"Jul-Sep, not signed off"', quartersOf("Jul-Sep, not signed off"), ["JUL_SEP"]);
eq('"Not decided"', quartersOf("Not decided"), []);
eq('"Tentative"', quartersOf("Tentative"), []);
/* A bare calendar Q3 is NOT the old Q3 FY27, and never was. Both spellings
   exist in the data and they mean different quarters; the "FY" is what tells
   them apart, so it is the one token this must not start ignoring. */
eq('"Q3" without FY is calendar', quartersOf("Q3"), ["JUL_SEP"]);
eq('...while "Q3 FY27" is not', quartersOf("Q3 FY27"), ["OCT_DEC"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
