#!/usr/bin/env node
/* DOES KYLAS KNOW HOW LONG EACH CALL WAS? — read-only.
 *
 *   node --env-file=.env.local scripts/probe-call-durations.mjs
 *
 * Ayush, 2026-10-12: "call duration kaise sync hoga". Talk time on the
 * dashboard is summed from the console's Call Log, and the console only knows
 * a duration when the call was dialled from its own dial button: on
 * 2026-10-12, 7 of 1,379 Call Log rows had one. The calls are being made
 * somewhere else — the Kylas dialler or a phone — and if that somewhere is
 * Kylas, Kylas holds the real length of every call.
 *
 * This answers the two questions that decide whether we can read it:
 *
 *   1. Do Kylas call logs carry a real duration (and who made the call)?
 *   2. Can the account's logs be LISTED BY DATE, or only "the latest 10"?
 *      The plain GET ignores every filter (found 2026-10-11), so a nightly
 *      sync needs some other read that can walk back through a day.
 *
 * Every GET reads. The two POSTs are Kylas SEARCH requests, which read too —
 * nothing is created or changed. Phone numbers are never printed.
 */
const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
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
const clip = (s, n = 140) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const listOf = (j) => j?.content || j?.data || j?.records || (Array.isArray(j) ? j : []);
const who = (v) => (v && typeof v === "object" ? v.name || v.firstName || v.id : v) || "";
const secsOf = (l) => Number(l.duration ?? l.callDuration ?? l.durationInSeconds ?? 0) || 0;

/* ── 1 · the latest logs, as Kylas hands them out ─────────────────── */
console.log(`\n1 · THE ACCOUNT'S LATEST CALL LOGS (GET /v1/call-logs)\n${"=".repeat(72)}`);
const first = await raw("/v1/call-logs");
const logs = listOf(first.json);
console.log(`  status ${first.status} · ${logs.length} log(s)${first.json?.totalElements != null ? ` · totalElements ${first.json.totalElements}` : ""}`);
if (first.status !== 200) console.log(`  answer: ${clip(first.text, 300)}`);
for (const l of logs) {
  const rel = (l.relatedTo || [])[0] || {};
  console.log(`  #${l.id}  ${l.startTime || l.createdAt || "?"}  ${String(secsOf(l)).padStart(5)}s  ` +
    `${(l.callType || "?").padEnd(9)} ${(l.outcome || "?").padEnd(10)} by ${clip(who(l.owner) || who(l.createdBy), 24)}` +
    `  → ${rel.entity || "?"} ${rel.id || ""}`);
}
if (logs[0]) {
  /* The field names, so a duration stored under a name nobody guessed still
     shows up. Values for the obviously harmless ones only. */
  console.log(`\n  fields on a log: ${Object.keys(logs[0]).sort().join(", ")}`);
  const timed = logs.filter((l) => secsOf(l) > 0).length;
  console.log(`  ${timed} of ${logs.length} have a duration above 0`);
  const one = await raw(`/v1/call-logs/${logs[0].id}`);
  if (one.status === 200 && one.json) {
    const extra = Object.keys(one.json).filter((k) => !(k in logs[0])).sort();
    console.log(`  read alone, #${logs[0].id} also has: ${extra.join(", ") || "(nothing more)"}`);
    console.log(`  its duration read alone: ${secsOf(one.json)}s` +
      (one.json.callRecording || one.json.recordingUrl ? " · has a recording" : ""));
  }
}

/* ── 2 · can it be walked back by date? ───────────────────────────── */
console.log(`\n2 · LISTING BY DATE — what a nightly sync would need\n${"=".repeat(72)}`);
const now = new Date();
const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
const latestIds = logs.map((l) => l.id).join();
const range = { rules: [{ id: "startTime", field: "startTime", type: "date", operator: "between",
                          value: [dayAgo.toISOString(), now.toISOString()] }], condition: "AND", valid: true };
const TRIES = [
  ["GET  page=1 (second page)",        "/v1/call-logs?page=1"],
  ["GET  sort by startTime",           "/v1/call-logs?sort=startTime,desc"],
  ["POST /v1/call-logs/search",        "/v1/call-logs/search?page=0&size=50", { jsonRule: range }],
  ["POST /v1/search/call-log",         "/v1/search/call-log?page=0&size=50",  { jsonRule: range }],
  ["POST /v1/call-logs/search (none)", "/v1/call-logs/search?page=0&size=50", { jsonRule: null }],
];
for (const [label, path, body] of TRIES) {
  const r = await raw(path, body || null);
  const got = listOf(r.json);
  const same = got.length && got.map((l) => l.id).join() === latestIds;
  const timed = got.filter((l) => secsOf(l) > 0).length;
  const span = got.length
    ? `${got.map((l) => l.startTime || "").filter(Boolean).sort()[0] || "?"} → ${got.map((l) => l.startTime || "").filter(Boolean).sort().pop() || "?"}`
    : "";
  console.log(`  ${label.padEnd(34)} ${r.status}  ${got.length} log(s)` +
    (r.json?.totalElements != null ? ` of ${r.json.totalElements}` : "") +
    (got.length ? ` · ${timed} timed · ${span}${same ? " · SAME as section 1 (filter ignored)" : ""}` : "") +
    (r.status !== 200 ? `  — ${clip(r.text, 160)}` : ""));
}

console.log(`
WHAT TO SEND BACK: this whole output. It contains log ids, times, durations
and owner names — no phone numbers, no key. Section 1 says whether Kylas has
the real lengths; section 2 says whether a sync can read a whole day of them.`);
