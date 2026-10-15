#!/usr/bin/env node
/* THE KYLAS DIALLER APP'S CALLS, INTO THE KPI BASE — real talk time at last.
 *
 *   node --env-file=.env.local scripts/import-dialler-calls.mjs           # the plan
 *   node --env-file=.env.local scripts/import-dialler-calls.mjs --apply   # write it
 *
 * Dry by default on the command line. Also the "dialler" cron job in
 * worker/index.mjs, which runs it hourly with apply — see CRON_DIALLER.
 *
 * WHY. Talk time on the dashboard was summed from the console's own stopwatch,
 * which only runs when a call is dialled from the console's button: 7 of 1,379
 * rows had one, so a month of calling read as three minutes. The Kylas DIALLER
 * APP measures every call it places. Proved on the live account 2026-10-15:
 *
 *   #45926805  10:52:09  1m11s  dialler, device set, owner Muskan Rajpoot
 *   #45926838  10:53:43     0s  this console, owner Enout Super Admin
 *
 * Note the second column as much as the first: the dialler's logs carry the
 * ASSOCIATE who dialled, where every log the console writes carries the API
 * key's user. So this import fixes talk time and gives honest per-person
 * attribution for it in the same stroke.
 *
 * ── THE ONE READ KYLAS ALLOWS, AND WHAT IT COSTS US ───────────────────
 * GET /v1/call-logs?size=N is the ONLY shape that returns more than the
 * latest ten (probe-call-durations.mjs, 2026-10-15: 17 shapes tried, one
 * answered). It has no paging, no sort and no date filter — `page`, `sort`,
 * `startTime` and `relatedToId` are all accepted and ignored. So the only
 * thing we can ever ask for is "the newest N logs", and that has a hard
 * consequence:
 *
 *   IF MORE THAN N LOGS ARRIVE BETWEEN TWO RUNS, THE ONES IN THE MIDDLE ARE
 *   LOST FOR EVER. There is no way to go back for them.
 *
 * So the import is idempotent (keyed on the Kylas log id, so overlapping runs
 * are free) and it CHECKS for that gap every time: if the oldest log it just
 * read is newer than the newest it has already stored, calls happened in
 * between that it will never see, and it says so loudly. Run it often enough
 * that the window always overlaps — hourly at this team's volume — and the
 * gap never opens. The account holds 8,655 logs and about 300-600 arrive a
 * day, so size=1000 hourly has a wide margin.
 */
import { pathToFileURL } from "node:url";
import { createAirtable, listTolerant, upsertManyTolerant } from "./airtable.mjs";

const TABLE = "Dialler Calls";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listOf = (j) => j?.content || j?.data || (Array.isArray(j) ? j : []);
const who = (v) => (v && typeof v === "object" ? (v.name || v.firstName || "") : v) || "";
const secsOf = (l) => Number(l?.duration ?? l?.callDuration ?? l?.durationInSeconds ?? 0) || 0;
const relList = (l) => [].concat(l?.relatedTo || []).filter(Boolean);
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;

/* Exported so the hourly cron and the command line run the SAME code. Throws
   rather than exits: there is no process to exit inside a scheduled Worker,
   and doing so would take down whatever else it was running. */
export async function run({ env = process.env, log = console.log, apply = false, size } = {}) {
  const APPLY = apply;
  const WANT = Number(size || env.DIALLER_SIZE || 1000);
  const KEY = env.KYLAS_KEY;
  const BASE = env.KYLAS_BASE || "https://api.kylas.io";
  const PAT = env.AIRTABLE_PAT;
  const AT_BASE = env.AIRTABLE_BASE;
  if (!KEY) throw new Error("Set KYLAS_KEY.");
  if (!PAT || !AT_BASE) throw new Error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");

  const kylas = async (path, t = 0) => {
    const r = await fetch(`${BASE}${path}`, { headers: { "api-key": KEY } });
    if (r.status === 429 && t < 6) { await sleep(500 * 2 ** t); return kylas(path, t + 1); }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) { const e = new Error(`GET ${path} -> ${r.status} ${text.slice(0, 200)}`); e.status = r.status; throw e; }
    return json;
  };
  const at = createAirtable(PAT, AT_BASE, {
    log: (m) => log("  " + m),
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}),
  });

  /* ── 1 · the biggest window Kylas will serve ──────────────────────── */
  /* Asked for rather than assumed: `size` is the only honoured parameter and
     nothing documents its ceiling, so the largest that answers is the one used.
     A size Kylas rejects comes back 400 or 404, not as a short list. */
  let logs = null;
  for (const n of [...new Set([WANT, 1000, 500, 200, 100])].filter((v) => v > 0)) {
    try {
      const got = listOf(await kylas(`/v1/call-logs?size=${n}`));
      if (!got.length) { log(`  size=${n} answered with no rows`); continue; }
      logs = got;
      log(`reading the newest ${got.length} call log(s) (asked for ${n})`);
      break;
    } catch (e) { log(`  size=${n} refused: ${e.message.slice(0, 90)}`); }
    await sleep(250);
  }
  if (!logs) throw new Error("Kylas served no call logs at any size — nothing to import.");

  /* ── 2 · which of them the dialler placed ─────────────────────────── */
  /* A duration is the test, and it is the right one: the console's own writes
     are 0s by construction (its stopwatch does not run unless somebody dials
     from its button), and a dialler call with no length is a call that never
     connected, which is not talk time either way. */
  const timed = logs.filter((l) => secsOf(l) > 0);
  const stamps = logs.map((l) => String(l.startTime || l.createdAt || "")).filter(Boolean).sort();
  const oldestSeen = stamps[0] || "";
  const newestSeen = stamps[stamps.length - 1] || "";
  const seconds = timed.reduce((n, l) => n + secsOf(l), 0);
  log(`  ${timed.length} of ${logs.length} carry a duration · ${mmss(seconds)} in total`);
  log(`  the window read spans ${oldestSeen.slice(0, 19)} .. ${newestSeen.slice(0, 19)}`);
  const byOwner = new Map();
  for (const l of timed) {
    const o = who(l.owner) || who(l.createdBy) || "(no owner)";
    const g = byOwner.get(o) || { calls: 0, secs: 0 };
    g.calls++; g.secs += secsOf(l);
    byOwner.set(o, g);
  }
  for (const [o, g] of [...byOwner].sort((a, b) => b[1].secs - a[1].secs))
    log(`    ${o.padEnd(22)} ${String(g.calls).padStart(4)} call(s)  ${mmss(g.secs)}`);

  /* ── 3 · the gap check ────────────────────────────────────────────── */
  /* The read has no paging, so a run can only ever see the newest N. If the
     oldest log in this window is NEWER than the newest already stored, the calls
     between those two timestamps were never read and never can be. */
  const held = await listTolerant(at, TABLE, { fields: ["Key", "Called At"], pageSize: 100, maxPages: 200,
    sort: [{ field: "Called At", direction: "desc" }] }).catch((e) => {
    /* THE STATUS FIRST, AND ENOUGH OF THE REASON. This was `slice(0, 90)` of
       the message, which on a real failure is 90 characters of URL — the 403
       that actually explained it never reached the screen, and "treating it as
       empty" then read as "the table is empty". A read that FAILED is not an
       empty table: it silently disables the gap check below, so the reason has
       to be visible. */
    log(`  ! could not read ${TABLE}${e.status ? ` (HTTP ${e.status})` : ""} — ${
      String(e.message || e).replace(/^[A-Z]+ \S+ -> \d+: /, "").slice(0, 300)}`);
    log(`    Carrying on as if it were empty, so the gap check below is OFF for this run.`);
    return [];
  });
  const haveKeys = new Set(held.map((r) => String(r.fields?.Key || "")));
  const newestHeld = held.map((r) => String(r.fields?.["Called At"] || "")).sort().pop() || "";
  log(`\n  ${TABLE} already holds ${held.length} row(s)` +
    (newestHeld ? `, newest ${newestHeld.slice(0, 19)}` : ""));
  const gap = !!(newestHeld && oldestSeen && oldestSeen > newestHeld);
  if (gap) {
    log(`\n  ! GAP. The oldest log in this window (${oldestSeen.slice(0, 19)}) is NEWER than`);
    log(`    the newest already stored (${newestHeld.slice(0, 19)}). Calls were placed in`);
    log(`    between and Kylas cannot be asked for them — this read has no paging.`);
    log(`    Talk time for that stretch will be short. Run this more often (hourly),`);
    log(`    or raise --size, so the windows always overlap.`);
  }

  /* ── 4 · the rows ─────────────────────────────────────────────────── */
  const rows = timed.map((l) => {
    const rel = relList(l).find((x) => String(x.entity || "").toLowerCase() === "contact") || relList(l)[0] || {};
    const rec = l.callRecording || l.recordingUrl || l.recording || "";
    return {
      Key: String(l.id),
      "Called At": l.startTime || l.createdAt || "",
      Owner: who(l.owner) || who(l.createdBy) || "",
      Duration: secsOf(l),
      "Contact Kylas ID": String(rel.id || ""),
      "Call Type": String(l.callType || ""),
      Device: String(l.deviceId || ""),
      Recording: typeof rec === "string" ? rec.slice(0, 500) : "",
      "Imported At": new Date().toISOString(),
    };
  });
  const fresh = rows.filter((r) => !haveKeys.has(r.Key));
  log(`  ${rows.length} dialler call(s) in hand · ${fresh.length} not yet stored`);
  for (const r of fresh.slice(0, 10))
    log(`    ${r.Key.padEnd(10)} ${String(r["Called At"]).slice(0, 19)}  ${
      String(mmss(r.Duration)).padStart(7)}  ${r.Owner.padEnd(20)} contact ${r["Contact Kylas ID"]}`);
  if (fresh.length > 10) log(`    … and ${fresh.length - 10} more`);

  const summary = { read: logs.length, timed: rows.length, fresh: fresh.length, seconds, gap,
                    oldestSeen, newestSeen, newestHeld, written: 0 };
  if (!rows.length) { log("\nNothing with a duration in this window."); return summary; }
  if (!APPLY) {
    log(`\nNothing was written. Re-run with --apply to upsert all ${rows.length} into ${TABLE}.`);
    log(`(Upsert is keyed on the Kylas log id, so re-running a window costs nothing.)`);
    return summary;
  }

  /* Every row, not just the new ones: the upsert is keyed on the Kylas id, so
     re-sending one Kylas has since corrected fixes it rather than duplicating. */
  const { dropped } = await upsertManyTolerant(at, TABLE, "Key", rows);
  if (dropped?.length) log(`  ! ${TABLE} has no column for: ${dropped.join(", ")} — run scripts/schema.mjs`);
  log(`\nimported ${rows.length} dialler call(s), ${mmss(seconds)} of talk time.`);
  log(`The dashboard sums this table for Talk time — Refresh to see it.`);
  return { ...summary, written: rows.length, dropped: dropped || [] };
}

/* ── the command line ─────────────────────────────────────────────── */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : "";
  };
  run({ apply: argv.includes("--apply"), size: flag("size") })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
