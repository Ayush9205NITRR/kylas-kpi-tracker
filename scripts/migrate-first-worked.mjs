#!/usr/bin/env node
/* Backfills First Worked At and First Picked At on contacts written before
 * those columns existed.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/migrate-first-worked.mjs
 *   ... node scripts/migrate-first-worked.mjs --apply
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY
 * The funnel's bottom two rungs — "Companies worked" and "Companies picked" —
 * are counted from Companies.First Worked At / First Picked At, which are MIN
 * rollups of these two contact fields. The writer only started setting them
 * recently, and it sets them ONCE, on a save: a contact that has not been
 * called since therefore has no date, for ever.
 *
 * That is the "mismatch" Ayush reported: the ladder showed Companies worked 0
 * sitting under Right POC 2. The upper rungs are derived from KPI Rank At and
 * the Is Right POC / Is Discovery formulas, which have been written all along,
 * so they had real numbers while the two rungs beneath them read zero. A funnel
 * that is empty at the bottom and full at the top is not a funnel; it reads as
 * a bug because it is one.
 *
 * WHAT IT DERIVES THEM FROM, in order:
 *
 *   First Worked At   First Call At          the MIN of this contact's Call Log
 *                     First Stage Change At  the MIN of its Stage Transitions
 *                     KPI Rank At            when its rung last rose
 *                     Last Call At           a call happened, this is all we kept
 *
 *   First Picked At   earliest transition INTO a stage that is not a no-answer
 *                     KPI Rank At
 *                     whatever First Worked At ended up being
 *
 * The earliest of the available candidates wins, because every one of them is
 * evidence the contact had been worked BY then — so the earliest is the
 * tightest true bound.
 *
 * THESE ARE FLOORS, NOT THE TRUTH, and the difference is worth stating.
 * rollup-calls.mjs deletes raw Call Log rows past the retention window, so
 * First Call At on an old contact is the first call that SURVIVES, not the
 * first that happened. A backfilled date can therefore be later than reality —
 * never earlier. That is the safe direction: a company counted into a later
 * period is a period boundary being wrong, a company counted into an earlier
 * one would rewrite a month that has already been reported.
 *
 * NEVER OVERWRITES. Both fields are write-once by design — a later save moving
 * them would move a company between periods retrospectively. So this fills
 * blanks only, which also makes it safe to run twice: the second run finds
 * nothing.
 *
 * PICKED IS NOT INVENTED. It is written only where Ever Picked is already true,
 * and that flag is the repaired, monotonic one — run migrate-ever-picked.mjs
 * FIRST or this will carry its old meaning ("was ever dialled") into a date
 * that claims somebody answered.
 */
/* Loads .env.local if it is there, so nothing needs sourcing first. Must come
   before any import that reads process.env at module scope. */
import "./env.mjs";
import { requireEnv } from "./env.mjs";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { NOT_CONNECTED } from "./stages.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
requireEnv("AIRTABLE_PAT", "AIRTABLE_BASE");

const KEY = "first-worked-2026-09-19-backfill";
const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });
const connected = (stage) => !!stage && !NOT_CONNECTED.includes(stage);

/* The earliest of whatever is present. Blanks, nulls and the empty string all
   drop out — an Airtable date field that was never written comes back missing,
   not as an epoch. */
const earliest = (...vals) => {
  const ok = vals.map((v) => (v ? String(v) : "")).filter(Boolean).sort();
  return ok[0] || "";
};

console.log(APPLY ? "First Worked / First Picked backfill"
                  : "First Worked / First Picked backfill — DRY RUN, nothing will be written");
console.log(`base ${BASE}\n`);

const FIELDS = ["Kylas Contact ID", "Name", "Owner", "Current Stage", "Previous Stage",
                "Ever Picked", "KPI Rank", "KPI Rank At",
                "First Call At", "Last Call At", "First Stage Change At",
                "First Worked At", "First Picked At"];

const [contacts, transitions] = await Promise.all([
  /* listTolerant, for the same reason migrate-ever-picked gives: this script
     exists to repair a base that is behind, and Airtable rejects a whole
     projection for one name the table does not have. */
  listTolerant(at, "Contacts", { fields: FIELDS, pageSize: 100, maxPages: 400 }),
  listTolerant(at, "Stage Transitions",
    { fields: ["To Stage", "Changed At", "Contact"], pageSize: 100, maxPages: 400 })
    .catch(() => []),
]);

/* A base that has never been repaired has neither column, and there is nothing
   this script can usefully do to it — writing would 422 on every batch. Say so
   once, plainly, rather than failing sixty times. */
const hasCol = (name) => contacts.some((r) => name in (r.fields || {}));
if (contacts.length && !hasCol("First Worked At") && !hasCol("First Picked At")) {
  console.log(`! no contact on this base carries First Worked At or First Picked At.`);
  console.log(`  Either the columns do not exist yet — run scripts/repair-base.mjs first —`);
  console.log(`  or no save has happened since they were added. Nothing to backfill from here.`);
  console.log(`  (This script fills blanks from history; it cannot create the columns.)`);
  if (!APPLY) process.exit(0);
}

/* Per contact: the first time anything was recorded, and the first time
   something was recorded that means they answered. */
const firstChange = new Map();     // record id -> earliest Changed At
const firstConnect = new Map();    // record id -> earliest Changed At into a connected stage
for (const t of transitions) {
  const who = (t.fields?.Contact || [])[0];
  const when = t.fields?.["Changed At"] || "";
  if (!who || !when) continue;
  if (!firstChange.has(who) || when < firstChange.get(who)) firstChange.set(who, when);
  if (connected(t.fields?.["To Stage"]))
    if (!firstConnect.has(who) || when < firstConnect.get(who)) firstConnect.set(who, when);
}

console.log(`${contacts.length} contact(s), ${transitions.length} stage transition(s)\n`);

const updates = [];
let hadWorked = 0, hadPicked = 0, noEvidence = 0, pickedNoDate = 0;

for (const r of contacts) {
  const f = r.fields || {};
  const fields = {};

  const worked = f["First Worked At"]
    || earliest(f["First Call At"], firstChange.get(r.id), f["KPI Rank At"], f["Last Call At"]);

  if (f["First Worked At"]) hadWorked++;
  else if (worked) fields["First Worked At"] = worked;
  else {
    /* No call, no transition, no rank date. This contact has genuinely never
       been worked — a row the nightly sync pulled from Kylas and nobody has
       dialled. Counting it as worked on a made-up date would put a company
       into the funnel that has never been touched. */
    noEvidence++;
  }

  if (f["First Picked At"]) hadPicked++;
  else if (f["Ever Picked"]) {
    /* Never earlier than the moment they were first worked: a contact cannot
       have answered before anybody called. KPI Rank At can predate the oldest
       SURVIVING call row once the rollup has compacted history, which would
       otherwise produce a company picked before it was worked — and the ladder
       would then show picked above worked, the very inversion this whole
       exercise is about. */
    const picked = earliest(firstConnect.get(r.id), f["KPI Rank At"]) || worked;
    const clamped = picked && worked && picked < worked ? worked : picked;
    if (clamped) fields["First Picked At"] = clamped;
    else pickedNoDate++;
  }

  if (Object.keys(fields).length)
    updates.push({ id: r.id, fields,
                   name: f.Name || f["Kylas Contact ID"] || r.id,
                   owner: f.Owner || "(no owner)" });
}

const w = updates.filter((u) => u.fields["First Worked At"]).length;
const p = updates.filter((u) => u.fields["First Picked At"]).length;

console.log(`  ${w} contact(s) get First Worked At`);
console.log(`  ${p} contact(s) get First Picked At`);
console.log(`  ${hadWorked} / ${hadPicked} already had one`);
console.log(`  ${noEvidence} never worked at all — no call, no transition, no rank date`);
if (pickedNoDate) console.log(`  ${pickedNoDate} marked Ever Picked with nothing to date it from`);

if (!updates.length) {
  console.log("\nNothing to backfill. The funnel's bottom two rungs are as complete as history allows.");
  process.exit(0);
}

console.log("");
for (const u of updates.slice(0, 12))
  console.log(`    ${u.name} — ${u.owner} — ` +
    Object.entries(u.fields).map(([k, v]) => `${k.replace("First ", "").replace(" At", "")} ${String(v).slice(0, 10)}`).join(", "));
if (updates.length > 12) console.log(`    ... and ${updates.length - 12} more`);

if (!APPLY) {
  console.log("\nNothing was changed. Re-run with --apply.");
  process.exit(0);
}

let done = 0;
for (let i = 0; i < updates.length; i += 10) {
  const batch = updates.slice(i, i + 10);
  try {
    await at.call("PATCH", `/${encodeURIComponent("Contacts")}`, {
      records: batch.map((u) => ({ id: u.id, fields: u.fields })), typecast: true });
  } catch (e) {
    if (/UNKNOWN_FIELD_NAME/.test(e.message)) {
      console.error(`\n! this base has no First Worked At / First Picked At column.`);
      console.error(`  Run scripts/repair-base.mjs against it, then run this again.`);
      console.error(`  ${done} contact(s) were updated before this point; re-running is safe.`);
      process.exit(1);
    }
    throw e;
  }
  done += batch.length;
}
console.log(`\nbackfilled ${done} contact(s).`);

/* Recorded so it is obvious later that this ran, and when. Not a guard — the
   backfill only fills blanks, so a second run is harmless and finds nothing. */
try {
  await at.upsert("Schema Migrations", "Key", {
    Key: KEY, "Applied At": new Date().toISOString(),
    Note: `Backfilled First Worked At on ${w} and First Picked At on ${p} contact(s) ` +
          `from call, transition and rank history. ${noEvidence} never worked. ` +
          `${transitions.length} transitions consulted.`,
  });
} catch (e) {
  console.log(`  (could not record the migration: ${e.message.slice(0, 80)})`);
}

console.log("Companies.First Worked At / First Picked At are MIN rollups of these,");
console.log("so the funnel's bottom two rungs correct themselves.");
