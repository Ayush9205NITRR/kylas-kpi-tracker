#!/usr/bin/env node
/* TAT: the arithmetic, the traps, and whether it holds at the size of the
 * actual account.
 *
 *   node scripts/test-tat.mjs
 *   node scripts/test-tat.mjs --scale 200000
 *
 * Every expected number below is worked out BY HAND in the comment beside it.
 * That is deliberate and it is most of the value of this file: a matrix with
 * somebody's name on it will be argued with, and the answer to "why does it
 * say 9" has to be a sum a person can follow, not "the code says so".
 *
 * Calendar reference for the fixtures — 2026-09-14 is a Monday:
 *   Mon 14  Tue 15  Wed 16  Thu 17  Fri 18  Sat 19  Sun 20  Mon 21
 * and 2026-08-03 is a Monday too.
 */
import { TAT_PAIRS, TAT_PAIR, MIN_N, tatGaps, tatMatrix, tatCohort, tatWorkList,
         median, p75, calendarDays, workingDays } from "./tat.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

/* A shorthand for the fixtures: one company's arrivals. */
const arr = (company, owner, rungs) =>
  Object.entries(rungs).filter(([, at]) => at)
    .map(([metric, at]) => ({ metric, company, owner: rungs[`${metric}Owner`] || owner,
                              at: `${at}T10:00:00Z` }))
    .filter((a) => !a.metric.endsWith("Owner"));

const RD = [TAT_PAIR.rightToDiscovery];
const CW = [TAT_PAIR.createdToWorked];

/* ══ 1 · the arithmetic, stated exactly ══════════════════════════════ */
console.log("days");
eq("same day is zero", calendarDays("2026-09-14T09:00:00Z", "2026-09-14T23:00:00Z"), 0);
/* Rounded by DATE, not by elapsed hours: ten minutes either side of midnight
   is a day. Rounding the other way lets a team look same-day by working late. */
eq("ten minutes across midnight is one day",
   calendarDays("2026-09-14T23:50:00Z", "2026-09-15T00:10:00Z"), 1);
eq("a month", calendarDays("2026-08-01T10:00:00Z", "2026-08-31T10:00:00Z"), 30);
eq("backwards is negative, not zero",
   calendarDays("2026-09-15T10:00:00Z", "2026-09-14T10:00:00Z"), -1);

console.log("\nworking days — the weekend is not a performance problem");
eq("Fri -> Mon is ONE working day, not three",
   workingDays("2026-09-18T10:00:00Z", "2026-09-21T10:00:00Z"), 1);
eq("Fri -> Sat is none of one", workingDays("2026-09-18T10:00:00Z", "2026-09-19T10:00:00Z"), 0);
eq("Fri -> Sun still none", workingDays("2026-09-18T10:00:00Z", "2026-09-20T10:00:00Z"), 0);
eq("Mon -> Fri is four", workingDays("2026-09-14T10:00:00Z", "2026-09-18T10:00:00Z"), 4);
eq("Mon -> the next Mon is five", workingDays("2026-09-14T10:00:00Z", "2026-09-21T10:00:00Z"), 5);
eq("same day is zero", workingDays("2026-09-14T10:00:00Z", "2026-09-14T10:00:00Z"), 0);
eq("a whole week is five", workingDays("2026-09-18T10:00:00Z", "2026-09-25T10:00:00Z"), 5);
/* 2026-08-01 is a Saturday; 2026-09-28 a Monday. 58 calendar days, and the
   closed form must agree with a walk over them. */
{
  let n = 0;
  for (let d = Date.parse("2026-08-01T00:00:00Z") + 86400000;
       d <= Date.parse("2026-09-28T00:00:00Z"); d += 86400000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  eq("the closed form agrees with counting them one by one",
     workingDays("2026-08-01T10:00:00Z", "2026-09-28T10:00:00Z"), n);
}

console.log("\nmedian and p75, defined so they can be checked by hand");
eq("odd n takes the middle", median([5, 7, 9, 11, 20]), 9);
eq("even n averages the two middles", median([2, 4, 6, 8, 10, 12]), 7);
eq("one value is its own median", median([4]), 4);
eq("nothing has no median", median([]), null);
/* NEAREST RANK: ceil(0.75 * n)th value, an observation rather than an
   interpolation — so "the slowest quarter took at least this long" points at
   an account somebody can open. */
eq("p75 of 5 is the 4th value (ceil 3.75)", p75([5, 7, 9, 11, 20]), 11);
eq("p75 of 6 is the 5th (ceil 4.5)", p75([2, 4, 6, 8, 10, 12]), 10);
eq("p75 of 4 is the 3rd", p75([1, 2, 3, 4]), 3);
/* The reason it is not a mean. */
eq("one eight-month account does not move the median",
   median([2, 4, 6, 8, 10, 240]), 7);

/* ══ 2 · the matrix, worked by hand ══════════════════════════════════
   Right POC → Discovery. now is Mon 2026-09-28.

   Priya, closed:   5  7  9 11 20     n=5  median 9   p75 = s[3] = 11
   Rubal, closed:   2  4  6  8 10 12  n=6  median 7   p75 = s[4] = 10
   Neha,  closed:   1  2               n=2  THIN
   team:  1 2 2 4 5 6 7 8 9 10 11 12 20   n=13 median = s[6] = 7
                                           p75 = ceil(9.75) = s[9] = 10
   so Priya is +2 on the team and Rubal is level.

   Priya open:  one from 2026-08-01 (58 days, past the 30-day gate)
                one from 2026-09-20 (8 days, not yet)               */
const NOW = Date.parse("2026-09-28T10:00:00Z");

const LADDER = [
  ...arr("P1", "Priya", { right: "2026-08-03", discovery: "2026-08-08" }),   /*  5 */
  ...arr("P2", "Priya", { right: "2026-08-03", discovery: "2026-08-10" }),   /*  7 */
  ...arr("P3", "Priya", { right: "2026-08-04", discovery: "2026-08-13" }),   /*  9 */
  ...arr("P4", "Priya", { right: "2026-08-05", discovery: "2026-08-16" }),   /* 11 */
  /* Priya found them, RUBAL ran the discovery. A handoff, and the one row in
     the fixture whose owner depends on the attribution policy. */
  { metric: "right",     company: "P5", owner: "Priya", at: "2026-08-06T10:00:00Z" },
  { metric: "discovery", company: "P5", owner: "Rubal", at: "2026-08-26T10:00:00Z" }, /* 20 */
  ...arr("P6", "Priya", { right: "2026-08-01" }),                            /* open, 58 */
  ...arr("P7", "Priya", { right: "2026-09-20" }),                            /* open,  8 */

  ...arr("R1", "Rubal", { right: "2026-08-03", discovery: "2026-08-05" }),   /*  2 */
  ...arr("R2", "Rubal", { right: "2026-08-04", discovery: "2026-08-08" }),   /*  4 */
  ...arr("R3", "Rubal", { right: "2026-08-05", discovery: "2026-08-11" }),   /*  6 */
  ...arr("R4", "Rubal", { right: "2026-08-06", discovery: "2026-08-14" }),   /*  8 */
  ...arr("R5", "Rubal", { right: "2026-08-07", discovery: "2026-08-17" }),   /* 10 */
  ...arr("R6", "Rubal", { right: "2026-08-10", discovery: "2026-08-22" }),   /* 12 */

  ...arr("N1", "Neha",  { right: "2026-08-03", discovery: "2026-08-04" }),   /*  1 */
  ...arr("N2", "Neha",  { right: "2026-08-05", discovery: "2026-08-07" }),   /*  2 */
];

console.log("\nthe matrix — Right POC -> Discovery, by BD");
{
  const m = tatMatrix({ arrivals: LADDER, now: NOW, pairs: RD });
  eq("everybody who owns a step has a row", m.bds, ["Neha", "Priya", "Rubal"]);

  const P = m.byBd.Priya.rightToDiscovery;
  eq("Priya closed five", P.n, 5);
  eq("Priya's median is 9", P.median, 9);
  eq("and her p75 is 11", P.p75, 11);
  eq("she has two still waiting", P.waiting, 2);
  eq("the oldest has sat 58 days", P.waitingOldest, 58);
  eq("and it is P6", P.waitingOldestCompany, "P6");
  eq("one of the two is past the 30-day gate", P.overdue, 1);
  eq("her slowest conversion was P5 at 20 days", P.worst, { company: "P5", days: 20 });
  eq("one of her five changed hands", P.handoffRate, 1 / 5);

  const R = m.byBd.Rubal.rightToDiscovery;
  eq("Rubal closed six", R.n, 6);
  eq("median 7", R.median, 7);
  eq("p75 10", R.p75, 10);
  eq("nothing of his is waiting", R.waiting, 0);
  eq("so nothing is overdue", R.overdue, 0);

  eq("the team median is 7 over thirteen", [m.team.rightToDiscovery.median,
                                            m.team.rightToDiscovery.n], [7, 13]);
  eq("team p75 is 10", m.team.rightToDiscovery.p75, 10);

  /* THE POINT OF THE GRID. A cell on its own is a fact with no scale; the
     comparison is the only part anybody can act on. */
  eq("Priya is two days slower than the team", P.vsTeam, 2);
  eq("Rubal is level with it", R.vsTeam, 0);

  /* REFUSAL 3. Neha has a median — 1.5 — and it is not published as a
     comparison, because a median over two accounts is a coin flip with
     somebody's name on it. */
  const N = m.byBd.Neha.rightToDiscovery;
  eq("Neha's two accounts do give a median", N.median, 1.5);
  eq("but the cell is marked thin", N.thin, true);
  eq("and it makes no claim against the team", N.vsTeam, null);
  eq(`the line is at ${MIN_N}`, MIN_N, 5);
  eq("five is enough", P.thin, false);

  /* REFUSAL 1, in its smallest form: the two numbers travel together. */
  ok("every cell carries its backlog beside its median",
     Object.values(m.byBd).every((row) => "waiting" in row.rightToDiscovery));
}

console.log("\nwhose step was it — the attribution policy");
{
  const start = tatMatrix({ arrivals: LADDER, now: NOW, pairs: RD, attribute: "start" });
  const end = tatMatrix({ arrivals: LADDER, now: NOW, pairs: RD, attribute: "end" });

  /* P5 took 20 days. Priya found the POC; Rubal ran the call. */
  eq("held accountable: the 20-day account is Priya's",
     start.byBd.Priya.rightToDiscovery.n, 5);
  eq("credited: it is Rubal's", end.byBd.Rubal.rightToDiscovery.n, 7);
  eq("and Priya is left with four", end.byBd.Priya.rightToDiscovery.n, 4);
  /* WHICH MATTERS MORE THAN IT LOOKS. One handoff moves her across the
     publishing line, so the same team on the same month is rankable under one
     policy and not under the other. Pick one and say which. */
  eq("four is below the line, so her cell stops making a claim",
     end.byBd.Priya.rightToDiscovery.thin, true);
  eq("her median moves too", end.byBd.Priya.rightToDiscovery.median, 8);
  eq("Rubal's median moves the other way", end.byBd.Rubal.rightToDiscovery.median, 8);
  eq("the team is unaffected either way", end.team.rightToDiscovery.median,
     start.team.rightToDiscovery.median);

  /* Open steps under end-attribution fall to whoever holds the account now,
     which is why a row stops being one book of business. */
  const owners = { P6: "Neha", P7: "Neha" };
  const e2 = tatMatrix({ arrivals: LADDER, owners, now: NOW, pairs: RD, attribute: "end" });
  eq("an unfinished step belongs to whoever holds it now",
     e2.byBd.Neha.rightToDiscovery.waiting, 2);
  eq("while the conversions in that same row are somebody else's accounts",
     e2.byBd.Neha.rightToDiscovery.n, 2);
}

/* ══ 3 · Case 1 — created to first reachout, and the weekend ═════════
   Q1  Mon 14 -> Tue 15   1 calendar   1 working
   Q2  Fri 18 -> Mon 21   3 calendar   1 working   <- the whole argument
   Q3  Mon 14 -> Mon 21   7 calendar   5 working
   Q4  Tue 15 -> Tue 15   0            0
   Q5  Wed 16 -> Fri 18   2            2

   calendar sorted 0 1 2 3 7  -> median 2, p75 = s[3] = 3
   working  sorted 0 1 1 2 5  -> median 1, p75 = s[3] = 2               */
console.log("\nCase 1 — created -> first reachout");
{
  const created = { Q1: "2026-09-14T09:00:00Z", Q2: "2026-09-18T09:00:00Z",
                    Q3: "2026-09-14T09:00:00Z", Q4: "2026-09-15T09:00:00Z",
                    Q5: "2026-09-16T09:00:00Z" };
  const owners = { Q1: "Priya", Q2: "Priya", Q3: "Priya", Q4: "Priya", Q5: "Priya" };
  const worked = [
    ...arr("Q1", "Priya", { worked: "2026-09-15" }),
    ...arr("Q2", "Priya", { worked: "2026-09-21" }),
    ...arr("Q3", "Priya", { worked: "2026-09-21" }),
    ...arr("Q4", "Priya", { worked: "2026-09-15" }),
    ...arr("Q5", "Priya", { worked: "2026-09-18" }),
  ];

  const cal = tatMatrix({ arrivals: worked, created, owners, now: NOW, pairs: CW });
  eq("five leads, all reached", cal.byBd.Priya.createdToWorked.n, 5);
  eq("median 2 calendar days", cal.byBd.Priya.createdToWorked.median, 2);
  eq("p75 3", cal.byBd.Priya.createdToWorked.p75, 3);

  const wrk = tatMatrix({ arrivals: worked, created, owners, now: NOW, pairs: CW,
                          useWorkingDays: true });
  /* HALF THE NUMBER, and none of the work changed. On a step whose median is
     under a week the weekend IS the number, so the unit has to be on the
     screen — a team told it takes them "2 days" to touch a new lead when it
     takes them 1 working day will go and fix the wrong thing. */
  eq("median 1 working day", wrk.byBd.Priya.createdToWorked.median, 1);
  eq("p75 2", wrk.byBd.Priya.createdToWorked.p75, 2);
  eq("and the unit says so on the way out", wrk.unit, "working days");

  /* A lead nobody has touched: created, never worked. It is an open step from
     the moment it lands, which is the only way queue latency shows up at all —
     measure only the ones that got called and an untouched backlog is
     invisible. */
  const cold = tatMatrix({ arrivals: worked, now: NOW, pairs: CW,
                           created: { ...created, Q9: "2026-08-01T09:00:00Z" },
                           owners: { ...owners, Q9: "Priya" } });
  eq("an untouched lead counts as waiting", cold.byBd.Priya.createdToWorked.waiting, 1);
  eq("58 days of it", cold.byBd.Priya.createdToWorked.waitingOldest, 58);
  eq("well past the 3-day gate", cold.byBd.Priya.createdToWorked.overdue, 1);
  eq("and it did not touch the median of the ones that were called",
     cold.byBd.Priya.createdToWorked.median, 2);
}

/* ══ 4 · THE TRAP ════════════════════════════════════════════════════
   The reason refusal 1 exists, as a number.

   August: 10 accounts reach Right POC. 8 convert (5 8 10 12 15 18 22 28
           days), 2 never do.        median of the 8 = (12+15)/2 = 13.5
   September: 10 reach Right POC. Only 2 convert (3 and 5 days), 8 stall.
                                    median of the 2 = 4

   By the obvious calculation September is THREE TIMES FASTER than August.
   September is a catastrophe. The cohort rate says so: 80% -> 20%.          */
console.log("\nthe survivorship trap — the naive number improves as things collapse");
{
  const rows = [];
  const push = (id, right, disc) => {
    rows.push({ metric: "right", company: id, owner: "Priya", at: `${right}T10:00:00Z` });
    if (disc) rows.push({ metric: "discovery", company: id, owner: "Priya", at: `${disc}T10:00:00Z` });
  };
  /* August: healthy. */
  const aug = ["2026-08-08", "2026-08-11", "2026-08-13", "2026-08-15",
               "2026-08-18", "2026-08-21", "2026-08-25", "2026-08-31"];
  aug.forEach((d, i) => push(`A${i}`, "2026-08-03", d));
  push("A8", "2026-08-03", null);
  push("A9", "2026-08-03", null);
  /* September: two quick wins and eight corpses. */
  push("S0", "2026-09-01", "2026-09-04");
  push("S1", "2026-09-01", "2026-09-06");
  for (let i = 2; i < 10; i++) push(`S${i}`, "2026-09-01", null);

  const later = Date.parse("2026-11-01T00:00:00Z");
  const { gaps } = tatGaps({ arrivals: rows, now: later, pairs: RD });
  const closedIn = (mon) => gaps.filter((g) => !g.open && g.from.startsWith(mon)).map((g) => g.days);

  eq("August, counting only what converted", median(closedIn("2026-08")), 13.5);
  eq("September, same calculation", median(closedIn("2026-09")), 4);
  ok("so the naive number says September got three times faster",
     median(closedIn("2026-09")) < median(closedIn("2026-08")) / 3);

  /* The fixed denominator. It cannot be gamed by accounts dropping out,
     because the accounts that dropped out are the denominator. */
  const c = tatCohort({ arrivals: rows, pair: "rightToDiscovery", now: later });
  eq("two cohorts", c.map((m) => m.key), ["2026-08", "2026-09"]);
  eq("August: 8 of 10 inside 30 days", [c[0].arrived, c[0].hit, c[0].pct], [10, 8, 80]);
  eq("September: 2 of 10", [c[1].arrived, c[1].hit, c[1].pct], [10, 2, 20]);
  eq("and eight of September's are still sitting there", c[1].stillOpen, 8);
  ok("both cohorts have had the full 30 days, so both are a result",
     c[0].settled && c[1].settled);

  /* The same collapse visible on the matrix, without splitting by month: the
     backlog is where it shows. */
  const m = tatMatrix({ arrivals: rows, now: later, pairs: RD });
  eq("ten accounts converted in all", m.byBd.Priya.rightToDiscovery.n, 10);
  eq("and ten are stuck", m.byBd.Priya.rightToDiscovery.waiting, 10);
  eq("all ten past the gate", m.byBd.Priya.rightToDiscovery.overdue, 10);

  /* A month still inside the gate is a floor, not a finding. Asked on
     2026-09-15, September has had two weeks of a thirty-day gate and half its
     cohort has not had a chance yet — a chart that plots this as a result
     always shows a cliff at the right-hand edge. */
  const early = tatCohort({ arrivals: rows, pair: "rightToDiscovery",
                            now: Date.parse("2026-09-15T00:00:00Z") });
  eq("September is not settled two weeks in",
     early.find((m2) => m2.key === "2026-09").settled, false);
  eq("August, sixty days on, is", early.find((m2) => m2.key === "2026-08").settled, true);
}

/* ══ 5 · the faults that hide work ═══════════════════════════════════ */
console.log("\ndata faults are reported, never averaged and never clamped");
{
  const rows = [
    /* Discovery stamped BEFORE Right POC — what a backfill does when it dates
       "first discovery" from an old call and Right POC from last week. */
    ...arr("X1", "Priya", { right: "2026-09-10", discovery: "2026-09-01" }),
    /* A discovery with no Right POC before it. The ladder is missing a stamp;
       this is the shape of the KPI mismatch that started all of this. */
    ...arr("X2", "Priya", { discovery: "2026-09-05" }),
    ...arr("X3", "Priya", { right: "2026-09-01", discovery: "2026-09-08" }),   /* 7, sound */
  ];
  const m = tatMatrix({ arrivals: rows, now: NOW, pairs: RD });
  eq("only the sound row is counted", m.byBd.Priya.rightToDiscovery.n, 1);
  eq("its median is its own value", m.byBd.Priya.rightToDiscovery.median, 7);
  eq("the out-of-order one is reported", m.anomalies.negative, 1);
  eq("so is the one with no start", m.anomalies.orphan, 1);
  /* CLAMPING IS THE TEMPTING BUG. max(0, days) on X1 would add a zero to the
     list, pull the median down and read as the team getting faster. */
  ok("nothing was clamped to zero",
     !m.anomalies.detail.negative.some((n) => n.days >= 0));
}

/* ══ 6 · the work list — the only output that changes a Monday ═══════ */
console.log("\nthe work list");
{
  const list = tatWorkList({ arrivals: LADDER, now: NOW, pairs: RD });
  eq("one account is past its gate", list.length, 1);
  eq("and it names it, with how long and since when",
     [list[0].company, list[0].owner, list[0].days, list[0].gate], ["P6", "Priya", 58, 30]);
  eq("scoped to one person", tatWorkList({ arrivals: LADDER, now: NOW, pairs: RD, bd: "Rubal" }).length, 0);

  /* Longest first, because that is the order somebody works in. */
  const many = tatWorkList({ arrivals: [
    ...arr("Z1", "Priya", { right: "2026-08-20" }),   /* 39 */
    ...arr("Z2", "Priya", { right: "2026-06-01" }),   /* 119 */
    ...arr("Z3", "Priya", { right: "2026-07-15" }),   /* 75 */
  ], now: NOW, pairs: RD });
  eq("oldest first", many.map((r) => r.company), ["Z2", "Z3", "Z1"]);
}

/* ══ 7 · the gates come from one place ═══════════════════════════════ */
console.log("\nthresholds");
{
  /* Read out of RCA_GATES rather than restated, so the work list and the RCA
     queue cannot end up disagreeing about which accounts are late. */
  eq("Right POC -> Discovery is the RCA gate", TAT_PAIR.rightToDiscovery.gate, 30);
  eq("Discovery -> SQL is its two legs added up (21 + 14)", TAT_PAIR.discoveryToSql.gate, 35);
  ok("the composite one is flagged so nobody is judged on it",
     TAT_PAIR.createdToRight.composite);
  ok("and so is the planning one", TAT_PAIR.workedToSql.planning);
  ok("every pair has a gate", TAT_PAIRS.every((p) => Number.isFinite(p.gate) && p.gate > 0));
}

/* ══ 8 · SCALE ═══════════════════════════════════════════════════════
   The account is ~10,000 companies today. This runs it at 100,000 across
   eight BDs and all six pairs, because the question is not whether it works
   at the current size but whether it will still be the same page in a year.
   Two things are checked, and the second matters more:

     - it stays inside a time budget, and
     - THE ANSWER IS STILL RIGHT. A planted sub-population with a median
       known by construction goes in among the noise; if the arithmetic
       drifts under load, or a bucket key collides, this is what catches it.
       A scale test that only measures a stopwatch tells you how fast you got
       the wrong number. */
const SCALE = Number(process.argv[process.argv.indexOf("--scale") + 1]) || 100000;

console.log(`\nscale — ${SCALE.toLocaleString()} companies, 8 BDs, ${TAT_PAIRS.length} pairs`);
{
  /* Deterministic, so a failure is reproducible and a timing regression is
     not just a different random shape. */
  const mulberry = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const BDS = ["Aarav", "Charu", "Devansh", "Neha", "Priya", "Ridhima", "Rubal", "Vikram"];
  const BASE = Date.parse("2026-01-01T00:00:00Z");
  const DAYMS = 86400000;
  const iso = (d) => new Date(BASE + d * DAYMS).toISOString();

  const build = (n, seed = 1) => {
    const rnd = mulberry(seed);
    const arrivals = [];
    const created = Object.create(null);
    const owners = Object.create(null);
    for (let i = 0; i < n; i++) {
      const id = `C${i}`;
      const owner = BDS[i % BDS.length];
      owners[id] = owner;
      const c = Math.floor(rnd() * 200);
      created[id] = iso(c);
      /* A funnel that leaks, so most companies stop part-way and the open
         steps — the expensive half — are the majority, as they are in life. */
      let at = c + Math.floor(rnd() * 6);
      arrivals.push({ metric: "worked", company: id, owner, at: iso(at) });
      if (rnd() < 0.55) {
        at += 1 + Math.floor(rnd() * 25);
        arrivals.push({ metric: "right", company: id, owner, at: iso(at) });
        if (rnd() < 0.45) {
          at += 1 + Math.floor(rnd() * 40);
          arrivals.push({ metric: "discovery", company: id, owner, at: iso(at) });
          if (rnd() < 0.35) {
            at += 1 + Math.floor(rnd() * 30);
            arrivals.push({ metric: "sql", company: id, owner, at: iso(at) });
          }
        }
      }
    }
    return { arrivals, created, owners };
  };

  /* THE PLANT. Zara owns nothing else, and her 999 Right POC -> Discovery
     steps are exactly 1..999 days.
       median of 1..999 = the 500th value = 500
       p75             = ceil(0.75 * 999) = 750th value = 750           */
  const plant = (bag) => {
    for (let k = 1; k <= 999; k++) {
      const id = `ZARA${k}`;
      bag.owners[id] = "Zara";
      bag.created[id] = iso(0);
      /* `worked` too, or every one of these is an orphan on workedToRight —
         which the first run of this test duly reported, 999 of them. The
         anomaly counter earning its keep on its own fixture. */
      bag.arrivals.push({ metric: "worked", company: id, owner: "Zara", at: iso(0) });
      bag.arrivals.push({ metric: "right", company: id, owner: "Zara", at: iso(0) });
      bag.arrivals.push({ metric: "discovery", company: id, owner: "Zara", at: iso(k) });
    }
    return bag;
  };

  const big = plant(build(SCALE));
  console.log(`  built ${big.arrivals.length.toLocaleString()} arrivals`);

  const before = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const m = tatMatrix({ arrivals: big.arrivals, created: big.created, owners: big.owners,
                        now: Date.parse("2027-01-01T00:00:00Z") });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const mb = (process.memoryUsage().heapUsed - before) / 1048576;
  console.log(`  matrix in ${ms.toFixed(0)} ms, +${mb.toFixed(0)} MB heap`);

  /* Correctness first. */
  const Z = m.byBd.Zara.rightToDiscovery;
  eq("the planted median survives 100k rows of noise around it", Z.median, 500);
  eq("and so does the planted p75", Z.p75, 750);
  eq("with the right count", Z.n, 999);
  eq("nine BDs in all", m.bds.length, BDS.length + 1);
  eq("no arithmetic faults in generated data", [m.anomalies.negative, m.anomalies.orphan], [0, 0]);
  ok("every pair produced a team cell",
     TAT_PAIRS.every((p) => m.team[p.key] && m.team[p.key].n > 0));
  /* The funnel leaks, so on the deeper steps most of the population is OPEN —
     and those are precisely the rows a completed-only calculation throws
     away. The generator sends 24.75% of companies to discovery and 35% of
     those on to SQL, so this cell is roughly 8.7% closed against 16.1% open
     whatever SCALE is set to. (rightToDiscovery is closed-heavy at small n,
     because the 999 planted rows are a large share of it — which is why the
     assertion is on this pair and not that one.) */
  ok("on the deeper steps the backlog is the bigger half, as it is in life",
     m.team.discoveryToSql.waiting > m.team.discoveryToSql.n);

  /* Then the stopwatch. Generous, because CI machines vary; it is here to
     catch an order-of-magnitude regression, not to police milliseconds. */
  const budget = Math.max(1500, SCALE / 20);
  ok(`inside the ${budget.toFixed(0)} ms budget (took ${ms.toFixed(0)})`, ms < budget);

  /* AND THAT IT IS LINEAR. A time budget alone passes happily on a quadratic
     implementation until the day the account doubles. Four times the rows
     must not be sixteen times the work. */
  const small = plant(build(Math.floor(SCALE / 4), 2));
  const runOf = (bag) => {
    const t = process.hrtime.bigint();
    tatMatrix({ arrivals: bag.arrivals, created: bag.created, owners: bag.owners,
                now: Date.parse("2027-01-01T00:00:00Z") });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const tSmall = Math.min(runOf(small), runOf(small));
  const tBig = Math.min(runOf(big), runOf(big));
  const ratio = tBig / Math.max(tSmall, 1);
  console.log(`  n/4 in ${tSmall.toFixed(0)} ms, n in ${tBig.toFixed(0)} ms — ratio ${ratio.toFixed(1)}x`);
  ok(`4x the rows costs well under 16x the time (${ratio.toFixed(1)}x)`, ratio < 8);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
