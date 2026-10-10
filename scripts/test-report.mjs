#!/usr/bin/env node
/* Period aggregation.
 *
 *   node scripts/test-report.mjs
 */
import { report, withDeltas, weekKey, monthKey, periodsBetween, periodLabel, mergeCalls,
         firstArrivals, arrivalsByCompany, seededRung, touchEvents } from "./report.mjs";

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

console.log("\nfirst arrivals, as dates rather than counts");
{
  /* The same fixtures the counting tests use, read the other way. The ladder
     app needs WHEN a company arrived, not how many arrived that week, and both
     answers have to come from one derivation. */
  const t = [
    { at: "2026-09-15T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_BOOKED" },
    { at: "2026-09-16T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_DONE_\u2013_AWAITING_CLIENT_INPUTS" },
    /* back to booked — already arrived there, so it must not re-arrive */
    { at: "2026-09-17T10:05:00Z", owner: "Ayush", company: "C1", to: "ACTIVE_REQUIREMENT_CALL_BOOKED" },
    { at: "2026-09-22T09:00:00Z", owner: "Charu", company: "C2", to: "SQL_SALES_QUALIFIED_LEAD" },
  ];
  const sig = [
    { at: "2026-09-14T10:02:00Z", owner: "Ayush", company: "C1", metric: "right" },
    { at: "2026-09-16T10:02:00Z", owner: "Ayush", company: "C1", metric: "right" },
  ];
  const by = arrivalsByCompany({ transitions: t, signals: sig });

  eq("booked is dated from the FIRST arrival", by.get("C1").booked, "2026-09-15T10:05:00Z");
  eq("re-entering booked does not move the date", firstArrivals({ transitions: t }).filter(
     (a) => a.metric === "booked" && a.company === "C1").length, 1);
  eq("done is its own date", by.get("C1").done, "2026-09-16T10:05:00Z");
  eq("a signal arrives once, on the first", by.get("C1").right, "2026-09-14T10:02:00Z");
  /* Crossing SQL crosses everything below it in one move, because the floors
     are floors — and all three carry the same date. */
  eq("one move past three floors dates all three",
     [by.get("C2").booked, by.get("C2").done, by.get("C2").sql],
     ["2026-09-22T09:00:00Z", "2026-09-22T09:00:00Z", "2026-09-22T09:00:00Z"]);
  ok("the list comes back in time order", firstArrivals({ transitions: t, signals: sig })
     .every((a, i, all) => i === 0 || all[i - 1].at <= a.at));
  eq("nothing in, nothing out", firstArrivals({}).length, 0);
}

console.log("\na rung for a company nobody has worked");
/* The stage is all there is, so it decides the one rung the company shows at —
   and it must not imply the rungs below it. */
eq("SQL",                 seededRung("SQL_SALES_QUALIFIED_LEAD"), 5);
eq("meeting done",        seededRung("ACTIVE_REQUIREMENT_CALL_DONE_\u2013_AWAITING_CLIENT_INPUTS"), 4);
eq("meeting booked",      seededRung("ACTIVE_REQUIREMENT_CALL_BOOKED"), 3);
eq("a no-show is still booked", seededRung("ACTIVE_REQUIREMENT_CALL_NO_SHOW"), 3);
eq("discovery done",      seededRung("DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS"), 2);
eq("discovery only booked is not discovery done", seededRung("DISCOVERY_CALL_BOOKED"), 1);
eq("MQL is the right POC",seededRung("MQL_MARKETING_QUALIFIED_LEAD"), 1);
eq("CNC is reached and no more", seededRung("CNC_COULD_NOT_CONNECT"), 0);
eq("the first stage is reached", seededRung("YET_TO_BE_MINED"), 0);
eq("a stage this build has never heard of is reached, not promoted",
   seededRung("SOMETHING_NEW"), 0);
/* Closing Loops can follow either meeting, so its rung cannot claim one. */
eq("closing loops does not claim a meeting", seededRung("CLOSING_LOOPS_LOW_VALUE"), 1);

/* ── THE BOTTOM TWO RUNGS COUNT ACTIVITY, NOT FIRST ARRIVAL ─────────────
   Anjali said she had reached out to four accounts and her column read 1.
   Under first-arrival counting that is exactly right and exactly useless: an
   account somebody had touched before could never appear in her day again.
   Ayush, 2026-09-30: worked = any stage change, picked = a move into a stage
   that is not CNC. */
console.log("\nactivity, not first arrival");
{
  const day = "2026-09-30T06:00:00.000Z";
  const anjali = (co, to, at = day) => ({ at, owner: "Anjali", to, company: co });
  /* Four accounts, all worked before — a month ago, by somebody else. */
  const old = ["c1", "c2", "c3", "c4"].map((co) =>
    ({ at: "2026-08-30T06:00:00.000Z", owner: "Gurnoor", to: "CNC_COULD_NOT_CONNECT", company: co }));
  const today = [anjali("c1", "FOLLOW_UP_1"), anjali("c2", "MQL_MARKETING_QUALIFIED_LEAD"),
                 anjali("c3", "CNC_COULD_NOT_CONNECT_2"), anjali("c4", "FOLLOW_UP_2")];
  const r = report("day", { transitions: [...old, ...today] }, { from: "2026-09-30", to: "2026-09-30" });
  eq("all four count as worked", r.totals.worked, 4);
  eq("...and Anjali gets all four", r.byOwner.find((o) => o.owner === "Anjali").worked, 4);
  /* c3 went to a CNC rung, so it was worked and NOT picked. */
  eq("three of them were picked", r.totals.picked, 3);
  eq("...and the CNC one is not among them",
     touchEvents({ transitions: today }).filter((e) => e.metric === "picked").map((e) => e.company).sort(),
     ["c1", "c2", "c4"]);
}

console.log("\none account touched twice is one account");
{
  const t = (co, owner, at, to) => ({ at, owner, to, company: co });
  const r = report("day", { transitions: [
    t("c1", "Anjali", "2026-09-30T04:00:00.000Z", "FOLLOW_UP_1"),
    t("c1", "Anjali", "2026-09-30T09:00:00.000Z", "FOLLOW_UP_2"),
  ] }, { from: "2026-09-30", to: "2026-09-30" });
  eq("twice in one day is one", r.totals.worked, 1);
  eq("...for the owner too", r.byOwner[0].worked, 1);
}

console.log("\ntwo associates on one account: one for the team, one each");
{
  /* THE TEAM TOTAL IS NOT THE SUM OF THE COLUMNS, and must not be. The account
     was worked once; each of them worked it. */
  const t = (owner, at) => ({ at, owner, to: "FOLLOW_UP_1", company: "c1" });
  const r = report("day", { transitions: [
    t("Anjali", "2026-09-30T04:00:00.000Z"), t("Mayra", "2026-09-30T09:00:00.000Z"),
  ] }, { from: "2026-09-30", to: "2026-09-30" });
  eq("the team worked one account", r.totals.worked, 1);
  eq("Anjali worked one", r.byOwner.find((o) => o.owner === "Anjali").worked, 1);
  eq("Mayra worked one", r.byOwner.find((o) => o.owner === "Mayra").worked, 1);
}

console.log("\nthe same account in two periods counts in both");
{
  const t = (at) => ({ at, owner: "Anjali", to: "FOLLOW_UP_1", company: "c1" });
  const r = report("day", { transitions: [t("2026-09-29T06:00:00.000Z"), t("2026-09-30T06:00:00.000Z")] },
                   { from: "2026-09-29", to: "2026-09-30" });
  eq("both days", r.periods.map((p) => p.worked), [1, 1]);
  /* ...which is the whole difference from the rungs above it. */
  eq("while a milestone arrives once", firstArrivals({ transitions: [
    { at: "2026-09-29T06:00:00.000Z", owner: "A", to: "SQL_SALES_QUALIFIED_LEAD", company: "c1" },
    { at: "2026-09-30T06:00:00.000Z", owner: "A", to: "SQL_SALES_QUALIFIED_LEAD", company: "c1" },
  ] }).filter((a) => a.metric === "sql").length, 1);
}

console.log("\na save that changed no stage still counts as worked");
{
  /* The console writes First Worked At on a save. A call logged against an
     account that stayed where it was is still that account being worked. */
  const r = report("day", { signals: [
    { at: "2026-09-30T06:00:00.000Z", owner: "Sejal", company: "c9", metric: "worked" },
  ] }, { from: "2026-09-30", to: "2026-09-30" });
  eq("counted", r.totals.worked, 1);
  eq("...and not picked, because nothing says it was", r.totals.picked, 0);
}

/* ── the booked → held cohort ─────────────────────────────────────────
   The rate the Progress table shows for SQL done. Every number below is worked
   out by hand first, because the whole point of the column is that the obvious
   same-period ratio gives the wrong answer. */
console.log("\nbooked -> held, as a cohort rather than a same-period ratio");
const BOOK = "ACTIVE_REQUIREMENT_CALL_BOOKED";
const HELD = "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS";
{
  /* Three booked on the 14th. Two of them held — one the next day, one three
     weeks later. The third never. So the 14th's cohort is 2 of 3. */
  const r = report("day", { transitions: [
    { at: "2026-09-14T09:00:00Z", owner: "A", company: "c1", to: BOOK },
    { at: "2026-09-14T09:10:00Z", owner: "A", company: "c2", to: BOOK },
    { at: "2026-09-14T09:20:00Z", owner: "A", company: "c3", to: BOOK },
    { at: "2026-09-15T09:00:00Z", owner: "A", company: "c1", to: HELD },
    { at: "2026-10-05T09:00:00Z", owner: "A", company: "c2", to: HELD },
  ] }, { from: "2026-09-14", to: "2026-10-05" });
  const day = (k) => r.periods.find((p) => p.key === k);
  eq("three booked on the 14th", day("2026-09-14").booked, 3);
  eq("two of them have since been held", day("2026-09-14").bookedHeld, 2);
  /* THE POINT. The old rate was done-this-period over booked-this-period: on
     the 14th that is 0/3 = 0%, and on the 15th 1/0 = undefined. Neither says
     anything about whether the bookings happened. */
  eq("...while the 14th's own `done` count is still 0 — the lag that broke it",
     day("2026-09-14").done, 0);
  eq("the meeting itself lands on the day it happened", day("2026-09-15").done, 1);
  eq("...and that day booked nothing, so it has no cohort",
     day("2026-09-15").bookedHeld, 0);
  /* A cohort is a subset of its denominator, so this can never exceed it —
     which is the property the 133% cell lacked. */
  ok("held never exceeds booked, in any period",
     r.periods.every((p) => p.bookedHeld <= p.booked));
  eq("the window totals agree", r.totals.bookedHeld, 2);
}
{
  /* HELD AFTER THE WINDOW STILL COUNTS. A September booking held in November
     is a September booking that happened, and the September row has to say so
     or the column quietly punishes recent periods. */
  const r = report("month", { transitions: [
    { at: "2026-09-10T09:00:00Z", owner: "A", company: "c1", to: BOOK },
    { at: "2026-11-20T09:00:00Z", owner: "A", company: "c1", to: HELD },
  ] }, { from: "2026-09-01", to: "2026-09-30" });
  const sep = r.periods.find((p) => p.key === "2026-09");
  eq("booked in September", sep.booked, 1);
  eq("...held in November, and September is still credited", sep.bookedHeld, 1);
  eq("...while November's meeting is outside the window and counts nowhere here",
     r.totals.done, 0);
}
{
  /* One jump from nothing to SQL marks booked, done and sql at the same
     instant — the floors are nested. The cohort must read 1 of 1, not 0. */
  const r = report("day", { transitions: [
    { at: "2026-09-14T09:00:00Z", owner: "A", company: "c1", to: "SQL_SALES_QUALIFIED_LEAD" },
  ] }, { from: "2026-09-14", to: "2026-09-14" });
  eq("a straight jump to SQL counts as booked", r.totals.booked, 1);
  eq("...and as held, in the same period", r.totals.bookedHeld, 1);
}
{
  /* SQL DONE -> SQL, AYUSH'S 6 OCT. Day view: SQL done 4, SQL 5, rate 125%.
     Avani: held on the 5th, SQL on the 6th. Kshitij: booked on the 28th,
     SQL on the 6th (skipping done). Three more jumped straight to SQL. */
  const SQL = "SQL_SALES_QUALIFIED_LEAD";
  const r = report("day", { transitions: [
    { at: "2026-09-28T09:00:00Z", owner: "M", company: "avani", to: BOOK },
    { at: "2026-10-05T09:00:00Z", owner: "M", company: "avani", to: HELD },
    { at: "2026-10-06T09:00:00Z", owner: "M", company: "avani", to: SQL },
    { at: "2026-09-28T10:00:00Z", owner: "A", company: "kshitij", to: BOOK },
    { at: "2026-10-06T10:00:00Z", owner: "A", company: "kshitij", to: SQL },
    { at: "2026-10-06T11:00:00Z", owner: "G", company: "shahil", to: SQL },
    { at: "2026-10-06T11:10:00Z", owner: "A", company: "sushmita", to: SQL },
    { at: "2026-10-06T11:20:00Z", owner: "N", company: "shubha", to: SQL },
  ] }, { from: "2026-10-05", to: "2026-10-06" });
  const day = (k) => r.periods.find((p) => p.key === k);
  eq("6 Oct: SQL done 4, as his screen said", day("2026-10-06").done, 4);
  eq("6 Oct: SQL 5, as his screen said", day("2026-10-06").sql, 5);
  eq("...and the cohort is 4 of those 4 — 100%, not 125%", day("2026-10-06").doneSql, 4);
  eq("Avani is credited to the 5th, where her meeting was held", day("2026-10-05").doneSql, 1);
  ok("doneSql never exceeds done, in any period", r.periods.every((p) => p.doneSql <= p.done));
  eq("the window totals agree", r.totals.doneSql, 5);
}
{
  /* A meeting held but not yet SQL is in the denominator and not the numerator,
     and becomes SQL later — the row rises. */
  const r = report("month", { transitions: [
    { at: "2026-10-03T09:00:00Z", owner: "A", company: "c9", to: HELD },
    { at: "2026-11-02T09:00:00Z", owner: "A", company: "c9", to: "SQL_SALES_QUALIFIED_LEAD" },
  ] }, { from: "2026-10-01", to: "2026-10-31" });
  eq("held in October, SQL in November: October still credited", r.periods[0].doneSql, 1);
}
{
  /* DAILY TALK TIME (2026-10-10). The calls' durations summed per day, raw
     rows and rolled-up days alike, per owner too. */
  const r = report("day", { calls: [
    { at: "2026-10-06T09:00:00Z", owner: "A", outcome: "Right POC", secs: 300 },
    { at: "2026-10-06T10:00:00Z", owner: "A", outcome: "No answer", secs: 20 },
    { at: "2026-10-06T11:00:00Z", owner: "B", outcome: "Discovery", secs: 900 },
    { at: "2026-10-05", owner: "A", outcome: "Right POC", n: 12, secs: 1800 },   /* a rolled-up day */
    { at: "2026-10-06T12:00:00Z", owner: "B", outcome: "No answer" },            /* no duration */
  ] }, { from: "2026-10-05", to: "2026-10-06" });
  const day = (k) => r.periods.find((p) => p.key === k);
  eq("talk time for the 6th is every call's seconds", day("2026-10-06").talkSeconds, 1220);
  eq("a rolled-up day carries its total", day("2026-10-05").talkSeconds, 1800);
  eq("the window total", r.totals.talkSeconds, 3020);
  eq("per owner too", (r.byOwner || []).find((o) => o.owner === "B")?.talkSeconds, 900);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
