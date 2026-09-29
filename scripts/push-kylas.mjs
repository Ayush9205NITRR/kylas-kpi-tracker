#!/usr/bin/env node
/* WHAT THE CONSOLE ALREADY KNOWS, PUSHED INTO KYLAS. Nightly.
 *
 *   node --env-file=.env.local scripts/push-kylas.mjs              # dry run
 *   node --env-file=.env.local scripts/push-kylas.mjs --apply
 *   node --env-file=.env.local scripts/push-kylas.mjs --apply --limit 200
 *
 * A save writes the call-back and the offsite quarter to Kylas from 1.29. This
 * is the other half: every contact saved BEFORE that, and every contact whose
 * quarter changed because somebody edited an event row rather than saving a
 * call. Without it the two fields are right on the contacts worked since the
 * upgrade and blank on the thousands worked before it, which is worse than
 * either — a filter in Kylas would look like it works and quietly miss most of
 * the pipeline.
 *
 * THE QUARTER IS NOT STORED ANYWHERE. It is derived, every time, from the
 * Timeline text on the contact's event rows (offsite.js). That is what makes
 * the old rows work without a migration: "Q2 FY27" — the financial-year
 * quarter the old chips wrote — reads as JUL_SEP, which is exactly what the
 * new "Jul-Sep" chip produces. Same bucket, different spelling, one parser.
 *
 * THE PUT REPLACES THE RECORD, so every write here is the whole contact as
 * Kylas currently holds it with the two fields changed. Read the header of
 * toKylasContact before touching this; it was learned the expensive way.
 *
 * It writes ONLY the two derived fields. It does not push a stage, a name or a
 * phone from Airtable into Kylas: Kylas is the system of record for those, and
 * a nightly job that overwrites them from a copy is how a CRM loses an edit
 * somebody made in the CRM.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { createClient } from "./kylas.mjs";
import { resolveWriteFields, extraCustomFields, describeWriteMap } from "./kylas-write-map.mjs";
import { offsiteOf } from "./offsite.mjs";
import { tzMinOf } from "./day.mjs";

export async function run({ env = {}, log = () => {}, apply = false, limit = Infinity, only = "" } = {}) {
  const TZ = tzMinOf(env);
  const { KYLAS_KEY, AIRTABLE_PAT, AIRTABLE_BASE } = env;
  if (!KYLAS_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE)
    throw new Error("push needs KYLAS_KEY, AIRTABLE_PAT and AIRTABLE_BASE");

  const at = createAirtable(AIRTABLE_PAT, AIRTABLE_BASE, { log: () => {},
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  const kylas = createClient(KYLAS_KEY, { log: () => {},
    ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });

  /* ── which fields, on this account ─────────────────────────────────── */
  const fieldList = await kylas.raw("GET",
    "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
  const rawFields = Array.isArray(fieldList) ? fieldList : fieldList?.content || fieldList?.data || [];
  const picklists = {};
  for (const f of rawFields) { const o = findOptions(f); if (o && (f.name || f.displayName)) picklists[f.name || f.displayName] = o; }
  const map = resolveWriteFields(rawFields.map((f) => ({ name: f.name, label: f.displayName, type: f.type })), picklists);
  describeWriteMap(map).forEach((l) => log(`  ${l}`));
  if (!map.nextCall && !map.offsite) {
    log("  neither field exists on this account — nothing to push.");
    return { checked: 0, changed: 0, wrote: 0, failed: 0, skipped: 0, reason: "no fields" };
  }

  /* ── what the console knows ────────────────────────────────────────── */
  const [contacts, rows] = await Promise.all([
    listTolerant(at, "Contacts", { fields: ["Kylas Contact ID", "Name", "Next Call Date", "Next Call Time"],
                                   pageSize: 100, maxPages: 5000 }),
    listTolerant(at, "Event Rows", { fields: ["Contact", "Event Type", "Timeline"], pageSize: 100, maxPages: 5000 }),
  ]);
  const rowsByContact = new Map();
  for (const r of rows)
    for (const id of r.fields?.Contact || [])
      (rowsByContact.get(id) || rowsByContact.set(id, []).get(id)).push(r.fields);
  log(`  ${contacts.length} contact(s), ${rows.length} event row(s)`);

  /* The card shape offsite.js reads. Past and Now are the same question here —
     an offsite held last February is the best guess for this year's. */
  const wantedFor = (rec) => {
    const evs = (rowsByContact.get(rec.id) || [])
      .map((f) => ({ eventType: f["Event Type"] || "", timeline: f.Timeline || "" }));
    return extraCustomFields(map, { nextCallDate: rec.fields?.["Next Call Date"] || "",
                                    nextCallTime: rec.fields?.["Next Call Time"] || "" },
                             { tzMin: TZ, quarters: offsiteOf({ past: [], current: evs }) });
  };

  /* ── the pass ──────────────────────────────────────────────────────── */
  let checked = 0, changed = 0, wrote = 0, failed = 0, skipped = 0, gone = 0;
  const examples = [];
  for (const rec of contacts) {
    const kid = String(rec.fields?.["Kylas Contact ID"] || "").trim();
    if (!kid) { skipped++; continue; }
    if (only && kid !== only) continue;
    const want = wantedFor(rec);
    if (!Object.keys(want).length) { skipped++; continue; }
    if (checked >= limit) break;
    checked++;

    let base;
    try { base = await kylas.contact(kid); }
    catch (e) {
      /* A CONTACT KYLAS NO LONGER HAS IS NOT A FAILURE OF THIS JOB. The KPI
         base keeps a row for every contact ever saved; Kylas' own copy can be
         deleted or merged away, and then the id 404s for ever. Counting that
         as a failure means this job exits non-zero every night, and a nightly
         job that is always red is a nightly job nobody reads. Counted as GONE
         instead: named once, and a growing number is the real signal — the
         two stores are drifting apart. */
      if (/\b404\b/.test(e.message)) {
        gone++;
        if (gone <= 5) log(`  · ${rec.fields?.Name || kid}: not in Kylas any more (${kid})`);
        continue;
      }
      failed++; log(`  ! ${rec.fields?.Name || kid}: could not read — ${e.message.slice(0, 90)}`); continue;
    }

    const have = base?.customFieldValues || {};
    const diff = Object.entries(want).filter(([k, v]) => !same(idOf(have[k]), v));
    if (!diff.length) continue;
    changed++;
    if (examples.length < 12)
      examples.push(`${(rec.fields?.Name || kid).padEnd(26)} ${diff.map(([k, v]) =>
        `${k}: ${JSON.stringify(idOf(have[k]) ?? null)} → ${JSON.stringify(v)}`).join(" · ")}`);
    if (!apply) continue;

    try { await kylas.raw("PUT", `/v1/contacts/${kid}`, bodyFor(base, want)); wrote++; }
    catch (e) { failed++; log(`  ! ${rec.fields?.Name || kid}: write refused — ${e.message.slice(0, 120)}`); }
  }

  log(`\n  ${checked} checked · ${changed} differ · ${skipped} had nothing to push` +
      (gone ? ` · ${gone} no longer in Kylas` : ""));
  if (gone > 5) log(`    …and ${gone - 5} more that Kylas no longer has`);
  examples.forEach((e) => log(`    ${e}`));
  if (examples.length && changed > examples.length) log(`    …and ${changed - examples.length} more`);
  log(apply ? `\n  ${wrote} written, ${failed} failed.` : `\n  Dry run — nothing written. Add --apply.`);
  return { checked, changed, wrote, failed, skipped, gone };
}

/* ── the pieces run() uses, out here so they are testable ──────────────── */

/* Options are nested at a different depth per field type. */
export function findOptions(f, d = 0) {
  if (!f || d > 4) return null;
  if (Array.isArray(f)) {
    if (f.length && f.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
      return f.map((x) => ({ id: x.id, code: x.name || x.displayName, label: x.displayName || x.name }));
    for (const x of f) { const h = findOptions(x, d + 1); if (h) return h; }
    return null;
  }
  if (typeof f === "object") for (const k of Object.keys(f)) { const h = findOptions(f[k], d + 1); if (h) return h; }
  return null;
}

/* An array is a MULTI-picklist, not an object with an id: mapped element by
   element, or it reads as "no value" and the field is dropped from a payload
   that replaces the record. See cfValue in kylas.mjs — the same bug, and it
   also made this job rewrite the same value every night, for ever, because
   undefined never equals [9103]. */
const idOf = (v) => (Array.isArray(v) ? v.map(idOf)
  : v && typeof v === "object" ? (v.id ?? v.value) : v);
const same = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) ===
                       JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

/* THE WHOLE CONTACT, because the PUT replaces it. Anything left out of this
   object is deleted from the record — see the header of toKylasContact, which
   was learned the expensive way. */
export function bodyFor(base, extra) {
  const body = {
    firstName: base.firstName, lastName: base.lastName || "Unknown",
    designation: base.designation, linkedin: base.linkedin,
    ...(base.remarks ? { remarks: base.remarks } : {}),
    ...(base.company ? { company: idOf(base.company) } : {}),
    ...(base.ownerId ? { ownerId: idOf(base.ownerId) } : {}),
    ...(base.phoneNumbers?.length ? { phoneNumbers: base.phoneNumbers } : {}),
    ...(base.emails?.length ? { emails: base.emails } : {}),
    customFieldValues: {},
  };
  for (const [k, v] of Object.entries(base.customFieldValues || {})) {
    const id = idOf(v);
    if (id !== undefined && id !== null && id !== "") body.customFieldValues[k] = id;
  }
  Object.assign(body.customFieldValues, extra);
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/* ── from a terminal ───────────────────────────────────────────────────── */
const isMain = (() => {
  try {
    return typeof process !== "undefined" && process.argv?.[1]
      && import.meta.url.endsWith(process.argv[1].split("/").pop());
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv;
  const a = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
  try {
    const out = await run({ env: process.env, log: (...x) => console.log(...x),
                            apply: argv.includes("--apply"),
                            limit: Number(a("limit", "0")) || Infinity, only: a("contact", "") });
    process.exit(out.failed ? 1 : 0);
  } catch (e) { console.error(`\npush failed: ${e.message}`); process.exit(1); }
}
