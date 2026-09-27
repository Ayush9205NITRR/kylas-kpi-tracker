/* Why the funnel is slow, not just where.
 *
 * Ayush, 2026-09-27: "this should help me focus very quickly on WHY the funnel
 * is not moving fast — where things are, rather than just 'we are stuck'.
 * [The matrix] does not give me enough quality input to act upon."
 *
 * Correct. "Priya is +3.5 days on Right POC -> Discovery" is a finding with no
 * action attached. It could mean five completely different things and each one
 * needs a different fix:
 *
 *   nobody called it for nine days        -> a cadence problem
 *   we called eight times, nobody picked  -> a contactability problem
 *   we spoke three times, no meeting      -> the ask is weak
 *   they said "call me next month"        -> not a problem at all
 *   it was booked and slipped twice       -> a confirmation problem
 *
 * The elapsed time is identical in all five. The number cannot tell them
 * apart, so the number cannot be acted on. THAT is what this file adds.
 *
 * ── THE IDEA ─────────────────────────────────────────────────────────
 * A gap between two rungs is not one thing. Split it by what we were actually
 * doing during it, which Call Log already records:
 *
 *   0 ─── first touch ─── touch ── touch ─────────────── now
 *     ^^^^^^^^^^^^^^^                    ^^^^^^^^^^^^^^^
 *     reaction lag                        trailing silence
 *
 * DEAD TIME IS THE HEADLINE. If a nine-day median contains six days when
 * nobody called, the funnel is not slow because selling is hard — it is slow
 * because nobody called. That is a rota problem with a one-week fix, and it is
 * invisible on any chart of elapsed time.
 *
 * ── AND THEN THE BUCKETS ─────────────────────────────────────────────
 * Every open gap lands in exactly one bucket, and every bucket names one
 * action. A dashboard that ranks buckets by size is a dashboard that answers
 * "what do I do on Monday" instead of "how are we doing".
 *
 * Pure functions over plain data, same as tat.mjs. Nothing here reads
 * Airtable.
 */

import { TAT_PAIRS, TAT_PAIR, tatGaps, median, p75 } from "./tat.mjs";

const DAY = 86400000;
const dayNumber = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / DAY) : NaN;
};

/* How long a touched account may go quiet before the silence is the finding
   rather than the schedule. Deliberately short: at a 30-day gate, a week of
   nothing is a third of the account's remaining life. */
export const ABANDON_DAYS = 7;

/* Enough dials to say we tried. Below this, "they never picked up" is not yet
   a contactability finding — it is two calls. */
export const CHASING_MIN = 3;

/* RCA reasons that put the ball in THEIR court. An account waiting on a client
   is not a performance problem and must not be counted as one; the team will
   stop trusting the page the first time a legitimately parked account appears
   on a list of their failures.

   Kept as a set here rather than a flag in rca-reasons.json only because that
   file is generated and this is a reading of it, not a property of it. */
export const THEIR_COURT = new Set([
  "AWAITING_CLIENT_INPUTS", "DATES_NOT_FIXED", "NO_EVENT_PLANNED",
  "NEEDS_SENIOR_BUY_IN", "BUDGET_NOT_SIGNED_OFF", "DECISION_DEFERRED",
  "EVENT_POSTPONED",
]);

/* Reasons that say, in the associate's own words, that the delay was ours.
   MY_FOLLOW_UP_SLIPPED is the single most useful code in the whole RCA set
   and nothing has ever counted it. */
export const OUR_FAULT = new Set(["MY_FOLLOW_UP_SLIPPED", "PROPOSAL_PENDING_OUR_SIDE"]);

/* ── THE BUCKETS ──────────────────────────────────────────────────────
   Ordered: the FIRST match wins, and the order encodes what overrides what.
   `waitingOnThem` is first because a stated reason beats anything inferred
   from dial counts — if they told us to call in November, the silence since
   is correct behaviour and not an abandonment. */
export const BUCKETS = [
  { key: "unknown", label: "No call history for this window",
    finding: "This step began before the Call Log reaches back to, so there is nothing to read.",
    action: "Not a finding about the account. It is the 30-day prune — see CALL_RETAIN_DAYS, and the durable per-contact counters in docs/exhaustion.md §3.",
    fault: "data-gap" },

  { key: "waitingOnThem", label: "Waiting on the client",
    finding: "They asked for time, or something of theirs is not ready.",
    action: "Nothing. Set the date and get it off the list until then.",
    fault: "theirs" },

  { key: "neverTouched", label: "Never touched since it got here",
    finding: "It reached this rung and nobody has called it once.",
    action: "This is a queue and rota problem, not a selling one. Fix the list before anything else.",
    fault: "ours" },

  { key: "abandoned", label: "Started, then dropped",
    finding: "Somebody worked it and then stopped for over a week.",
    action: "Follow-up cadence. Usually the single biggest number on this page, and the cheapest to fix.",
    fault: "ours" },

  { key: "chasing", label: "Dialling, never connecting",
    finding: "Plenty of attempts, nobody has ever picked up.",
    action: "Not effort — reach. Change the time of day, the number, or the contact. Check whether another contact on the account has ever answered.",
    fault: "data" },

  { key: "engaged", label: "Talking, not converting",
    finding: "We have had real conversations and it still has not moved.",
    action: "This is the only bucket that is actually about selling. The ask at the end of the call, or the offer.",
    fault: "skill" },

  { key: "working", label: "In hand, not yet due",
    finding: "Touched recently, still inside the gate.",
    action: "Nothing. This is what a healthy account in flight looks like.",
    fault: "none" },
];

export const BUCKET = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

/* ── ACTIVITY INSIDE ONE GAP ──────────────────────────────────────────
   calls: [{ company, at, outcome }] — Call Log, joined up to the company.
   Outcome "No answer" is the one that does not count as a connect; every
   other outcome means somebody spoke, which is the same rule report.mjs uses
   for `connects`. Two definitions of "connected" is how Phone Picked once
   read 100%. */
const NO_ANSWER = "No answer";

export function activityIn(callDays, fromISO, endISO) {
  const d0 = dayNumber(fromISO), d1 = dayNumber(endISO);
  const span = Math.max(0, d1 - d0);
  const inWindow = callDays.filter((c) => c.day >= d0 && c.day <= d1);

  const touchDays = [...new Set(inWindow.map((c) => c.day))].sort((a, b) => a - b);
  const connects = inWindow.filter((c) => c.connected).length;

  /* The silences, including the one before the first touch and the one after
     the last. Both ends matter and for different reasons: the leading gap is
     how long the account sat unnoticed after it arrived, the trailing gap is
     how long it has been ignored as of right now — and the trailing one is
     the only number on this page that is still getting worse while you read
     it. */
  let longest = span, leading = span, trailing = span;
  if (touchDays.length) {
    leading = touchDays[0] - d0;
    trailing = d1 - touchDays[touchDays.length - 1];
    longest = Math.max(leading, trailing);
    for (let i = 1; i < touchDays.length; i++)
      longest = Math.max(longest, touchDays[i] - touchDays[i - 1]);
  }

  return {
    calls: inWindow.length,
    touches: touchDays.length,     /* DAYS touched, not dials — five dials in
                                      ten minutes is one attempt */
    connects,
    span,
    leadingSilence: leading,
    trailingSilence: trailing,
    longestSilence: longest,
    /* The share of the wait during which nothing at all was happening. The
       number that turns "9 days" into "9 days, 6 of them silent". */
    deadShare: span > 0 ? Math.round((longest / span) * 100) / 100 : 0,
  };
}

/* ── ONE GAP, DIAGNOSED ───────────────────────────────────────────────
   Returns the gap with `activity`, `bucket` and `reason` attached. */
export function classify(gap, act, rcaReason = "", covered = true) {
  /* THE GUARD THAT MATTERS MOST IN PRODUCTION. Call Log is pruned at
     CALL_RETAIN_DAYS (30) and the rollup that replaces it keeps no contact
     link, so for any gap that began before the call history starts there is
     no activity to read — and "no calls found" is indistinguishable from
     "nobody called". Without this, every account older than a month reads as
     NEVER TOUCHED, the dashboard declares a catastrophe, and the first person
     to check one of those accounts by hand stops believing the page.

     So a gap outside the horizon is not diagnosed. It is counted, named, and
     left out of every share and median. An honest gap in the data beats a
     confident wrong answer. */
  if (!covered) return "unknown";
  if (rcaReason && THEIR_COURT.has(rcaReason)) return "waitingOnThem";
  /* A closed gap is history; it is bucketed only so the same function can
     describe how it went. Only open gaps are work. */
  if (!gap.open && gap.days <= (TAT_PAIR[gap.pair]?.gate ?? Infinity)) return "working";
  if (!act.touches) return "neverTouched";
  if (gap.open && act.trailingSilence >= ABANDON_DAYS) return "abandoned";
  if (act.touches >= CHASING_MIN && act.connects === 0) return "chasing";
  if (act.connects >= 1) return "engaged";
  return "working";
}

/* ── THE WHOLE PICTURE ────────────────────────────────────────────────
   arrivals / created / owners : as tat.mjs takes them
   calls   : [{ company, at, outcome }]
   rca     : [{ company, gate, reason }] — the answers already in the RCA
             table, which nothing has ever aggregated

   Returns, per pair:
     { pair, label, gate, inFlight, closed,
       medianDays, medianDeadDays, deadShare,
       buckets: [{ key, n, share, days, owners }],
       byOwner: { [bd]: { [bucketKey]: n } },
       rcaReasons: [{ code, n }],
       worst: [ the named accounts ] }                                   */
export function diagnose({ arrivals = [], created = {}, owners = {}, calls = [],
                           rca = [], now = Date.now(), pairs = TAT_PAIRS,
                           attribute = "start", callsFrom = null } = {}) {
  const { gaps } = tatGaps({ arrivals, created, owners, now, attribute, pairs });

  /* How far back the call history actually reaches. Taken from the data
     unless the caller states it, because the caller usually cannot: after a
     prune, the oldest surviving row IS the horizon and nothing records where
     it used to be. */
  const horizon = callsFrom
    ? dayNumber(callsFrom)
    : calls.reduce((lo, c) => {
        const d = dayNumber(c.at);
        return Number.isFinite(d) && (lo === null || d < lo) ? d : lo;
      }, null);

  /* Calls bucketed by company once, with the day number and connectedness
     precomputed — otherwise every gap re-parses every call and six pairs over
     a real account is a million Date.parse calls. */
  const byCompany = new Map();
  for (const c of calls) {
    const day = dayNumber(c.at);
    if (!Number.isFinite(day) || !c.company) continue;
    let list = byCompany.get(c.company);
    if (!list) byCompany.set(c.company, (list = []));
    list.push({ day, connected: (c.outcome || "") !== NO_ANSWER && !!c.outcome });
  }

  /* RCA answers, keyed company|gate. The RCA gates are named by rung pair
     ("right" -> "discovery"), which is the same pairing this file uses, so
     they join without a translation table. */
  const rcaBy = new Map();
  for (const r of rca) {
    if (!r.company || !r.reason) continue;
    rcaBy.set(`${r.company}|${r.from || ""}|${r.to || ""}`, r.reason);
    rcaBy.set(`${r.company}|${r.gate || ""}`, r.reason);
  }

  const out = [];
  for (const p of pairs) {
    const mine = gaps.filter((g) => g.pair === p.key);
    if (!mine.length) continue;

    const rows = mine.map((g) => {
      const act = activityIn(byCompany.get(g.company) || [], g.from,
                             g.to || new Date(now).toISOString());
      const reason = rcaBy.get(`${g.company}|${p.from}|${p.to}`) || "";
      /* Covered when the window began at or after the call history starts —
         OR when it contains calls at all, which settles it regardless: a
         window with calls in it is a window we plainly have data for.

         That second clause is not a softening, it is the boundary case. The
         derived horizon is the EARLIEST SURVIVING CALL, which is a lower
         bound on where the log really starts, not the log's start: an
         account that reached the rung a day before the first retained call
         is covered, and without this clause the oldest account in every
         export is excluded for no reason. Pass `callsFrom` (the retention
         boundary — now minus CALL_RETAIN_DAYS) to settle it exactly. */
      const covered = horizon !== null
        && (dayNumber(g.from) >= horizon || act.touches > 0);
      return { ...g, activity: act, rcaReason: reason, covered,
               bucket: classify(g, act, reason, covered) };
    });

    /* Everything below is computed over covered rows only. An uncovered row
       cannot say anything about silence, so letting one into a median would
       be inventing a number. */
    const known = rows.filter((r) => r.covered);
    const open = known.filter((r) => r.open);
    const closed = known.filter((r) => !r.open);
    const uncovered = rows.length - known.length;

    /* THE HEADLINE PAIR OF NUMBERS. How long the step takes, and how much of
       that was nothing happening. Taken over CLOSED gaps so it describes a
       completed step rather than a backlog.

       Except on created -> first reachout, where the step ENDS at the first
       call, so the whole of it is silent by definition and "100% dead" is a
       tautology rather than a finding. The wait itself is the finding there,
       and the matrix already reports it. */
    const tautological = p.from === "created" && p.to === "worked";
    const medianDays = median(closed.map((r) => r.days));
    const medianDead = tautological ? null : median(closed.map((r) => r.activity.longestSilence));
    const medianTouches = median(closed.map((r) => r.activity.touches));

    /* Buckets over the OPEN gaps: that is the work. A bucket over closed ones
       would be a history lesson. */
    const counts = new Map();
    for (const r of open) {
      let b = counts.get(r.bucket);
      if (!b) counts.set(r.bucket, (b = { key: r.bucket, n: 0, days: [], owners: new Map() }));
      b.n++;
      b.days.push(r.days);
      b.owners.set(r.owner || "—", (b.owners.get(r.owner || "—") || 0) + 1);
    }

    const buckets = BUCKETS
      .filter((b) => counts.has(b.key))
      .map((b) => {
        const c = counts.get(b.key);
        return {
          ...b, n: c.n,
          share: open.length ? Math.round((c.n / open.length) * 100) : 0,
          medianDays: median(c.days),
          oldest: Math.max(...c.days),
          /* Who it is concentrated in. A bucket that is one person is a
             coaching conversation; a bucket spread across everybody is a
             process problem, and confusing the two wastes both. */
          owners: [...c.owners.entries()].sort((x, y) => y[1] - x[1])
            .map(([name, n]) => ({ name, n })),
        };
      })
      .sort((a, b) => b.n - a.n);

    const reasons = new Map();
    for (const r of rows) if (r.rcaReason) reasons.set(r.rcaReason, (reasons.get(r.rcaReason) || 0) + 1);

    out.push({
      pair: p.key, label: p.label, gate: p.gate,
      composite: !!p.composite, planning: !!p.planning,
      inFlight: open.length, closed: closed.length,
      /* Said out loud on every step, because a page that quietly measures
         half the account and presents it as all of it is worse than no page.
         `coverage` is the share of this step's gaps the call history can
         actually speak to. */
      uncovered,
      coverage: rows.length ? Math.round(((rows.length - uncovered) / rows.length) * 100) : null,
      medianDays, p75Days: p75(closed.map((r) => r.days)),
      medianDeadDays: medianDead, medianTouches,
      /* "Of the nine days this step takes, six are silent." */
      deadShare: medianDays > 0 && medianDead !== null
        ? Math.round((medianDead / medianDays) * 100) : null,
      overdue: open.filter((r) => r.overdue).length,
      buckets,
      rcaReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1])
        .map(([code, n]) => ({ code, n })),
      rows,
    });
  }

  return out;
}

/* ── WHERE TO LOOK FIRST ──────────────────────────────────────────────
   One ranked list, because the question was "where is the funnel stuck" and
   the answer to that is a single name, not a grid.

   Ranked by ACCOUNTS AT RISK — open, past the gate, and our fault — rather
   than by median days. A step with a bad median and four accounts in it is a
   statistic; a step with fifty accounts rotting is the bottleneck, and the
   whole point of this page is to stop looking at the first one. */
export function bottlenecks(diagnosis) {
  return diagnosis
    .filter((d) => !d.planning && !d.composite)
    .map((d) => {
      const ours = d.buckets.filter((b) => b.fault === "ours" || b.fault === "data")
        .reduce((n, b) => n + b.n, 0);
      /* The biggest bucket that names something we can change. Not "waiting on
         the client" (correct behaviour) and not the data gap (a fact about
         the Call Log, not about the funnel). */
      const top = d.buckets.find((b) => b.fault === "ours" || b.fault === "data"
                                        || b.fault === "skill") || null;
      return {
        pair: d.pair, label: d.label,
        atRisk: ours, inFlight: d.inFlight, overdue: d.overdue,
        medianDays: d.medianDays, medianDeadDays: d.medianDeadDays,
        deadShare: d.deadShare,
        cause: top ? top.label : null,
        causeKey: top ? top.key : null,
        action: top ? top.action : null,
        /* Who to start with. Named, because "the team should follow up more"
           is not something anybody does on a Monday. */
        who: top ? top.owners.slice(0, 2) : [],
      };
    })
    .sort((a, b) => b.atRisk - a.atRisk || b.overdue - a.overdue);
}
