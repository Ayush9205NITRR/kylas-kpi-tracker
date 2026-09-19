#!/usr/bin/env node
/* Rebuilds Stage Transitions from the Call Log's own record of stage history.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/seed-transitions.mjs
 *   ... node scripts/seed-transitions.mjs --apply
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY NOT FROM KYLAS
 * Because Kylas has no stage history to give. The documented API — contacts,
 * companies, call-logs, search, meetings, notes — has no audit, timeline or
 * changelog endpoint, and a contact carries only its CURRENT
 * cfPipelineStageBd. Asking Kylas "what stage was this on the 3rd" is not a
 * question it can answer.
 *
 * WHERE THE HISTORY ACTUALLY IS
 * Call Log, in this base. One row per save, append-only, each carrying
 * `Called At` and the `Stage Set` on that call. Walk a contact's calls in order
 * and every change of Stage Set IS a transition, with the exact moment it
 * happened. That is recorded fact, not reconstruction from a summary.
 *
 * WHAT THIS IS FOR
 * migrate-ever-picked.mjs decides whether a contact ever answered by looking
 * for a connected stage in the transitions. On a base where the console wrote
 * calls before it wrote transitions, that evidence is thin, and a contact who
 * answered long ago and has since gone back to Could Not Connect would be
 * wrongly cleared. Run this first and the evidence is as complete as the
 * record allows.
 *
 * THE FIRST OBSERVED STAGE IS WRITTEN TOO, with an empty From — exactly as the
 * console itself does on a contact's first save. That differs from
 * sync-kylas.mjs, which deliberately skips a first observation, and the reason
 * is the timestamp: the sync only knows `updatedAt`, which is "last touched"
 * and would date the whole book to whenever it was last poked. Here `Called At`
 * is precisely when that stage was set, so back-filling it restores real
 * history rather than inventing an arrival.
 *
 * Expect past periods in the report to GAIN numbers — that is the point. The
 * arrivals were always real; nothing was recording them.
 *
 * Keys match the console's own (`<kylas contact id>-<ISO called at>`), so rows
 * the console already wrote are updated in place rather than duplicated, and
 * re-running changes nothing.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { STAGES } from "./stages.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...)."); process.exit(1); }

const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });
const iso = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? new Date(t).toISOString() : ""; };
const known = new Set(STAGES);

console.log(APPLY ? "Seed Stage Transitions from Call Log"
                  : "Seed Stage Transitions from Call Log — DRY RUN, nothing will be written");
console.log(`base ${BASE}\n`);

const [calls, contacts, existing] = await Promise.all([
  /* Tolerant of a missing column for the same reason the repair script is:
     this runs on bases that are behind, by definition. */
  listTolerant(at, "Call Log", { fields: ["Called At", "Stage Set", "Owner", "Contact"],
                                 pageSize: 100, maxPages: 400 }),
  listTolerant(at, "Contacts", { fields: ["Kylas Contact ID", "Name"], pageSize: 100, maxPages: 400 }),
  listTolerant(at, "Stage Transitions", { fields: ["Key"], pageSize: 100, maxPages: 400 }).catch(() => []),
]);

const kidOf = new Map(contacts.map((r) => [r.id, String(r.fields?.["Kylas Contact ID"] || "")]));
const nameOf = new Map(contacts.map((r) => [r.id, r.fields?.Name || ""]));
const have = new Set(existing.map((r) => String(r.fields?.Key || "")));

console.log(`${calls.length} call(s), ${contacts.length} contact(s), ${existing.length} transition(s) already`);

/* Group calls by the contact they hang off. */
const byContact = new Map();
let orphan = 0, stageless = 0;
for (const r of calls) {
  const who = (r.fields?.Contact || [])[0];
  if (!who) { orphan++; continue; }
  const stage = r.fields?.["Stage Set"] || "";
  if (!stage || !known.has(stage)) { stageless++; continue; }
  const when = iso(r.fields?.["Called At"]);
  if (!when) { stageless++; continue; }
  if (!byContact.has(who)) byContact.set(who, []);
  byContact.get(who).push({ when, stage, owner: r.fields?.Owner || "" });
}
if (orphan) console.log(`  ${orphan} call(s) not linked to a contact — skipped`);
if (stageless) console.log(`  ${stageless} call(s) with no usable stage or date — skipped`);

/* Walk each contact's calls in order; a change of Stage Set is a transition. */
const rows = [];
let unchanged = 0, firsts = 0;
for (const [who, list] of byContact) {
  const kid = kidOf.get(who);
  if (!kid) continue;                       /* cannot key it without the id */
  list.sort((a, b) => a.when.localeCompare(b.when));
  let prev = "";
  for (const c of list) {
    if (c.stage === prev) { unchanged++; continue; }
    if (!prev) firsts++;
    rows.push({
      Key: `${kid}-${c.when}`,
      "From Stage": prev,
      "To Stage": c.stage,
      "Changed At": c.when,
      Owner: c.owner,
      Source: "Backfill",
      Contact: [who],
      _new: !have.has(`${kid}-${c.when}`),
      _who: nameOf.get(who) || kid,
    });
    prev = c.stage;
  }
}

const fresh = rows.filter((r) => r._new);
console.log(`\n  ${rows.length} transition(s) derived across ${byContact.size} contact(s)`);
console.log(`     ${firsts} first observation(s), written with an empty From Stage`);
console.log(`     ${unchanged} call(s) left the stage where it was — not a transition`);
console.log(`     ${fresh.length} NOT already in the table`);

if (!fresh.length) {
  console.log("\nNothing to add. The transitions already cover every stage change in the call log.");
  process.exit(0);
}

for (const r of fresh.slice(0, 10))
  console.log(`    ${r._who} — ${r["From Stage"] || "(first seen)"} -> ${r["To Stage"]} @ ${r["Changed At"].slice(0, 10)}`);
if (fresh.length > 10) console.log(`    ... and ${fresh.length - 10} more`);

if (!APPLY) {
  console.log("\nNothing was changed. Re-run with --apply.");
  process.exit(0);
}

/* ONLY THE NEW ONES. Upserting every derived row would be harmless for the
   data — the key matches, so nothing duplicates — but it would rewrite Source
   on rows the console itself wrote, turning "Console" into "Backfill" and
   losing the distinction between a stage an associate set on a call and one
   reconstructed afterwards. */
const payload = fresh.map(({ _new, _who, ...f }) => f);
await at.upsertMany("Stage Transitions", "Key", payload);
console.log(`\nwrote ${payload.length} new transition(s); ` +
            `${rows.length - payload.length} were already recorded and were left alone.`);

try {
  await at.upsert("Schema Migrations", "Key", {
    Key: "seed-transitions-2026-09-19-from-call-log",
    "Applied At": new Date().toISOString(),
    Note: `Derived ${rows.length} transitions from ${calls.length} call log rows ` +
          `across ${byContact.size} contacts; wrote ${payload.length} new.`,
  });
} catch (e) {
  console.log(`  (could not record the migration: ${e.message.slice(0, 80)})`);
}

console.log("\nNow run: node scripts/migrate-ever-picked.mjs");
