#!/usr/bin/env node
/* APPEND A TAG TO SOURCE OF DATA ON MANY KYLAS COMPANIES — safely.
 *
 * Ayush, 2026-10-12: the October batch (276 companies) was tagged
 * "Lifetime MQL-SQL | October" in Airtable, and the console never showed it,
 * because the accounts list reads Source of Data from KYLAS. "Use API to bulk
 * edit." This is that, with the one thing the repo already learned the hard
 * way built in:
 *
 *   A COMPANY UPDATE CAN ERASE THE ACCOUNT'S OWNER. PUT /v1/companies/{id}
 *   replaces the record, and Kylas does not take an owner on it — lucidity
 *   (1777441) came out of a 200 with no owner, and no API call could put one
 *   back (docs/STATE.md §3e). Every account in the console is allotted by that
 *   owner. 276 ownerless accounts would vanish from every associate's list.
 *
 * So nothing real is written until a THROWAWAY company has been put through
 * the exact same write and come out with its owner and every other field
 * intact. Steps, each its own run:
 *
 *   1. dry run (default)   reads every company, prints what would change,
 *                          writes nothing
 *        node --env-file=.env.local scripts/bulk-tag-companies.mjs
 *
 *   2. --canary            creates "ZZ ENOUT TEST — delete me", writes it the
 *                          way step 3 would, reads it back, deletes it. Tries
 *                          the body WITHOUT ownerId first, then with the SAME
 *                          ownerId. Records which one kept the owner, or that
 *                          neither did — in which case step 3 refuses to run.
 *
 *   3. --apply --limit 1   the first real company. Look at it in Kylas.
 *      --apply --all       the rest. Already-tagged ones are skipped, so it
 *                          is safe to re-run after a stop.
 *
 * Every real write is: read the company, PUT the WHOLE record with only
 * Source of Data changed, read it back, and compare. The owner, the name and
 * every other field must be what they were. The first company that does not
 * match STOPS the run — at most one account is ever wrong, and its full
 * before-image is in bulk-tag-snapshot-<time>.json.
 *
 * Options:  --ids <file>   default scripts/batches/lifetime-mql-sql-october.txt
 *           --tag <text>   default "Lifetime MQL-SQL | October"
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const IDS_FILE = arg("ids", "scripts/batches/lifetime-mql-sql-october.txt");
const TAG = arg("tag", "Lifetime MQL-SQL | October");
const FIELD = "cfSourceOfData";
const CANARY_FILE = ".bulk-tag-canary.json";
const CANARY_MAX_AGE_MS = 24 * 3600 * 1000;
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { "api-key": KEY, "content-type": "application/json" };
/* A 429 is a wait, not a failure — Kylas throttles at about five a second. */
async function call(method, path, body, tries = 0) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (r.status === 429 && tries < 6) {
    await sleep(Number(r.headers.get("retry-after") || 0) * 1000 || 500 * 2 ** tries);
    return call(method, path, body, tries + 1);
  }
  if (!r.ok) { const e = new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  await sleep(250);
  return json;
}

/* ── the body: the record as Kylas holds it, minus what Kylas computes ── */
/* Same rules as probe-reassign.mjs, the only other file that may send a
   company body. A lookup ({id,name}) goes back as its id; a phone number,
   which also has a .value, is left whole. */
const SERVER_KEYS = new Set([
  "id", "createdAt", "updatedAt", "createdBy", "updatedBy", "recordActions",
  "entityType", "actualValue", "hasDuplicate", "converted", "convertedAt",
  "convertedBy", "pipeline", "stageUpdatedAt", "associatedContacts",
  "metaData", "idNameStore", "companyStage", "lastActivityAt",
  "nextActivityAt", "score", "duplicateOf", "ownerName",
]);
const OWNER_KEYS = new Set(["ownerId", "owner"]);
const cfOf = (v) => (Array.isArray(v) ? v.map(cfOf) : v && typeof v === "object" ? (v.id ?? v.value) : v);
const isLookup = (v) => !!v && typeof v === "object" && !Array.isArray(v)
  && v.id !== undefined && Object.keys(v).every((k) => k === "id" || k === "name");
const topOf = (v) => (Array.isArray(v) ? (v.every(isLookup) ? v.map((x) => x.id) : v) : isLookup(v) ? v.id : v);
const idOf = (v) => (v && typeof v === "object" ? v.id : v) ?? null;
const textOf = (v) => (v && typeof v === "object" ? (v.name ?? v.value ?? "") : (v ?? "")).toString();

function bodyFor(rec, newSource, ownerMode) {
  const body = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (SERVER_KEYS.has(k) || OWNER_KEYS.has(k) || v === undefined || v === null) continue;
    body[k] = k === "customFieldValues"
      ? Object.fromEntries(Object.entries(v || {}).map(([kk, raw]) => [kk, cfOf(raw)])
          .filter(([, x]) => x !== undefined && x !== null && x !== ""))
      : topOf(v);
  }
  if (!body.name) throw new Error("Kylas returned this company without a name — refusing to write it back");
  body.customFieldValues = { ...(body.customFieldValues || {}), [FIELD]: newSource };
  /* "omit": the owner is not in the body at all (Kylas' documented Update
     Company has no owner field). "same": the owner it already has. Which of
     the two keeps it is what --canary finds out. */
  if (ownerMode === "same" && idOf(rec.ownerId) != null) body.ownerId = Number(idOf(rec.ownerId));
  return body;
}
const withTag = (src) => {
  const s = String(src || "").trim();
  return !s ? TAG : `${s} + ${TAG}`;
};
const hasTag = (src) => String(src || "").includes(TAG);

/* Everything that must survive the write, in a comparable form. */
function shape(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (SERVER_KEYS.has(k) || k === "customFieldValues" || v === undefined || v === null) continue;
    out[k] = JSON.stringify(topOf(v));
  }
  for (const [k, v] of Object.entries(rec?.customFieldValues || {})) {
    if (k === FIELD || v === undefined || v === null || v === "") continue;
    out[`cf.${k}`] = JSON.stringify(cfOf(v));
  }
  out.ownerId = JSON.stringify(idOf(rec?.ownerId));
  return out;
}
function differences(before, after, newSource) {
  const a = shape(before), b = shape(after), diff = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (a[k] !== b[k]) diff.push(`${k}: ${a[k] ?? "(none)"} -> ${b[k] ?? "(none)"}`);
  if (idOf(after?.ownerId) == null) diff.unshift("OWNER IS GONE");
  if (textOf(after?.customFieldValues?.[FIELD]) !== newSource)
    diff.push(`${FIELD} did not take: ${JSON.stringify(textOf(after?.customFieldValues?.[FIELD]))}`);
  return diff;
}

/* ── 2 · the canary ──────────────────────────────────────────────── */
if (has("canary")) {
  console.log(`\nCANARY — a throwaway company goes through the exact write, before any real one.\n`);
  const tried = [];
  let passed = null;
  for (const mode of ["omit", "same"]) {
    const name = `ZZ ENOUT TEST — delete me ${new Date().toISOString().slice(0, 16)} ${mode}`;
    let id = null;
    try {
      const made = await call("POST", "/v1/companies", { name, customFieldValues: { [FIELD]: "canary" } });
      id = made?.id;
      if (!id) throw new Error("Kylas created no id");
      const before = await call("GET", `/v1/companies/${id}`);
      if (idOf(before?.ownerId) == null) {
        tried.push({ mode, ok: false, why: "the new company has no owner to lose — the test proves nothing" });
        console.log(`  ${mode.padEnd(5)} cannot test: Kylas gave the new company no owner.`);
        continue;
      }
      const want = withTag(textOf(before.customFieldValues?.[FIELD]));
      await call("PUT", `/v1/companies/${id}`, bodyFor(before, want, mode));
      const after = await call("GET", `/v1/companies/${id}`);
      const diff = differences(before, after, want);
      tried.push({ mode, ok: !diff.length, diff });
      console.log(`  ${mode.padEnd(5)} ${diff.length ? "FAILED" : "kept the owner and every field"}` +
        (diff.length ? `\n         ${diff.join("\n         ")}` : ""));
      if (!diff.length) { passed = mode; break; }
    } catch (e) {
      tried.push({ mode, ok: false, why: e.message });
      console.log(`  ${mode.padEnd(5)} error: ${e.message.slice(0, 200)}`);
    } finally {
      if (id) {
        try { await call("DELETE", `/v1/companies/${id}`); console.log(`        deleted the test company ${id}`); }
        catch (e) { console.log(`        ! could not delete test company ${id} ("${name}") — delete it in Kylas. ${e.message.slice(0, 120)}`); }
      }
    }
  }
  writeFileSync(CANARY_FILE, JSON.stringify({ at: new Date().toISOString(), base: BASE, passed, tried }, null, 2));
  if (passed) {
    console.log(`\nPASSED with ownerMode "${passed}". Next: --apply --limit 1, then look at that company in Kylas.\n`);
    process.exit(0);
  }
  console.log(`\nNO WRITE KEPT THE OWNER. --apply will refuse to run. Send this output back —` +
              `\nthe tag has to go in through Kylas' own bulk edit instead.\n`);
  process.exit(1);
}

/* ── the list ────────────────────────────────────────────────────── */
const ids = [...new Set(readFileSync(IDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#")))];
if (ids.some((x) => !/^\d+$/.test(x))) { console.error(`${IDS_FILE}: every line must be a Kylas company id`); process.exit(1); }

/* ── 1 · dry run ─────────────────────────────────────────────────── */
if (!has("apply")) {
  console.log(`\nDRY RUN — ${ids.length} companies, tag "${TAG}". Nothing is written.\n`);
  let todo = 0, done = 0, missing = 0, noOwner = 0;
  for (const id of ids) {
    let rec;
    try { rec = await call("GET", `/v1/companies/${id}`); }
    catch (e) { missing++; console.log(`  ${id.padEnd(9)} ! cannot read: ${e.message.slice(0, 80)}`); continue; }
    const src = textOf(rec.customFieldValues?.[FIELD]);
    if (idOf(rec.ownerId) == null) noOwner++;
    if (hasTag(src)) { done++; continue; }
    todo++;
    console.log(`  ${id.padEnd(9)} ${String(rec.name || "").slice(0, 28).padEnd(28)} owner ${String(idOf(rec.ownerId) ?? "NONE").padEnd(7)}` +
      `  "${src.slice(0, 40)}" -> "+ ${TAG}"`);
  }
  console.log(`\n${todo} to tag · ${done} already tagged · ${missing} unreadable · ${noOwner} with no owner today`);
  console.log(`Next: --canary (creates and deletes one test company; no real company is touched).\n`);
  process.exit(0);
}

/* ── 3 · apply ───────────────────────────────────────────────────── */
const canary = existsSync(CANARY_FILE) ? JSON.parse(readFileSync(CANARY_FILE, "utf8")) : null;
if (!canary?.passed || canary.base !== BASE || Date.now() - Date.parse(canary.at) > CANARY_MAX_AGE_MS) {
  console.error(`Refusing: no passing --canary against ${BASE} in the last 24 hours (${CANARY_FILE}).` +
    (canary && !canary.passed ? " The last canary FAILED — no write keeps the owner." : ""));
  process.exit(1);
}
const LIMIT = has("all") ? Infinity : Number(arg("limit", "0"));
if (!(LIMIT > 0)) { console.error("Say how many: --limit 1 for the first one, --all for the rest."); process.exit(1); }
const mode = canary.passed;
const snapFile = `bulk-tag-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const snaps = [];
const keep = () => writeFileSync(snapFile, JSON.stringify(snaps, null, 2));
console.log(`\nAPPLY — up to ${LIMIT === Infinity ? "all" : LIMIT} of ${ids.length}, ownerMode "${mode}". Before-images: ${snapFile}\n`);
let wrote = 0, skipped = 0;
for (const id of ids) {
  if (wrote >= LIMIT) break;
  const before = await call("GET", `/v1/companies/${id}`);
  const src = textOf(before.customFieldValues?.[FIELD]);
  if (hasTag(src)) { skipped++; continue; }
  if (idOf(before.ownerId) == null) { console.log(`  ${id} has no owner already — skipped, set it in Kylas first`); skipped++; continue; }
  const want = withTag(src);
  snaps.push({ id, before }); keep();
  await call("PUT", `/v1/companies/${id}`, bodyFor(before, want, mode));
  const after = await call("GET", `/v1/companies/${id}`);
  const diff = differences(before, after, want);
  if (diff.length) {
    console.log(`\n  STOPPED at ${id} (${before.name}). The write did not come back clean:\n    ${diff.join("\n    ")}` +
      `\n  Its before-image is in ${snapFile}. Nothing after it was touched.\n`);
    process.exit(1);
  }
  wrote++;
  console.log(`  ${String(wrote).padStart(3)}  ${id.padEnd(9)} ${String(before.name || "").slice(0, 30).padEnd(30)} owner kept · "${want.slice(-60)}"`);
}
console.log(`\n${wrote} tagged · ${skipped} skipped (already tagged or no owner).` +
  (LIMIT === 1 && wrote ? `\nOpen that company in Kylas: owner, fields, Source of Data. Then --apply --all.` : "") + "\n");
