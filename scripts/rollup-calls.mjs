#!/usr/bin/env node
/* Call Log retention: aggregate old days, then delete their raw rows.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/rollup-calls.mjs
 *   ... node scripts/rollup-calls.mjs --apply        # actually write and delete
 *   ... node scripts/rollup-calls.mjs --days 60      # keep 60 days raw (default 90)
 *   ... node scripts/rollup-calls.mjs --before 2026-07-01   # an explicit cutoff
 *
 * WHY THIS EXISTS
 * Call Log is one row per CALL. At 1,200 calls a day across eight associates
 * that is 36,000 rows a month, and Airtable counts records across the WHOLE
 * base: a Team base (50,000) fills in about six weeks, Business (125,000) in
 * about fourteen. Upgrading buys months, not a solution. Calling the same
 * contacts repeatedly does not help either — repeat calls are what MAKE the
 * rows.
 *
 * The raw calls are not lost. Kylas has its own native call log, written on
 * every save, and it has no row cap: it stays the record of individual calls.
 * Airtable only needs what the period report reads, and the report groups by
 * day, week or month — so one row per day per owner per outcome carries every
 * number it can produce. 8 associates x 22 days x a handful of outcomes is
 * some hundreds of rows a month instead of 36,000.
 *
 * THE ORDER IS THE SAFETY PROPERTY
 * Per day: write the aggregate, verify it, THEN delete that day's raw rows.
 *   crash after the write   the raw rows are still there, the next run
 *                           recomputes the same totals from them and
 *                           overwrites the same key — idempotent
 *   crash after the delete  the day has no raw rows left and is skipped
 * A day can therefore exist in both tables for a moment, and report.mjs
 * prefers the raw rows for any day that has them (see mergeCalls), so the
 * in-between state reads correctly rather than double.
 *
 * Totals are written ABSOLUTE, never incremented — an increment would double
 * the day every time the script was re-run over rows it had not yet deleted.
 */
import { createAirtable } from "./airtable.mjs";

/* Callable, so the same job runs from a terminal and from a scheduled Worker. */
export async function run({ env = {}, log = () => {}, apply = false,
                           retainDays = 90, before = "" } = {}) {
  const APPLY = apply;
  /* retainDays, not `days` — the body already has a local `days` holding the
     list of dates being rolled up, and shadowing it silently rolled up the
     wrong thing. Caught by the parser rather than by a test, which is luck. */
  const DAYS = Number(retainDays || env.CALL_RETAIN_DAYS || 90);
  const PAT = env.AIRTABLE_PAT;
    const BASE = env.AIRTABLE_BASE;
    /* Thrown rather than exited: there is no process to exit inside a scheduled
       Worker, and doing so would take down whatever else it was running. */
    if (!PAT || !BASE) throw new Error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");
    if (!Number.isFinite(DAYS) || DAYS < 1) throw new Error("days must be a positive number.");

    const at = createAirtable(PAT, BASE, {
      log: (m) => log("  " + m),
      ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}),
      ...(env.AIRTABLE_GAP ? { gap: Number(env.AIRTABLE_GAP) } : {}),
    });
  const day = (v) => String(v || "").slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  /* Everything strictly BEFORE this stays raw. */
  const cutoff = before
    ? day(before)
    : new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

  if (cutoff > today) { log(`Cutoff ${cutoff} is in the future.`); return { stopped: true }; }

  log(APPLY ? "Call Log rollup" : "Call Log rollup — DRY RUN, nothing will be written or deleted");
  log(`base ${BASE} · keeping raw calls from ${cutoff} onward` +
              (before ? "" : ` (${DAYS} days)`));

  const rows = await at.listAll("Call Log", {
    fields: ["Called At", "Owner", "Outcome", "Duration"],
    pageSize: 100, maxPages: 400,
  });
  log(`\n${rows.length} raw call row(s) in the base`);

  /* Group the old ones by day, then within a day by owner and outcome. */
  const byDay = new Map();
  let recent = 0, undated = 0;
  for (const r of rows) {
    const d = day(r.fields?.["Called At"]);
    if (!d) { undated++; continue; }
    /* A day that is not over must never be rolled: calls are still being logged
       into it, and an aggregate written now would be wrong an hour later — the
       same rule the daily snapshot follows. */
    if (d >= cutoff || d >= today) { recent++; continue; }
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }

  log(`  ${recent} within the window, left alone`);
  if (undated) log(`  ! ${undated} row(s) carry no Called At — left alone, they cannot be dated`);

  const days = [...byDay.keys()].sort();
  /* NOT an early exit. "Nothing to roll up" is exactly when somebody most needs
     the projection below — it means the window is holding everything, and
     whether THAT fits is the question this script exists to answer. */
  if (!days.length) log("\nNothing old enough to roll up.");
  else {
    const totalOld = days.reduce((n, d) => n + byDay.get(d).length, 0);
    log(`  ${totalOld} row(s) across ${days.length} day(s) older than ${cutoff}`);
  }

  let wrote = 0, deleted = 0, aggregates = 0;
  for (const d of days) {
    const group = new Map();          // "owner|outcome" -> { calls, seconds }
    for (const r of byDay.get(d)) {
      const owner = r.fields?.Owner || "";
      const outcome = r.fields?.Outcome || "";
      const k = `${owner}|${outcome}`;
      if (!group.has(k)) group.set(k, { owner, outcome, calls: 0, seconds: 0 });
      const g = group.get(k);
      g.calls++;
      g.seconds += Number(r.fields?.Duration || 0);
    }

    const out = [...group.values()].map((g) => ({
      Key: `${d}|${g.owner}|${g.outcome}`,
      Day: d, Owner: g.owner, Outcome: g.outcome,
      Calls: g.calls, "Talk Seconds": g.seconds,
      "Rolled At": new Date().toISOString(),
    }));
    aggregates += out.length;

    if (!APPLY) {
      log(`  ${d}: ${byDay.get(d).length} row(s) -> ${out.length} aggregate(s)`);
      continue;
    }

    /* WRITE FIRST. */
    const done = await at.upsertMany("Call Rollup", "Key", out);
    if (done.length !== out.length) {
      log(`\n! ${d}: wrote ${done.length} of ${out.length} aggregates. ` +
                    `NOT deleting the raw rows for this day — re-run once the base is healthy.`);
      break;
    }
    wrote += done.length;

    /* VERIFY, then delete. Trusting the write response alone would mean one bad
       day silently loses its calls; a read back is cheap next to that. */
    const back = await at.list("Call Rollup", `{Day} = '${d}'`, 200);
    const sum = back.reduce((n, r) => n + Number(r.fields?.Calls || 0), 0);
    if (sum < byDay.get(d).length) {
      log(`\n! ${d}: the rollup reads back ${sum} call(s) but ${byDay.get(d).length} ` +
                    `were counted. NOT deleting the raw rows.`);
      break;
    }

    await at.remove("Call Log", byDay.get(d).map((r) => r.id));
    deleted += byDay.get(d).length;
    log(`  ${d}: ${byDay.get(d).length} row(s) -> ${out.length} aggregate(s), raw deleted`);
  }

  if (days.length) {
    log(`\n${APPLY ? "done" : "dry run done"} — ${aggregates} aggregate(s)` +
                (APPLY ? `, ${wrote} written, ${deleted} raw row(s) deleted` : ""));
    if (!APPLY) log("Nothing was changed. Re-run with --apply.");
    else log(`Call Log is now ${rows.length - deleted} row(s).`);
  }

  /* ── DOES THE WINDOW ACTUALLY FIT? ──────────────────────────────────────
     Rolling up old days does nothing about the days still inside the window,
     and THAT is what decides whether the base fits. 90 days of retention at
     1,200 calls a day is 108,000 raw rows — over a Team base on its own, before
     a single contact. A retention script that quietly leaves you over the cap
     has not solved the problem it exists for, so it works out the steady state
     from the rate actually observed here and says which plans it fits. */
  const kept = rows.filter((r) => {
    const d = day(r.fields?.["Called At"]);
    return d && d >= cutoff && d < today;
  });
  const keptDays = new Set(kept.map((r) => day(r.fields["Called At"]))).size;
  if (keptDays >= 2) {
    const perDay = kept.length / keptDays;
    const steady = Math.round(perDay * DAYS);
    log(`\nsteady state at this rate: ${perDay.toFixed(0)} call(s)/day ` +
                `x ${DAYS} day(s) retained = ~${steady.toLocaleString()} raw row(s), ` +
                `plus aggregates for everything older.`);
    /* Airtable counts records across the WHOLE base, so these are shared with
       Contacts, Companies, Event Rows and the rest — the headroom is smaller
       than the difference suggests. */
    for (const [plan, cap] of [["Team", 50_000], ["Business", 125_000]]) {
      if (steady > cap * 0.8)
        log(`  ! ${steady.toLocaleString()} is ${steady > cap ? "OVER" : "within 20% of"} ` +
                    `the ${plan} cap of ${cap.toLocaleString()} records per base, which is shared ` +
                    `with every other table. Retain ~${Math.floor((cap * 0.6) / perDay)} day(s) instead.`);
    }
  }

}

const isMain = (() => {
  try {
    return typeof process !== "undefined" && process.argv?.[1]
      && import.meta.url.endsWith(process.argv[1].split("/").pop());
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv;
  const a = (n) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : undefined; };
  try {
    await run({ env: process.env, log: (...x) => console.log(...x),
                apply: argv.includes("--apply"),
                retainDays: Number(a("days") || process.env.CALL_RETAIN_DAYS || 90),
                before: a("before") || "" });
  } catch (e) { console.error(`\nrollup failed: ${e.message}`); process.exit(1); }
}
