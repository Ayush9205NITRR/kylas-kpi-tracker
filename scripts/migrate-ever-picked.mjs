#!/usr/bin/env node
/* Clears Ever Picked on contacts that never actually picked up.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/migrate-ever-picked.mjs
 *   ... node scripts/migrate-ever-picked.mjs --apply
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY
 * syncContact used to set the flag whenever the stage's rung was above zero:
 *
 *   "Ever Picked": !!prev?.fields?.["Ever Picked"] || computed > 0
 *
 * Every stage has a rung above zero — Could Not Connect is 6 — so the flag went
 * true on the FIRST save of every contact, whether or not anybody answered.
 * Companies.Phone Picked is IF({Ever Picked} = 1, 1, 0), so that funnel rung has
 * been reading 1 for every company ever dialled, and the Reached -> Right POC
 * conversion rate was computed against it.
 *
 * The writer is fixed. This is for the rows written before that.
 *
 * WHY NOT JUST RECOMPUTE FROM THE CURRENT STAGE
 * Because the flag is deliberately MONOTONIC: someone who answered, was
 * qualified and then went to Could Not Connect on a later call still picked up,
 * and kpi-spec.md §4 warns about exactly that — reading Current Stage alone
 * would erase them. So this looks for EVIDENCE of a connect anywhere in the
 * record, and only clears the flag where there is none:
 *
 *   Current Stage      not in NOT_CONNECTED          -> they picked up
 *   Previous Stage     not in NOT_CONNECTED          -> they picked up
 *   Stage Transitions  any To Stage not NOT_CONNECTED-> they picked up
 *
 * KPI Rank is deliberately NOT used as evidence. It is a high-water MARK, not a
 * path: a contact that went MQL (14) then Followup CNC (15) carries rank 15,
 * and rung 15 is a CNC stage — reading the rank back would wrongly clear a
 * contact that genuinely answered. The transitions are the history; the rank is
 * a summary of it.
 *
 * ONLY EVER CLEARS. It never sets the flag true, because the old rule set it
 * for everything, so nothing can be wrongly false. That also makes this safe to
 * run twice: it is derived from evidence, not incremented.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { NOT_CONNECTED } from "./stages.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...)."); process.exit(1); }

const KEY = "ever-picked-2026-09-19-cnc-not-picked";
const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });
const connected = (stage) => !!stage && !NOT_CONNECTED.includes(stage);

console.log(APPLY ? "Ever Picked repair" : "Ever Picked repair — DRY RUN, nothing will be written");
console.log(`base ${BASE}\n`);

const [contacts, transitions] = await Promise.all([
  /* listTolerant: Airtable rejects a whole projection for one unknown name,
     and this script exists to repair a base that may be a repair-base behind —
     dying with a raw 422 on exactly the base it was written for would be a
     poor joke. It names the field and reads everything instead. */
  listTolerant(at, "Contacts", {
    fields: ["Kylas Contact ID", "Name", "Current Stage", "Previous Stage", "Ever Picked", "KPI Rank"],
    pageSize: 100, maxPages: 400,
  }),
  listTolerant(at, "Stage Transitions", { fields: ["To Stage", "Contact"], pageSize: 100, maxPages: 400 })
    .catch(() => []),
]);

/* Which contacts have a transition INTO a connected stage. */
const everConnected = new Set();
for (const t of transitions) {
  const who = (t.fields?.Contact || [])[0];
  if (who && connected(t.fields?.["To Stage"])) everConnected.add(who);
}

console.log(`${contacts.length} contact(s), ${transitions.length} stage transition(s)`);
if (!transitions.length)
  console.log("  ! no Stage Transitions rows — judging on Current and Previous Stage alone.\n" +
              "    That is weaker evidence: a contact who answered before the console\n" +
              "    started writing transitions, and has since gone back to CNC, will be\n" +
              "    cleared. Check a sample before --apply.");

const clear = [];
let kept = 0, already = 0;
for (const r of contacts) {
  const f = r.fields || {};
  if (!f["Ever Picked"]) { already++; continue; }
  const evidence =
    connected(f["Current Stage"]) ||
    connected(f["Previous Stage"]) ||
    everConnected.has(r.id);
  if (evidence) { kept++; continue; }
  clear.push({ id: r.id, name: f.Name || f["Kylas Contact ID"] || r.id,
               stage: f["Current Stage"] || "(none)" });
}

console.log(`\n  ${kept} keep the flag — evidence of a connect`);
console.log(`  ${already} already had it clear`);
console.log(`  ${clear.length} to CLEAR — no connect anywhere in the record`);

if (!clear.length) {
  console.log("\nNothing to repair. Phone Picked is already honest on this base.");
  process.exit(0);
}

for (const c of clear.slice(0, 10)) console.log(`    ${c.name} — ${c.stage}`);
if (clear.length > 10) console.log(`    ... and ${clear.length - 10} more`);

if (!APPLY) {
  console.log("\nNothing was changed. Re-run with --apply.");
  process.exit(0);
}

/* Airtable takes 10 records per update. */
let done = 0;
for (let i = 0; i < clear.length; i += 10) {
  const batch = clear.slice(i, i + 10);
  await at.call("PATCH", `/${encodeURIComponent("Contacts")}`, {
    records: batch.map((c) => ({ id: c.id, fields: { "Ever Picked": false } })),
  });
  done += batch.length;
}
console.log(`\ncleared ${done} contact(s).`);

/* Recorded so it is obvious later that this ran, and when. Not a guard — the
   repair is idempotent, so a second run is harmless and finds nothing. */
try {
  await at.upsert("Schema Migrations", "Key", {
    Key: KEY, "Applied At": new Date().toISOString(),
    Note: `Cleared Ever Picked on ${done} contact(s) with no evidence of a connect. ` +
          `${kept} kept, ${already} already clear, ${transitions.length} transitions consulted.`,
  });
} catch (e) {
  console.log(`  (could not record the migration: ${e.message.slice(0, 80)})`);
}

console.log("Companies.Phone Picked is a rollup of this, so it corrects itself.");
