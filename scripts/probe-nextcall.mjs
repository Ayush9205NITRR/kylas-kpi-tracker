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
import { resolveWriteFields, nextCallFrom, offsiteFrom, describeWriteMap } from "./kylas-write-map.mjs";
/* The same options reader the Worker and the push use. The offsite quarter is
   a PICKLIST, so without its options there is nothing to decode an id against
   and the read side looks broken when only the probe was. */
import { findOptions } from "./push-kylas.mjs";

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
const picklists = {};
for (const f of fields) { const o = findOptions(f); if (o && (f.name || f.displayName)) picklists[f.name || f.displayName] = o; }
const map = resolveWriteFields(fields, picklists);
console.log("\nthe fields this account keeps them in:");
describeWriteMap(map).forEach((l) => console.log("  " + l));
if (map.offsite?.options?.length)
  console.log(`    quarters offered: ${map.offsite.options.map((o) => `${o.id}=${o.label || o.code}`).join(" · ")}`);
if (!map.nextCall && !map.offsite) {
  console.log("\n  ! Neither field resolved on this account. Nothing can read or write one.\n");
  process.exit(1);
}

if (FIND) {
  const recent = rows(await call("POST", "/v1/search/contact?page=0&size=100&sort=updatedAt,desc",
    { fields: ["id", "firstName", "lastName", "customFieldValues", "updatedAt"], jsonRule: everything() }));
  /* A contact is worth checking if it has EITHER a call-back or an offsite
     quarter, because both were write-only and both are read here. */
  const held = (c, f) => {
    if (!f) return undefined;
    const v = (c.customFieldValues || {})[f.name];
    if (v === undefined || v === null || v === "") return undefined;
    if (Array.isArray(v) && !v.length) return undefined;
    return v;
  };
  const withOne = recent.filter((c) => held(c, map.nextCall) !== undefined ||
                                       held(c, map.offsite) !== undefined);
  console.log(`\n${withOne.length} of the last ${recent.length} contacts have a call-back or an offsite quarter set in Kylas:\n`);
  for (const c of withOne.slice(0, 15)) {
    const nc = held(c, map.nextCall);
    const off = held(c, map.offsite);
    const got = nc === undefined ? { date: "", time: "" } : nextCallFrom(map.nextCall, nc, TZ);
    const qs = off === undefined ? [] : offsiteFrom(map.offsite, off);
    console.log(`  ${String(c.id).padEnd(10)} ${[c.firstName, c.lastName].filter(Boolean).join(" ").slice(0, 26).padEnd(28)}` +
                `call-back ${(got.date ? got.date + (got.time ? " " + got.time : "") : "—").padEnd(18)}` +
                `offsite ${qs.join(", ") || "—"}`);
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
const raw = map.nextCall ? (c.customFieldValues || {})[map.nextCall.name] : undefined;
const mapped = toConsoleContact(c, { writeMap: map, tzMin: TZ });

console.log(`\ncontact ${ID} — ${[c.firstName, c.lastName].filter(Boolean).join(" ")}`);
if (map.nextCall) {
  console.log(`  call-back in Kylas ${JSON.stringify(raw ?? null)}   (${map.nextCall.name}, ${map.nextCall.type})`);
  console.log(`  the console shows  date ${JSON.stringify(mapped.nextCallDate)}  time ${JSON.stringify(mapped.nextCallTime)}`);
}

/* ── REQ-04 · THE OFFSITE QUARTER, same question ────────────────────
   It was write-only for exactly the same reason the call-back was, so it is
   checked in the same breath rather than in a probe of its own. The quarter
   is DERIVED from the timeline text as well, so a blank here is only a fault
   when Kylas actually holds one. */
const offRaw = map.offsite ? (c.customFieldValues || {})[map.offsite.name] : undefined;
const offHad = offRaw !== undefined && offRaw !== null && offRaw !== "" &&
               !(Array.isArray(offRaw) && !offRaw.length);
if (map.offsite) {
  console.log(`  offsite in Kylas   ${JSON.stringify(offRaw ?? null)}   (${map.offsite.name}, ${map.offsite.type})`);
  console.log(`  the console shows  ${JSON.stringify(mapped.offsiteTimeline)}${
    mapped.offsiteTimelineAll?.length > 1
      ? `   (all of them: ${JSON.stringify(mapped.offsiteTimelineAll)})` : ""}`);
}

const had = !!map.nextCall && raw !== undefined && raw !== null && raw !== "";
let bad = 0;
const ok = (w, c2) => { if (!c2) bad++; console.log(`  ${c2 ? "PASS" : "FAIL"}  ${w}`); };
console.log("");
if (!had && !offHad) {
  console.log("  This contact has NEITHER a call-back nor an offsite quarter in Kylas, so");
  console.log("  two blanks are correct and this proves nothing. Run --find to pick one");
  console.log("  that has something to read.\n");
  process.exit(1);
}
if (had) {
  ok("the call-back reaches the console instead of coming back blank", !!mapped.nextCallDate);
  ok("...as a real date", /^\d{4}-\d{2}-\d{2}$/.test(mapped.nextCallDate || ""));
} else console.log("  SKIP  no call-back on this contact, so there is nothing to check");
/* The timezone is the part that fails silently: 10:00 promised in Delhi is
   stored 04:30Z, and reading the UTC clock straight off shows 04:30. */
if (had && /TIME/.test(map.nextCall.type))
  ok("...and the time is the local one promised, not the UTC instant",
     !!mapped.nextCallTime && mapped.nextCallTime === nextCallFrom(map.nextCall, raw, TZ).time);

if (offHad) {
  /* The quarter Kylas holds, decoded independently of the mapper, so the two
     are compared rather than the mapper being asked to mark its own work. */
  const want = offsiteFrom(map.offsite, offRaw);
  ok("the offsite quarter reaches the console instead of coming back blank",
     !!mapped.offsiteTimeline);
  ok(`...and it is the one Kylas holds (${want.join(", ") || "none"})`,
     mapped.offsiteTimeline === (want[0] || ""));
  if (want.length > 1)
    ok(`...with the other ${want.length - 1} kept, not dropped`,
       (mapped.offsiteTimelineAll || []).length === want.length);
} else if (map.offsite) {
  console.log("  SKIP  no offsite quarter on this contact, so there is nothing to check");
}

console.log(`\n${bad ? `${bad} FAULT(S) — send this output back.`
  : "Clean. What Kylas holds is what the console will show."}\n`);
process.exit(bad ? 1 : 0);
