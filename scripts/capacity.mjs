#!/usr/bin/env node
/* WHEN DOES AIRTABLE STOP BEING ENOUGH?
 *
 *   node scripts/capacity.mjs
 *   node scripts/capacity.mjs --associates 4 --calls 150 --contacts-per-company 2
 *   node scripts/capacity.mjs --retention 30        # tighter Call Log rollup
 *
 * Ayush, 2026-10-07: "calculate the scale of how soon will I require to move
 * off Airtable."
 *
 * THE ANSWER IS TWO ANSWERS, and conflating them is how this gets planned
 * wrongly. Airtable has two independent ceilings and they are reached by
 * different things at different times:
 *
 *   1. RECORDS PER BASE, counted across every table in the base. This is hit
 *      by the STATIC backfill — 17,925 companies and their contacts — not by
 *      daily use. It does not care how many associates there are. It is
 *      reached the day the sync finally fills the base, which is a task
 *      already on the list.
 *
 *   2. API CALLS PER MONTH. This is hit by USE — saves, mirror deltas, syncs —
 *      and scales with the number of associates. Exceeding it does not stop
 *      the base: it throttles every call to 2/second for the rest of the
 *      calendar month, which on a console someone is waiting for is worse
 *      than an error, because it is invisible.
 *
 * Both are per-BASE, and this repo uses two bases (the KPI base and the
 * research base), so the research base's Company List is counted separately.
 *
 * Nothing here is a guess about Airtable's own numbers: the plan ceilings are
 * quoted at the top and sourced in docs/STATE.md. What IS an assumption is the
 * shape of the usage, and every one of those is a flag you can change.
 */

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : d;
};

/* ── --measure · ASK KYLAS INSTEAD OF ASSUMING ──────────────────────────
   The contact count moves the record floor more than any other input, and it
   was the one number here that started as a guess. Kylas reports the true
   total on a search even though it only serves the first 10,000 rows
   (STATE.md §), so one request per entity settles it. Read-only. */
async function measure() {
  const KEY = process.env.KYLAS_KEY;
  if (!KEY) { console.error("--measure needs KYLAS_KEY (use --env-file=.env.local)."); process.exit(1); }
  const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
  const everything = () => ({ condition: "AND", valid: true, rules: [
    { id: "multi_field", field: "multi_field", type: "multi_field",
      input: "multi_field", operator: "multi_field", value: "" }] });
  const total = async (entity, tries = 0) => {
    const r = await fetch(`${BASE}/v1/search/${entity}?page=0&size=1`, {
      method: "POST", headers: { "api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ fields: ["id"], jsonRule: everything() }) });
    /* A 429 is a wait, not an answer — it has misled this repo repeatedly. */
    if (r.status === 429 && tries < 6) {
      await new Promise((s) => setTimeout(s, 500 * 2 ** tries));
      return total(entity, tries + 1);
    }
    if (!r.ok) throw new Error(`${entity}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    const n = j?.totalElements ?? j?.totalSize ?? j?.page?.totalElements;
    if (!Number.isFinite(n)) throw new Error(`${entity}: no total in the reply`);
    return n;
  };
  const companies = await total("company");
  const contacts = await total("contact");
  console.log(`\nmeasured on this account: ${companies.toLocaleString("en-IN")} companies, ` +
              `${contacts.toLocaleString("en-IN")} contacts ` +
              `(${(contacts / companies).toFixed(2)} per company)\n`);
  return { companies, contacts };
}
const MEASURED = process.argv.includes("--measure") ? await measure() : null;

/* ── Airtable's ceilings, per base ──────────────────────────────────────
   Records per base, and API calls per month. Verified 2026-10-07; Airtable has
   changed these before, so they are data here rather than scattered in prose. */
const PLANS = [
  { name: "Free",             records: 1_000,   calls: 1_000,   note: "blocked after a 30-day grace period" },
  { name: "Team",             records: 50_000,  calls: 100_000, note: "throttled to 2 req/s for the rest of the month" },
  { name: "Business",         records: 125_000, calls: null,    note: "no published monthly cap" },
  { name: "Enterprise Scale", records: 500_000, calls: null,    note: "no published monthly cap" },
];
const PER_SECOND = 5;            /* every plan, per base */

/* ── what we are modelling ──────────────────────────────────────────── */
const ASSOCIATES  = arg("associates", 8);
const CALLS       = arg("calls", 150);              /* per associate per working day */
const WORKDAYS    = arg("workdays", 22);            /* per month */
const COMPANIES   = arg("companies", MEASURED?.companies ?? 17_925);
const PER_COMPANY = arg("contacts-per-company",
  MEASURED ? MEASURED.contacts / MEASURED.companies : 2);
const RETENTION   = arg("retention", 90);           /* days of raw Call Log kept */
/* A save upserts up to five tables, one request each (airtable.mjs: "a save
   touches up to five tables", and `upsert` is a single PATCH). */
const REQ_PER_SAVE = arg("req-per-save", 5);
/* Stage Transitions only gets a row when the stage actually moves. */
const MOVE_RATE   = arg("move-rate", 0.15);

const CONTACTS = Math.round(COMPANIES * PER_COMPANY);
const callsPerMonth = ASSOCIATES * CALLS * WORKDAYS;
const callsPerDay = ASSOCIATES * CALLS;
const fmt = (n) => n.toLocaleString("en-IN");
const months = (n) => n < 1 ? `${Math.round(n * 30)} days`
  : n < 2 ? `${n.toFixed(1)} months (${Math.round(n * 4.3)} weeks)`
  : `${n.toFixed(1)} months`;

console.log(`
WHEN AIRTABLE STOPS BEING ENOUGH
${"=".repeat(68)}

Modelling ${ASSOCIATES} associate(s) x ${CALLS} calls x ${WORKDAYS} working days
  = ${fmt(callsPerMonth)} calls a month (${fmt(callsPerDay)} a day)
Backfill: ${fmt(COMPANIES)} companies, ${fmt(CONTACTS)} contacts (at ${PER_COMPANY} per company)
Call Log retention: ${RETENTION} days raw, then rolled up`);

/* ── 1 · RECORDS ────────────────────────────────────────────────────────
   The floor is what the base holds before anybody calls anyone: the whole
   company and contact list, once the sync fills it. The growing part is the
   Call Log, which rollup-calls.mjs bounds at RETENTION days — without that
   cron it is unbounded and nothing below applies. */
const floor = COMPANIES + CONTACTS;
const logSteady = Math.round(callsPerDay * RETENTION);
const moveRows = Math.round(callsPerMonth * MOVE_RATE);
const aggRows = ASSOCIATES * WORKDAYS * 6;   /* day x owner x outcome, per month */

console.log(`
${"-".repeat(68)}
1 · RECORDS PER BASE  —  hit by the BACKFILL, not by use
${"-".repeat(68)}

  Companies                            ${fmt(COMPANIES).padStart(9)}
  Contacts                             ${fmt(CONTACTS).padStart(9)}
                                       ${"-".repeat(9)}
  Floor, before a single call           ${fmt(floor).padStart(8)}

  Call Log at steady state             ${fmt(logSteady).padStart(9)}   (${fmt(callsPerDay)}/day x ${RETENTION} days)
  Stage Transitions, per month         ${fmt(moveRows).padStart(9)}   (at ${Math.round(MOVE_RATE * 100)}% of calls)
  Rolled-up aggregates, per month      ${fmt(aggRows).padStart(9)}
                                       ${"-".repeat(9)}
  Steady state                          ${fmt(floor + logSteady + aggRows).padStart(8)}`);

const steady = floor + logSteady + aggRows;
for (const p of PLANS) {
  const headroom = p.records - floor;
  if (headroom <= 0) {
    console.log(`\n  ${p.name.padEnd(18)} ${fmt(p.records).padStart(8)} records` +
      `  — ALREADY OVER on the backfill alone (by ${fmt(-headroom)})`);
    continue;
  }
  /* Months of growth the plan has left once the backfill is in. */
  const perMonth = moveRows + aggRows;
  const toFill = headroom - logSteady;
  const verdict = toFill <= 0
    ? `fills before the ${RETENTION}-day Call Log is even full`
    : perMonth <= 0 ? "stable" : `${months(toFill / perMonth)} of growth left after the backfill`;
  console.log(`\n  ${p.name.padEnd(18)} ${fmt(p.records).padStart(8)} records` +
              `  — ${fmt(headroom)} spare after the backfill\n` +
              `  ${" ".repeat(18)} ${" ".repeat(8)}         ${verdict}`);
}

/* ── 2 · API CALLS ──────────────────────────────────────────────────────
   Saves dominate. The mirror only pulls a delta for a table that was READ in
   the last hour, at most once every ten minutes (mirror.mjs activeWithinMs /
   deltaEveryMs), so an idle month costs almost nothing — which is why this
   has not bitten yet with nobody using it. */
const saveCalls = callsPerMonth * REQ_PER_SAVE;
const MIRROR_TABLES = 13;
const activeHours = arg("active-hours", 9);
const deltaCalls = MIRROR_TABLES * 6 * activeHours * WORKDAYS;   /* 6 per hour, worst case */
const rebuildCalls = MIRROR_TABLES * 28 * Math.ceil(floor / 100 / MIRROR_TABLES);  /* ~26h cadence */
const syncCalls = 30 * Math.ceil(callsPerDay / 10) + 24 * 30;    /* nightly writes + hourly polls */
const total = saveCalls + deltaCalls + rebuildCalls + syncCalls;

console.log(`
${"-".repeat(68)}
2 · API CALLS PER MONTH  —  hit by USE, scales with associates
${"-".repeat(68)}

  Saves            ${fmt(saveCalls).padStart(9)}   ${fmt(callsPerMonth)} saves x ${REQ_PER_SAVE} requests
  Mirror deltas    ${fmt(deltaCalls).padStart(9)}   ${MIRROR_TABLES} tables, 6/hour, ${activeHours}h x ${WORKDAYS} days
  Mirror rebuilds  ${fmt(rebuildCalls).padStart(9)}   every ~26h, paginated at 100
  Syncs + polls    ${fmt(syncCalls).padStart(9)}   nightly incremental + hourly contacts
                   ${"-".repeat(9)}
  Total            ${fmt(total).padStart(9)}`);

const team = PLANS.find((p) => p.name === "Team");
const ratio = total / team.calls;
console.log(`
  Team's cap is ${fmt(team.calls)} a month. This model uses ${fmt(total)} — ${
  ratio > 1 ? `${ratio.toFixed(1)}x OVER` : `${Math.round(ratio * 100)}% of it`}.`);
if (ratio > 1) {
  const breakEven = Math.floor(ASSOCIATES / ratio);
  console.log(`  Past the cap, every request drops to 2/second for the rest of the month.`);
  console.log(`  ${breakEven} associate(s) is roughly where that budget runs out.`);
}
/* The per-second ceiling is the one an associate FEELS, and it is on every
   plan — no upgrade moves it. */
const peakPerSec = (callsPerDay * REQ_PER_SAVE) / (activeHours * 3600);
console.log(`
  Per-second: ${PER_SECOND}/s on every plan (${peakPerSec.toFixed(2)}/s average here).
  Average is not the problem; a shared ceiling and bursty saves is. ${ASSOCIATES}
  associates saving within the same second need ${ASSOCIATES * REQ_PER_SAVE} requests
  and the base allows ${PER_SECOND}.`);

console.log(`
${"-".repeat(68)}
3 · THE SAME DATA IN D1
${"-".repeat(68)}

  D1 has no record cap and no monthly request cap. The ceiling is 10GB a
  database; bench-lanes.mjs measured 13MB at 10,000 companies, so ${fmt(COMPANIES)}
  companies is roughly ${(COMPANIES / 10000 * 13).toFixed(0)}MB — about ${Math.round(10240 / (COMPANIES / 10000 * 13))}x headroom.

  The same bench measured the read: 309ms from SQL at 10,000 companies
  against 50s from Airtable. The migration is not only about ceilings.

${"=".repeat(68)}
WHERE THESE NUMBERS COME FROM
${MEASURED
  ? `
  Companies and contacts were MEASURED on the live account just now
  (${PER_COMPANY.toFixed(2)} contacts per company).`
  : `
  Companies (${fmt(COMPANIES)}) and contacts-per-company (${PER_COMPANY}) are ASSUMED.
  The contact count moves the record floor more than any other input here,
  so measure it rather than planning on the guess — one read, writes nothing:

    node --env-file=.env.local scripts/capacity.mjs --measure`}

  Airtable's ceilings are its published limits, verified 2026-10-07.
  Requests per save, the 13 mirror tables, the ~26h rebuild / 10-min delta
  cadence and the ${RETENTION}-day retention are read out of this repo's own code
  (airtable.mjs, mirror.mjs, rollup-calls.mjs), not estimated.

  What remains a judgement call: ${ASSOCIATES} associates, ${CALLS} calls each, ${Math.round(MOVE_RATE * 100)}% of calls
  moving a stage, and ${arg("active-hours", 9)} active hours a day. Change them with the flags.
`);
