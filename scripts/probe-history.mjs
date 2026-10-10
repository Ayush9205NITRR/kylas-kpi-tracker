#!/usr/bin/env node
/* WHERE DO THIS ACCOUNT'S PREVIOUS REMARKS ACTUALLY LIVE? — read-only.
 *
 *   node --env-file=.env.local scripts/probe-history.mjs --contact 5358971
 *
 * Ayush, 2026-10-09: "Previous remarks fetch nahi ho rahe hai."
 *
 * A contact in Kylas can carry what was said in three different places, and
 * the "Said before" strip has to read the right one:
 *
 *   1. the contact's own `remarks` field      — read since 1.47
 *   2. the notes on each CALL LOG              — read since 1.55 (/history)
 *   3. the contact's NOTES tab                 — not read; Kylas documents
 *                                                how to write one, not how to
 *                                                read them back
 *
 * Pick a contact whose previous remarks you can SEE in Kylas, and this prints
 * what each of the three holds for it. If the text you see in Kylas is under
 * 3 and nowhere else, send the output back — the probe also tries the likely
 * shapes of a Notes read, and the one that answers is the one to build on.
 *
 * Every request is a GET. Nothing is written.
 */
import { createClient, callNotes, toConsoleContact, kylasRemarksOf } from "./kylas.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const ID = (() => { const i = process.argv.indexOf("--contact"); return i > -1 ? process.argv[i + 1] : ""; })();
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
if (!ID) { console.error("Pass --contact <Kylas contact id> — one whose previous remarks you can see in Kylas."); process.exit(1); }

const kylas = createClient(KEY, { log: () => {}, ...(process.env.KYLAS_BASE ? { base: BASE } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A 429 is a wait, not an answer — it has misled this repo four times. */
async function raw(path, t = 0, body = null) {
  const r = await fetch(`${BASE}${path}`, body
    ? { method: "POST", headers: { "api-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { headers: { "api-key": KEY } });
  if (r.status === 429 && t < 6) { await sleep(500 * 2 ** t); return raw(path, t + 1, body); }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const clip = (s, n = 160) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

const c = await kylas.contact(ID);
const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ") || "(no name)";
console.log(`\ncontact ${ID} — ${name}\n${"=".repeat(72)}`);

/* 1 · the remarks field, as the console reads it */
const mapped = toConsoleContact(c, {});
const human = String(mapped.remarks || "").split("--- BD CONSOLE (auto")[0].trim();
console.log(`\n1 · REMARKS FIELD on the contact`);
console.log(human ? `  "${clip(human, 300)}"` : "  (empty — nothing typed here, or only the console's own block)");

/* 1b · the team's Remarks CUSTOM field — what "Said before" reads first
   since 1.58. Every custom field with "remark" in its name is listed, so a
   field Kylas named differently shows up here rather than reading as empty. */
console.log(`\n1b · REMARKS CUSTOM FIELD (cfRemarks)`);
const cfKeys = Object.keys(c?.customFieldValues || {}).filter((k) => /remark/i.test(k));
console.log(cfKeys.length ? `  fields: ${cfKeys.join(", ")}` : "  no custom field with \"remark\" in its name on this contact");
const kr = kylasRemarksOf(c);
console.log(kr ? `  reads as: "${clip(kr, 300)}"` : "  (empty)");

/* 2 · call logs */
console.log(`\n2 · CALL LOGS — what the strip now reads`);
let logs = null;
try { logs = await kylas.callLogs(ID); } catch (e) { console.log(`  ! ${clip(e.message, 200)}`); }
if (logs) {
  const list = Array.isArray(logs) ? logs : logs.content || logs.data || logs.records || [];
  const notes = callNotes(logs);
  console.log(`  ${list.length} call log(s), ${notes.length} with something typed on them`);
  for (const n of notes.slice(0, 5)) console.log(`  · ${n.at.slice(0, 10)} ${n.by ? `(${n.by}) ` : ""}"${clip(n.text)}"`);
  /* The shape is undocumented. If it holds logs and the reader found no
     notes, the first one is shown raw so the reader can be taught it. */
  if (list.length && !notes.length)
    console.log(`  ! logs came back but no note was found on any — the first, raw:\n    ${clip(JSON.stringify(list[0]), 600)}`);
  if (!list.length && logs && typeof logs === "object")
    console.log(`  (reply keys: ${Object.keys(logs).join(", ") || "none"})`);
}

/* 2b · OTHER WAYS TO ASK FOR A CONTACT'S CALL LOGS. The documented GET
   answered 404 02002001 on Ayush's account (2026-10-10) — which reads like
   "no call log with that id": the path may be taken as a CALL LOG id, not a
   contact's. So the likely alternatives are asked too, and every refusal's
   BODY is printed, because Kylas says which parameter it wanted there. */
console.log(`\n2b · OTHER WAYS TO READ THIS CONTACT'S CALL LOGS`);
const rule = (field, type = "long") => ({ fields: ["id", "outcome", "notes", "startTime", "createdAt", "owner", "relatedTo"],
  jsonRule: { condition: "AND", valid: true, rules: [{ id: field, field, type, input: "text", operator: "equal", value: String(ID) }] } });
const callTries = [
  ["GET", `/v1/call-logs/${ID}?relatedToType=contact`],
  ["GET", `/v1/call-logs?relatedToType=contact&relatedToId=${ID}`],
  ["GET", `/v1/call-logs?entityType=contact&entityId=${ID}`],
  ["GET", `/v1/call-logs/contact/${ID}`],
  ["GET", `/v1/contacts/${ID}/call-logs`],
  ["POST", `/v1/call-logs/search?page=0&size=10`, rule("relatedTo")],
  ["POST", `/v1/call-logs/search?page=0&size=10`, rule("associatedContacts")],
  ["POST", `/v1/search/call-log?page=0&size=10`, rule("relatedTo")],
];
let callFound = "";
for (const [m, p, b] of callTries) {
  const r = await raw(p, 0, m === "POST" ? b : null);
  const list = Array.isArray(r.json) ? r.json : r.json?.content || r.json?.data || r.json?.records || null;
  const n = Array.isArray(list) ? list.length : null;
  const why = r.status >= 400 ? `   ${clip(r.text, 160)}` : "";
  console.log(`  ${String(r.status).padEnd(4)} ${m.padEnd(4)} ${p}${b ? "  {" + b.jsonRule.rules[0].field + "}" : ""}${n != null ? `   -> ${n} log(s)` : ""}${why}`);
  if (r.status === 200 && n) {
    callFound ||= `${m} ${p}`;
    const notes = callNotes(r.json);
    for (const x of notes.slice(0, 2)) console.log(`         "${clip(x.text)}"`);
    if (!notes.length) console.log(`         first, raw: ${clip(JSON.stringify(list[0]), 300)}`);
  }
}

/* 3 · the Notes tab — undocumented, so ask the way it is most likely asked */
console.log(`\n3 · NOTES TAB — not read by the console yet; trying the likely ways to read it`);
const tries = [
  `/v1/notes/relation?targetEntityId=${ID}&targetEntityType=CONTACT&page=0&size=10`,
  `/v1/notes/relation?targetEntityId=${ID}&targetEntityType=CONTACT&page=0&size=10&sort=createdAt,desc`,
  `/v1/notes/relation?entityId=${ID}&entityType=CONTACT&page=0&size=10`,
  `/v1/notes/relation?targetEntityId=${ID}&targetEntityType=CONTACT`,
  `/v1/notes/relation?targetEntityId=${ID}&targetEntityType=contact`,
  `/v1/notes?targetEntityId=${ID}&targetEntityType=CONTACT`,
  `/v1/notes?entityType=contact&entityId=${ID}`,
  `/v1/contacts/${ID}/notes`,
];
let found = "";
for (const p of tries) {
  const r = await raw(p);
  const list = Array.isArray(r.json) ? r.json : r.json?.content || r.json?.data || r.json?.records || null;
  const n = Array.isArray(list) ? list.length : null;
  console.log(`  ${String(r.status).padEnd(4)} ${p}${n != null ? `   -> ${n} note(s)` : ""}${
    r.status >= 400 ? `\n         ${clip(r.text, 200)}` : ""}`);
  if (r.status === 200 && n) {
    found ||= p;
    for (const x of list.slice(0, 3))
      console.log(`         "${clip(String(x.description ?? x.sourceEntity?.description ?? x.text ?? JSON.stringify(x)).replace(/<[^>]+>/g, " "))}"`);
  }
}
console.log(`\n${"=".repeat(72)}`);
if (callFound) console.log(`Call logs answer at:\n  ${callFound}\n`);
console.log(found
  ? `The Notes tab answers at:\n  ${found}\nSend this output back — that is the shape to add to the strip.`
  : `No Notes read answered with notes. If the remarks you see in Kylas are in 1 or 2
above, the strip (1.55) already shows them. If they are on the Notes tab and
nothing above found them, send this output back anyway — the statuses say
which way the endpoint refuses.`);
console.log("");
