#!/usr/bin/env node
/* Account progress, focus standing and follow-up adherence (TAT).
 *
 *   node scripts/test-progress.mjs
 */
import { accountProgress, focusStanding, median } from "./progress.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const rec = (id, fields) => ({ id, fields });
const companies = [rec("coA", { "Kylas Company ID": "A" }), rec("coB", { "Kylas Company ID": "B" }), rec("coC", { "Kylas Company ID": "C" })];
const contacts = [
  rec("a1", { Company: ["coA"], "Current Stage": "FOLLOW_UP_1", "Next Call Date": "2026-09-30" }),
  rec("a2", { Company: ["coA"], "Current Stage": "CNC_COULD_NOT_CONNECT", "Next Call Date": "2026-09-28" }),
  rec("b1", { Company: ["coB"], "Current Stage": "SQL_SALES_QUALIFIED_LEAD" }),
  rec("c1", { Company: ["coC"], "Current Stage": "NOT_INTERESTED", "Next Call Date": "2026-09-20" }),
];
const transitions = [rec("t1", { Contact: ["b1"], "To Stage": "SQL_SALES_QUALIFIED_LEAD", "Changed At": "2026-09-15T10:00:00Z" })];
const calls = [
  rec("k1", { Contact: ["a1"], "Called At": "2026-09-10T10:00:00Z", Owner: "Rubal", "Next Call Date": "2026-09-12" }),
  rec("k2", { Contact: ["a1"], "Called At": "2026-09-12T11:00:00Z", Owner: "Rubal", "Next Call Date": "2026-09-15" }),
  rec("k3", { Contact: ["a1"], "Called At": "2026-09-18T11:00:00Z", Owner: "Rubal", "Next Call Date": "2026-09-25" }),
];
const today = "2026-09-28";
const { byCompany, followups } = accountProgress({ companies, contacts, transitions, calls, today });

console.log("\n1. where each account stands");
eq("A: furthest stage is Follow-up 1", byCompany.get("A").stage, "FOLLOW_UP_1");
eq("A: next call is the earliest call-back in play", byCompany.get("A").nextCall, "2026-09-28");
eq("A: last call", byCompany.get("A").lastCallAt, "2026-09-18T11:00:00Z");
eq("B: done at SQL, dated by the transition", [byCompany.get("B").done, byCompany.get("B").sqlAt], [true, "2026-09-15T10:00:00Z"]);
eq("C: every contact at a dead end is closed, and its call-back does not count", [byCompany.get("C").closed, byCompany.get("C").nextCall], [true, null]);

console.log("\n2. focus standing");
eq("A picked on the 20th, due today", focusStanding({ setAt: "2026-09-20T09:00:00Z" }, byCompany.get("A"), today).state, "today");
eq("…and 8 days open", focusStanding({ setAt: "2026-09-20T09:00:00Z" }, byCompany.get("A"), today).daysOpen, 8);
eq("B: done, pick→SQL in 5 days", (({ state, tatDays }) => [state, tatDays])(focusStanding({ setAt: "2026-09-10T09:00:00Z" }, byCompany.get("B"), today)), ["done", 5]);
eq("a company never worked has no date", focusStanding({ setAt: "2026-09-27" }, undefined, today).state, "no-date");
eq("overdue", focusStanding({ setAt: "2026-09-01" }, { nextCall: "2026-09-25" }, today).state, "overdue");

console.log("\n3. follow-ups on time (TAT)");
const r = followups.get("Rubal");
eq("three promises: on time, late by 3, still open and late by 3", [r.due, r.onTime, r.late, r.open, r.delays], [3, 1, 2, 1, [3, 3]]);
eq("median delay", median(r.delays), 3);

/* ── the label follows the rung ─────────────────────────────────────────
   KPI Rank only ever rises, so it records the furthest a contact ever got.
   Current Stage records where it is now. When a POC reaches Discovery and is
   later re-dialled to a no-answer, those two disagree — and the account is
   sorted by the first while being LABELLED by the second, which read as "rung
   26 · CNC (Could Not Connect)". The order was right and the words were
   wrong, and the words are what anybody reads. */
console.log("\n5. a contact that fell back down the funnel");
{
  const rows = [
    rec("x1", { Company: ["coX"], "Current Stage": "CNC_COULD_NOT_CONNECT", "KPI Rank": 26 }),
  ];
  const { byCompany } = accountProgress({ companies: [rec("coX", { "Kylas Company ID": "9001" })], contacts: rows,
                                          transitions: [], calls: [], today: "2026-09-29" });
  const p = byCompany.get("9001");
  eq("the rung is the furthest it ever reached", p.rung, 26);
  eq("...and the name is that rung's, not where it sits today",
    p.stage, "SQL_SALES_QUALIFIED_LEAD");
}
console.log("\n   ...while a contact that never fell back is unchanged");
{
  const rows = [rec("y1", { Company: ["coY"], "Current Stage": "ACTIVATION" })];
  const { byCompany } = accountProgress({ companies: [rec("coY", { "Kylas Company ID": "9002" })], contacts: rows,
                                          transitions: [], calls: [], today: "2026-09-29" });
  eq("the stage it is on", byCompany.get("9002").stage, "ACTIVATION");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
