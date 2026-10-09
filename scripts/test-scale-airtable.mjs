#!/usr/bin/env node
/* DOES AIRTABLE HOLD UP AT THIS ACCOUNT'S REAL SIZE?
 *
 *   node scripts/test-scale-airtable.mjs
 *   node scripts/test-scale-airtable.mjs --companies 17925 --per-company 2
 *   node scripts/test-scale-airtable.mjs --quick            # 2,000 companies
 *
 * Ayush, 2026-10-08: "iske scale test kar lo, ki Airtable se data replace
 * karna padega or this will work fine."
 *
 * capacity.mjs answered that from Airtable's published limits — the record cap
 * and the monthly call cap. This asks a different and sharper question: BEFORE
 * either of those bites, does this repo's own code still return the right
 * answer at that size?
 *
 * It matters because `listAll` takes a `maxPages` and, unless the caller
 * passes `throwIfMore`, returns a PREFIX when it runs out. A prefix is not an
 * error. The reply is a 200, the console paints, the dashboard adds up — and
 * the numbers are of the first N rows. This repo has already been bitten by
 * exactly that once: "a month of numbers [was] the first 4,000 calls"
 * (reconcile.mjs).
 *
 * So: fill the mock to a real account's size and ask every ceiling whether it
 * is above or below the data it will be pointed at. The mock enforces
 * Airtable's five-a-second limit and its 100-row pages, so the paging under
 * test is the real paging; only the bulk SEED bypasses the ceiling, because
 * 50,000 rows at ten per request behind 5/s is twenty minutes of nothing.
 *
 * WHAT THIS IS NOT. It does not call the real Airtable, and it does not
 * measure wall-clock latency against it — bench-lanes.mjs models that. This is
 * about correctness at size: truncation, and the request count that causes it.
 */
import { spawn } from "node:child_process";
import { createAirtable } from "./airtable.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : d;
};
const QUICK = process.argv.includes("--quick");
const COMPANIES = arg("companies", QUICK ? 2_000 : 17_925);
const PER_CO = arg("per-company", 2);
const CONTACTS = COMPANIES * PER_CO;
/* 90 days is what rollup-calls.mjs keeps raw before compacting. */
const CALLS = arg("calls", QUICK ? 5_000 : 1_200 * 90);
const EVENTS = arg("events", QUICK ? 2_000 : Math.round(CONTACTS * 0.25));
const PORT = 9931;

let pass = 0, fail = 0;
const fmt = (n) => n.toLocaleString("en-IN");
const check = (what, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};

const mock = spawn(process.execPath, ["scripts/mock-airtable.mjs"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
mock.stdout.on("data", () => {});
const stop = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/__count`, { headers: { Authorization: "Bearer x" } });
        if (r.ok) break; } catch { /* not up yet */ }
  await sleep(150);
}

const bulk = (table, count, fields) => fetch(`${BASE}/__bulk`, {
  method: "POST", headers: { Authorization: "Bearer x", "content-type": "application/json" },
  body: JSON.stringify({ table, count, fields }) }).then((r) => r.json());

console.log(`\nFILLING THE BASE TO THIS ACCOUNT'S SIZE`);
console.log(`${"=".repeat(70)}`);
const t0 = Date.now();
await bulk("Companies", COMPANIES, { "Kylas Company ID": "#", Name: "co-#",
  Owner: "Enout Super Admin", "Kylas Owner ID": "74725", "KPI Rank": 13 });
await bulk("Contacts", CONTACTS, { "Kylas Contact ID": "#", Name: "contact-#",
  Owner: "Enout Super Admin", "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD",
  "KPI Rank": 13, Remarks: "note #" });
await bulk("Call Log", CALLS, { Key: "c-#", "Called At": "2026-09-01T09:00:00.000Z",
  Owner: "Enout Super Admin", Outcome: "No answer" });
await bulk("Event Rows", EVENTS, { "Row Key": "e-#", Period: "current",
  "Event Type": "Employee offsites", Budget: "8L" });
await bulk("Stage Transitions", Math.round(CONTACTS * 0.3), { Key: "t-#",
  "To Stage": "MQL_MARKETING_QUALIFIED_LEAD", "Changed At": "2026-09-01T09:00:00.000Z" });
const counts = await fetch(`${BASE}/__count`, { headers: { Authorization: "Bearer x" } }).then((r) => r.json());
/* ARRANGE, ASSERTED. The first run of this seeded nothing — the mock throttled
   its own seeding hooks — and then cheerfully reported that no read truncates,
   over an empty base. Every ceiling is above zero. A scale test that passes
   with no data at scale is worse than no scale test, so it refuses to go on. */
if (counts.error || typeof counts.Contacts !== "number") {
  console.error(`\n! the base did not fill: ${JSON.stringify(counts).slice(0, 200)}`);
  stop(); process.exit(1);
}
for (const [t, want] of [["Companies", COMPANIES], ["Contacts", CONTACTS], ["Call Log", CALLS]])
  if (counts[t] !== want) {
    console.error(`\n! ${t} holds ${fmt(counts[t] || 0)}, asked for ${fmt(want)} — seeding is wrong, ` +
                  `so nothing below would mean anything.`);
    stop(); process.exit(1);
  }
const total = Object.values(counts).reduce((a, b) => a + b, 0);
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(20)} ${fmt(n).padStart(9)}`);
console.log(`  ${"TOTAL RECORDS".padEnd(20)} ${fmt(total).padStart(9)}   (seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

/* ── 1 · the plan caps, against what is actually there ──────────────── */
console.log(`\n1 · AIRTABLE'S RECORD CAP, AGAINST THIS BASE`);
console.log(`${"-".repeat(70)}`);
for (const [plan, cap] of [["Free", 1_000], ["Team", 50_000], ["Business", 125_000], ["Enterprise Scale", 500_000]]) {
  const over = total > cap;
  console.log(`  ${plan.padEnd(18)} ${fmt(cap).padStart(9)}  ${
    over ? `OVER by ${fmt(total - cap)}` : `${fmt(cap - total)} spare`}`);
}

/* ── 2 · THE PART THAT FAILS QUIETLY ────────────────────────────────
   Every ceiling in the code, against the table it will be pointed at. A
   ceiling below its table does not error — it returns a prefix. */
console.log(`\n2 · EVERY PAGING CEILING, AGAINST THE TABLE IT READS`);
console.log(`${"-".repeat(70)}`);
console.log(`  A ceiling below its table returns a PREFIX, not an error: a 200,`);
console.log(`  a console that paints, and numbers that are of the first N rows.\n`);

/* Where each ceiling lives, read out of the source rather than retyped, so a
   changed number here is a changed number there. */
/* A FILTERED READ IS NOT MEASURED AGAINST THE WHOLE TABLE. The contacts read
   for one company carries `{Company Kylas ID} = ...`, so its 20 pages are
   2,000 contacts AT ONE COMPANY — a ceiling nothing will ever reach. Comparing
   it to every contact in the base made the first run of this cry wolf, and a
   scale test that cries wolf gets switched off, which is this repo's own
   argument about the reconciler. `scope` says what the ceiling is measured
   against. */
const CEILINGS = [
  ["airtable.mjs  companies, for the queue", "Companies", 200, "table"],
  ["airtable.mjs  scanContacts", "Contacts", 200, "table"],
  ["airtable.mjs  contacts, for one company", "Contacts", 20, "company"],
  ["airtable.mjs  contacts, for the board", "Contacts", 200, "table"],
  ["airtable.mjs  companies, for the board", "Companies", 200, "table"],
  ["airtable.mjs  contacts, for RCA", "Contacts", 400, "table"],
  /* Reads EVERY event row and filters client-side, so this one is a full
     scan however few contacts are being shown. */
  ["airtable.mjs  eventsFor (scans all, filters after)", "Event Rows", 60, "table"],
  ["handlers.mjs  the report's four tables", "Call Log", 2000, "table"],
  ["handlers.mjs  owners", "Contacts", 200, "table"],
  /* Was 200 pages here, read whole, for the watermark AND the previous stage —
     the second of which wrote KPI Rank down for contacts past row 20,000. The
     watermark is now one sorted row; the previous stage reads by id or reads
     the whole table with throwIfMore. test-sync-scale.mjs runs both. */
  ["sync-kylas.mjs  previous stage, whole table", "Contacts", 2000, "table"],
  ["rollup-calls.mjs  the raw call log", "Call Log", 400, "table"],
  ["mirror.mjs  a table build", "Contacts", 2000, "table"],
];
let truncating = 0;
for (const [where, table, pages, scope] of CEILINGS) {
  const holds = scope === "company" ? PER_CO : (counts[table] || 0);
  const ceiling = pages * 100;
  const ok = ceiling >= holds;
  if (!ok) truncating++;
  const against = scope === "company" ? `${fmt(holds)} per company` : `${fmt(holds)} in ${table}`;
  console.log(`  ${ok ? "ok  " : "CUT "} ${where.padEnd(44)} ${
    String(pages).padStart(4)} pages = ${fmt(ceiling).padStart(7)}  vs ${
    against.padStart(20)}${ok ? "" : `   LOSES ${fmt(holds - ceiling)}`}`);
}
check("no read silently truncates at this size", truncating === 0,
      truncating ? `${truncating} of ${CEILINGS.length} ceilings are below their table` : "");

/* ── 3 · AND PROVE IT, through the real client ──────────────────────
   The table above is arithmetic. This is the same question asked of the code:
   read Contacts with the ceiling scanContacts uses and count what comes back. */
console.log(`\n3 · THE SAME QUESTION, ASKED OF THE REAL CLIENT`);
console.log(`${"-".repeat(70)}`);
const at = createAirtable("pat_mock", "appMOCK", { log: () => {}, apiUrl: BASE });
const t1 = Date.now();
const got = await at.listAll("Contacts", { fields: ["Name"], pageSize: 100, maxPages: 200 });
const secs = (Date.now() - t1) / 1000;
console.log(`  asked for every contact with maxPages 200`);
console.log(`  the base holds   ${fmt(counts.Contacts)}`);
console.log(`  the read returned ${fmt(got.length)}   in ${secs.toFixed(1)}s`);
check("the read returned every contact, not a prefix", got.length === counts.Contacts,
      got.length === counts.Contacts ? "" :
      `SILENTLY DROPPED ${fmt(counts.Contacts - got.length)} contacts — no error, a 200`);

/* throwIfMore is the opt-in that turns the prefix into a failure. Proving it
   fires here is proving the fix exists and is simply not switched on. */
let threw = "";
try {
  await at.listAll("Contacts", { fields: ["Name"], pageSize: 100, maxPages: 200, throwIfMore: true });
} catch (e) { threw = e.message; }
check("...and throwIfMore would have caught it", !!threw || got.length === counts.Contacts,
      threw ? threw.slice(0, 90) : "nothing to catch at this size");

/* ── 4 · what the reads cost, in requests ───────────────────────────── */
console.log(`\n4 · WHAT ONE FULL READ COSTS, IN AIRTABLE REQUESTS`);
console.log(`${"-".repeat(70)}`);
const reads = await fetch(`${BASE}/__reads`, { headers: { Authorization: "Bearer x" } }).then((r) => r.json());
const pagesFor = (n) => Math.ceil(n / 100);
const oneLap = ["Companies", "Contacts", "Call Log", "Event Rows", "Stage Transitions"]
  .reduce((a, t) => a + pagesFor(counts[t] || 0), 0);
console.log(`  requests this test has made so far        ${fmt(reads.reads).padStart(8)}`);
console.log(`  one full pass over the five big tables    ${fmt(oneLap).padStart(8)} requests`);
console.log(`  ...at Airtable's 5 req/s ceiling          ${(oneLap / 5 / 60).toFixed(1).padStart(8)} minutes`);
console.log(`  mirror rebuilds every ~26h, so per month  ${fmt(oneLap * 28).padStart(8)} requests`);
check("a full pass fits inside Team's 100,000 monthly calls on its own",
      oneLap * 28 < 100_000, `${fmt(oneLap * 28)} a month just to rebuild the mirror`);

console.log(`\n${"=".repeat(70)}`);
console.log(`${pass} passed, ${fail} failed`);
stop();
process.exit(fail ? 1 : 0);
