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
import { resolveFieldMap, problemsOf, kindOfKylas, checkValue, verdict } from "./field-map.mjs";
import { contactRow, runRow, recordPush, storeFieldMap, whyOf } from "./push-log.mjs";

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
  const kylasFields = rawFields.map((f) => ({ name: f.name, label: f.displayName, type: f.type }));
  const map = resolveWriteFields(kylasFields, picklists);
  describeWriteMap(map).forEach((l) => log(`  ${l}`));

  /* THE FIELD MAP, CHECKED BEFORE ANYTHING IS TOUCHED (scripts/field-map.mjs).
     A datum with no Kylas field is not an error anywhere downstream — the value
     is simply left off the write — so this is the one place it can be said out
     loud, and the run row below is where the digest reads it from. */
  const resolved = resolveFieldMap({ kylasFields, writeMap: map, picklists });
  const mapProblems = problemsOf(resolved);
  mapProblems.forEach((p) => log(`  ! field map: ${p.label} — ${p.status}: ${p.note}`));
  const stamp = new Date().toISOString();
  const runId = `push-${stamp.slice(0, 16).replace(/[-:T]/g, "")}`;
  if (!map.nextCall && !map.offsite) {
    log("  neither field exists on this account — nothing to push.");
    let tracked = { stored: false, why: "dry run — nothing is recorded" };
    if (apply) {
      tracked = await recordPush(at, [runRow({ run: runId, at: stamp, totals: {}, mapProblems })], { log });
      await storeFieldMap(at, resolved, { log, now: stamp });
    }
    return { checked: 0, changed: 0, wrote: 0, failed: 0, skipped: 0, reason: "no fields", mapProblems, tracked };
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
  const quartersFor = (rec) => offsiteOf({ past: [], current: (rowsByContact.get(rec.id) || [])
    .map((f) => ({ eventType: f["Event Type"] || "", timeline: f.Timeline || "" })) });
  const wantedFor = (rec) => extraCustomFields(map, { nextCallDate: rec.fields?.["Next Call Date"] || "",
                                                      nextCallTime: rec.fields?.["Next Call Time"] || "" },
                                               { tzMin: TZ, quarters: quartersFor(rec) });

  /* Which registry key a Kylas field name is, and the resolved field behind it. */
  const keyOf = new Map(), fieldOf = {};
  if (map.nextCall) { keyOf.set(map.nextCall.name, "nextCall"); fieldOf.nextCall = map.nextCall; }
  if (map.offsite) { keyOf.set(map.offsite.name, "offsite"); fieldOf.offsite = map.offsite; }
  const labelOf = (k) => resolved.find((r) => r.key === keyOf.get(k))?.label || keyOf.get(k) || k;

  /* ── the pass ──────────────────────────────────────────────────────── */
  let checked = 0, changed = 0, wrote = 0, failed = 0, skipped = 0, gone = 0, unmapped = 0, held = 0;
  const examples = [];
  const track = [];           /* one entry per contact the pass tried to write */
  for (const rec of contacts) {
    const kid = String(rec.fields?.["Kylas Contact ID"] || "").trim();
    if (!kid) { skipped++; continue; }
    if (only && kid !== only) continue;
    const want = wantedFor(rec);
    /* A value the console HAS and no Kylas field to put it in. Counted, not
       listed per contact: it is one fact about the account, and the run row
       carries it. */
    if ((!map.nextCall && rec.fields?.["Next Call Date"]) || (!map.offsite && quartersFor(rec).length)) unmapped++;
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

    /* THE TYPE IS CHECKED BEFORE THE SEND. A value of the wrong kind for its
       Kylas field either fails the whole contact (a 400 that names no field) or
       is answered 200 and stored as nothing. Held back and named instead, so
       the rest of the contact still goes. `soft` is a name sent where an id is
       taken — reported, not held, because that is what a save has always done. */
    const outcomes = [], send = {}, putBody = { ...want };
    for (const [k, v] of diff) {
      const f = fieldOf[keyOf.get(k)];
      const chk = checkValue(kindOfKylas(f?.type), v, { options: f?.options });
      if (chk.ok || chk.soft) { send[k] = v; continue; }
      delete putBody[k];
      outcomes.push({ key: keyOf.get(k), label: labelOf(k), kylasField: k, sent: v,
                      got: idOf(have[k]) ?? null, status: "type", why: chk.why });
    }
    if (outcomes.length) held++;

    if (examples.length < 12)
      examples.push(`${(rec.fields?.Name || kid).padEnd(26)} ${diff.map(([k, v]) =>
        `${k}: ${JSON.stringify(idOf(have[k]) ?? null)} → ${JSON.stringify(v)}${k in send ? "" : "  [held back: type]"}`).join(" · ")}`);
    if (!apply) continue;

    const name = rec.fields?.Name || "";
    if (!Object.keys(send).length) { track.push({ kid, name, outcomes }); continue; }

    let landed = false;
    try { await kylas.raw("PUT", `/v1/contacts/${kid}`, bodyFor(base, putBody)); wrote++; landed = true; }
    catch (e) {
      failed++; log(`  ! ${name || kid}: write refused — ${e.message.slice(0, 120)}`);
      for (const [k, v] of Object.entries(send))
        outcomes.push({ key: keyOf.get(k), label: labelOf(k), kylasField: k, sent: v, got: idOf(have[k]) ?? null,
                        status: "refused", why: e.message.slice(0, 140) });
    }

    /* THE END STATE. Read the record back and see whether each value is there.
       A 200 means the request was well formed — never that anything was stored. */
    if (landed) {
      let after = null;
      try { after = await kylas.contact(kid); } catch { after = null; }
      for (const [k, v] of Object.entries(send)) {
        if (!after) { outcomes.push({ key: keyOf.get(k), label: labelOf(k), kylasField: k, sent: v, got: null,
                                      status: "unread", why: whyOf("unread") }); continue; }
        const got = idOf(after.customFieldValues?.[k]);
        const vd = verdict({ sent: v, got });
        outcomes.push({ key: keyOf.get(k), label: labelOf(k), kylasField: k, sent: v, got: got ?? null,
                        status: vd.status, why: vd.why || "" });
      }
    }
    track.push({ kid, name, outcomes });
  }

  /* ── what the night amounted to ────────────────────────────────────── */
  const allPushed = (t) => t.outcomes.length > 0 && t.outcomes.every((o) => o.status === "pushed");
  const nonePushed = (t) => !t.outcomes.some((o) => o.status === "pushed");
  const pushed = track.filter(allPushed).length;
  const notPushed = track.filter(nonePushed).length;
  const partly = track.length - pushed - notPushed;

  log(`\n  ${checked} checked · ${changed} differ · ${skipped} had nothing to push` +
      (gone ? ` · ${gone} no longer in Kylas` : ""));
  if (gone > 5) log(`    …and ${gone - 5} more that Kylas no longer has`);
  examples.forEach((e) => log(`    ${e}`));
  if (examples.length && changed > examples.length) log(`    …and ${changed - examples.length} more`);
  if (unmapped) log(`  ! ${unmapped} contact(s) have a value the console holds and this account has no Kylas field for`);
  if (apply) {
    log(`\n  ${wrote} written, ${failed} failed.`);
    log(`  ${pushed} pushed and verified · ${partly} partly pushed · ${notPushed} not pushed` +
        (held ? ` · ${held} held back for type` : ""));
    for (const t of track.filter((x) => !allPushed(x)).slice(0, 8))
      log(`    · ${t.name || t.kid}: ${t.outcomes.filter((o) => o.status !== "pushed")
        .map((o) => `${o.label} — ${o.why || whyOf(o.status)}`).join("; ")}`);
  } else log(`\n  Dry run — nothing written. Add --apply.`);

  /* ── and it is kept ────────────────────────────────────────────────── */
  const totals = { checked, changed, wrote, failed, gone, unmapped, held, pushed, partly, notPushed };
  let tracked = { stored: false, why: "dry run — nothing was written, so nothing is recorded" };
  if (apply) {
    const lines = track.map((t) => contactRow({ run: runId, at: stamp, kid: t.kid, name: t.name, outcomes: t.outcomes }));
    lines.push(runRow({ run: runId, at: stamp, totals, mapProblems }));
    tracked = await recordPush(at, lines, { log });
    const last = {};
    for (const t of track) for (const o of t.outcomes) {
      const l = (last[o.key] ||= { error: "" });
      if (o.status === "pushed") l.at = stamp;
      else if (!l.error) l.error = o.why || whyOf(o.status);
    }
    await storeFieldMap(at, resolved, { log, now: stamp, last });
    log(tracked.stored ? `  recorded in Push Log (${tracked.rows} row(s)).` : `  not recorded — ${tracked.why}`);
  }
  return { ...totals, skipped, mapProblems, tracked };
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
    process.exit(out.failed || out.notPushed ? 1 : 0);
  } catch (e) { console.error(`\npush failed: ${e.message}`); process.exit(1); }
}
