#!/usr/bin/env node
/* Migrates stored data onto the current ladder.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/migrate-ladder.mjs
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/migrate-ladder.mjs --apply
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY A FORMULA UPDATE IS NOT ENOUGH. Retiring "Reschedule Pending" renumbered
 * the funnel from 24 rungs to 23: everything that sat above it moved down one.
 * `repair-base.mjs --update-formulas` fixes the LABEL formulas, but the rank
 * NUMBERS stored on every contact are still on the old numbering, so:
 *
 *   a stored 22 used to mean Closing Loops - Low Value.  It now reads as
 *     Discovery Call Done - Awaiting Client Inputs.
 *   a stored 24 used to mean SQL.  There is no rung 24 any more, so the label
 *     formula falls through to its base case and reads as rung 1.
 *
 * And the one that actually costs money: a contact still sitting on rank 21
 * (Reschedule Pending) now reads as Closing Loops - Low Value, which is the
 * SQL Meeting Done floor. Left alone, every one of those contacts silently
 * claims a meeting that never happened.
 *
 * ORDER MATTERS. Run this and the formula update together — either first is
 * fine, but between them the labels are wrong. The whole sequence:
 *
 *   node scripts/verify-base.mjs                        see what differs
 *   node scripts/repair-base.mjs                        add missing fields
 *   node scripts/repair-base.mjs --update-formulas      fix the label formulas
 *   node scripts/migrate-ladder.mjs                     read the plan
 *   node scripts/migrate-ladder.mjs --apply             write it
 *   node scripts/verify-base.mjs                        confirm
 */
import { createAirtable } from "./airtable.mjs";
import { RANK_REMAP, CODE_REMAP, RETIRED, STAGE_RUNG, STAGE_LABEL } from "./stages.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");
  process.exit(1);
}

/* One key per migration. Derived from what is being migrated, so adding a
   second retirement later produces a different key and runs again — while
   re-running this one does not. */
const KEY = `ladder-${RETIRED.map((r) => `${r.removedOn}-${r.code}`).join("+") || "none"}`;

const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });

if (!Object.keys(RANK_REMAP).length && !Object.keys(CODE_REMAP).length) {
  console.log("Nothing to migrate — no stage has been retired since this base was built.");
  process.exit(0);
}

console.log(`Migration ${KEY}`);
for (const r of RETIRED)
  console.log(`  ${r.code} (was rung ${r.wasRung}) -> ${r.mapTo} (rung ${STAGE_RUNG[r.mapTo]})`);
console.log(`  stored rank remap: ${Object.entries(RANK_REMAP).map(([a, b]) => `${a}→${b}`).join("  ")}`);
console.log();

/* ── has it already run? ───────────────────────────────────────────── */
let done = null;
try {
  done = await at.find("Schema Migrations", `{Key} = '${KEY}'`);
} catch (e) {
  console.error(`Could not read the Schema Migrations table: ${e.message}`);
  console.error(`It is part of the schema — run repair-base.mjs (or create-base.mjs on a new base)`);
  console.error(`to add it. This script will not migrate without somewhere to record that it did:`);
  console.error(`running the remap twice would turn a rank of 22 into 20 and nothing would say so.`);
  process.exit(1);
}
if (done) {
  console.log(`Already applied ${done.fields["Applied At"] || ""}.`);
  console.log(done.fields.Note ? `  ${done.fields.Note}` : "");
  console.log(`\nDoing it again would move every rank down a second time. Nothing written.`);
  console.log(`If you are certain it needs repeating, delete that row from Schema Migrations first.`);
  process.exit(0);
}

/* ── the plan ──────────────────────────────────────────────────────── */
/* Every place a stage code or a rank number is STORED. Formulas and rollups
   recompute themselves and are not listed; Companies.KPI Rank is derived from
   Contacts.KPI Score, so fixing Contacts fixes Companies. */
const STAGE_FIELDS = [
  ["Contacts", "Current Stage"],
  ["Contacts", "Previous Stage"],
  ["Contacts", "Exit Reason"],
  ["Call Log", "Stage Set"],
  ["Stage Transitions", "From Stage"],
  ["Stage Transitions", "To Stage"],
];

const plan = [];          /* { table, id, label, changes: {field: [from, to]} } */

/* Contacts carry the rank as well as the codes. */
const contacts = await at.listAll("Contacts", {
  fields: ["Kylas Contact ID", "Name", "KPI Rank", "Current Stage", "Previous Stage", "Exit Reason"],
});
for (const r of contacts) {
  const f = r.fields || {};
  const changes = {};
  const rank = Number(f["KPI Rank"] ?? 0);
  if (rank && RANK_REMAP[String(rank)] !== undefined) changes["KPI Rank"] = [rank, RANK_REMAP[String(rank)]];
  for (const key of ["Current Stage", "Previous Stage", "Exit Reason"]) {
    const v = f[key];
    if (v && CODE_REMAP[v]) changes[key] = [v, CODE_REMAP[v]];
  }
  if (Object.keys(changes).length)
    plan.push({ table: "Contacts", id: r.id, label: f.Name || f["Kylas Contact ID"] || r.id, changes });
}

/* The other tables carry codes only. */
for (const [table, field] of STAGE_FIELDS) {
  if (table === "Contacts") continue;                 /* done above, in one pass */
  const rows = await at.listAll(table, { fields: [field] }).catch((e) => {
    console.error(`  could not read ${table}.${field}: ${e.message}`);
    return null;
  });
  if (rows === null) { process.exitCode = 1; continue; }
  for (const r of rows) {
    const v = (r.fields || {})[field];
    if (v && CODE_REMAP[v])
      plan.push({ table, id: r.id, label: r.id, changes: { [field]: [v, CODE_REMAP[v]] } });
  }
}

if (!plan.length) {
  console.log(`Nothing stored is on the old ladder — ${contacts.length} contact(s) checked.`);
  if (APPLY) {
    await at.upsert("Schema Migrations", "Key", {
      Key: KEY, "Applied At": new Date().toISOString(),
      Note: `Nothing to change; ${contacts.length} contact(s) checked. Recorded so it is not re-run.`,
    });
    console.log(`Recorded in Schema Migrations so this is not asked again.`);
  } else {
    console.log(`Run with --apply to record that, so the check is not repeated.`);
  }
  process.exit(0);
}

/* ── report ────────────────────────────────────────────────────────── */
const byTable = {};
for (const p of plan) byTable[p.table] = (byTable[p.table] || 0) + 1;
console.log(`${plan.length} row(s) to change: ` +
  Object.entries(byTable).map(([t, n]) => `${n} in ${t}`).join(", "));
console.log();

/* Rank moves summarised, because 200 identical lines is not a report. */
const rankMoves = {};
for (const p of plan) {
  const m = p.changes["KPI Rank"];
  if (m) rankMoves[`${m[0]} → ${m[1]}`] = (rankMoves[`${m[0]} → ${m[1]}`] || 0) + 1;
}
if (Object.keys(rankMoves).length) {
  console.log("KPI Rank:");
  for (const [move, n] of Object.entries(rankMoves).sort()) {
    const to = Number(move.split(" → ")[1]);
    const label = Object.entries(STAGE_RUNG).find(([, r]) => r === to)?.[0];
    console.log(`  ${String(n).padStart(4)} contact(s)  ${move}   (${STAGE_LABEL[label] || "?"})`);
  }
  console.log();
}

const codeMoves = {};
for (const p of plan)
  for (const [field, [from, to]] of Object.entries(p.changes))
    if (field !== "KPI Rank") codeMoves[`${p.table}.${field}: ${from} → ${to}`] =
      (codeMoves[`${p.table}.${field}: ${from} → ${to}`] || 0) + 1;
if (Object.keys(codeMoves).length) {
  console.log("Stage values:");
  for (const [move, n] of Object.entries(codeMoves).sort())
    console.log(`  ${String(n).padStart(4)} row(s)  ${move}`);
  console.log();
}

/* The first few in full, so the shape of the change is visible rather than
   only its count. */
console.log("First few rows:");
for (const p of plan.slice(0, 5))
  console.log(`  ${p.table.padEnd(18)} ${String(p.label).slice(0, 28).padEnd(28)} ` +
    Object.entries(p.changes).map(([f, [a, b]]) => `${f} ${a}→${b}`).join(", "));
if (plan.length > 5) console.log(`  … and ${plan.length - 5} more`);

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply.`);
  process.exit(0);
}

/* ── write ─────────────────────────────────────────────────────────── */
console.log();
let wrote = 0, failed = 0;
for (const p of plan) {
  const fields = Object.fromEntries(Object.entries(p.changes).map(([f, [, to]]) => [f, to]));
  try {
    await at.call("PATCH", `/${encodeURIComponent(p.table)}`,
                  { records: [{ id: p.id, fields }], typecast: true });
    wrote++;
    if (wrote % 25 === 0) console.log(`  ${wrote}/${plan.length}…`);
  } catch (e) {
    failed++;
    console.error(`  ! ${p.table} ${p.label}: ${e.message}`);
  }
}
console.log(`\n${wrote} row(s) updated${failed ? `, ${failed} failed` : ""}.`);

/* Record it even on a partial run, with the numbers, so a second attempt is a
   deliberate act rather than an accident. A partial run recorded is safer than
   a partial run forgotten: re-running blind would move the already-migrated
   rows a second time. */
await at.upsert("Schema Migrations", "Key", {
  Key: KEY,
  "Applied At": new Date().toISOString(),
  Note: `${wrote} of ${plan.length} row(s) migrated` + (failed ? `, ${failed} FAILED` : "") +
    `. Rank remap ${Object.entries(RANK_REMAP).map(([a, b]) => `${a}->${b}`).join(" ")}` +
    `; ${RETIRED.map((r) => `${r.code}->${r.mapTo}`).join(", ")}.` +
    (failed ? " Re-running is blocked: delete this row only after checking which rows are still stale."
            : ""),
});
console.log(`Recorded in Schema Migrations.`);
if (failed) process.exit(1);
console.log(`\nRun verify-base.mjs to confirm, and check a contact that was at SQL.`);
