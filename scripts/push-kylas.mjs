#!/usr/bin/env node
/* WHAT THE CONSOLE ALREADY KNOWS, PUSHED INTO KYLAS. Nightly.
 *
 *   node --env-file=.env.local scripts/push-kylas.mjs              # dry run
 *   node --env-file=.env.local scripts/push-kylas.mjs --apply
 *   node --env-file=.env.local scripts/push-kylas.mjs --apply --limit 200   # at most 200 WRITES
 *   node --env-file=.env.local scripts/push-kylas.mjs --reads 3000          # look at 3000 contacts
 *   node --env-file=.env.local scripts/push-kylas.mjs --contact 6326286     # one contact
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
 * It writes the two derived fields AND THE REMARKS BLOCK (Ayush, 2026-10-18:
 * "I need all the data to be pushed in remarks"): stage, owner, next call, every
 * event row (past and current, with budget, timeline, pax and its note), vendor,
 * mode and offering. The block goes in the team's custom Remarks field
 * (cfRemarks): Kylas keeps no built-in `remarks` on this account (a PUT answers
 * 200 and a read-back shows null, which is how this was found). It is cut out and
 * rewritten between its two markers; whatever a human typed outside it is kept. It does not push a stage, a name or
 * a phone from Airtable into Kylas as FIELDS: Kylas is the system of record for
 * those, and a nightly job that overwrites them from a copy is how a CRM loses
 * an edit somebody made in the CRM. The stage in the block is context for the
 * person reading the record.
 *
 * TWO CAPS, because they guard different things. `limit` caps WRITES (what a
 * mistake can damage). `reads` caps contacts LOOKED AT (how long the run takes).
 * They used to be one number counting reads, so once the first hundred contacts
 * agreed with Kylas every night re-read the same hundred and nothing past them
 * was ever pushed. A window that moves a day at a time (see `rotate`) now reaches
 * everyone.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { createClient, renderRemarks, mergeNote, noteText, clipBlock, MARK_A, MARK_B } from "./kylas.mjs";
import { STAGE_LABEL } from "./stages.mjs";
import { resolveWriteFields, extraCustomFields, describeWriteMap } from "./kylas-write-map.mjs";
import { offsiteOf } from "./offsite.mjs";
import { tzMinOf } from "./day.mjs";
import { resolveFieldMap, problemsOf, kindOfKylas, checkValue, verdict } from "./field-map.mjs";
import { contactRow, runRow, recordPush, storeFieldMap, whyOf } from "./push-log.mjs";
import { findOptions } from "./kylas-options.mjs";

export { findOptions };

export async function run({ env = {}, log = () => {}, apply = false, limit = Infinity, reads = Infinity, only = "", now = Date.now(),
                            signal = null, breakerMin = 20, flushEvery = 250 } = {}) {
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
  /* ── what the console knows ────────────────────────────────────────── */
  const [contacts, rows] = await Promise.all([
    listTolerant(at, "Contacts", { fields: ["Kylas Contact ID", "Name", "Next Call Date", "Next Call Time", "Current Stage", "Owner",
                                            "Vendor Info", "Mode of Meeting", "Service Offering"],
                                   pageSize: 100, maxPages: 5000 }),
    listTolerant(at, "Event Rows", { fields: ["Contact", "Period", "Event Type", "Budget", "Timeline", "Pax", "Remarks", "Removed At"],
                                     pageSize: 100, maxPages: 5000 }),
  ]);
  const rowsByContact = new Map();
  for (const r of rows) {
    /* A row the console removed counts for nothing (schema: Removed At). */
    if (r.fields?.["Removed At"]) continue;
    for (const id of r.fields?.Contact || [])
      (rowsByContact.get(id) || rowsByContact.set(id, []).get(id)).push(r.fields);
  }
  log(`  ${contacts.length} contact(s), ${rows.length} event row(s)`);

  /* The card shape offsite.js reads. Past and Now are the same question here —
     an offsite held last February is the best guess for this year's. */
  const quartersFor = (rec) => offsiteOf({ past: [], current: (rowsByContact.get(rec.id) || [])
    .map((f) => ({ eventType: f["Event Type"] || "", timeline: f.Timeline || "" })) });
  const wantedFor = (rec) => extraCustomFields(map, { nextCallDate: rec.fields?.["Next Call Date"] || "",
                                                      nextCallTime: rec.fields?.["Next Call Time"] || "" },
                                               { tzMin: TZ, quarters: quartersFor(rec) });

  /* THE CARD, AS AIRTABLE HOLDS IT: what renderRemarks prints. A contact the
     console never touched has no event rows, vendor, mode, offering or call-back,
     and its block would be only the stage and owner Kylas already knows — noise
     on tens of thousands of records. So the block is written only where the
     console has something to say. */
  const cardFor = (rec) => {
    const f = rec.fields || {}, past = [], current = [];
    for (const e of rowsByContact.get(rec.id) || []) {
      const r = { eventType: e["Event Type"] || "", budget: e.Budget || "", timeline: e.Timeline || "",
                  pax: e.Pax || "", remarks: e.Remarks || "" };
      (e.Period === "Past" ? past : current).push(r);
    }
    return { stage: f["Current Stage"] || "", owner: f.Owner || "", nextCallDate: f["Next Call Date"] || "",
             nextCallTime: f["Next Call Time"] || "", past, current, vendorInfo: f["Vendor Info"] || "",
             modeOfMeeting: f["Mode of Meeting"] || "", serviceOffering: !!f["Service Offering"] };
  };
  const blockFor = (rec) => {
    const c = cardFor(rec);
    if (!c.past.length && !c.current.length && !c.vendorInfo && !c.modeOfMeeting && !c.serviceOffering && !c.nextCallDate) return "";
    return renderRemarks(c, { stageLabel: STAGE_LABEL[c.stage] || c.stage });
  };

  /* Which registry key a Kylas field name is, and the resolved field behind it. */
  const keyOf = new Map(), fieldOf = {};
  if (map.nextCall) { keyOf.set(map.nextCall.name, "nextCall"); fieldOf.nextCall = map.nextCall; }
  if (map.offsite) { keyOf.set(map.offsite.name, "offsite"); fieldOf.offsite = map.offsite; }
  if (map.remarks) { keyOf.set(map.remarks.name, "remarks"); fieldOf.remarks = map.remarks; }
  const labelOf = (k) => resolved.find((r) => r.key === keyOf.get(k))?.label || keyOf.get(k) || k;

  /* ── the pass ──────────────────────────────────────────────────────── */
  let checked = 0, changed = 0, wrote = 0, failed = 0, skipped = 0, gone = 0, unmapped = 0, held = 0, remarksPushed = 0;
  const examples = [];
  const track = [];           /* one entry per contact the pass tried to write */

  const allPushed = (t) => t.outcomes.length > 0 && t.outcomes.every((o) => o.status === "pushed");
  const nonePushed = (t) => !t.outcomes.some((o) => o.status === "pushed");
  let flushed = 0, stopped = "";
  /* A BIG RUN KEEPS ITS WORK AS IT GOES, AND STOPS ITSELF WHEN IT IS WRONG.
     The Push Log used to be written once, at the end — so a laptop that slept
     halfway through a bulk run lost the record of everything it had pushed. Rows
     are keyed run|contact, so writing a slice now and the rest later is safe.
     And a run whose first twenty contacts mostly fail is not going to improve on
     the next three thousand: past `breakerMin` tracked contacts, more than one in
     ten not fully pushed stops it, and says so. */
  const afterTrack = async () => {
    if (!apply) return;
    if (track.length - flushed >= flushEvery) {
      const part = track.slice(flushed).map((t) => contactRow({ run: runId, at: stamp, kid: t.kid, name: t.name, outcomes: t.outcomes }));
      const w = await recordPush(at, part, { log });
      if (w.stored) flushed = track.length;
    }
    if (!stopped && track.length >= breakerMin) {
      const bad = track.filter((t) => !allPushed(t)).length;
      if (bad / track.length > 0.1) stopped = `${bad} of the first ${track.length} contacts written were not fully pushed — stopped before it went further`;
    }
  };

  /* WHO THERE IS SOMETHING TO PUSH FOR, then the window of them looked at tonight. */
  const candidates = [];
  for (const rec of contacts) {
    const kid = String(rec.fields?.["Kylas Contact ID"] || "").trim();
    if (!kid) { skipped++; continue; }
    if (only && kid !== only) continue;
    /* A value the console HAS and no Kylas field to put it in. Counted, not
       listed per contact: it is one fact about the account, and the run row
       carries it. */
    if ((!map.nextCall && rec.fields?.["Next Call Date"]) || (!map.offsite && quartersFor(rec).length) || (!map.remarks && blockFor(rec))) unmapped++;
    if (!Object.keys(wantedFor(rec)).length && !blockFor(rec)) { skipped++; continue; }
    candidates.push(rec);
  }
  /* ROTATE, WITHOUT STATE. When there are more candidates than the read budget,
     start each day where the last stopped: day N looks at [N*reads, (N+1)*reads)
     of the list, wrapping. Nothing is stored, so there is nothing to lose, and
     every contact is reached every ceil(n/reads) days. */
  /* A Kylas call is about half a second (the client keeps a gap between them). */
  const mins = (n) => Math.max(1, Math.round(n / 60));
  log(`  ${candidates.length} contact(s) have something to push · reading them all takes about ${mins(candidates.length * 0.5)} min,` +
      ` and writing every one about ${mins(candidates.length * 1.5)} min`);
  let order = candidates;
  if (!only && Number.isFinite(reads) && candidates.length > reads) {
    const start = (Math.floor(now / 86400000) * reads) % candidates.length;
    order = [...candidates.slice(start), ...candidates.slice(0, start)];
    log(`  ${candidates.length} contact(s) have something to push; tonight looks at ${reads} of them, from #${start + 1}`);
  }
  for (const rec of order) {
    const kid = String(rec.fields?.["Kylas Contact ID"] || "").trim();
    const want = wantedFor(rec);
    const block = blockFor(rec);
    if (checked >= reads || changed >= limit) break;
    if (signal?.aborted) { stopped = "interrupted — what was pushed so far is kept"; break; }
    checked++;
    if (checked % 100 === 0) log(`  … ${checked} looked at · ${changed} differ · ${wrote} written${failed ? ` · ${failed} failed` : ""}`);

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
    if (only) showContact({ log, rec, kid, base, want, have, block, keyOf, fieldOf, labelOf, map });
    const diff = Object.entries(want).filter(([k, v]) => !same(idOf(have[k]), v));   /* the two derived fields */
    /* THE REMARKS BLOCK, rewritten between its markers over whatever the team's
       Remarks field holds (a human's text outside the block is kept). Compared as
       text a person reads, so markup or a trimmed newline is not a difference. */
    if (map.remarks && block) {
      const nk = map.remarks.name, wantNote = mergeNote(idOf(have[nk]) ?? "", clipBlock(block));
      want[nk] = wantNote;
      if (noteText(wantNote) !== noteText(idOf(have[nk]))) diff.push([nk, wantNote]);
    }
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
      examples.push(`${(rec.fields?.Name || kid).padEnd(26)} ${diff.map(([k, v]) => k === map.remarks?.name
        ? `remarks: ${noteText(idOf(have[k])) ? "block rewritten" : "block added"} (${block.split("\n").map((l) => l.split(/\s/)[0]).join(", ")})`
        : `${k}: ${JSON.stringify(idOf(have[k]) ?? null)} → ${JSON.stringify(v)}${k in send ? "" : "  [held back: type]"}`).join(" · ")}`);
    if (!apply) continue;

    const name = rec.fields?.Name || "";
    if (!Object.keys(send).length) { track.push({ kid, name, outcomes }); await afterTrack(); if (stopped) break; continue; }

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
        const isNote = map.remarks && k === map.remarks.name;
        const vd = isNote ? verdict({ sent: noteText(v), got: noteText(got) }) : verdict({ sent: v, got });
        if (isNote && vd.status === "pushed") remarksPushed++;
        outcomes.push({ key: keyOf.get(k), label: labelOf(k), kylasField: k, sent: v, got: got ?? null,
                        status: vd.status, why: vd.why || "" });
      }
    }
    track.push({ kid, name, outcomes });
    await afterTrack();
    if (stopped) break;
  }

  /* ── what the night amounted to ────────────────────────────────────── */
  const pushed = track.filter(allPushed).length;
  const notPushed = track.filter(nonePushed).length;
  const partly = track.length - pushed - notPushed;

  log(`\n  ${checked} checked · ${changed} differ · ${skipped} had nothing to push` +
      (gone ? ` · ${gone} no longer in Kylas` : ""));
  if (gone > 5) log(`    …and ${gone - 5} more that Kylas no longer has`);
  examples.forEach((e) => log(`    ${e}`));
  if (examples.length && changed > examples.length) log(`    …and ${changed - examples.length} more`);
  if (unmapped) log(`  ! ${unmapped} contact(s) have a value the console holds and this account has no Kylas field for`);
  if (stopped) log(`\n  !! STOPPED: ${stopped}`);
  if (apply) {
    log(`\n  ${wrote} written, ${failed} failed.`);
    log(`  ${pushed} pushed and verified (${remarksPushed} with the remarks block) · ${partly} partly pushed · ${notPushed} not pushed` +
        (held ? ` · ${held} held back for type` : ""));
    for (const t of track.filter((x) => !allPushed(x)).slice(0, 8))
      log(`    · ${t.name || t.kid}: ${t.outcomes.filter((o) => o.status !== "pushed")
        .map((o) => `${o.label} — ${o.why || whyOf(o.status)}`).join("; ")}`);
  } else log(`\n  Dry run — nothing written. Add --apply.`);

  /* ── and it is kept ────────────────────────────────────────────────── */
  const totals = { checked, changed, wrote, failed, gone, unmapped, held, pushed, partly, notPushed, remarks: remarksPushed };
  let tracked = { stored: false, why: "dry run — nothing was written, so nothing is recorded" };
  if (apply) {
    const lines = track.slice(flushed).map((t) => contactRow({ run: runId, at: stamp, kid: t.kid, name: t.name, outcomes: t.outcomes }));
    lines.push(runRow({ run: runId, at: stamp, totals,
                        mapProblems: [...mapProblems, ...(stopped ? [{ key: "stopped", label: "Run stopped", status: "stopped", note: stopped }] : [])] }));
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
  return { ...totals, skipped, mapProblems, tracked, ...(stopped ? { stopped } : {}) };
}

/* ── the pieces run() uses, out here so they are testable ──────────────── */

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

/* `--contact <id>`: what Airtable wants on this contact, what Kylas holds, side by
   side, field by field. The answer to "is the offsite really on the contact in
   Kylas" without having to open Kylas. */
function showContact({ log, rec, kid, base, want, have, block, keyOf, fieldOf, labelOf, map }) {
  const nice = (k, v) => {
    const opts = fieldOf[keyOf.get(k)]?.options || [];
    const one = (x) => { const o = opts.find((y) => String(y.id) === String(x)); return o ? `${o.label || o.code} [${x}]` : String(x); };
    return v === undefined || v === null || v === "" ? "(empty)" : Array.isArray(v) ? v.map(one).join(", ") : one(v);
  };
  log(`\n  CONTACT ${rec.fields?.Name || ""} · Kylas ${kid}`);
  for (const [k, v] of Object.entries(want)) {
    const held = idOf(have[k]);
    log(`    ${labelOf(k).padEnd(18)} Airtable wants ${nice(k, v).padEnd(34)} Kylas holds ${nice(k, held).padEnd(34)} ${same(held, v) ? "SAME" : "DIFFERENT"}`);
  }
  if (!Object.keys(want).length) log("    (no call-back or offsite quarter on this contact in Airtable)");
  const nk = map?.remarks?.name;
  const mine = nk ? String(idOf(have[nk]) ?? "") : "";
  log(`    ${"Remarks block".padEnd(18)} Airtable wants ${block ? `${block.split("\n").length} line(s)` : "(none: nothing captured in the console)"}` +
      `${nk ? `   → into ${map.remarks.label} (${nk}, ${map.remarks.type})` : "   → NO Remarks field on this account"}`);
  if (block && nk) {
    const same_ = noteText(mergeNote(mine, clipBlock(block))) === noteText(mine);
    const hasBlock = noteText(mine).includes(noteText(MARK_A));
    log(`    ${"".padEnd(18)} Kylas holds ${same_ ? "the same block" : hasBlock ? "an OLDER block" : "no block"}` +
        `${mine && !hasBlock ? ` (the field holds ${noteText(mine).length} characters somebody typed — they are kept)` : ""}`);
    clipBlock(block).split("\n").forEach((l) => log(`        wanted  | ${l}`));
  }
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
  /* Ctrl-C finishes the contact in hand, keeps what was pushed, and says so. */
  const ctl = new AbortController();
  process.once("SIGINT", () => { console.log("\n  Ctrl-C: finishing this contact, then stopping…"); ctl.abort(); });
  try {
    const out = await run({ env: process.env, log: (...x) => console.log(...x), signal: ctl.signal,
                            apply: argv.includes("--apply"),
                            limit: Number(a("limit", "0")) || Infinity,
                            reads: Number(a("reads", "0")) || Infinity, only: a("contact", "") });
    process.exit(out.failed || out.notPushed || out.stopped ? 1 : 0);
  } catch (e) { console.error(`\npush failed: ${e.message}`); process.exit(1); }
}
