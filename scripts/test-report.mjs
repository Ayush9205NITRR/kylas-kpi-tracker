#!/usr/bin/env node
/* Period aggregation.
 *
 *   node scripts/test-report.mjs
 */
import { report, withDeltas, weekKey, monthKey, periodsBetween, periodLabel, mergeCalls } from "./report.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

console.log("period keys");
/* 2026-09-18 is a Friday. Its week starts Monday the 14th. */
eq("Friday -> that Monday", weekKey("2026-09-18"), "2026-09-14");
eq("the Monday itself", weekKey("2026-09-14"), "2026-09-14");
eq("Sunday belongs to the week that STARTED, not the one beginning",
   weekKey("2026-09-20"), "2026-09-14");
eq("the next Monday moves on", weekKey("2026-09-21"), "2026-09-21");
eq("month", monthKey("2026-09-18T11:00:00Z"), "2026-09");

console.log("\nevery period in the window, including silent ones");
eq("days", periodsBetween("day", "2026-09-16", "2026-09-19").length, 4);
eq("weeks across a month boundary", periodsBetween("week", "2026-08-31", "2026-09-14"),
   ["2026-08-31", "2026-09-07", "2026-09-14"]);
eq("months", periodsBetween("month", "2026-07-02", "2026-09-30"), ["2026-07", "2026-08", "2026-09"]);
ok("a week reads as a range", /–/.test(periodLabel("week", "2026-09-14")));

console.log("\ncounting");
const calls = [
  { at: "2026-09-14T09:00:00Z", owner: "Ayush", outcome: "No answer" },
  { at: "2026-09-14T10:00:00Z", owner: "Ayush", outcome: "Right POC" },
  { at: "2026-09-15T10:00:00Z", owner: "Ayush", outcome: "Discovery" },
  { at: "2026-09-15T11:00:00Z", owner: "Charu", outcome: "No answer" },
  { at: "2026-09-22T11:00:00Z", owner: "Charu", outcome: "Wrong POC" },
];
const transitions = [
  { at: "2026-09-15T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_BOOKED" },
  /* the same company moving on — booked must NOT count twice */
  { at: "2026-09-16T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS" },
  /* and going backwards then forwards again */
  { at: "2026-09-17T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_BOOKED" },
  { at: "2026-09-22T09:00:00Z", owner: "Charu", company: "C2", to: "SQL_SALES_QUALIFIED_LEAD" },
];
const signals = [
  { at: "2026-09-14T10:02:00Z", owner: "Ayush", company: "C1", metric: "right" },
  { at: "2026-09-15T10:02:00Z", owner: "Ayush", company: "C1", metric: "discovery" },
  /* same company again — once only */
  { at: "2026-09-16T10:02:00Z", owner: "Ayush", company: "C1", metric: "right" },
];

{
  const r = report("day", { calls, transitions, signals });
  eq("window derived from the data", [r.from, r.to], ["2026-09-14", "2026-09-22"]);
  eq("every day in between is present", r.periods.length, 9);
  const on = (k) => r.periods.find((p) => p.key === k);
  eq("calls on the 14th", on("2026-09-14").calls, 2);
  eq("one of them connected", on("2026-09-14").connects, 1);
  eq("a silent day is a zero, not a gap", on("2026-09-18").calls, 0);
  eq("right POC counted once, on the day it happened", on("2026-09-14").right, 1);
  eq("and not again later", on("2026-09-16").right, 0);
  eq("booked counted on first arrival", on("2026-09-15").booked, 1);
  eq("not when it re-enters", on("2026-09-17").booked, 0);
  /* Active Requirement Call Done is rung 25 — the SQL-meeting-done floor. */
  eq("crossing a higher floor counts for that floor", on("2026-09-16").done, 1);
  eq("SQL", on("2026-09-22").sql, 1);
  eq("totals add up", r.totals.calls, 5);
  /* TWO: C1 booked, and C2 went straight to SQL — which is above the booked
     floor, so it necessarily reached booked too. That is the whole point of a
     floor, and a report that said 1 here would be under-counting the funnel. */
  eq("a company that reached SQL also reached booked", r.totals.booked, 2);
  eq("C2's booked lands on ITS day", on("2026-09-22").booked, 1);
}

console.log("\nthe same rows, by week");
{
  const r = report("week", { calls, transitions, signals });
  eq("two weeks", r.periods.map((p) => p.key), ["2026-09-14", "2026-09-21"]);
  eq("week one's calls", r.periods[0].calls, 4);
  eq("week two's calls", r.periods[1].calls, 1);
  eq("totals match the daily view", r.totals.calls, 5);
}

console.log("\nand by month");
{
  const r = report("month", { calls, transitions, signals });
  eq("one month", r.periods.map((p) => p.key), ["2026-09"]);
  eq("everything in it", r.periods[0].calls, 5);
}

console.log("\nper associate");
{
  const r = report("week", { calls, transitions, signals });
  const by = Object.fromEntries(r.byOwner.map((o) => [o.owner, o]));
  eq("Ayush's calls", by.Ayush.calls, 3);
  eq("Charu's calls", by.Charu.calls, 2);
  eq("ordered by activity", r.byOwner[0].owner, "Ayush");
}

console.log("\nsomething to measure against");
{
  const r = withDeltas(report("week", { calls, transitions, signals }));
  eq("first period has no delta", r.periods[0].delta.calls, null);
  eq("second period's change", r.periods[1].delta.calls, -3);
  eq("best week for calls", r.best.calls.value, 4);
  /* C1 crossed the SQL-meeting-done floor on the 16th, so `done` does have a
     best. The "no best" case is covered by the empty window below. */
  eq("best exists for a metric that was scored", r.best.done.value, 1);
  eq("current is the latest", r.current.key, "2026-09-21");
  eq("previous is the one before", r.previous.key, "2026-09-14");
  ok("streak counts back from now", r.streak >= 1);
}

console.log("\nan empty window still renders");
{
  const r = withDeltas(report("week", {}, { from: "2026-09-01", to: "2026-09-14" }));
  ok("periods exist", r.periods.length >= 2);
  eq("all zero", r.totals.calls, 0);
  eq("no best", r.best.calls, null);
  eq("no streak", r.streak, 0);
}

console.log("\nan explicit window clips the data");
{
  const r = report("day", { calls, transitions, signals },
                   { from: "2026-09-15", to: "2026-09-16" });
  eq("two days", r.periods.length, 2);
  eq("only what falls inside", r.totals.calls, 2);
  /* The 14th is outside, so its right-POC does not appear — but it still
     consumed the once-only slot, so the 16th must not claim it either. */
  eq("an earlier first-arrival is not re-counted inside the window", r.totals.right, 0);
}

console.log("\nrolled-up days count the same as raw ones");
{
  /* The same four calls, once as raw rows and once as a single rolled row. */
  const rawDay = [
    { at: "2026-09-14T09:00:00Z", owner: "Ayush", outcome: "No answer" },
    { at: "2026-09-14T09:05:00Z", owner: "Ayush", outcome: "No answer" },
    { at: "2026-09-14T10:00:00Z", owner: "Ayush", outcome: "Right POC" },
    { at: "2026-09-14T11:00:00Z", owner: "Ayush", outcome: "Right POC" },
  ];
  const rolled = [
    { at: "2026-09-14", owner: "Ayush", outcome: "No answer", n: 2 },
    { at: "2026-09-14", owner: "Ayush", outcome: "Right POC", n: 2 },
  ];
  const a = report("day", { calls: rawDay });
  const b = report("day", { calls: rolled });
  eq("calls match", b.totals.calls, a.totals.calls);
  eq("connects match", b.totals.connects, a.totals.connects);
  eq("and are the real numbers", [b.totals.calls, b.totals.connects], [4, 2]);
  /* n is a COUNT, not a flag: a missing or silly one must not erase the call. */
  eq("no n means one", report("day", { calls: [{ at: "2026-09-14", owner: "A", outcome: "x" }] }).totals.calls, 1);
  eq("zero n means one", report("day", { calls: [{ at: "2026-09-14", owner: "A", outcome: "x", n: 0 }] }).totals.calls, 1);
}

console.log("\na day held by both sources is counted once, from the raw rows");
{
  const raw = [
    { at: "2026-09-14T09:00:00Z", owner: "Ayush", outcome: "No answer" },
    { at: "2026-09-14T10:00:00Z", owner: "Ayush", outcome: "Right POC" },
  ];
  /* What a crashed rollup leaves behind: the aggregate written, the raw rows
     not yet deleted. Both describe the same day. */
  const rolled = [
    { at: "2026-09-14", owner: "Ayush", outcome: "No answer", n: 1 },
    { at: "2026-09-14", owner: "Ayush", outcome: "Right POC", n: 1 },
    /* an older day that only the rollup has */
    { at: "2026-09-10", owner: "Ayush", outcome: "No answer", n: 7 },
  ];
  const merged = mergeCalls(raw, rolled);
  const r = report("day", { calls: merged });
  eq("the duplicated day is not doubled", r.periods.find((p) => p.key === "2026-09-14").calls, 2);
  eq("the rolled-only day still counts", r.periods.find((p) => p.key === "2026-09-10").calls, 7);
  eq("totals", r.totals.calls, 9);
  eq("nothing raw is ever dropped", mergeCalls(raw, []).length, 2);
  eq("no raw at all means the rollup stands", mergeCalls([], rolled).length, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
