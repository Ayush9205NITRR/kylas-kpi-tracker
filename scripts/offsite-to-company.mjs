#!/usr/bin/env node
/* ADD THE CONTACTS' OFFSITE QUARTER TO THE COMPANY IN KYLAS.
 *
 *   node --env-file=.env.local scripts/offsite-to-company.mjs                    the check: nothing written
 *   ... --apply --limit 1                                                        the first company — look at it in Kylas
 *   ... --apply --all                                                            the rest
 *
 * The rule is offsite-sync.mjs: the company keeps every quarter it has and gets
 * the contacts' quarters added. The quarters come from the Event Rows, exactly
 * as the console derives them (Past and Now, rows not Removed).
 *
 * THE WRITE IS THE ONE-FIELD JSON PATCH (see STATE §3l2): PATCH
 * application/json-patch+json on /customFieldValues/<field> changes that field
 * only and never moves the owner. The owner is read before and after each
 * write; the first company whose owner differs STOPS the run. A company whose
 * owner is deactivated is refused by Kylas ("Invalid owner.") — skipped, listed.
 *
 * Logs print Kylas ids and quarters only (this repo's Actions logs are public).
 */
import { createClient } from "./kylas.mjs";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { companyOwnerOf } from "./reassign.mjs";
import { findOptions } from "./kylas-options.mjs";
import { offsiteOf } from "./offsite.mjs";
import { planCompany } from "./offsite-sync.mjs";
import { offsiteFrom } from "./kylas-write-map.mjs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const { KYLAS_KEY, AIRTABLE_PAT } = process.env;
const BASE = process.env.AIRTABLE_BASE || "appEwJu0bleHh9b8t";
if (!KYLAS_KEY || !AIRTABLE_PAT) { console.error("Set KYLAS_KEY and AIRTABLE_PAT."); process.exit(1); }
const APPLY = has("apply");
const LIMIT = has("all") ? Infinity : Number(arg("limit", 0)) || 0;
if (APPLY && !LIMIT) { console.error("--apply needs --limit N or --all."); process.exit(1); }
const KBASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kylas = createClient(KYLAS_KEY, { log: () => {}, base: KBASE });
const at = createAirtable(AIRTABLE_PAT, BASE, { log: () => {} });

/* 1 · what the contacts say, per Kylas company — the console's own derivation */
const [rows, contacts, cos] = await Promise.all([
  listTolerant(at, "Event Rows", { fields: ["Event Type", "Timeline", "Contact", "Removed At"], pageSize: 100, maxPages: 2000 }),
  listTolerant(at, "Contacts", { fields: ["Company"], pageSize: 100, maxPages: 2000 }),
  at.listAll("Companies", { fields: ["Kylas Company ID"], pageSize: 100, maxPages: 2000 }),
]);
const kidOf = new Map(cos.map((r) => [r.id, String(r.fields?.["Kylas Company ID"] || "")]));
const companyOf = new Map(contacts.map((r) => [r.id, kidOf.get((r.fields?.Company || [])[0]) || ""]));
const fromContacts = new Map();
for (const r of rows) {
  const f = r.fields || {};
  if (f["Removed At"]) continue;
  const kid = companyOf.get((f.Contact || [])[0]);
  if (!kid) continue;
  const q = offsiteOf({ current: [{ eventType: f["Event Type"] || "", timeline: f.Timeline || "" }] });
  if (!q.length) continue;
  if (!fromContacts.has(kid)) fromContacts.set(kid, new Set());
  for (const k of q) fromContacts.get(kid).add(k);
}
console.log(`contacts name a quarter on ${fromContacts.size} companies`);

/* 2 · the company's offsite field in Kylas */
/* The first form returned nothing on 2026-10-27 (0 fields, an array), so the
   others the contact side works with are tried in turn; each count is printed. */
let fl = [];
for (const path of [
  "/v1/entities/company/fields?entityType=company&custom-only=false&page=0&size=200",
  "/v1/entities/company/fields?entityType=company&custom-only=false&sort=createdAt,asc&page=0&size=200",
  "/v1/entities/company/fields?entityType=company&custom-only=true&page=0&size=200",
  "/v1/entities/company/fields?page=0&size=200",
  "/v1/entities/company/fields",
  "/v1/entities/COMPANY/fields?entityType=COMPANY&custom-only=false&page=0&size=200",
]) {
  try {
    const r = await kylas.raw("GET", path);
    const list = Array.isArray(r) ? r : r?.content || r?.data || [];
    console.log(`  ${path.replace("/v1/entities/", "")} -> ${list.length} fields`);
    if (list.length) { fl = list; break; }
  } catch (e) { console.log(`  ${path.replace("/v1/entities/", "")} -> ${e.status || e.message}`); }
}
const all = Array.isArray(fl) ? fl : fl?.content || fl?.data || [];
/* Found the way the server finds it (handlers.mjs companyFieldsShared): by LABEL,
   offsite in the name, with options. Every candidate is printed — field metadata,
   no company data — so a wrong pick is visible in the log. */
console.log(`company fields from Kylas: ${all.length}; response shape ${Array.isArray(fl) ? "array" : Object.keys(fl || {}).join(",")}`);
for (const f of all.filter((x) => /off|quarter|timeline|site/i.test(`${x.name} ${x.displayName}`)))
  console.log(`  like: ${f.name} · "${f.displayName}" · type ${f.type}`);
{ const seen = new Set(); let n = 0;
  for (const kid of fromContacts.keys()) { if (n++ >= 6) break;
    try { for (const k of Object.keys((await kylas.company(kid))?.customFieldValues || {})) if (/off|quarter|timeline|site/i.test(k)) seen.add(k); } catch (_) {} }
  console.log(`  custom keys on a few of those companies: ${[...seen].join(", ") || "none"}`); }
const cands = all.filter((f) => /offsite/i.test(`${f.name} ${f.displayName}`) && (findOptions(f) || []).length);
for (const f of all.filter((x) => /offsite/i.test(`${x.name} ${x.displayName}`)))
  console.log(`  candidate: ${f.name} · "${f.displayName}" · type ${f.type} · ${(findOptions(f) || []).length} options · keys ${Object.keys(f).filter((k) => /multi|pick|allow|array|list/i.test(k)).join(",") || "-"}`);
const score = (f) => (/BD\s*-\s*New/i.test(`${f.displayName}`) ? 5 : 0) + (/timeline|quarter/i.test(`${f.name} ${f.displayName}`) ? 2 : 0) + (/multi/i.test(String(f.type)) ? 1 : 0);
const pick = cands.sort((a, b) => score(b) - score(a))[0];
const isMultiRaw = (f) => /MULTI/i.test(String(f?.type)) || f?.multiValue === true || f?.isMultiValue === true || f?.allowMultiple === true;
const field = pick ? { name: pick.name, label: pick.displayName || pick.name, type: String(pick.type || ""), multi: isMultiRaw(pick), options: findOptions(pick) } : null;
if (!field) { console.error("No offsite picklist field on the company in Kylas — nothing to write."); process.exit(1); }
console.log(`company field: ${field.name} (${field.type}${field.multi ? ", multi" : ", single"}, ${field.options.length} options)`);

/* 3 · plan every company */
const sleepGap = async () => sleep(Number(process.env.KYLAS_GAP || 450));
const plans = [], gone = [], tally = {};
for (const [kid, want] of fromContacts) {
  let rec;
  try { rec = await kylas.company(kid); } catch (e) { if (e?.status === 404) { gone.push(kid); continue; } throw e; }
  const plan = planCompany(field, rec?.customFieldValues?.[field.name], want);
  tally[plan.status] = (tally[plan.status] || 0) + 1;
  plans.push({ kid, ...plan });
}
console.log(`\nplanned ${plans.length} companies: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(" · ")}${gone.length ? ` · ${gone.length} gone from Kylas` : ""}`);
const todo = plans.filter((p) => p.status === "add");
for (const p of plans.filter((x) => x.status !== "same").slice(0, 40))
  console.log(`  ${p.kid}: ${p.status} — has [${p.existing.join(", ") || "none"}], contacts say [${p.target.join(", ")}]${p.add.length ? `, add [${p.add.join(", ")}]` : ""}`);
if (!APPLY) { console.log(`\nDry run — nothing written. ${todo.length} company(ies) would be written. Add --apply --limit 1.`); process.exit(0); }

/* 4 · write, read back, stop on any owner change */
async function patch(kid, value) {
  const ops = [{ op: "add", path: `/customFieldValues/${field.name}`, value }];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${KBASE}/v1/companies/${kid}`, { method: "PATCH",
      headers: { "api-key": KYLAS_KEY, "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops),
      signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (res.status === 429) { await sleep(1200 * 2 ** i); continue; }
    if (!res.ok) { const e = new Error(`${res.status} ${text.slice(0, 160)}`); e.status = res.status; throw e; }
    return;
  }
  throw new Error("429 four times");
}
let wrote = 0, refused = 0, mismatched = 0;
const refusedWhy = {};
for (const p of todo) {
  if (wrote >= LIMIT) break;
  const ownerBefore = await companyOwnerOf(kylas, p.kid, null);
  try { await patch(p.kid, p.value); }
  catch (e) { refused++; const w = String(e.message).replace(/[^\x20-\x7e]/g, "").slice(0, 70); refusedWhy[w] = (refusedWhy[w] || 0) + 1;
    console.log(`  ${p.kid}: refused — ${w}`); await sleepGap(); continue; }
  const after = await kylas.company(p.kid);
  const ownerAfter = await companyOwnerOf(kylas, p.kid, null);
  const got = offsiteFrom(field, after?.customFieldValues?.[field.name]);
  if (String(ownerAfter) !== String(ownerBefore)) {
    console.log(`  !! ${p.kid}: OWNER CHANGED ${ownerBefore} -> ${ownerAfter}. Stopping.`); process.exit(2); }
  if (got.join() !== p.target.join()) { mismatched++; console.log(`  ${p.kid}: wrote [${p.target.join(", ")}] but Kylas now holds [${got.join(", ")}]`); }
  else { wrote++; console.log(`  ${p.kid}: now [${got.join(", ")}] (added ${p.add.join(", ")}) — owner ${ownerAfter || "?"} unchanged`); }
  await sleepGap();
}
console.log(`\n${wrote} written and read back, ${refused} refused, ${mismatched} not as written. ${todo.length - wrote - refused - mismatched} left.`);
if (mismatched) process.exit(1);
