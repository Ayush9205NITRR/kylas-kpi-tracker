/* Period reporting: the same numbers by day, by week, by month.
 *
 * Built from the two APPEND-ONLY tables, not from the nightly snapshot:
 *
 *   Call Log          one row per save, with Called At and Owner
 *   Stage Transitions one row per stage move, with Changed At, To Stage, Owner
 *
 * That choice matters. Daily Snapshot freezes where things STOOD at end of day,
 * which cannot be re-derived and cannot be broken down any finer than a day —
 * and it only exists for days the cron actually ran. The two event tables are a
 * complete history the moment somebody saves, so a month can be cut into weeks
 * and a week into days from the same rows, and a gap in the cron costs nothing.
 *
 * Pure functions over rows the caller fetched. No network here, so it is
 * testable — see scripts/test-report.mjs.
 */
import { STAGE_RUNG, MILESTONE } from "./stages.mjs";

/* ── periods ───────────────────────────────────────────────────────── */
/* ISO dates throughout, because they sort as strings and a KPI report that
   disagrees with itself about what "this week" means is worse than no report.
   Weeks start MONDAY: a BD week is Monday to Friday, and a Sunday-start week
   splits it across two rows. */
export const dayKey = (iso) => String(iso || "").slice(0, 10);

export function weekKey(iso) {
  const d = new Date(dayKey(iso) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  /* getUTCDay: 0 = Sunday. Monday is the start, so Sunday steps back 6. */
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export const monthKey = (iso) => String(iso || "").slice(0, 7);

/* Quarter and year, so the report can be read from the top down: a year opens
   into its four quarters, a quarter into its months, a month into its days.
   Keyed so they still sort as strings, which is what every period here relies
   on — "2026-Q2" sorts after "2026-Q1" and before "2027-Q1". */
export function quarterKey(iso) {
  const m = Number(String(iso || "").slice(5, 7));
  if (!m) return "";
  return `${String(iso).slice(0, 4)}-Q${Math.floor((m - 1) / 3) + 1}`;
}
export const yearKey = (iso) => String(iso || "").slice(0, 4);

export const KEY_OF = { day: dayKey, week: weekKey, month: monthKey,
                        quarter: quarterKey, year: yearKey };

/* Which period a level opens INTO. The report is one table at a time and this
   is the only thing that says what "click a row" means, so it lives beside the
   keys rather than in the view. A day does not open into anything. */
export const DRILL_INTO = { year: "quarter", quarter: "month", month: "week", week: "day", day: null };

/* Whether a key at one level sits inside a key at the level above. Used to
   narrow the window when a row is opened; string prefixes would be wrong for
   quarter -> month (2026-Q1 is not a prefix of 2026-02), so it is a date range
   in both directions. */
export function periodRange(period, key) {
  if (period === "year") return [`${key}-01-01`, `${key}-12-31`];
  if (period === "quarter") {
    const y = key.slice(0, 4), q = Number(key.slice(6));
    const first = (q - 1) * 3 + 1;
    const last = first + 2;
    const endDay = new Date(Date.UTC(Number(y), last, 0)).getUTCDate();
    return [`${y}-${String(first).padStart(2, "0")}-01`, `${y}-${String(last).padStart(2, "0")}-${endDay}`];
  }
  if (period === "month") {
    const [y, m] = key.split("-");
    const endDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
    return [`${key}-01`, `${key}-${endDay}`];
  }
  if (period === "week") {
    const a = new Date(key + "T00:00:00Z");
    const b = new Date(a); b.setUTCDate(b.getUTCDate() + 6);
    return [key, b.toISOString().slice(0, 10)];
  }
  return [key, key];
}

/* How a period reads to a person. A week is named by the Monday it starts on,
   which is ambiguous on its own, so it carries its range. */
export function periodLabel(period, key) {
  if (period === "year") return key;
  if (period === "quarter") {
    const [y, q] = key.split("-");
    return `${q} ${y}`;
  }
  if (period === "month") {
    const [y, m] = key.split("-");
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1))
      .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (period === "week") {
    const a = new Date(key + "T00:00:00Z");
    const b = new Date(a); b.setUTCDate(b.getUTCDate() + 6);
    const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return `${fmt(a)} – ${fmt(b)}`;
  }
  const d = new Date(key + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/* Every period between two dates, including ones with no activity. A month with
   a silent week in it should show that week as a zero, not skip it — a gap the
   reader has to notice for themselves is how a bad week gets missed. */
export function periodsBetween(period, fromISO, toISO) {
  const key = KEY_OF[period] || dayKey;
  const out = [];
  const d = new Date(dayKey(fromISO) + "T00:00:00Z");
  const end = new Date(dayKey(toISO) + "T00:00:00Z");
  /* 4000 days was a fine ceiling when the coarsest period was a month. A year
     view over a decade is 3,650 steps and would have been silently truncated —
     a report that stops early and says nothing is the failure mode this whole
     function exists to avoid. */
  let guard = 0;
  while (d <= end && guard++ < 40000) {
    const k = key(d.toISOString());
    if (!out.length || out[out.length - 1] !== k) out.push(k);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ── what counts as reaching a milestone ───────────────────────────── */
/* A transition INTO a stage at or above the floor. Because rank only rises,
   the first such transition is the moment that company arrived — later ones are
   movement within the same milestone and must not be counted again. */
const FLOORS = [
  { key: "booked", floor: MILESTONE.sqlMeetingBooked.floor, label: MILESTONE.sqlMeetingBooked.label },
  { key: "done", floor: MILESTONE.sqlMeetingDone.floor, label: MILESTONE.sqlMeetingDone.label },
  { key: "sql", floor: MILESTONE.sql.floor, label: MILESTONE.sql.label },
];

export const METRICS = [
  { key: "calls", label: "Calls logged", kind: "flow" },
  { key: "connects", label: "Connected", kind: "flow" },
  { key: "right", label: "Right POC", kind: "first" },
  { key: "discovery", label: "Discovery", kind: "first" },
  { key: "booked", label: "SQL meeting booked", kind: "first" },
  { key: "done", label: "SQL meeting done", kind: "first" },
  { key: "sql", label: "SQL", kind: "first" },
];

const blank = () => Object.fromEntries(METRICS.map((m) => [m.key, 0]));

/* ── the aggregation ───────────────────────────────────────────────── */
/* calls:        [{ at, owner, outcome }]
   transitions:  [{ at, owner, to, contact }]     `to` is a stage CODE
   contactRight / contactDiscovery: [{ at, owner, contact }] — when a contact
        first became a Right POC / a successful discovery. Those are not stage
        moves, they are data being filled in, so they arrive separately.

   Returns { periods: [{ key, label, ...counts }], totals, byOwner } */
export function report(period, { calls = [], transitions = [], signals = [] } = {},
                      { from = "", to = "" } = {}) {
  const key = KEY_OF[period] || dayKey;

  /* The window. Derived from the data when not given, so a first run shows
     whatever exists rather than an empty grid. */
  const stamps = [...calls.map((c) => c.at), ...transitions.map((t) => t.at), ...signals.map((s) => s.at)]
    .map(dayKey).filter(Boolean).sort();
  const start = dayKey(from) || stamps[0] || dayKey(new Date().toISOString());
  const end = dayKey(to) || stamps[stamps.length - 1] || dayKey(new Date().toISOString());

  const keys = periodsBetween(period, start, end);
  const rows = new Map(keys.map((k) => [k, { key: k, label: periodLabel(period, k), ...blank() }]));
  const owners = new Map();
  const bump = (k, owner, metric, n = 1) => {
    const row = rows.get(k);
    if (row) row[metric] += n;
    if (!owner) return;
    if (!owners.has(owner)) owners.set(owner, { owner, ...blank() });
    owners.get(owner)[metric] += n;
  };

  const inWindow = (at) => dayKey(at) >= start && dayKey(at) <= end;

  for (const c of calls) {
    if (!inWindow(c.at)) continue;
    /* `n` is how many calls this entry STANDS FOR. One raw Call Log row is one
       call; a rolled-up row is a whole day's worth for one owner and outcome,
       and expanding it back into hundreds of objects just to count them again
       would make a year of history a million allocations. */
    const n = Number(c.n) > 0 ? Number(c.n) : 1;
    bump(key(c.at), c.owner, "calls", n);
    /* "Connected" is any outcome that is not a no-answer. A dial that nobody
       picked up is work, but it is not a conversation. */
    if (c.outcome && c.outcome !== "No answer") bump(key(c.at), c.owner, "connects", n);
  }

  /* FIRST arrival only, per company per milestone. A company that moves from
     booked to done to booked again must count once for booked, not twice —
     otherwise a stage being corrected inflates the month. */
  const seen = new Set();
  const ordered = [...transitions].filter((t) => t.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const t of ordered) {
    const rung = STAGE_RUNG[t.to] || 0;
    for (const f of FLOORS) {
      if (rung < f.floor) continue;
      const id = `${f.key}:${t.company || t.contact || ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (inWindow(t.at)) bump(key(t.at), t.owner, f.key);
    }
  }

  /* Right POC and discovery are data, not stages, so they come as their own
     first-time events. Same once-only rule. */
  const seenSig = new Set();
  for (const sig of [...signals].filter((s) => s.at).sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const id = `${sig.metric}:${sig.company || sig.contact || ""}`;
    if (seenSig.has(id)) continue;
    seenSig.add(id);
    if (inWindow(sig.at)) bump(key(sig.at), sig.owner, sig.metric);
  }

  const periods = keys.map((k) => rows.get(k));
  const totals = periods.reduce((acc, r) => {
    for (const m of METRICS) acc[m.key] += r[m.key];
    return acc;
  }, blank());

  return { period, from: start, to: end, periods, totals,
           byOwner: [...owners.values()].sort((a, b) => b.calls - a.calls) };
}

/* ── raw rows and rolled-up days, together ──────────────────────────
   Call Log rows are deleted once they are rolled up, because at 1,200 calls a
   day they fill an Airtable base in six weeks. The report therefore reads two
   tables, and for a short moment during a rollup a day can exist in BOTH: the
   aggregate is written first and the raw rows deleted after, so a crash in
   between leaves a duplicate. Counting both would double that day.

   RAW WINS, always. It is the finer record, it is the one the rollup is
   derived from, and preferring it means an interrupted rollup reads correctly
   and simply re-runs. Preferring the aggregate would mean the same crash
   silently dropped whatever the raw rows held beyond it. */
export function mergeCalls(raw = [], rolled = []) {
  const rawDays = new Set(raw.map((c) => dayKey(c.at)).filter(Boolean));
  const kept = rolled.filter((c) => !rawDays.has(dayKey(c.at)));
  return [...raw, ...kept];
}

/* ── the part that is meant to motivate ────────────────────────────── */
/* Ayush: "it should act to the point of motivation rather it should be just a
   plain or dumb data." A number on its own is not motivating or discouraging —
   it needs something to be measured against. So every period carries its change
   on the one before, and the set carries its best period and a current streak.
   That is the difference between "12 discoveries" and "12 discoveries, your best
   week yet, up 4 on last week". */
export function withDeltas(rep) {
  const periods = rep.periods.map((p, i) => {
    const prev = i > 0 ? rep.periods[i - 1] : null;
    const delta = {};
    for (const m of METRICS) delta[m.key] = prev ? p[m.key] - prev[m.key] : null;
    return { ...p, delta };
  });

  const best = {};
  for (const m of METRICS) {
    let top = null;
    for (const p of periods) if (!top || p[m.key] > top[m.key]) top = p;
    /* A best of zero is not a best. */
    best[m.key] = top && top[m.key] > 0 ? { key: top.key, label: top.label, value: top[m.key] } : null;
  }

  /* Consecutive periods, counting back from the most recent, with any activity.
     Counted on calls because that is the thing an associate controls. */
  let streak = 0;
  for (let i = periods.length - 1; i >= 0; i--) {
    if (periods[i].calls > 0) streak++;
    else break;
  }

  const current = periods[periods.length - 1] || null;
  const previous = periods[periods.length - 2] || null;

  return { ...rep, periods, best, streak, current, previous };
}
