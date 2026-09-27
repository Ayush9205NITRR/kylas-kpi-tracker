/* TAT — how long each step takes, and whose step it was.
 *
 * Ayush, 2026-09-27: "I want TAT for each BD ... with respect to company or
 * with respect to stage, ek matrix bana sakte hai."
 *
 * The matrix is BD down the side, stage-pair across the top. One cell is one
 * person's typical wait on one step.
 *
 * ── THE ONLY NEW IDEA HERE IS THE PAIRING ────────────────────────────
 * Nothing is measured that is not already measured. report.mjs's
 * firstArrivals() already returns, for every company, the moment it first
 * reached each rung and who owned it then. A TAT is the subtraction of two of
 * those. This file does the subtraction, decides whose it was, and refuses to
 * average it in the three ways that would make the answer a lie.
 *
 * ── THE THREE REFUSALS ───────────────────────────────────────────────
 * They are the whole value of the file; the arithmetic is trivial.
 *
 * 1. IT NEVER AVERAGES ONLY THE ONES THAT FINISHED. The obvious calculation —
 *    mean of (discovery − right) over the companies that reached discovery —
 *    moves the WRONG WAY as things get worse, because the accounts still stuck
 *    at Right POC have no discovery date and drop out of the sum. A month in
 *    which your two fastest accounts converted scores better than one in which
 *    ten did. So every cell carries `waiting` beside `n`, and neither number is
 *    published without the other.
 *
 * 2. IT NEVER USES A MEAN. Sales cycles are long-tailed; one account that took
 *    eight months destroys a mean and says nothing about the typical case.
 *    Median, with p75 beside it so the tail stays visible instead of hidden.
 *
 * 3. IT NEVER RANKS A BD ON FOUR ACCOUNTS. A median over a handful is noise,
 *    and a noisy number with somebody's name on it is worse than no number.
 *    Cells under MIN_N are marked `thin` and carry no `vsTeam`.
 *
 * Pure functions over plain data, so the proxy can wire them and the test can
 * hand them fixtures. Nothing here reads Airtable or Kylas.
 */

import { RCA_GATES } from "./rca.mjs";

/* ── WHAT GETS MEASURED ───────────────────────────────────────────────
   `from` and `to` are rung keys as report.mjs names them, plus the synthetic
   rung "created" — the day the company landed in Kylas, which is the only
   input this file needs that the ladder does not already produce.

   `gate` is how long the step is allowed to take before somebody owes an
   explanation. Where RCA already gates the same pair of rungs, the number is
   READ FROM THERE rather than restated: a threshold that lives in two files
   ends up as two thresholds, and then the work list and the RCA queue disagree
   about which accounts are late. */
const rcaGate = (from, to) => RCA_GATES.find((g) => g.from === from && g.to === to)?.days;

/* The two the RCA queue already owns. */
const RIGHT_TO_DISCOVERY = rcaGate("right", "discovery");    /* 30 */
const DISCOVERY_TO_BOOKED = rcaGate("discovery", "booked");  /* 21 */
const DONE_TO_SQL = rcaGate("done", "sql");                  /* 14 */

/* And the ones it does not, which are stated here because there is nowhere
   better. These are starting guesses, not findings — replace each with the
   team's own p75 once there are three months of data to take it from. */
const CREATED_TO_WORKED = 3;
const WORKED_TO_RIGHT = 14;

export const MIN_N = 5;   /* refusal 3: below this a cell is `thin` */

export const TAT_PAIRS = [
  /* Case 1, the half nobody owns yet. How long a lead sits in the queue before
     anybody dials it. Usually the largest and the cheapest to fix, and it is a
     management number — allocation and daily pace — not a skill number. */
  { key: "createdToWorked", from: "created", to: "worked",
    label: "Created → first reachout", gate: CREATED_TO_WORKED },

  /* Case 1 as asked, end to end. COMPOSITE on purpose: it is the queue wait
     plus the finding-them wait, so a bad number here cannot be pinned on one
     person or one behaviour. It is on the matrix because it is the number
     Ayush asked for; when it is bad, read the two rows above and below it
     rather than acting on this one. */
  { key: "createdToRight", from: "created", to: "right",
    label: "Created → Right POC", gate: CREATED_TO_WORKED + WORKED_TO_RIGHT,
    composite: true },

  /* Case 2: "Right POC find karne mein time zyada lag raha hai." This is that
     sentence as a number, with the queue wait taken OUT — so it moves only
     when the finding gets harder or the persistence gets shorter. */
  { key: "workedToRight", from: "worked", to: "right",
    label: "First reachout → Right POC", gate: WORKED_TO_RIGHT },

  /* Case 3. Already gated by RCA at 30 days. */
  { key: "rightToDiscovery", from: "right", to: "discovery",
    label: "Right POC → Discovery", gate: RIGHT_TO_DISCOVERY },

  /* Case 4. RCA gates the two legs separately (discovery → booked, then
     done → sql) and never the whole hop, so the gate is their sum: an account
     that is inside both legs is inside this one. */
  { key: "discoveryToSql", from: "discovery", to: "sql",
    label: "Discovery → SQL", gate: DISCOVERY_TO_BOOKED + DONE_TO_SQL },

  /* End to end, for planning only. It is the sum of four things and a person
     cannot act on a sum — it answers "how far ahead of a revenue target must
     we start dialling", which is a calendar question, not a coaching one. */
  { key: "workedToSql", from: "worked", to: "sql",
    label: "First reachout → SQL",
    gate: WORKED_TO_RIGHT + RIGHT_TO_DISCOVERY + DISCOVERY_TO_BOOKED + DONE_TO_SQL,
    planning: true },
];

export const TAT_PAIR = Object.fromEntries(TAT_PAIRS.map((p) => [p.key, p]));

/* ── DAYS ─────────────────────────────────────────────────────────────
   Whole days by CALENDAR DATE, not by elapsed hours: a dial at 23:50 and the
   Right POC at 00:10 the next morning is one day, not zero. Rounding the other
   way would let a team look same-day by working late.

   Both are computed for every gap. Calendar days are what a client experiences
   and what a forecast needs; working days are what a person is accountable
   for, because a Friday-to-Monday gap is one working day and calling it three
   makes the weekend look like a performance problem. On the steps whose median
   is under a week — "created → first reachout" certainly — that difference is
   most of the number. */

const DAY = 86400000;
const dayNumber = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / DAY) : NaN;
};

export const calendarDays = (a, b) => {
  const d = dayNumber(b) - dayNumber(a);
  return Number.isFinite(d) ? d : null;
};

/* Weekdays in the half-open range (a, b] — so same day is 0, and the day of
   arrival counts while the day of departure does not. Epoch day 0 is a
   Thursday, hence the +4.

   Closed form rather than a loop: the scale test runs a quarter of a million
   of these, and a day-by-day walk over a gap that turns out to be 400 days
   long is how an O(n) report becomes an O(n·days) one. */
const weekdaysUpTo = (d) => {
  if (!Number.isFinite(d)) return NaN;
  const n = d + 1;                                  /* days 0..d inclusive */
  const weeks = Math.floor(n / 7);
  let out = weeks * 5;
  for (let x = weeks * 7; x < n; x++) {
    const dow = (x + 4) % 7;                        /* 0 Sun … 6 Sat */
    if (dow !== 0 && dow !== 6) out++;
  }
  return out;
};

export const workingDays = (a, b) => {
  const d0 = dayNumber(a), d1 = dayNumber(b);
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return null;
  return weekdaysUpTo(d1) - weekdaysUpTo(d0);
};

/* ── QUANTILES ────────────────────────────────────────────────────────
   Stated exactly, because a matrix nobody can check by hand is a matrix nobody
   believes. Median: sort ascending, middle for odd n, the mean of the two
   middles for even n. p75: NEAREST RANK — the ceil(0.75·n)th value, an actual
   observation rather than an interpolation between two. Nearest rank because
   "the slowest quarter of this person's accounts took at least X" is a
   sentence about a real account somebody can go and open. */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export const p75 = (xs) => quantile(xs, 0.75);

/* ── THE GAPS ─────────────────────────────────────────────────────────
   arrivals:  the flat list from report.mjs's firstArrivals() —
              [{ metric, company, owner, at }]. The FLAT list, not
              arrivalsByCompany(), because that one drops `owner` and owner is
              half of what this file is for.
   created:   { [companyId]: iso } — the only input the ladder does not
              already produce.
   owners:    { [companyId]: name } — the company's owner now. Used for the
              "created" end of a gap, which no arrival owns, and for open gaps
              under end-attribution.

   Returns one row per (company, pair) that has a start:

     { pair, company, owner, startOwner, endOwner, handoff,
       from, to, days, workDays, open, overdue }

   `open` means the step has not finished, and `days` is then the wait SO FAR.
   Open rows are the ones refusal 1 exists to keep on the page. */
export function tatGaps({ arrivals = [], created = {}, owners = {},
                          now = Date.now(), attribute = "start",
                          pairs = TAT_PAIRS } = {}) {
  const nowISO = new Date(now).toISOString();

  /* company -> { metric: { at, owner } }, first arrival wins. firstArrivals()
     already guarantees one row per (company, metric) and hands them back in
     time order, but this is fed fixtures and live data alike and a second
     `right` for one company must not silently replace the first. */
  const byCompany = new Map();
  for (const a of arrivals) {
    if (!a || !a.company || !a.metric || !a.at) continue;
    let row = byCompany.get(a.company);
    if (!row) byCompany.set(a.company, (row = {}));
    if (!row[a.metric] || String(a.at) < String(row[a.metric].at))
      row[a.metric] = { at: a.at, owner: a.owner || "" };
  }
  for (const [company, at] of Object.entries(created)) {
    if (!at) continue;
    let row = byCompany.get(company);
    if (!row) byCompany.set(company, (row = {}));
    /* Nobody "owns" a creation, so it inherits the company's owner. */
    row.created = { at, owner: owners[company] || "" };
  }

  const gaps = [];
  /* Not gaps, but the two things that would otherwise vanish. Both are
     reported rather than swallowed: each is a data fault that HIDES work, and
     a TAT page that silently drops rows is indistinguishable from a team that
     did not do them. */
  const anomalies = { negative: [], orphan: [] };

  for (const [company, row] of byCompany) {
    for (const p of pairs) {
      const a = row[p.from], b = row[p.to];

      /* Reached the later rung but not the earlier one. Real, and common
         wherever a rung is backfilled or seeded from a stage: a discovery with
         no Right POC before it. Excluded from the arithmetic — there is no
         start to subtract — and counted, because it means the ladder is
         missing a stamp. */
      if (!a) { if (b) anomalies.orphan.push({ company, pair: p.key }); continue; }

      const endAt = b ? b.at : nowISO;
      const days = calendarDays(a.at, endAt);
      const work = workingDays(a.at, endAt);

      /* The later rung dated BEFORE the earlier one. A backfill stamping
         "first discovery" from an old call while Right POC came from last
         week will do this. Never clamped to zero: a floor at zero would pull
         every median down and read as the team getting faster. */
      if (days === null || days < 0) {
        if (b) anomalies.negative.push({ company, pair: p.key, from: a.at, to: b.at, days });
        continue;
      }

      const startOwner = a.owner || owners[company] || "";
      const endOwner = (b && b.owner) || owners[company] || "";
      gaps.push({
        pair: p.key, company,
        /* WHOSE STEP IT WAS — see tatMatrix's note. */
        owner: (attribute === "end" ? endOwner : startOwner) || "",
        startOwner, endOwner,
        /* Changed hands mid-step. A cell full of these is not one person's
           number however it is attributed, and the matrix says so. */
        handoff: !!(startOwner && endOwner && startOwner !== endOwner),
        from: a.at, to: b ? b.at : null,
        days, workDays: work,
        open: !b,
        overdue: !b && days >= p.gate,
      });
    }
  }

  return { gaps, anomalies };
}

/* ── THE MATRIX ───────────────────────────────────────────────────────
   BD down the side, stage-pair across the top, plus a team row — which is the
   only reason the grid is worth building. "Priya: 11 days" is a fact with no
   scale attached; "Priya 11, team 9" is a conversation. Every cell therefore
   carries `vsTeam`, and a cell that cannot support the comparison does not
   make it.

   ATTRIBUTION, which is a policy choice and not a fact:

     "start" (default) — the step belongs to whoever owned the account when it
        ARRIVED at the earlier rung. They are the person the clock has been
        running against.
     "end" — it belongs to whoever got it over the line.

   Default "start" because it is the only one under which a row is coherent.
   Under "end", a cell's `n` is the accounts this person CLOSED and its
   `waiting` is the accounts they now HOLD — two different books of business in
   one row, so the median and the backlog beside it are not about the same
   accounts and refusal 1 stops working. Under "start" both halves are the same
   book: these are the accounts that became yours at this rung, here is how
   many you moved on and how long the rest have been sitting.

   Both are implemented because the honest answer is that "end" is the fairer
   credit and "start" is the fairer accountability, and a team will want to see
   it both ways before they trust either. */
export function tatMatrix({ arrivals = [], created = {}, owners = {},
                            now = Date.now(), attribute = "start",
                            pairs = TAT_PAIRS, useWorkingDays = false,
                            minN = MIN_N } = {}) {
  const { gaps, anomalies } = tatGaps({ arrivals, created, owners, now, attribute, pairs });
  const lengthOf = (g) => (useWorkingDays ? g.workDays : g.days);

  /* Buckets, keyed "<owner>|<pair>" and "|<pair>" for the team. One pass; the
     sorting that medians need happens once per cell at the end rather than
     once per row. */
  const bucket = new Map();
  const take = (k) => {
    let b = bucket.get(k);
    if (!b) bucket.set(k, (b = { closed: [], open: [], handoffs: 0, worst: null, oldest: null }));
    return b;
  };
  const add = (b, g) => {
    const len = lengthOf(g);
    if (g.open) {
      b.open.push(len);
      if (!b.oldest || len > lengthOf(b.oldest)) b.oldest = g;
    } else {
      b.closed.push(len);
      if (!b.worst || len > lengthOf(b.worst)) b.worst = g;
      if (g.handoff) b.handoffs++;
    }
  };

  const bds = new Set();
  for (const g of gaps) {
    if (g.owner) { bds.add(g.owner); add(take(`${g.owner}|${g.pair}`), g); }
    add(take(`|${g.pair}`), g);            /* the team row, always */
  }

  const cellFrom = (b, p) => {
    if (!b) return { n: 0, median: null, p75: null, waiting: 0, thin: true,
                     overdue: 0, handoffRate: null, worst: null, oldest: null, vsTeam: null };
    const overdue = b.open.filter((d) => d >= p.gate).length;
    return {
      n: b.closed.length,
      median: median(b.closed),
      p75: p75(b.closed),
      /* Refusal 1. These two are published together or not at all. */
      waiting: b.open.length,
      waitingOldest: b.oldest ? lengthOf(b.oldest) : null,
      waitingOldestCompany: b.oldest ? b.oldest.company : null,
      /* The work list, as a count: open, and already past the gate. This is
         the actionable number on the whole grid — a median is a description,
         an overdue count is a Monday morning. */
      overdue,
      /* Refusal 3. */
      thin: b.closed.length < minN,
      handoffRate: b.closed.length ? b.handoffs / b.closed.length : null,
      worst: b.worst ? { company: b.worst.company, days: lengthOf(b.worst) } : null,
      vsTeam: null,
    };
  };

  const team = {};
  for (const p of pairs) team[p.key] = cellFrom(bucket.get(`|${p.key}`), p);

  const byBd = {};
  for (const bd of [...bds].sort()) {
    byBd[bd] = {};
    for (const p of pairs) {
      const cell = cellFrom(bucket.get(`${bd}|${p.key}`), p);
      /* The comparison is withheld from a thin cell rather than shown small.
         "+6 days vs team" over three accounts is a coin flip wearing a number,
         and it is the kind of number that ends up in somebody's review. */
      const t = team[p.key];
      if (!cell.thin && cell.median !== null && t.median !== null && !t.thin)
        cell.vsTeam = Math.round((cell.median - t.median) * 10) / 10;
      byBd[bd][p.key] = cell;
    }
  }

  return {
    unit: useWorkingDays ? "working days" : "calendar days",
    attribute,
    minN,
    pairs: pairs.map((p) => ({ key: p.key, label: p.label, gate: p.gate,
                               composite: !!p.composite, planning: !!p.planning })),
    bds: [...bds].sort(),
    byBd,
    team,
    anomalies: { negative: anomalies.negative.length, orphan: anomalies.orphan.length,
                 detail: anomalies },
  };
}

/* ── THE COHORT ───────────────────────────────────────────────────────
   Refusal 1 again, in the form that can be trended.

   "Of the companies that reached Right POC in July, what share reached
   Discovery within 30 days?"

   The denominator is fixed the moment the month closes, so it cannot be gamed
   by slow accounts dropping out of it — which is exactly what a median over
   completed conversions lets them do. This is the number to put on a monthly
   chart; the medians are for the current week.

   A month is only fully answerable once every account in it has had `gate`
   days to convert. Until then `settled` is false and the rate is a floor, not
   a result — a cohort chart whose last point is still filling in always slopes
   downwards at the right-hand end, and somebody always reads that as a
   collapse. */
export function tatCohort({ arrivals = [], created = {}, owners = {},
                            pair = "rightToDiscovery", now = Date.now(),
                            attribute = "start", bd = null } = {}) {
  const p = TAT_PAIR[pair];
  if (!p) throw new Error(`unknown TAT pair ${JSON.stringify(pair)}`);
  const { gaps } = tatGaps({ arrivals, created, owners, now, attribute, pairs: [p] });

  const months = new Map();
  for (const g of gaps) {
    if (bd && g.owner !== bd) continue;
    const k = String(g.from).slice(0, 7);
    let m = months.get(k);
    if (!m) months.set(k, (m = { key: k, arrived: 0, hit: 0, stillOpen: 0, missed: 0, last: "" }));
    m.arrived++;
    if (g.from > m.last) m.last = g.from;
    if (!g.open && g.days <= p.gate) m.hit++;
    else if (g.open) m.stillOpen++;
    else m.missed++;
  }

  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key)).map(({ last, ...m }) => ({
    ...m,
    pct: m.arrived ? Math.round((m.hit / m.arrived) * 1000) / 10 : null,
    /* Measured from the LAST arrival in the cohort, not from the end of its
       month. A month is only a result once its slowest-starting account has
       also had the full gate to convert; before that the rate can only rise,
       so publishing it as a result puts a cliff on the right-hand end of
       every cohort chart that somebody then reads as a collapse.

       From the arrival rather than the month boundary because the boundary is
       wrong by up to a month in both directions — it calls a cohort unsettled
       when every account in it landed on the 3rd and has had six weeks. */
    settled: !!last && Date.parse(last) + p.gate * DAY <= now,
  }));
}

/* ── THE WORK LIST ────────────────────────────────────────────────────
   Not a report. What one person opens on a Monday: their own open steps, past
   the gate, oldest first. The only output here that names accounts rather than
   counting them, and the only one that changes anybody's day. */
export function tatWorkList({ arrivals = [], created = {}, owners = {},
                              now = Date.now(), attribute = "start",
                              pairs = TAT_PAIRS, bd = null, limit = 50 } = {}) {
  const { gaps } = tatGaps({ arrivals, created, owners, now, attribute, pairs });
  return gaps
    .filter((g) => g.overdue && (!bd || g.owner === bd))
    .sort((a, b) => b.days - a.days)
    .slice(0, limit)
    .map((g) => ({ company: g.company, owner: g.owner, pair: g.pair,
                   label: TAT_PAIR[g.pair]?.label || g.pair,
                   days: g.days, workDays: g.workDays, since: g.from,
                   gate: TAT_PAIR[g.pair]?.gate ?? null }));
}
