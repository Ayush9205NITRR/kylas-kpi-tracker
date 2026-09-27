#!/usr/bin/env node
/* Turning "this step is slow" into "do this, to these accounts, today".
 *
 *   node scripts/test-diagnose.mjs
 *
 * The fixtures are five accounts that all took EXACTLY THE SAME NUMBER OF
 * DAYS and need five different fixes. If the buckets cannot tell them apart,
 * the whole file is just a slower way to print a median.
 */
import { TAT_PAIR } from "./tat.mjs";
import { diagnose, bottlenecks, activityIn, classify,
         ABANDON_DAYS, CHASING_MIN } from "./diagnose.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

const RD = [TAT_PAIR.rightToDiscovery];
const NOW = Date.parse("2026-09-28T12:00:00Z");
const right = (co, d) => ({ metric: "right", company: co, owner: "Priya", at: `${d}T10:00:00Z` });
const disc = (co, d) => ({ metric: "discovery", company: co, owner: "Priya", at: `${d}T10:00:00Z` });
const call = (co, d, outcome = "No answer") => ({ company: co, at: `${d}T11:00:00Z`, outcome });

/* ══ 1 · the decomposition ═══════════════════════════════════════════
   Right POC on the 1st, discovery on the 21st — twenty days. Called on the
   2nd and again on the 20th.

     |  1 day  |            17 days             | 1 day |
     ^ right   ^ call                     call ^       ^ discovery

   Two touches and eighteen of the twenty days silent. A median of "20 days"
   says the step is slow; this says nobody called for two and a half weeks,
   which is a different meeting entirely.                                   */
console.log("splitting a wait into what we were actually doing");
{
  const days = [{ day: Math.floor(Date.parse("2026-08-02T11:00:00Z") / 86400000), connected: false },
                { day: Math.floor(Date.parse("2026-08-20T11:00:00Z") / 86400000), connected: true }];
  const a = activityIn(days, "2026-08-01T10:00:00Z", "2026-08-21T10:00:00Z");
  eq("the whole step took 20 days", a.span, 20);
  eq("touched on two days", a.touches, 2);
  eq("one of them connected", a.connects, 1);
  eq("a day passed before anybody reacted", a.leadingSilence, 1);
  eq("the longest silence inside it was 18 days", a.longestSilence, 18);
  eq("and it closed the day after the last call", a.trailingSilence, 1);
  eq("so 90% of the wait was nothing happening", a.deadShare, 0.9);

  /* Five dials in one afternoon is one attempt. The silence either side of
     them is unchanged, which is the point — activity is not progress. */
  const burst = ["09:00", "09:05", "09:12", "09:30", "16:00"].map((t) => ({
    day: Math.floor(Date.parse(`2026-08-02T${t}:00Z`) / 86400000), connected: false }));
  const b = activityIn(burst, "2026-08-01T10:00:00Z", "2026-08-21T10:00:00Z");
  eq("five dials in a day is five calls", b.calls, 5);
  eq("but one touch", b.touches, 1);
  eq("and the 19 days of silence after them are still there", b.trailingSilence, 19);
}

/* ══ 2 · five accounts, same elapsed time, five different problems ══ */
console.log("\nsame number of days, different fix");
{
  const arrivals = [], calls = [];
  /* All five reached Right POC on 1 September and none has converted. On
     2026-09-28 every one of them is 27 days old. The MATRIX CANNOT TELL THEM
     APART — it sees five identical rows. */
  for (const co of ["Cold", "Dropped", "Chased", "Talking", "Parked"])
    arrivals.push(right(co, "2026-09-01"));

  /* Cold    — nobody has called it once. */
  /* Dropped — worked hard for three days, then silence for three weeks. */
  calls.push(call("Dropped", "2026-09-01"), call("Dropped", "2026-09-02"),
             call("Dropped", "2026-09-03", "Right POC"));
  /* Chased  — dialled nine times across three weeks, never once picked up. */
  for (const d of ["02","04","07","09","11","15","18","22","26"])
    calls.push(call("Chased", `2026-09-${d}`));
  /* Talking — real conversations, recent, and still no meeting. */
  for (const d of ["03","10","17","25"])
    calls.push(call("Talking", `2026-09-${d}`, "Right POC"));
  /* Parked  — they asked us to come back after their event. */
  calls.push(call("Parked", "2026-09-02", "Right POC"));

  const rca = [{ company: "Parked", from: "right", to: "discovery", reason: "NO_EVENT_PLANNED" },
               { company: "Dropped", from: "right", to: "discovery", reason: "MY_FOLLOW_UP_SLIPPED" }];
  const [d] = diagnose({ arrivals, calls, rca, now: NOW, pairs: RD,
                         owners: Object.fromEntries(arrivals.map((a) => [a.company, "Priya"])) });

  eq("all five are the same age", [...new Set(d.rows.map((r) => r.days))], [27]);
  const bucketOf = (co) => d.rows.find((r) => r.company === co).bucket;
  eq("nobody called it",              bucketOf("Cold"), "neverTouched");
  eq("started and stopped",           bucketOf("Dropped"), "abandoned");
  eq("dialling, never connecting",    bucketOf("Chased"), "chasing");
  eq("talking, not converting",       bucketOf("Talking"), "engaged");
  eq("they asked for time",           bucketOf("Parked"), "waitingOnThem");

  /* AND THE ONE THAT MATTERS MOST. A stated reason beats anything inferred
     from dial counts: Parked has been silent for 26 days and would look
     exactly like Dropped, except that they told us to wait. Getting this
     backwards puts a correctly-parked account on somebody's failure list,
     and that is how a team stops trusting the page. */
  eq("a client-side reason outranks the silence it caused",
     d.rows.find((r) => r.company === "Parked").activity.trailingSilence >= ABANDON_DAYS, true);

  /* Dropped said "my follow-up slipped" IN ITS RCA, which is the associate
     agreeing with the bucket in their own words. Nothing has ever counted
     these. */
  eq("the RCA answers are aggregated, finally",
     d.rcaReasons.map((r) => r.code).sort(), ["MY_FOLLOW_UP_SLIPPED", "NO_EVENT_PLANNED"]);
}

/* ══ 3 · the horizon — the one that would wreck this in production ══
   Call Log is pruned at 30 days and the rollup that replaces it keeps no
   contact link. So for anything older than that there are no calls to find,
   and "no calls found" looks exactly like "nobody called".

   Without the guard, every account older than a month reads NEVER TOUCHED,
   the page declares a catastrophe, and the first person to open one of those
   accounts and see nine logged calls stops believing any of it.            */
console.log("\nwhen the call history does not reach back that far");
{
  const arrivals = [right("Ancient", "2026-06-01"), right("Recent", "2026-09-10"),
                    disc("Recent", "2026-09-20")];
  /* The log only goes back to 1 September — everything before was pruned. */
  const calls = [call("Recent", "2026-09-11"), call("Recent", "2026-09-19", "Discovery")];
  const [d] = diagnose({ arrivals, calls, now: NOW, pairs: RD,
                         owners: { Ancient: "Priya", Recent: "Priya" } });

  eq("the old one is not accused of anything",
     d.rows.find((r) => r.company === "Ancient").bucket, "unknown");
  eq("the recent one is diagnosed normally",
     d.rows.find((r) => r.company === "Recent").bucket, "working");
  eq("and the page says how much of the step it can actually see", d.coverage, 50);
  eq("naming the number it cannot", d.uncovered, 1);
  /* The decisive one: an uncovered row must not reach a median, or the page
     invents a silence that nobody can check. */
  eq("the old one is kept out of the arithmetic entirely", d.inFlight, 0);

  /* And stated explicitly, the horizon can be overridden — after a prune the
     oldest surviving row IS the horizon and nothing records where it was. */
  const [d2] = diagnose({ arrivals, calls, now: NOW, pairs: RD,
                          callsFrom: "2026-01-01T00:00:00Z",
                          owners: { Ancient: "Priya", Recent: "Priya" } });
  eq("told the history is complete, it will diagnose the old one",
     d2.rows.find((r) => r.company === "Ancient").bucket, "neverTouched");
}

/* ══ 4 · the ranked answer ══════════════════════════════════════════ */
console.log("\nwhere to look first");
{
  const arrivals = [], calls = [];
  /* One step with a handful of stalls, another with a pile of them. Ranked by
     ACCOUNTS AT RISK and not by median days, because a bad median over three
     accounts is a statistic and twelve rotting accounts is the bottleneck. */
  for (let i = 0; i < 12; i++) {
    arrivals.push(right(`R${i}`, "2026-08-20"));
    calls.push(call(`R${i}`, "2026-08-21"));         /* touched once, then dropped */
  }
  for (let i = 0; i < 3; i++) {
    arrivals.push(right(`D${i}`, "2026-08-01"), disc(`D${i}`, "2026-08-05"));
    calls.push(call(`D${i}`, "2026-08-02"), call(`D${i}`, "2026-08-04", "Discovery"),
               call(`D${i}`, "2026-09-26", "Discovery"));
  }
  const owners = Object.fromEntries(arrivals.map((a) => [a.company, "Priya"]));
  const ranked = bottlenecks(diagnose({ arrivals, calls, now: NOW, owners }));

  eq("Right POC → Discovery is the bottleneck", ranked[0].pair, "rightToDiscovery");
  eq("twelve accounts of ours are in it", ranked[0].atRisk, 12);
  eq("and it names the cause, not just the delay", ranked[0].causeKey, "abandoned");
  ok("with something to actually do", /cadence/i.test(ranked[0].action));
  ok("and somebody to start with", ranked[0].who[0].name === "Priya");
  /* Composite and planning pairs are excluded: nobody can act on a sum. */
  ok("no planning numbers in the ranking",
     !ranked.some((r) => r.pair === "workedToSql" || r.pair === "createdToRight"));
}

/* ══ 5 · the thresholds ═════════════════════════════════════════════ */
console.log("\nthresholds");
{
  const g = { pair: "rightToDiscovery", open: true, days: 20 };
  const act = (o) => ({ touches: 1, connects: 0, trailingSilence: 0, ...o });
  eq(`a week of silence is abandonment (${ABANDON_DAYS}d)`,
     classify(g, act({ trailingSilence: ABANDON_DAYS })), "abandoned");
  eq("a day less is not", classify(g, act({ trailingSilence: ABANDON_DAYS - 1 })), "working");
  eq(`${CHASING_MIN} unanswered attempts is a reach problem`,
     classify(g, act({ touches: CHASING_MIN })), "chasing");
  eq("two is just two calls", classify(g, act({ touches: 2 })), "working");
  eq("no data means no accusation", classify(g, act(), "", false), "unknown");
  /* A closed step inside its gate is simply fine, however it got there. */
  eq("a step that finished in time is not a finding",
     classify({ pair: "rightToDiscovery", open: false, days: 9 }, act()), "working");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
