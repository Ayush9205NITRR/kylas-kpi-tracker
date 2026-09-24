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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
