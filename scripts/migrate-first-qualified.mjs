#!/usr/bin/env node
/* Backfills First Right POC At and First Discovery At on contacts that
 * qualified before those columns existed.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/migrate-first-qualified.mjs
 *   ... node scripts/migrate-first-qualified.mjs --apply
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY
 * Ayush, 2026-09-21: "this account has 2 right POCs and 1 discovery call, but
 * the status hasn't been updated and these activities are not reflecting in
 * the KPI dashboard."
 *
 * They were not reflecting because they had no DATE. Is Right POC and
 * Is Discovery are Airtable formulas — they go true the moment an event row
 * carries budget, timeline or pax. Nothing moves in Kylas when somebody writes
 * down a budget, so there is no Stage Transition row, so the report takes them
 * as `signals` instead. A signal needs a timestamp to be placed in a week or a
 * month, and the only one available was KPI Rank At, which is stamped when the
 * numeric rank RISES.
 *
 * So: fill in a budget and a headcount, leave the stage on LinkedIn Outreach
 * Initiated, and the rank does not rise. Flag true, no date, signal dropped,
 * rung reads zero — with the contact card in the console plainly showing
 * "Right POC" the whole time. Two screens, one truth, opposite answers.
 *
 * The writer now stamps both fields on the save that latches the flag. This
 * backfills the contacts that qualified before it did.
 *
 * WHAT IT DERIVES THEM FROM, in order:
 *
 *   First Right POC At   KPI Rank At        what the proxy used to use: right
 *                                           whenever the stage moved on the
 *                                           same save, which is most old rows
 *                        First Picked At    they answered; they were a right
 *                                           POC no earlier than that
 *                        First Worked At    somebody called them by then
 *                        Last Call At       a call happened, this is all we kept
 *
 *   First Discovery At   the same chain, then clamped to be no earlier than
 *                        First Right POC At — discovery is a strict superset
 *                        of right POC (all three fields versus any one), so a
 *                        discovery dated before its own right POC would put
 *                        the ladder out of order.
 *
 * THESE ARE FLOORS, NOT THE TRUTH. Every candidate is evidence the contact had
 * qualified BY then, so the earliest available is the tightest true bound — and
 * a backfilled date can be later than reality, never earlier. That is the safe
 * direction: too late moves a company into a later period; too early rewrites a
 * month that has already been reported.
 *
 * NEVER OVERWRITES. Both fields are write-once by design, so this fills blanks
 * only and a second run finds nothing.
 *
 * NOTHING IS INVENTED. A date is written only where the base's own formula
 * already says the contact qualifies. This script does not decide who is a
 * right POC; it only dates the ones that are.
 */
/* Loads .env.local if it is there, so nothing needs sourcing first. Must come
   before any import that reads process.env at module scope. */
import "./env.mjs";
import { requireEnv } from "./env.mjs";
import { buildLine } from "./build.mjs";
import { createAirtable, listTolerant, columnsOf } from "./airtable.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
requireEnv("AIRTABLE_PAT", "AIRTABLE_BASE");

const KEY = "first-qualified-2026-09-21-backfill";
const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });

const earliest = (...vals) => {
  const ok = vals.map((v) => (v ? String(v) : "")).filter(Boolean).sort();
  return ok[0] || "";
};

console.log(APPLY ? "First Right POC / First Discovery backfill"
                  : "First Right POC / First Discovery backfill — DRY RUN, nothing will be written");
console.log(`base ${BASE}`);
/* WHICH COPY OF THIS REPO. A fix can be pushed, pulled into the wrong
   clone, and produce the old message verbatim — see build.mjs. */
console.log(`${buildLine()}\n`);

const FIELDS = ["Kylas Contact ID", "Name", "Owner", "Company",
                "Is Right POC", "Is Discovery", "Ever Right POC", "Ever Discovery",
                "KPI Rank At", "First Worked At", "First Picked At", "Last Call At",
                "First Right POC At", "First Discovery At"];

/* listTolerant for the reason the other migrations give: this script exists to
   repair a base that is behind, and Airtable rejects a whole projection over
   one name the table does not have. */
const contacts = await listTolerant(at, "Contacts",
  { fields: FIELDS, pageSize: 100, maxPages: 400 });

/* ASK THE SCHEMA, NOT THE ROWS. This guard used to be
   `contacts.some((r) => name in (r.fields || {}))`, and it was wrong in the one
   case it exists for. Airtable OMITS an empty field from a record entirely, so
   a column that has been created and never written appears in NO record —
   which is precisely the state of First Right POC At on a base that has just
   been repaired, right up until this script fills it. The guard therefore
   refused to run on exactly the base it was written for:

       ! no contact on this base carries First Right POC At or First Discovery At.
         The columns do not exist yet — run scripts/repair-base.mjs first

   reported by Ayush on 2026-09-22 after repair-base had already run.

   columnsOf() returns null when the PAT cannot read the schema, and null is
   NOT "missing": in that case this proceeds and lets the PATCH answer, which
   it does clearly with UNKNOWN_FIELD_NAME. */
const cols = await columnsOf(at, "Contacts");
const lacks = (name) => cols && !cols.has(name);
if (lacks("First Right POC At") && lacks("First Discovery At")) {
  console.log(`! this base has no First Right POC At or First Discovery At column.`);
  console.log(`  Run scripts/repair-base.mjs --apply first, then run this again.`);
  console.log(`  (This script fills blanks; it cannot create columns.)`);
  process.exit(APPLY ? 1 : 0);
}
if (lacks("Is Right POC")) {
  console.log(`! this base has no Is Right POC formula, so there is nothing to date.`);
  console.log(`  Run scripts/repair-base.mjs --update-formulas first.`);
  process.exit(APPLY ? 1 : 0);
}
if (!cols) console.log(`  (could not read the base schema — proceeding; a missing column will be named by the write)\n`);

console.log(`${contacts.length} contact(s)\n`);

const updates = [];
let hadRight = 0, hadDisc = 0, rightNoDate = 0, discNoDate = 0, notQualified = 0;

for (const r of contacts) {
  const f = r.fields || {};
  const fields = {};

  /* The base's own formulas decide who qualifies. Ever Right POC is OR'd in
     because it is the monotonic latch: a contact who qualified and whose rows
     were later cleared is still a contact who qualified, and Is Right POC
     already reads it — this is belt and braces for a base mid-repair where the
     formula has not been updated yet. */
  const isRight = !!f["Is Right POC"] || !!f["Ever Right POC"];
  const isDisc = !!f["Is Discovery"] || !!f["Ever Discovery"];
  if (!isRight && !isDisc) { notQualified++; continue; }

  const floor = earliest(f["KPI Rank At"], f["First Picked At"],
                         f["First Worked At"], f["Last Call At"]);

  let rightAt = f["First Right POC At"] || "";
  if (rightAt) hadRight++;
  else if (isRight) {
    if (floor) { fields["First Right POC At"] = floor; rightAt = floor; }
    else rightNoDate++;
  }

  if (f["First Discovery At"]) hadDisc++;
  else if (isDisc) {
    /* Never earlier than right POC. A complete row has all three fields, so it
       also has any one of them — discovery is contained in right POC by
       construction, and a ladder where discovery predates its own right POC is
       reporting an impossible order. */
    const disc = floor && rightAt && floor < rightAt ? rightAt : floor;
    if (disc) fields["First Discovery At"] = disc;
    else discNoDate++;
  }

  if (Object.keys(fields).length)
    updates.push({ id: r.id, fields,
                   name: f.Name || f["Kylas Contact ID"] || r.id,
                   owner: f.Owner || "(no owner)" });
}

const nr = updates.filter((u) => u.fields["First Right POC At"]).length;
const nd = updates.filter((u) => u.fields["First Discovery At"]).length;

console.log(`  ${nr} contact(s) get First Right POC At`);
console.log(`  ${nd} contact(s) get First Discovery At`);
console.log(`  ${hadRight} / ${hadDisc} already had one`);
console.log(`  ${notQualified} do not qualify for either rung`);
if (rightNoDate || discNoDate)
  console.log(`  ${rightNoDate + discNoDate} qualify with no date to derive from — ` +
              `no call, no rank date, nothing. These stay uncounted.`);

if (!updates.length) {
  console.log("\nNothing to backfill. Right POC and Discovery are as complete as history allows.");
  process.exit(0);
}

console.log("");
for (const u of updates.slice(0, 12))
  console.log(`    ${u.name} — ${u.owner} — ` +
    Object.entries(u.fields).map(([k, v]) =>
      `${k.replace("First ", "").replace(" At", "")} ${String(v).slice(0, 10)}`).join(", "));
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
      console.error(`\n! this base has no First Right POC At / First Discovery At column.`);
      console.error(`  Run scripts/repair-base.mjs against it, then run this again.`);
      console.error(`  ${done} contact(s) were updated before this point; re-running is safe.`);
      process.exit(1);
    }
    throw e;
  }
  done += batch.length;
}
console.log(`\nbackfilled ${done} contact(s).`);

try {
  await at.upsert("Schema Migrations", "Key", {
    Key: KEY, "Applied At": new Date().toISOString(),
    Note: `Backfilled First Right POC At on ${nr} and First Discovery At on ${nd} ` +
          `contact(s) from rank, picked and call history. ${notQualified} do not qualify.`,
  });
} catch (e) {
  console.log(`  (could not record the migration: ${e.message.slice(0, 80)})`);
}

console.log("The report dates the Right POC and Discovery rungs from these,");
console.log("so both correct themselves on the next /report read.");
