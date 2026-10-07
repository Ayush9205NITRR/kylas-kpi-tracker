#!/usr/bin/env node
/* Fixtures for the mock Airtable, so a view can be judged on a spread rather
 * than on a happy path.
 *
 *   node scripts/dev-seed.mjs companies    43 companies across all six lanes
 *   node scripts/dev-seed.mjs rca          3 stalled contacts + 4 that must NOT be asked
 *   node scripts/dev-seed.mjs history      14 months of calls and transitions
 *   node scripts/dev-seed.mjs callbacks    contacts with a promised call-back
 *   node scripts/dev-seed.mjs buckets      accounts across all six call buckets
 *   node scripts/dev-seed.mjs all          all five, in order
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
/* Same, but hands back the records the mock created — the link fields need
   the parent's record id, which only the reply knows. */
async function postBack(table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map((fields) => ({ fields }));
    for (let t = 0; t < 6; t++) {
      const r = await fetch(`${A}/${encodeURIComponent(table)}`, {
        method: "POST", headers: H, body: JSON.stringify({ records: batch, typecast: true }) });
      if (r.ok) { out.push(...(await r.json()).records); break; }
      if (r.status !== 429) { console.error(`! ${table}: ${r.status} ${(await r.text()).slice(0, 160)}`); process.exit(1); }
      await sleep(700);
    }
    await sleep(260);
  }
  return out;
}

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
  /* First Worked At / First Picked At are what the ladder's bottom two rungs
     count. Without them every fixture contact sits outside the funnel and the
     ladder reads zero all the way down, which is how the first version of this
     seeder made a working ladder look broken. */
  const c = (Name, kid, extra) => ({ Name, "Kylas Contact ID": kid, Owner: "Enout Super Admin",
    "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD",
    "First Worked At": ago((extra["KPI Rank At"] ? 5 : 0) + 120),
    "First Picked At": ago(115),
    ...extra });
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
  /* Contacts carrying the two milestone dates spread across the window, so the
     ladder's bottom rungs have arrivals in more than one period and the
     "carried in" case can actually be seen. */
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const people = [];
  for (let i = 0; i < 24; i++) {
    const worked = 30 + i * 16;
    people.push({ Name: `Hist Contact ${i + 1}`, "Kylas Contact ID": String(71000 + i),
      Owner: i % 3 === 0 ? "Priya Deshmukh" : "Enout Super Admin",
      "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD",
      "First Worked At": ago(worked),
      /* Not everyone picks up, and those who do, do it later — which is the
         whole shape the funnel is meant to show. */
      ...(i % 4 === 0 ? {} : { "First Picked At": ago(worked - 4) }),
      /* Is Right POC / Is Discovery, not Has Signal: those are the FORMULA
         fields the proxy's report actually reads, and the mock does not compute
         formulas — it stores what it is given. Seeding the inputs and not the
         outputs left the top five rungs at zero while the bottom two worked. */
      ...(i % 3 === 0 ? { "KPI Rank": 14, "KPI Rank At": ago(worked - 9),
                          "Has Signal": 1, "Is Right POC": 1 } : {}),
      ...(i % 6 === 0 ? { "KPI Rank": 16, "Has Complete Row": 1, "Is Discovery": 1 } : {}),
    });
  }
  await post("Contacts", people);
  console.log(`           ${people.length} contacts with milestone dates across the window`);

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

/* CALL-BACKS, WHICH NOTHING ELSE SEEDED. The Next call column, its chip row,
   the focus pane's "promised and kept" and — since the filter builder learned
   what a date is — "next call within the next N days" all read one field, and
   no fixture ever wrote it. So every one of them was being judged on a column
   of em dashes, which agrees with any change you make to it.

   A spread on purpose: overdue, today, this week, and one far enough out to
   fall outside every window. The contact has to be LINKED to the company —
   progress.mjs walks Contacts → Company → Kylas id, so a contact with a date
   and no link is a call-back nobody can see. */
async function callbacks() {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  /* THE IDS THE MOCK KYLAS ACTUALLY HAS. companies() above invents 500000+,
     which is deliberate — it is what a base synced from another tenant looks
     like, and the console's "Kylas has never heard of these ids" banner is
     seeded by it. But a call-back has to land on an account the list SHOWS,
     and the list comes from Kylas. These four are in mock-kylas.mjs whatever
     MOCK_MANY is set to, so this fixture does not depend on it.
     Days from today: overdue, today, inside the week, and one well past it. */
  const PLAN = [["903", -11], ["1776620", 0], ["1778327", 3], ["1810449", 45]];
  const made = await postBack("Companies", PLAN.map(([kid], i) => ({
    "Kylas Company ID": kid, Name: `callback-co-${i + 1}`,
    Owner: "Enout Super Admin", "Kylas Owner ID": "74725",
    "Source of Data": SRC[i % SRC.length], "KPI Rank": 6,
  })));
  /* REMARKS, so the "Said before" preview has something to preview. It shipped
     with no fixture at all behind it, which is exactly why nobody saw what it
     looked like until it was in front of an associate. Three shapes, because
     they lay out differently and only one of them was ever imagined:
       0  a short note, the common case
       1  a long one, which must truncate to a line and offer "more"
       2  a human note ABOVE the machine block — the auto summary must be
          stripped, not shown back
     The third is left blank: no note is also a state. */
  const NOTE = [
    "Wants a Goa venue, 2 nights.",
    "Budget approx 8L but not signed off — finance review is on the 20th, and she " +
    "asked us to come back after that with two options, one in Goa and one closer " +
    "to Pune, because half the team is travelling from there and last year's offsite " +
    "lost a day to the drive.",
    "Prefers WhatsApp over calls.\n--- BD CONSOLE (auto, do not edit below) ---\n" +
    "Stage: MQL · Owner: Enout Super Admin · written by the console",
    "",
  ];
  const people = PLAN.map(([, d], i) => ({
    Name: `Callback Contact ${i + 1}`, "Kylas Contact ID": String(72000 + i),
    Owner: i % 2 ? "Priya Deshmukh" : "Enout Super Admin",
    Remarks: NOTE[i] || undefined,
    /* NOT an exit stage: progress.mjs drops a call-back promised to somebody
       who has since said no, which is right, and which also means seeding one
       there would silently seed nothing. */
    "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD",
    Company: made[i] ? [made[i].id] : undefined,
    "Next Call Date": day(d),
  }));
  /* THREE CONTACTS ON ONE ACCOUNT, EACH AT A DIFFERENT STAGE — the case the
     Account stage column exists for, and the one no fixture had. The account
     sits at the FURTHEST of them (Follow-up 2, rung 17), not the first, not
     the last written, and not the company's own field. Without this every
     account had exactly one contact and "highest wins" was a rule nothing
     could disagree with. */
  const SPREAD = ["CNC_COULD_NOT_CONNECT", "MQL_MARKETING_QUALIFIED_LEAD", "FOLLOW_UP_2"];
  SPREAD.forEach((stage, i) => people.push({
    Name: `Spread Contact ${i + 1}`, "Kylas Contact ID": String(72100 + i),
    Owner: "Enout Super Admin", "Current Stage": stage,
    Company: made[0] ? [made[0].id] : undefined,
  }));

  await post("Contacts", people);
  console.log(`           ${SPREAD.length} contacts on ${PLAN[0][0]} at ${SPREAD.length} different stages `
    + `— the account sits at ${SPREAD[SPREAD.length - 1]}`);
  console.log(`callbacks  ${people.length - SPREAD.length} promised on real Kylas ids — `
    + `${PLAN.filter(([, d]) => d < 0).length} overdue, 1 today, `
    + `${PLAN.filter(([, d]) => d > 0 && d <= 7).length} inside the week, `
    + `${PLAN.filter(([, d]) => d > 7).length} beyond it`);
}

/* ONE ACCOUNT IN EVERY BUCKET, so the board can be judged on a spread.
   Without this the fixture had contacts on four accounts and the board showed
   two buckets with one card each and 262 in "No contacts yet" — which is
   honest about the mock, and useless for looking at the thing.

   Three stages per bucket, chosen to include the ones that are easy to file
   wrongly: Discovery Call No-Show sits in Meeting in play (it is a meeting to
   re-book, not a loss) though its rung is 20; Connect Later sits in CNC though
   nobody failed to connect; Offsite Delayed sits in Activation and above
   though its rung is below Activation's. */
const BUCKET_STAGES = [
  ["YET_TO_BE_MINED"],
  ["CNC_COULD_NOT_CONNECT", "CNC_COULD_NOT_CONNECT_3", "CONNECT_LATER"],
  ["ACTIVATION", "MQL_MARKETING_QUALIFIED_LEAD", "FOLLOW_UP_2", "OFFSITE_DELAYED"],
  ["DISCOVERY_CALL_BOOKED", "GHOSTED", "ACTIVE_REQUIREMENT_CALL_BOOKED"],
  ["DISQUALIFIED_WRONG_POC", "NOT_A_DECISION_MAKER_NDM", "POC_ORGANIZATION_CHANGED"],
  ["NOT_INTERESTED", "INVALID_CONTACT", "CLOSING_LOOPS_LOW_VALUE"],
];
async function buckets() {
  const flat = BUCKET_STAGES.flat();
  /* Kylas ids the mock actually serves under MOCK_MANY — the board shows the
     Kylas roster, so an account Kylas has never heard of never appears on it
     however many contacts it has. */
  const made = await postBack("Companies", flat.map((stage, i) => ({
    "Kylas Company ID": String(200000 + i), Name: `bucket-${String(i).padStart(2, "0")}`,
    Owner: i % 2 ? "Priya Deshmukh" : "Enout Super Admin", "Kylas Owner ID": i % 2 ? "74726" : "74725",
    "Source of Data": SRC[i % SRC.length], "KPI Rank": 6,
  })));
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const people = flat.map((stage, i) => ({
    Name: `Bucket Contact ${i + 1}`, "Kylas Contact ID": String(73000 + i),
    Owner: i % 2 ? "Priya Deshmukh" : "Enout Super Admin",
    "Current Stage": stage,
    Company: made[i] ? [made[i].id] : undefined,
    /* A call-back on every third, so the cards have something to sort by. */
    ...(i % 3 === 0 ? { "Next Call Date": day((i % 7) - 2) } : {}),
  }));
  await post("Contacts", people);
  console.log(`buckets    ${flat.length} accounts across ${BUCKET_STAGES.length} buckets, `
    + `${people.filter((p) => p["Next Call Date"]).length} of them with a call-back`);
}

const what = process.argv[2] || "all";
/* ── MEETINGS BOOKED IN ONE PERIOD AND HELD IN ANOTHER ────────────────
   The case the "SQL booked → held" column exists for, and the one nothing
   seeded. history() writes its transitions with NO Contact link, so every one
   of them collapses onto the same blank company in firstArrivals() — fine for
   counting rows, useless for a cohort, and the reason the whole fixture showed
   a single booked company in a single month.

   Here each transition hangs off a real contact on a real company, and the
   bookings are deliberately spread so the lag is visible:
     - booked in month -3, held in month -2   (a past row that rose later)
     - booked in month -2, held in month -1
     - booked in month -2, never held         (so the rate is not a flat 100%)
     - booked in month -1, held the same week (the fast one)
     - booked last week, not yet held         (the recent cohort, still open)
   Read that as: month -2 booked two and held one = 50%. Under the old
   same-period ratio month -2 would have read "done 1 ÷ booked 2" by accident
   and month -1 "done 1 ÷ booked 1" = 100%, neither about its own bookings. */
async function meetings() {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const PLAN = [
    { who: "Lag A", booked: 95, held: 70 },
    { who: "Lag B", booked: 65, held: 35 },
    { who: "Lag C", booked: 62, held: null },
    { who: "Lag D", booked: 33, held: 30 },
    { who: "Lag E", booked: 6, held: null },
  ];
  const cos = await postBack("Companies", PLAN.map((p, i) => ({
    "Kylas Company ID": String(73100 + i), Name: `meet-co-${i + 1}`,
    Owner: "Enout Super Admin", "Kylas Owner ID": "74725", "KPI Rank": 23,
  })));
  const people = await postBack("Contacts", PLAN.map((p, i) => ({
    Name: `${p.who} Contact`, "Kylas Contact ID": String(73100 + i),
    Owner: "Enout Super Admin",
    "Current Stage": p.held ? "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS"
                            : "ACTIVE_REQUIREMENT_CALL_BOOKED",
    "KPI Rank": p.held ? 25 : 23,
    Company: cos[i] ? [cos[i].id] : undefined,
  })));
  const trans = [];
  PLAN.forEach((p, i) => {
    const contact = people[i] ? [people[i].id] : undefined;
    trans.push({ Key: `mt-b-${i}`, "To Stage": "ACTIVE_REQUIREMENT_CALL_BOOKED",
      "From Stage": "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS",
      "Changed At": ago(p.booked), Owner: "Enout Super Admin", Source: "Console", Contact: contact });
    if (p.held != null)
      trans.push({ Key: `mt-h-${i}`, "To Stage": "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS",
        "From Stage": "ACTIVE_REQUIREMENT_CALL_BOOKED",
        "Changed At": ago(p.held), Owner: "Enout Super Admin", Source: "Console", Contact: contact });
  });
  await post("Stage Transitions", trans);
  const held = PLAN.filter((p) => p.held != null).length;
  console.log(`meetings   ${PLAN.length} booked, ${held} later held — the booked -> held cohort`);
}

const JOBS = { companies, rca, history, callbacks, buckets, meetings };
if (what === "all") { for (const fn of Object.values(JOBS)) await fn(); }
else if (JOBS[what]) await JOBS[what]();
else { console.error(`usage: node scripts/dev-seed.mjs companies|rca|history|callbacks|buckets|meetings|all`); process.exit(2); }
