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
import { createClient, callNotes, toConsoleContact } from "./kylas.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const ID = (() => { const i = process.argv.indexOf("--contact"); return i > -1 ? process.argv[i + 1] : ""; })();
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
if (!ID) { console.error("Pass --contact <Kylas contact id> — one whose previous remarks you can see in Kylas."); process.exit(1); }

const kylas = createClient(KEY, { log: () => {}, ...(process.env.KYLAS_BASE ? { base: BASE } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A 429 is a wait, not an answer — it has misled this repo four times. */
async function raw(path, t = 0) {
  const r = await fetch(`${BASE}${path}`, { headers: { "api-key": KEY } });
  if (r.status === 429 && t < 6) { await sleep(500 * 2 ** t); return raw(path, t + 1); }
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

/* 3 · the Notes tab — undocumented, so ask the way it is most likely asked */
console.log(`\n3 · NOTES TAB — not read by the console yet; trying the likely ways to read it`);
const tries = [
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
  console.log(`  ${String(r.status).padEnd(4)} ${p}${n != null ? `   -> ${n} note(s)` : ""}`);
  if (r.status === 200 && n) {
    found ||= p;
    for (const x of list.slice(0, 3))
      console.log(`         "${clip(String(x.description ?? x.sourceEntity?.description ?? x.text ?? JSON.stringify(x)).replace(/<[^>]+>/g, " "))}"`);
  }
}
console.log(`\n${"=".repeat(72)}`);
console.log(found
  ? `The Notes tab answers at:\n  ${found}\nSend this output back — that is the shape to add to the strip.`
  : `No Notes read answered with notes. If the remarks you see in Kylas are in 1 or 2
above, the strip (1.55) already shows them. If they are on the Notes tab and
nothing above found them, send this output back anyway — the statuses say
which way the endpoint refuses.`);
console.log("");
