#!/usr/bin/env node
/* Fixtures for the mock Airtable, so a view can be judged on a spread rather
 * than on a happy path.
 *
 *   node scripts/dev-seed.mjs companies    43 companies across all six lanes
 *   node scripts/dev-seed.mjs rca          3 stalled contacts + 4 that must NOT be asked
 *   node scripts/dev-seed.mjs history      14 months of calls and transitions
 *   node scripts/dev-seed.mjs all          all three, in order
 *
 * Writes to the MOCK base at 127.0.0.1:9901. It refuses to run against anything
 * else — see the guard below. Start the stack first:
 *
 *   node scripts/mock-kylas.mjs &
 *   node scripts/mock-airtable.mjs &
 *   KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x \
 *   AIRTABLE_BASE_URL=http://127.0.0.1:9901 AIRTABLE_PAT=pat_mock \
 *   AIRTABLE_BASE=appMOCK PORT=8787 node scripts/proxy.mjs &
 *
 * WHY THESE SHAPES. Each fixture exists because a real bug hid behind a thinner
 * one. The company set covers every lane INCLUDING closed, which is how the
 * Closed column being silently empty was caught. The RCA set is three due and
 * four controls — moved recently, already booked, no rank date, somebody else's
 * — and every one of those four was, at some point, wrongly listed as due.
 */
const BASE = process.env.AIRTABLE_BASE_URL || "http://127.0.0.1:9901";
const APP = process.env.AIRTABLE_BASE || "appMOCK";
const PAT = process.env.AIRTABLE_PAT || "pat_mock";

/* THE GUARD. This writes hundreds of invented rows. Pointed at the real base by
   a stray env var it would be a long evening, and the only thing standing
   between here and there is one variable somebody exported in another tab. */
if (!/127\.0\.0\.1|localhost/.test(BASE) || APP !== "appMOCK") {
  console.error(`! dev-seed only writes to the local mock.\n` +
                `  AIRTABLE_BASE_URL=${BASE}\n  AIRTABLE_BASE=${APP}\n` +
                `  Refusing: these fixtures are junk data and this is not the mock.`);
  process.exit(1);
}

const A = `${BASE}/v0/${APP}`;
const H = { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* The mock rate-limits above 5 req/s, and a 429 has no `records` — a loop that
   does not retry reads that as success and seeds half a fixture. */
async function post(table, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((fields) => ({ fields }));
    let ok = false;
    for (let t = 0; t < 6; t++) {
      const r = await fetch(`${A}/${encodeURIComponent(table)}`, {
        method: "POST", headers: H, body: JSON.stringify({ records: batch, typecast: true }) });
      if (r.ok) { ok = true; break; }
      if (r.status !== 429) { console.error(`! ${table}: ${r.status} ${(await r.text()).slice(0, 160)}`); process.exit(1); }
      await sleep(700);
    }
    if (!ok) { console.error(`! ${table}: still rate limited after six tries`); process.exit(1); }
    await sleep(260);
  }
}

const SRC = ["Apollo", "Cold Calling", "Round-Robin", "LinkedIn"];

async function companies() {
  const rows = [];
  let id = 500000, n = 0;
  /* lane, how many, days since the last call (null = never) */
  const plan = [
    ["untouched", 9, null], ["working", 14, [1, 3, 9, 21, 40]],
    ["right", 8, [2, 6, 18, 33]], ["discovery", 5, [4, 12, 27]],
    ["booked", 4, [1, 5, 16]], ["closed", 3, [30, 60]],
  ];
  for (const [lane, count, ages] of plan) {
    for (let i = 0; i < count; i++) {
      const age = ages ? ages[i % ages.length] : null;
      rows.push({
        "Kylas Company ID": String(id++),
        Name: `${lane}-co-${String(i + 1).padStart(2, "0")}`,
        "Source of Data": SRC[n++ % SRC.length],
        Owner: "Enout Super Admin", "Kylas Owner ID": "74725",
        Batch: `B-${10 + (i % 3)}`,
        "Last Called At": age === null ? "" : day(age),
        Reached: lane !== "untouched", "Phone Picked": lane !== "untouched",
        "Right POC": ["right", "discovery", "booked"].includes(lane),
        "Successful Discovery": ["discovery", "booked"].includes(lane),
        "SQL Meeting Booked": lane === "booked",
        "KPI Rank": lane === "booked" ? 19 : lane === "discovery" ? 16 : lane === "right" ? 14 : 6,
        "KPI Stage": lane === "booked" ? "19 · Discovery Call Booked" : "",
        "Kylas Stage": lane === "booked" ? "DISCOVERY_CALL_BOOKED"
          : ["discovery", "right"].includes(lane) ? "MQL_MARKETING_QUALIFIED_LEAD"
          : lane === "closed" ? "NOT_INTERESTED"
          : lane === "working" ? "CNC_COULD_NOT_CONNECT" : "",
        "Right POC Contacts": ["right", "discovery", "booked"].includes(lane)
          ? (i % 3 === 0 ? "Hema Bharathi, Shipra Gupta" : "Hema Bharathi") : "",
        "Discovery Contacts": ["discovery", "booked"].includes(lane) ? "Shipra Gupta" : "",
      });
    }
  }
  await post("Companies", rows);
  console.log(`companies  ${rows.length} across ${plan.length} lanes`);
}

async function rca() {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const c = (Name, kid, extra) => ({ Name, "Kylas Contact ID": kid, Owner: "Enout Super Admin",
    "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD", ...extra });
  const rows = [
    /* due */
    c("Stalled Right A", "70001", { "KPI Rank": 14, "KPI Rank At": ago(40), "Has Signal": 1, "Has Complete Row": 0 }),
    c("Stalled Right B", "70002", { "KPI Rank": 14, "KPI Rank At": ago(95), "Has Signal": 1, "Has Complete Row": 0 }),
    c("Stalled Discovery", "70003", { "KPI Rank": 16, "KPI Rank At": ago(30), "Has Signal": 1, "Has Complete Row": 1 }),
    /* controls — every one of these was wrongly listed as due at some point */
    c("Fresh Right", "70004", { "KPI Rank": 14, "KPI Rank At": ago(5), "Has Signal": 1, "Has Complete Row": 0 }),
    c("Booked Already", "70005", { "KPI Rank": 19, "KPI Rank At": ago(60), "Has Signal": 1, "Has Complete Row": 1,
      "Current Stage": "DISCOVERY_CALL_BOOKED" }),
    c("No Date", "70006", { "KPI Rank": 14, "Has Signal": 1, "Has Complete Row": 0 }),
    { ...c("Other Owner", "70007", { "KPI Rank": 14, "KPI Rank At": ago(80), "Has Signal": 1, "Has Complete Row": 0 }),
      Owner: "Priya Deshmukh" },
  ];
  await post("Contacts", rows);
  console.log(`rca        ${rows.length} contacts (3 due, 4 controls)`);
}

async function history() {
  const calls = [], trans = [];
  const OUT = ["No answer", "No answer", "No answer", "Wrong POC", "Right POC", "Discovery"];
  let n = 0;
  for (let d = 430; d >= 0; d -= 3) {
    const at = new Date(Date.now() - d * 86400000);
    for (let i = 0; i < 2 + (d % 4); i++) {
      const t = new Date(at); t.setUTCHours(9 + i, (i * 7) % 60, 0, 0);
      calls.push({ Key: `h-${n++}`, "Called At": t.toISOString(), Outcome: OUT[(d + i) % OUT.length],
                   Owner: "Enout Super Admin", Duration: 40, "Duration Source": "dialed" });
    }
    /* %12===6 and not %12===0: d steps by 3 from 430, so d is always 1 mod 3 and
       a multiple of 12 never comes up. The first version of this seeded zero
       transitions and nobody noticed until the conversion columns stayed 0. */
    if (d % 12 === 6) trans.push({ Key: `ht-${n++}`, "To Stage": "DISCOVERY_CALL_BOOKED",
      "From Stage": "MQL_MARKETING_QUALIFIED_LEAD", "Changed At": at.toISOString(),
      Owner: "Enout Super Admin", Source: "Console" });
    if (d % 30 === 10) trans.push({ Key: `ht-${n++}`, "To Stage": "SQL_SALES_QUALIFIED_LEAD",
      "From Stage": "DISCOVERY_CALL_BOOKED", "Changed At": at.toISOString(),
      Owner: "Enout Super Admin", Source: "Console" });
  }
  await post("Call Log", calls);
  await post("Stage Transitions", trans);
  console.log(`history    ${calls.length} calls, ${trans.length} transitions over 14 months`);
}

const what = process.argv[2] || "all";
const JOBS = { companies, rca, history };
if (what === "all") { for (const fn of Object.values(JOBS)) await fn(); }
else if (JOBS[what]) await JOBS[what]();
else { console.error(`usage: node scripts/dev-seed.mjs companies|rca|history|all`); process.exit(2); }
