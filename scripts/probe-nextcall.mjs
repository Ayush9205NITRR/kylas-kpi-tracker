#!/usr/bin/env node
/* DOES THE CALL-BACK COME BACK? — read-only, five seconds.
 *
 *   node --env-file=.env.local scripts/probe-nextcall.mjs --find
 *   node --env-file=.env.local scripts/probe-nextcall.mjs --contact 5374375
 *
 * The console WROTE the call-back into Kylas on every save and, until
 * 1.44.0, never read it back: toConsoleContact returned a hardcoded
 * nextCallDate: "". A contact served from the Airtable copy carried its
 * promise; the same contact served from KYLAS arrived blank, and the
 * associate was asked for a date they had already given.
 *
 * This runs the REAL mapper — scripts/kylas.mjs toConsoleContact, through the
 * REAL resolved write map — against a live contact, and prints what the
 * console will now show beside what Kylas actually holds. It writes nothing.
 *
 * --find lists recent contacts that have a call-back set in Kylas, so there
 * is something to check in the first place. A probe that reads a contact with
 * no call-back proves nothing, and saying so is cheaper than the hour it cost
 * to learn that the last time.
 */
import { toConsoleContact } from "./kylas.mjs";
import { resolveWriteFields, nextCallFrom, describeWriteMap } from "./kylas-write-map.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const TZ = Number(process.env.TZ_OFFSET_MIN ?? 330);
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const ID = arg("contact");
const FIND = process.argv.includes("--find");
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
if (!ID && !FIND) { console.error("Pass --contact <id>, or --find to see which contacts have one set."); process.exit(1); }

const H = { "api-key": KEY, "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A 429 is a wait, not an answer — it has misled this repo three times. */
async function call(method, path, body, t = 0) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 429 && t < 6) { await sleep(500 * 2 ** t); return call(method, path, body, t + 1); }
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}
const rows = (r) => r?.content || r?.data || (Array.isArray(r) ? r : []);
const everything = () => ({ condition: "AND", valid: true, rules: [
  { id: "multi_field", field: "multi_field", type: "multi_field",
    input: "multi_field", operator: "multi_field", value: "" }] });

/* THE SAME MAP THE SAVE AND THE SERVER USE. The call-back field has no fixed
   key — it is found per account by label — so without this the mapper has no
   way to know which custom field holds the promise. */
const fields = rows(await call("GET",
  "/v1/entities/contact/fields?entityType=contact&custom-only=false&page=0&size=200"));
const map = resolveWriteFields(fields, {});
console.log("\nthe field this account keeps the call-back in:");
describeWriteMap(map).forEach((l) => console.log("  " + l));
if (!map.nextCall) {
  console.log("\n  ! No call-back field resolved on this account. Nothing can read or write one.\n");
  process.exit(1);
}

if (FIND) {
  const recent = rows(await call("POST", "/v1/search/contact?page=0&size=100&sort=updatedAt,desc",
    { fields: ["id", "firstName", "lastName", "customFieldValues", "updatedAt"], jsonRule: everything() }));
  const withOne = recent.filter((c) => {
    const v = (c.customFieldValues || {})[map.nextCall.name];
    return v !== undefined && v !== null && v !== "";
  });
  console.log(`\n${withOne.length} of the last ${recent.length} contacts have a call-back set in Kylas:\n`);
  for (const c of withOne.slice(0, 15)) {
    const raw = (c.customFieldValues || {})[map.nextCall.name];
    const got = nextCallFrom(map.nextCall, raw, TZ);
    console.log(`  ${String(c.id).padEnd(10)} ${[c.firstName, c.lastName].filter(Boolean).join(" ").slice(0, 26).padEnd(28)}` +
                `Kylas holds ${String(JSON.stringify(raw)).padEnd(26)} -> console shows ${got.date}${got.time ? " " + got.time : ""}`);
  }
  if (!withOne.length) {
    console.log("  (none — set one in the console, save, then run this again)");
    console.log("  Without one there is nothing for the read side to get wrong.\n");
    process.exit(1);
  }
  console.log(`\nThen: --contact <id> to see the whole record as the console will.\n`);
  process.exit(0);
}

/* ── one contact, through the real mapper ───────────────────────────── */
const c = await call("GET", `/v1/contacts/${ID}`);
const raw = (c.customFieldValues || {})[map.nextCall.name];
const mapped = toConsoleContact(c, { writeMap: map, tzMin: TZ });

console.log(`\ncontact ${ID} — ${[c.firstName, c.lastName].filter(Boolean).join(" ")}`);
console.log(`  Kylas holds        ${JSON.stringify(raw ?? null)}   (${map.nextCall.name}, ${map.nextCall.type})`);
console.log(`  the console shows  date ${JSON.stringify(mapped.nextCallDate)}  time ${JSON.stringify(mapped.nextCallTime)}`);

const had = raw !== undefined && raw !== null && raw !== "";
let bad = 0;
const ok = (w, c2) => { if (!c2) bad++; console.log(`  ${c2 ? "PASS" : "FAIL"}  ${w}`); };
console.log("");
if (!had) {
  console.log("  This contact has NO call-back in Kylas, so a blank is correct and this");
  console.log("  proves nothing. Run --find to pick one that has one.\n");
  process.exit(1);
}
ok("the call-back reaches the console instead of coming back blank", !!mapped.nextCallDate);
ok("...as a real date", /^\d{4}-\d{2}-\d{2}$/.test(mapped.nextCallDate || ""));
/* The timezone is the part that fails silently: 10:00 promised in Delhi is
   stored 04:30Z, and reading the UTC clock straight off shows 04:30. */
if (/TIME/.test(map.nextCall.type))
  ok("...and the time is the local one promised, not the UTC instant",
     !!mapped.nextCallTime && mapped.nextCallTime === nextCallFrom(map.nextCall, raw, TZ).time);

console.log(`\n${bad ? `${bad} FAULT(S) — send this output back.`
  : "Clean. The call-back survives the round trip; the console will show it."}\n`);
process.exit(bad ? 1 : 0);
