#!/usr/bin/env node
/* THE KYLAS DIALLER APP'S TALK TIME — is it there, and can we read it in bulk?
 *
 *   node --env-file=.env.local scripts/probe-call-durations.mjs
 *   node --env-file=.env.local scripts/probe-call-durations.mjs --contact 5383723
 *
 * Ayush, 2026-10-15: "Talk time needs to be added through kylas dialer app —
 * kylas dialer app se joh talk time aa rahe hai usko list karo."
 *
 * WHERE THIS STANDS. Talk time on the dashboard is summed from the console's
 * own stopwatch, which only runs when a call is dialled from the console's
 * button: 7 of 1,379 rows had one, so a month read as three minutes. The
 * Kylas DIALLER APP records the real length of every call it places. So the
 * question is no longer "does a duration exist" but:
 *
 *   1. ARE the dialler app's calls in this account, with real durations?
 *      Every call log this console creates is `isManual` with duration 0 and
 *      is created by the API key's user, so the two are told apart by
 *      isManual / deviceId / callRecording / who created it — printed below
 *      per log, so one glance settles it.
 *
 *   2. CAN A WHOLE DAY BE READ? This is the blocker, and the reason nothing
 *      is built yet. GET /v1/call-logs returns the account's latest TEN and
 *      ignores every filter put to it — page, sort and relatedToId all came
 *      back with the identical ten (2026-10-11 and 2026-10-12). A nightly
 *      import needs a read that pages, or filters by date, or at least goes
 *      contact by contact. Section 2 tries every shape worth trying and says
 *      which, if any, answered differently.
 *
 * Every GET reads. The POSTs are Kylas SEARCH requests, which read too —
 * nothing is created, updated or deleted. Phone numbers are never printed.
 */
const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : ""; };
const CONTACT = arg("contact");
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A 429 is a wait, not an answer. */
async function raw(path, body = null, t = 0) {
  const r = await fetch(`${BASE}${path}`, body
    ? { method: "POST", headers: { "api-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { headers: { "api-key": KEY } });
  if (r.status === 429 && t < 6) { await sleep(500 * 2 ** t); return raw(path, body, t + 1); }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const clip = (s, n = 150) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const listOf = (j) => j?.content || j?.data || j?.records || j?.results || (Array.isArray(j) ? j : []);
const who = (v) => (v && typeof v === "object" ? (v.name || v.firstName || v.id) : v) || "";
const secsOf = (l) => Number(l?.duration ?? l?.callDuration ?? l?.durationInSeconds ?? l?.talkTime ?? 0) || 0;
const hasRec = (l) => !!(l?.callRecording || l?.recordingUrl || l?.recording);
/* relatedTo comes back as an array on the list and as a bare object on some
   single reads, so it is normalised rather than assumed — the first version
   of this probe crashed on the object form. */
const relList = (l) => [].concat(l?.relatedTo || []).filter(Boolean);
/* The console's own writes: isManual true, no device, no recording, 0s. */
const looksManual = (l) => l?.isManual === true || (!l?.deviceId && !hasRec(l) && secsOf(l) === 0);
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;

/* ── 1 · the latest logs, and which app made them ─────────────────── */
console.log(`\n1 · THE ACCOUNT'S LATEST CALL LOGS — dialler app, or this console?\n${"=".repeat(74)}`);
const first = await raw("/v1/call-logs");
const base = listOf(first.json);
const baseIds = base.map((l) => l.id).join();
console.log(`  status ${first.status} · ${base.length} log(s)` +
  (first.json?.totalElements != null ? ` · the account holds ${first.json.totalElements}` : ""));
if (first.status !== 200) console.log(`  answer: ${clip(first.text, 300)}`);
for (const l of base) {
  const rel = relList(l)[0] || {};
  console.log(`  #${String(l.id).padEnd(9)} ${String(l.startTime || l.createdAt || "?").slice(0, 19)}` +
    `  ${String(secsOf(l) ? mmss(secsOf(l)) : "0s").padStart(7)}` +
    `  ${looksManual(l) ? "console " : "DIALLER "}` +
    `${hasRec(l) ? "rec " : "    "}${l.deviceId ? "dev " : "    "}` +
    ` by ${clip(who(l.owner) || who(l.createdBy), 20).padEnd(20)} -> ${rel.entity || "?"} ${rel.id || ""}`);
}
if (base.length) {
  const timed = base.filter((l) => secsOf(l) > 0);
  const dialler = base.filter((l) => !looksManual(l));
  console.log(`\n  ${timed.length} of ${base.length} carry a duration · ${dialler.length} look like the dialler app`);
  console.log(`  fields on a log: ${Object.keys(base[0]).sort().join(", ")}`);
  /* Any key whose name hints at a length, with its value, so a duration
     stored under a name nobody guessed is not missed. */
  const timeKeys = Object.entries(base[0])
    .filter(([k]) => /dur|time|sec|talk|length/i.test(k) && !/startTime|createdAt|updatedAt/.test(k));
  console.log(`  length-ish keys on the newest: ${JSON.stringify(Object.fromEntries(timeKeys))}`);
  const one = await raw(`/v1/call-logs/${base[0].id}`);
  if (one.status === 200 && one.json) {
    const extra = Object.keys(one.json).filter((k) => !(k in base[0])).sort();
    console.log(`  read alone it also has: ${extra.join(", ") || "(nothing more)"} · duration ${secsOf(one.json)}s`);
  }
  if (!timed.length)
    console.log(`\n  ! NONE of the latest ten has a duration. If the team dialled through the\n` +
                `    Kylas app today, either these ten are all console saves (see the column\n` +
                `    above) or the app is not writing a length. Section 2 looks further back.`);
}

/* ── 2 · can a whole day be read? ─────────────────────────────────── */
console.log(`\n2 · A READ THAT GOES PAST THE LATEST TEN — what an import needs\n${"=".repeat(74)}`);
const now = new Date(), from = new Date(now.getTime() - 7 * 864e5);
const dateRule = (field) => ({ condition: "AND", valid: true, rules: [
  { id: field, field, type: "date", input: "date", operator: "between",
    value: [from.toISOString(), now.toISOString()] }] });
const anything = { condition: "AND", valid: true, rules: [
  { id: "multi_field", field: "multi_field", type: "multi_field",
    input: "multi_field", operator: "multi_field", value: "" }] };

const TRIES = [
  /* paging and sorting on the endpoint that does answer */
  ["GET  ?size=100",                 "/v1/call-logs?size=100"],
  ["GET  ?page=0&size=100",          "/v1/call-logs?page=0&size=100"],
  ["GET  ?pageNumber=0&pageSize=100","/v1/call-logs?pageNumber=0&pageSize=100"],
  ["GET  ?limit=100&offset=0",       "/v1/call-logs?limit=100&offset=0"],
  ["GET  ?sort=startTime,asc",       "/v1/call-logs?sort=startTime,asc"],
  ["GET  ?startTime>= (7d)",         `/v1/call-logs?startTimeFrom=${from.toISOString()}&startTimeTo=${now.toISOString()}`],
  /* the search endpoints, under every entity name worth trying */
  ["POST /v1/search/call-log",       "/v1/search/call-log?page=0&size=100",  { fields: ["id"], jsonRule: anything }],
  ["POST /v1/search/calllog",        "/v1/search/calllog?page=0&size=100",   { fields: ["id"], jsonRule: anything }],
  ["POST /v1/search/call_log",       "/v1/search/call_log?page=0&size=100",  { fields: ["id"], jsonRule: anything }],
  ["POST /v1/search/call",           "/v1/search/call?page=0&size=100",      { fields: ["id"], jsonRule: anything }],
  ["POST /v1/search/calls",          "/v1/search/calls?page=0&size=100",     { fields: ["id"], jsonRule: anything }],
  ["POST /v1/search/activity",       "/v1/search/activity?page=0&size=100",  { fields: ["id"], jsonRule: anything }],
  ["POST /v1/call-logs/search",      "/v1/call-logs/search?page=0&size=100", { jsonRule: anything }],
  ["POST /v1/call-logs/filter",      "/v1/call-logs/filter?page=0&size=100", { jsonRule: anything }],
  ["POST search by startTime (7d)",  "/v1/search/call-log?page=0&size=100",  { fields: ["id"], jsonRule: dateRule("startTime") }],
  /* the activity timeline, which is where a CRM usually keeps calls */
  ["GET  /v1/activities",            "/v1/activities?page=0&size=100"],
  ["GET  /v1/activity-logs",         "/v1/activity-logs?page=0&size=100"],
];
let found = [];
for (const [label, path, body] of TRIES) {
  const r = await raw(path, body || null);
  const got = listOf(r.json);
  const same = got.length > 0 && got.map((l) => l.id).join() === baseIds;
  const timed = got.filter((l) => secsOf(l) > 0).length;
  const stamps = got.map((l) => String(l.startTime || l.createdAt || "")).filter(Boolean).sort();
  const span = stamps.length ? `${stamps[0].slice(0, 10)}..${stamps[stamps.length - 1].slice(0, 10)}` : "";
  const note = r.status !== 200 ? `— ${clip(r.text, 90)}`
    : !got.length ? "— 200 but no rows"
    : same ? "— the SAME ten (filter ignored)"
    : `${got.length} row(s)${r.json?.totalElements != null ? ` of ${r.json.totalElements}` : ""} · ${timed} timed · ${span}  <<< THIS ONE ANSWERS`;
  if (r.status === 200 && got.length && !same) found.push(label);
  console.log(`  ${label.padEnd(33)} ${String(r.status).padEnd(4)} ${note}`);
  await sleep(220);
}

/* ── 3 · one contact's calls ──────────────────────────────────────── */
if (CONTACT) {
  console.log(`\n3 · EVERY CALL ON CONTACT ${CONTACT}, if Kylas will scope by contact\n${"=".repeat(74)}`);
  for (const [label, path, body] of [
    ["GET  /v1/contacts/{id}/call-logs",  `/v1/contacts/${CONTACT}/call-logs`],
    ["GET  /v1/contacts/{id}/activities", `/v1/contacts/${CONTACT}/activities`],
    ["GET  /v1/contacts/{id}/timeline",   `/v1/contacts/${CONTACT}/timeline`],
    ["GET  ?relatedToId (known ignored)", `/v1/call-logs?relatedToType=contact&relatedToId=${CONTACT}`],
    ["POST search by relatedToId",        "/v1/search/call-log?page=0&size=100",
      { fields: ["id"], jsonRule: { condition: "AND", valid: true, rules: [
        { id: "relatedToId", field: "relatedToId", type: "long", input: "select",
          operator: "equal", value: Number(CONTACT) }] } }],
  ]) {
    const r = await raw(path, body || null);
    const got = listOf(r.json);
    const mine = got.filter((l) => relList(l).some((x) => String(x.id) === String(CONTACT)));
    const same = got.length > 0 && got.map((l) => l.id).join() === baseIds;
    console.log(`  ${label.padEnd(36)} ${String(r.status).padEnd(4)} ` +
      (r.status !== 200 ? `— ${clip(r.text, 80)}`
        : same ? "— the SAME ten (not scoped)"
        : `${got.length} row(s), ${mine.length} actually this contact's, ${got.filter((l) => secsOf(l) > 0).length} timed`));
    await sleep(220);
  }
}

console.log(`\n${"=".repeat(74)}`);
if (found.length) {
  console.log(`READ THIS: ${found.length} shape(s) answered with something other than the latest ten —`);
  for (const f of found) console.log(`   ${f}`);
  console.log(`Send the output back and I will build the nightly import of real talk time on it.`);
} else {
  console.log(`NOTHING got past the latest ten. On this evidence the API cannot hand us a`);
  console.log(`day of call logs, so the dialler app's talk time cannot be imported yet. Send`);
  console.log(`this output back — the next step is Kylas support: "which endpoint lists call`);
  console.log(`logs for the account, paged or filtered by date?" This output IS the question.`);
}
console.log(`\nSafe to paste: log ids, times, durations, owner names. No phone numbers, no key.\n`);
