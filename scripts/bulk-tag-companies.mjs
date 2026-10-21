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
 *           --view <name>  INSTEAD of --ids/--tag: the companies, and each one's
 *                          months, come from a Company List view in the Company
 *                          Database base (2026-10-21, "Oct/Nov/Dec"). See below.
 *
 * ── --view: THE MONTH ON THE KYLAS SOURCE, FROM AIRTABLE ─────────────────
 * offsite-month-source.py wrote each account's months into Company List's
 * "Source (MQL-SQL)" ("lifetime-MQL-SQL October, November"). This reads that
 * view (Kylas Company Id + Source (MQL-SQL); needs AIRTABLE_PAT) and puts the
 * same months on the company's Source of Data IN KYLAS, by Ayush's rule:
 * whatever Kylas holds STAYS; lifetime-MQL-SQL there -> the months go right
 * after it; not there -> " + lifetime-MQL-SQL <months>" at the end.
 *
 * STRICT: THE OWNER MUST NOT CHANGE (Ayush, 2026-10-21). This is the reason it
 * goes through this script and NOT kylas-airtable-sync's "Assign Companies from
 * Airtable -> Kylas": that job's company PUT resets the owner and then re-assigns
 * it from Airtable's "Owner - Kylas" copy, which is stale the moment anybody
 * re-assigns in Kylas or the console. Here the owner is never taken from
 * Airtable: it is read from Kylas before the write, the write keeps it (proved
 * by --canary first), it is read back after, and the FIRST company whose owner
 * differs STOPS the run. Contacts are never touched — company only.
 *
 * WHAT KYLAS ACTUALLY DOES TO THE OWNER (2026-10-21). A company PUT takes no
 * owner and hands the record to the API user (kylas-airtable-sync saw it live on
 * 2026-07-01). The first canaries passed only because a company the API creates
 * is ALREADY the API user's, so "owner unchanged" proved nothing. Now:
 *   - the canary first gives its test company to a real, active owner, so the
 *     reset would show;
 *   - every write is PUT, then, if the owner moved, PUT /{id}/owner with the
 *     owner Kylas had before (the endpoint proven live 2026-10-15), then a
 *     read-back. Only if the owner is the one it had before does the run go on.
 *     For about a second the record may sit with the API user.
 *   - a company whose owner is DEACTIVATED is skipped: Kylas cannot give a
 *     record back to an inactive user (400 "user is not active"), so writing it
 *     would change its owner for good. Listed, never written.
 *   - a company Kylas refuses (400 — 1773567 on 2026-10-21, "generic.error") is
 *     skipped, its owner checked, and the run goes on; ten refusals and more
 *     refusals than writes stops it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { toUser } from "./kylas.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const IDS_FILE = arg("ids", "scripts/batches/lifetime-mql-sql-october.txt");
const TAG = arg("tag", "Lifetime MQL-SQL | October");
const VIEW = arg("view", "");
/* In a public repository's Actions log a company name is published. --ids-only
   (or BULK_TAG_IDS_ONLY=1) prints ids and owners, no names. */
const IDS_ONLY = has("ids-only") || process.env.BULK_TAG_IDS_ONLY === "1";
const nameOf = (rec) => (IDS_ONLY ? "" : String(rec?.name || ""));
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
  /* WHO created / last updated it — Kylas stamps these itself on every write
     ("Universal API Key"). Never sent back, never compared: reading them as a
     changed field failed the first live --view canary on 2026-10-21 with the
     owner intact. */
  "createdViaId", "createdViaName", "createdViaType", "updatedViaId", "updatedViaName", "updatedViaType",
]);
const OWNER_KEYS = new Set(["ownerId", "owner", "ownedBy", "ownerDetails", "assignedTo", "recordOwner"]);
const cfOf = (v) => (Array.isArray(v) ? v.map(cfOf) : v && typeof v === "object" ? (v.id ?? v.value) : v);
const isLookup = (v) => !!v && typeof v === "object" && !Array.isArray(v)
  && v.id !== undefined && Object.keys(v).every((k) => k === "id" || k === "name");
const topOf = (v) => (Array.isArray(v) ? (v.every(isLookup) ? v.map((x) => x.id) : v) : isLookup(v) ? v.id : v);
const idOf = (v) => (v && typeof v === "object" ? v.id : v) ?? null;
/* For the log: the whole value on one line; a long one keeps both ends. */
const clip = (s, n = 90) => { const t = String(s).replace(/\r?\n/g, " ⏎ "); return t.length <= n ? t : `${t.slice(0, 40)} … ${t.slice(-(n - 43))}`; };
const textOf = (v) => (v && typeof v === "object" ? (v.name ?? v.value ?? "") : (v ?? "")).toString();

/* WHERE THE OWNER IS. The company SEARCH returns it as ownerId, and that is
   what this script first assumed of GET /v1/companies/{id} too — the first
   live dry run (2026-10-12) read all 273 as "owner NONE" and the canary
   could not test anything. So: every name it plausibly lives under on the
   record, then the search the console's own crawl uses, by id. Whatever is
   found is said, with where it came from. */
const OWNER_FIELDS = ["ownerId", "owner", "ownedBy", "ownerDetails", "assignedTo", "recordOwner"];
function ownerOnRecord(rec) {
  for (const k of OWNER_FIELDS) {
    const v = idOf(rec?.[k]);
    if (v !== null && v !== undefined && v !== "") return { id: String(v), from: k };
  }
  const store = rec?.metaData?.idNameStore?.ownerId;
  if (store && typeof store === "object" && Object.keys(store).length === 1)
    return { id: String(Object.keys(store)[0]), from: "metaData.idNameStore.ownerId" };
  return null;
}
let searchWorks = null;
async function ownerBySearch(id) {
  if (searchWorks === false) return null;
  try {
    const r = await call("POST", "/v1/search/company?page=0&size=5", { fields: ["id", "name", "ownerId"],
      jsonRule: { condition: "AND", valid: true, rules: [
        { id: "id", field: "id", type: "long", input: "number", operator: "equal", value: Number(id) }] } });
    const row = (r?.content || r?.data || []).find((x) => String(x.id) === String(id));
    const v = row ? idOf(row.ownerId ?? row.owner) : null;
    searchWorks = true;
    return v == null || v === "" ? null : { id: String(v), from: "search" };
  } catch (e) {
    if (searchWorks === null) console.log(`  (the company search by id is refused: ${e.message.slice(0, 120)})`);
    searchWorks = false;
    return null;
  }
}
const ownerOf = async (id, rec) => ownerOnRecord(rec) || ownerBySearch(id);
/* The record's owner-ish fields, as Kylas sent them — printed once, so a
   name nobody guessed shows up in the output instead of reading as "none". */
const ownerishKeys = (rec) => Object.fromEntries(Object.entries(rec || {})
  .filter(([k]) => /own|assign/i.test(k)).map(([k, v]) => [k, JSON.stringify(v)?.slice(0, 80)]));

function bodyFor(rec, newSource, ownerMode, owner) {
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
  if (ownerMode === "same" && owner?.id) body.ownerId = Number(owner.id);
  return body;
}
const withTag = (src) => {
  const s = String(src || "").trim();
  return !s ? TAG : `${s} + ${TAG}`;
};
const hasTag = (src) => String(src || "").includes(TAG);

/* ── the month rule (--view) ─────────────────────────────────────── */
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const M = `(?:${MONTHS.join("|")})`;
/* the lifetime tag, and a month list after it ("October, November" or "| October") */
const LIFE = new RegExp(`(lifetime\\s*-?\\s*mql\\s*[-/]?\\s*sql)((?:\\s*\\|)?\\s+${M}(?:\\s*,\\s*${M})*)?`, "gi");
const byMonth = (a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b);
const monthsIn = (text) => (String(text || "").match(new RegExp(M, "g")) || []);
/* The months written after the LAST lifetime tag in `text`. */
export function monthsAfterTag(text) {
  const all = [...String(text || "").matchAll(LIFE)];
  const last = all[all.length - 1];
  return last?.[2] ? [...new Set(monthsIn(last[2]))].sort(byMonth) : [];
}
/* Kylas' value with these months on it. What is there stays; the months already
   after the tag are kept and merged, so running it twice changes nothing. */
export function monthSource(src, months) {
  const s = String(src || "").trim();
  const all = [...s.matchAll(LIFE)];
  if (!all.length) {
    const tag = `lifetime-MQL-SQL ${[...new Set(months)].sort(byMonth).join(", ")}`;
    return s ? `${s} + ${tag}` : tag;
  }
  const last = all[all.length - 1];
  const merged = [...new Set([...monthsIn(last[2] || ""), ...months])].sort(byMonth);
  return s.slice(0, last.index) + `${last[1]} ${merged.join(", ")}` + s.slice(last.index + last[0].length);
}
const want = (id, src) => (VIEW ? monthSource(src, VIEW_MONTHS.get(id) || []) : withTag(src));
const isDone = (id, src) => (VIEW ? want(id, src) === String(src || "").trim() : hasTag(src));

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
  return out;
}
function differences(before, after, newSource, ownerBefore, ownerAfter) {
  const a = shape(before), b = shape(after), diff = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (a[k] !== b[k]) diff.push(`${k}: ${a[k] ?? "(none)"} -> ${b[k] ?? "(none)"}`);
  if (!ownerAfter?.id) diff.unshift(`OWNER IS GONE (was ${ownerBefore?.id ?? "?"})`);
  else if (ownerAfter.id !== ownerBefore?.id) diff.unshift(`OWNER CHANGED ${ownerBefore?.id} -> ${ownerAfter.id}`);
  if (textOf(after?.customFieldValues?.[FIELD]) !== newSource)
    diff.push(`${FIELD} did not take: ${JSON.stringify(textOf(after?.customFieldValues?.[FIELD]))}`);
  return diff;
}

/* Is this owner still an active user? null when Kylas will not say. */
const userCache = new Map();
async function ownerActive(ownerId) {
  if (userCache.has(ownerId)) return userCache.get(ownerId);
  let v = null;
  try { v = toUser(await call("GET", `/v1/users/${ownerId}`)).active; } catch { v = null; }
  userCache.set(ownerId, v);
  return v;
}

/* After a write: read back; if the owner moved, give it back with the owner
   endpoint and read again. -> { after, ownerAfter, restored } */
async function keepOwner(id, ownerBefore) {
  let after = await call("GET", `/v1/companies/${id}`);
  let ownerAfter = await ownerOf(id, after);
  let restored = false;
  if (ownerAfter?.id !== ownerBefore.id) {
    await call("PUT", `/v1/companies/${id}/owner`, { ownerId: Number(ownerBefore.id) });
    restored = true;
    after = await call("GET", `/v1/companies/${id}`);
    ownerAfter = await ownerOf(id, after);
  }
  return { after, ownerAfter, restored };
}

/* ── the list ────────────────────────────────────────────────────── */
const VIEW_MONTHS = new Map();
let ids;
if (VIEW) {
  /* The view, read through the Airtable API: every row's Kylas Company Id and the
     months in its Source (MQL-SQL). Duplicate rows of one company are merged. */
  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) { console.error("--view needs AIRTABLE_PAT (a token that can read the Company Database base)."); process.exit(1); }
  const AT = (process.env.AIRTABLE_API || "https://api.airtable.com").replace(/\/$/, "");
  const CO_BASE = process.env.AIRTABLE_COMPANY_BASE_ID || "app55PsyRKqkf2CAQ";
  let offset = "", rows = 0, noId = 0, noMonth = 0;
  do {
    const q = new URLSearchParams({ view: VIEW, pageSize: "100" });
    q.append("fields[]", "Kylas Company Id"); q.append("fields[]", "Source (MQL-SQL)");
    if (offset) q.set("offset", offset);
    let r;
    for (let i = 0; i < 6; i++) {
      r = await fetch(`${AT}/v0/${CO_BASE}/${encodeURIComponent("Company List")}?${q}`, { headers: { authorization: `Bearer ${PAT}` } });
      if (r.status !== 429) break;
      await sleep(1000 * 2 ** i);
    }
    if (!r.ok) { console.error(`Airtable: the view "${VIEW}" could not be read — ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    const page = await r.json();
    for (const rec of page.records || []) {
      rows++;
      const kid = String(rec.fields?.["Kylas Company Id"] ?? "").trim().replace(/\.0+$/, "");
      const months = monthsAfterTag(rec.fields?.["Source (MQL-SQL)"]);
      if (!/^\d+$/.test(kid)) { noId++; continue; }
      if (!months.length) { noMonth++; continue; }
      VIEW_MONTHS.set(kid, [...new Set([...(VIEW_MONTHS.get(kid) || []), ...months])].sort(byMonth));
    }
    offset = page.offset || "";
    await sleep(220);
  } while (offset);
  ids = [...VIEW_MONTHS.keys()];
  console.log(`\nView "${VIEW}": ${rows} rows -> ${ids.length} Kylas companies` +
    `${noId ? ` · ${noId} rows without a Kylas Company Id (skipped)` : ""}${noMonth ? ` · ${noMonth} with no month after lifetime-MQL-SQL (skipped)` : ""}`);
  console.log("OWNER: never read from Airtable, never changed. Read from Kylas, kept, read back; the first difference stops the run.");
} else {
  ids = [...new Set(readFileSync(IDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")))];
  if (ids.some((x) => !/^\d+$/.test(x))) { console.error(`${IDS_FILE}: every line must be a Kylas company id`); process.exit(1); }
}

/* ── --probe <id>: WHY DOES KYLAS REFUSE THIS COMPANY? ──────────────
   2026-10-21: the canary passed and then every real company came back 400
   02803002 "generic.error" — a code that names no field. The canary's test
   company carried a name and one text field; a real one carries thirty. So,
   without touching the real record:
     1. its body's SHAPE (keys and kinds, never values — the log is public),
        each custom field against Kylas' own definition of it;
     2. that body POSTed as a THROWAWAY company. Refused too -> the body is the
        cause, and each key is tried alone on a throwaway to name it;
     3. with --probe-write only: the real PUT with the owner it already has in
        the body ("same"), then the usual owner check and read-back. */
const kind = (v) => (v === null ? "null" : Array.isArray(v) ? `[${v.length ? kind(v[0]) : ""}]x${v.length}`
  : typeof v === "object" ? `{${Object.keys(v).join(",")}}` : typeof v === "string" ? `str(${v.length})` : typeof v);
const codeOf = (e) => String(e?.message || "").replace(/^\S+ \S+ -> /, "").replace(/"path":"[^"]*",?/, "").slice(0, 220);
if (has("probe")) {
  const id = String(arg("probe", ""));
  if (!/^\d+$/.test(id)) { console.error("--probe <Kylas company id>"); process.exit(1); }
  const rec = await call("GET", `/v1/companies/${id}`);
  const owner = await ownerOf(id, rec);
  console.log(`\nPROBE ${id} — owner ${owner?.id ?? "NONE"} (${owner ? ((await ownerActive(owner.id)) ? "active" : "NOT active") : "-"})`);
  const src = textOf(rec.customFieldValues?.[FIELD]);
  const target = VIEW ? want(id, src) : withTag(src);
  const body = bodyFor(rec, target, "omit", owner);
  console.log(`\n1 · the body a write sends (keys and kinds, no values):`);
  for (const [k, v] of Object.entries(body)) if (k !== "customFieldValues") console.log(`    ${k.padEnd(26)} ${kind(v)}   (Kylas sent: ${kind(rec[k])})`);
  console.log(`    left out (server/owner keys present on the record): ${Object.keys(rec).filter((k) => SERVER_KEYS.has(k) || OWNER_KEYS.has(k)).join(", ")}`);
  let defs = [];
  try { const r = await call("GET", "/v1/entities/company/fields?entityType=company&custom-only=false&page=0&size=200"); defs = r?.content || r || []; }
  catch (e) { console.log(`    (field definitions not readable: ${codeOf(e)})`); }
  if (!Array.isArray(defs)) defs = defs?.data || defs?.fields || [];
  console.log(`    (${defs.length} field definitions read; one carries: ${Object.keys(defs[0] || {}).join(",")})`);
  const defOf = (n) => defs.find((d) => d.name === n || d.fieldName === n || d.internalName === n);
  for (const [k, v] of Object.entries(body.customFieldValues || {})) {
    const d = defOf(k);
    const opts = d?.picklist?.picklistValues || d?.picklistValues || [];
    const vals = Array.isArray(v) ? v : [v];
    const bad = opts.length ? vals.filter((x) => { const o = opts.find((p) => String(p.id) === String(x)); return !o || o.disabled === true || o.active === false; }) : [];
    console.log(`    cf ${k.padEnd(28)} ${kind(v).padEnd(10)} def: ${d ? `${d.type}${d.active === false ? " INACTIVE" : ""}${d.deleted ? " DELETED" : ""}${d.standard ? " standard" : ""}` : "NOT IN THE FIELD LIST"}` +
      `${bad.length ? `  !! ${bad.length} value(s) not an active option` : ""}   (Kylas sent: ${kind(rec.customFieldValues?.[k])})`);
  }
  const testName = `ZZ ENOUT TEST — delete me probe ${new Date().toISOString().slice(0, 16)}`;
  const tryCreate = async (b) => {
    try {
      const made = await call("POST", "/v1/companies", { ...b, name: testName });
      if (made?.id) { try { await call("DELETE", `/v1/companies/${made.id}`); } catch (e) { console.log(`    ! could not delete test company ${made.id} — delete "${testName}" in Kylas.`); } }
      return null;
    } catch (e) { return codeOf(e); }
  };
  console.log(`\n2 · that body as a throwaway company:`);
  const whole = await tryCreate(body);
  console.log(`    the whole body: ${whole ? `REFUSED ${whole}` : "created fine (and deleted)"}`);
  if (whole) {
    const culprits = [];
    for (const [k, v] of Object.entries(body)) {
      if (k === "name") continue;
      if (k === "customFieldValues") {
        for (const [kk, vv] of Object.entries(v)) { const r = await tryCreate({ customFieldValues: { [kk]: vv } }); if (r) culprits.push({ cf: true, k: kk, r }); }
      } else { const r = await tryCreate({ [k]: v }); if (r) culprits.push({ cf: false, k, r }); }
    }
    console.log(culprits.length ? `    refused on its own:\n      ${culprits.map((c) => `${c.cf ? "cf " : ""}${c.k} — ${c.r}`).join("\n      ")}`
      : "    every key is accepted on its own — it is a combination, or the update path");
    /* Each refused one in the other shapes a lookup could go in as, on a
       throwaway — and only a shape that READS BACK as the same value counts. */
    const raw = (c) => (c.cf ? rec.customFieldValues?.[c.k] : rec[c.k]);
    for (const c of culprits) {
      const r0 = raw(c);
      const variants = [["as Kylas sent it", r0], ["its name", textOf(r0)], ["its id as text", idOf(r0) == null ? undefined : String(idOf(r0))],
        ["{id} only", idOf(r0) == null ? undefined : { id: idOf(r0) }]];
      const out = [];
      for (const [label, val] of variants) {
        if (val === undefined || val === "") continue;
        const b = c.cf ? { customFieldValues: { [c.k]: val } } : { [c.k]: val };
        let res;
        try {
          const made = await call("POST", "/v1/companies", { ...b, name: testName });
          let same = "?";
          try { const got = await call("GET", `/v1/companies/${made.id}`); same = JSON.stringify(cfOf(c.cf ? got.customFieldValues?.[c.k] : got[c.k])) === JSON.stringify(cfOf(r0)) ? "reads back the same" : "reads back DIFFERENT"; }
          finally { try { await call("DELETE", `/v1/companies/${made.id}`); } catch { console.log(`    ! could not delete test company ${made.id} — delete "${testName}" in Kylas.`); } }
          res = `accepted, ${same}`;
        } catch (e) { res = `refused ${codeOf(e).slice(0, 90)}`; }
        out.push(`${label}: ${res}`);
      }
      console.log(`    ${c.cf ? "cf " : ""}${c.k}:\n      ${out.join("\n      ")}`);
    }
  }
  /* 4 · CAN ONE FIELD BE WRITTEN WITHOUT SENDING THE REST BACK? A value Kylas
     itself will not take back (a picklist option since retired) makes every
     whole-record write impossible. So, on a throwaway carrying this record's
     lookups and a real owner: PATCH (merge-patch, json-patch) and a PUT of
     only the name and the one field — and after each, did the field take, did
     everything else stay, and is the owner still the owner? */
  console.log(`\n4 · writing ONLY Source of Data, on a throwaway:`);
  const seedCf = { cfBatch: "probe", [FIELD]: "a" };
  for (const [k, v] of Object.entries(rec.customFieldValues || {}))
    if (v && typeof v === "object" && !Array.isArray(v) && k !== "cfPipelineStageBd") seedCf[k] = v;
  const seed = { name: testName, customFieldValues: seedCf };
  if (rec.numberOfEmployees) seed.numberOfEmployees = rec.numberOfEmployees;
  let tid = null;
  try {
    tid = (await call("POST", "/v1/companies", seed))?.id;
    if (owner && (await ownerActive(owner.id)) === true) await call("PUT", `/v1/companies/${tid}/owner`, { ownerId: Number(owner.id) });
    const start = await call("GET", `/v1/companies/${tid}`);
    const ownerStart = await ownerOf(tid, start);
    console.log(`    test company ${tid}, owner ${ownerStart?.id}, fields: ${Object.keys(shape(start)).join(", ")}`);
    const raw = async (method, path, body, ctype) => {
      const r = await fetch(`${BASE}${path}`, { method, headers: { ...H, "content-type": ctype }, body: JSON.stringify(body) });
      const t = await r.text(); await sleep(300);
      return `${r.status}${r.ok ? "" : ` ${t.replace(/"timestamp":"[^"]*",?/, "").slice(0, 110)}`}`;
    };
    const tries = [
      ["PATCH merge-patch", "PATCH", { customFieldValues: { [FIELD]: "m" } }, "application/merge-patch+json", "m"],
      ["PATCH json-patch replace", "PATCH", [{ op: "replace", path: `/customFieldValues/${FIELD}`, value: "j" }], "application/json-patch+json", "j"],
      ["PATCH json-patch add", "PATCH", [{ op: "add", path: `/customFieldValues/${FIELD}`, value: "k" }], "application/json-patch+json", "k"],
      ["PATCH plain json", "PATCH", { customFieldValues: { [FIELD]: "p" } }, "application/json", "p"],
      ["PUT name + the field only", "PUT", { name: testName, customFieldValues: { [FIELD]: "u" } }, "application/json", "u"],
    ];
    let prev = start;
    for (const [label, method, body, ctype, val] of tries) {
      const status = await raw(method, `/v1/companies/${tid}`, body, ctype);
      const now = await call("GET", `/v1/companies/${tid}`);
      const took = textOf(now.customFieldValues?.[FIELD]) === val;
      const lost = Object.entries(shape(prev)).filter(([k, v]) => shape(now)[k] !== v).map(([k]) => k);
      const ownerNow = await ownerOf(tid, now);
      console.log(`    ${label.padEnd(26)} ${status.padEnd(4)} field ${took ? "TOOK" : "did not take"} · ` +
        `${lost.length ? `CHANGED/LOST: ${lost.join(", ")}` : "every other field kept"} · owner ${ownerNow?.id === ownerStart?.id ? "unchanged" : `${ownerStart?.id} -> ${ownerNow?.id}`}`);
      if (ownerNow?.id !== ownerStart?.id && ownerStart) await call("PUT", `/v1/companies/${tid}/owner`, { ownerId: Number(ownerStart.id) });
      prev = await call("GET", `/v1/companies/${tid}`);
    }
  } catch (e) { console.log(`    error: ${codeOf(e)}`); }
  finally {
    if (tid) { try { await call("DELETE", `/v1/companies/${tid}`); console.log(`    deleted the test company ${tid}`); } catch { console.log(`    ! could not delete test company ${tid} — delete "${testName}" in Kylas.`); } }
  }

  if (has("probe-write")) {
    console.log(`\n3 · the real write, owner ${owner?.id} IN the body ("same"):`);
    if (!owner || (await ownerActive(owner.id)) !== true) { console.log("    not tried: no active owner"); process.exit(1); }
    writeFileSync(`bulk-tag-snapshot-probe-${id}.json`, JSON.stringify({ id, owner, before: rec }, null, 2));
    try { await call("PUT", `/v1/companies/${id}`, bodyFor(rec, target, "same", owner)); }
    catch (e) {
      const chk = await keepOwner(id, owner);
      console.log(`    REFUSED ${codeOf(e)}\n    owner after: ${chk.ownerAfter?.id} (${chk.ownerAfter?.id === owner.id ? "unchanged" : "CHANGED"})`);
      process.exit(0);
    }
    const { after, ownerAfter, restored } = await keepOwner(id, owner);
    const diff = differences(rec, after, target, owner, ownerAfter);
    console.log(`    TOOK IT. owner ${owner.id} -> ${ownerAfter?.id}${restored ? " (moved by Kylas, given back)" : " (never moved)"}` +
      `${diff.length ? `\n    !! differences:\n      ${diff.join("\n      ")}` : "\n    every other field the same"}`);
    process.exit(diff.length ? 1 : 0);
  }
  console.log("\nNothing real was written.\n");
  process.exit(0);
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
      const ownerBefore = await ownerOf(id, before);
      if (!ownerBefore) {
        tried.push({ mode, ok: false, why: "no owner found on the new company — the test proves nothing", fields: ownerishKeys(before) });
        console.log(`  ${mode.padEnd(5)} cannot test: no owner found on the new company. Owner-like fields: ${JSON.stringify(ownerishKeys(before))}`);
        continue;
      }
      /* A company the API creates is the API user's already — so a reset to the
         API user could not show. Give it to a real, active owner first. */
      const apiUser = ownerBefore.id;
      let realOwner = null;
      for (const rid of ids.slice(0, 25)) {
        try {
          const o = await ownerOf(rid, await call("GET", `/v1/companies/${rid}`));
          if (o && o.id !== apiUser && (await ownerActive(o.id)) === true) { realOwner = o.id; break; }
        } catch { /* try the next */ }
      }
      if (!realOwner) {
        tried.push({ mode, ok: false, why: "no active owner other than the API user found to test with" });
        console.log(`  ${mode.padEnd(5)} cannot test: no active owner other than the API user (${apiUser}) found among the companies`);
        continue;
      }
      await call("PUT", `/v1/companies/${id}/owner`, { ownerId: Number(realOwner) });
      const given = await call("GET", `/v1/companies/${id}`);
      const ownerGiven = await ownerOf(id, given);
      if (ownerGiven?.id !== realOwner) {
        tried.push({ mode, ok: false, why: `could not give the test company to ${realOwner}` });
        console.log(`  ${mode.padEnd(5)} cannot test: the owner endpoint did not move the test company to ${realOwner}`);
        continue;
      }
      console.log(`  ${mode.padEnd(5)} test company ${id}, owner ${ownerGiven.id} (a real BD user; the API user is ${apiUser})`);
      const target = VIEW ? monthSource(textOf(given.customFieldValues?.[FIELD]), ["October"])
                          : withTag(textOf(given.customFieldValues?.[FIELD]));
      await call("PUT", `/v1/companies/${id}`, bodyFor(given, target, mode, ownerGiven));
      const { after, ownerAfter, restored } = await keepOwner(id, ownerGiven);
      const diff = differences(given, after, target, ownerGiven, ownerAfter);
      tried.push({ mode, ok: !diff.length, diff, restored });
      console.log(`  ${mode.padEnd(5)} ${diff.length ? "FAILED" : `kept the owner and every field${restored ? " (Kylas moved the owner on the write; the owner endpoint gave it back)" : ""}`}` +
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

/* ── 1 · dry run ─────────────────────────────────────────────────── */
if (!has("apply")) {
  console.log(`\nDRY RUN — ${ids.length} companies, ${VIEW ? `months from the view "${VIEW}"` : `tag "${TAG}"`}. Nothing is written.\n`);
  let todo = 0, done = 0, missing = 0, noOwner = 0, inactive = 0, shown = false;
  const fromCount = {};
  for (const id of ids) {
    let rec;
    try { rec = await call("GET", `/v1/companies/${id}`); }
    catch (e) { missing++; console.log(`  ${id.padEnd(9)} ! cannot read: ${e.message.slice(0, 80)}`); continue; }
    if (!shown) { shown = true; console.log(`  owner-like fields on ${id} as Kylas sends them: ${JSON.stringify(ownerishKeys(rec))}\n`); }
    const src = textOf(rec.customFieldValues?.[FIELD]);
    const owner = await ownerOf(id, rec);
    if (!owner) noOwner++; else fromCount[owner.from] = (fromCount[owner.from] || 0) + 1;
    if (isDone(id, src)) { done++; continue; }
    if (owner && (await ownerActive(owner.id)) === false) {
      inactive++;
      console.log(`  ${id.padEnd(9)} owner ${owner.id} is DEACTIVATED — will be skipped (the write would change its owner for good)`);
      continue;
    }
    todo++;
    console.log(`  ${id.padEnd(9)} ${nameOf(rec).slice(0, 28).padEnd(28)} owner ${String(owner?.id ?? "NONE").padEnd(7)}` +
      `  "${clip(src)}" -> "${clip(want(id, src))}"`);
  }
  console.log(`\n${todo} to tag · ${done} already tagged · ${missing} unreadable · ${noOwner} with no owner found · ${inactive} with a deactivated owner (skipped)`);
  console.log(`owner read from: ${JSON.stringify(fromCount)}`);
  if (noOwner) console.log(`! ${noOwner} with no owner found. --apply skips those; if it is most of them, send this output back.`);
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
let wrote = 0, skipped = 0, refused = 0, inactive = 0, reasserted = 0;
for (const id of ids) {
  if (wrote >= LIMIT) break;
  const before = await call("GET", `/v1/companies/${id}`);
  const src = textOf(before.customFieldValues?.[FIELD]);
  if (isDone(id, src)) { skipped++; continue; }
  const ownerBefore = await ownerOf(id, before);
  if (!ownerBefore) { console.log(`  ${id} — no owner found, skipped (cannot prove it survives)`); skipped++; continue; }
  if ((await ownerActive(ownerBefore.id)) === false) {
    console.log(`  ${id} — owner ${ownerBefore.id} is deactivated, skipped (a write would change its owner for good)`);
    skipped++; inactive++; continue;
  }
  const target = want(id, src);
  snaps.push({ id, owner: ownerBefore, before }); keep();
  try {
    await call("PUT", `/v1/companies/${id}`, bodyFor(before, target, mode, ownerBefore));
  } catch (e) {
    if (e.status !== 400 && e.status !== 422) throw e;
    refused++;
    const chk = await keepOwner(id, ownerBefore);
    if (chk.ownerAfter?.id !== ownerBefore.id) {
      console.log(`\n  STOPPED at ${id}: Kylas refused the write AND its owner is no longer ${ownerBefore.id}. Before-image in ${snapFile}.\n`);
      process.exit(1);
    }
    console.log(`  ${id} — Kylas refused the write (${e.message.slice(-90)}); nothing changed, owner ${ownerBefore.id} checked`);
    if (refused >= 10 && refused > wrote) {
      console.log(`\n  STOPPED: Kylas refused ${refused} writes and took ${wrote}. Send this output back.\n`);
      process.exit(1);
    }
    continue;
  }
  const { after, ownerAfter, restored } = await keepOwner(id, ownerBefore);
  if (restored) reasserted++;
  const diff = differences(before, after, target, ownerBefore, ownerAfter);
  if (diff.length) {
    console.log(`\n  STOPPED at ${id} (${nameOf(before)}). The write did not come back clean:\n    ${diff.join("\n    ")}` +
      `\n  Its before-image is in ${snapFile}. Nothing after it was touched.\n`);
    process.exit(1);
  }
  wrote++;
  console.log(`  ${String(wrote).padStart(3)}  ${id.padEnd(9)} ${nameOf(before).slice(0, 30).padEnd(30)} owner ${ownerBefore.id} kept${restored ? " (given back)" : ""} · "${target.slice(-60)}"`);
}
console.log(`\nOWNER CHECK: ${wrote} of ${wrote} written companies read back with the owner they had before` +
  `${reasserted ? ` (${reasserted} were moved by Kylas on the write and given back at once)` : ""}.`);
if (inactive || refused) console.log(`Skipped: ${inactive} with a deactivated owner · ${refused} Kylas refused. None of them was changed.`);
console.log(`\n${wrote} tagged · ${skipped} skipped (already tagged or no owner).` +
  (LIMIT === 1 && wrote ? `\nOpen that company in Kylas: owner, fields, Source of Data. Then --apply --all.` : "") + "\n");
