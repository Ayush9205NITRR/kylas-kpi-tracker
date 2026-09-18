#!/usr/bin/env node
/* Reads a live base and compares it against schema.mjs.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/verify-base.mjs
 *
 * Answers the only question that matters after a build: is the base actually
 * what the schema says. Read-only — it changes nothing, so it is safe to run
 * as often as you like.
 *
 * IT USED TO CHECK NAMES AND TYPES ONLY, and that is how the ladder went
 * wrong: retiring "Reschedule Pending" renumbered the funnel from 24 rungs to
 * 23, the live base kept the old 24-rung formula in Contacts.KPI Stage and
 * Companies.KPI Stage, and this script printed a clean ✓ for weeks. A field
 * with the right name and the right type can still be the wrong field. The
 * comparison now lives in schema-diff.mjs and includes the formula text, the
 * rollup aggregation and every select's choices.
 */
import { diffBase, manualCount, cleanExceptExtras } from "./schema-diff.mjs";

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");
  process.exit(1);
}

const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
  headers: { Authorization: `Bearer ${PAT}` },
});
if (!res.ok) {
  console.error(`GET tables -> ${res.status}\n${await res.text()}`);
  process.exit(1);
}
const tables = (await res.json()).tables;
const d = diffBase(tables);

/* ── per table ─────────────────────────────────────────────────────── */
const at = (list, table) => list.filter((x) => x.table === table);
const names = [...new Set([...d.missingFields, ...d.wrongType, ...d.formulaDrift,
                           ...d.rollupDrift, ...d.choiceDrift, ...d.extra]
  .map((x) => x.table))];
const allTables = [...new Set(tables.map((t) => t.name).concat(names))].sort();
const short = (s, n = 68) => (s.length > n ? s.slice(0, n) + "…" : s);

for (const name of allTables) {
  if (d.missingTables.includes(name)) { console.log(`MISSING TABLE  ${name}`); continue; }
  const miss = at(d.missingFields, name);
  const wrong = at(d.wrongType, name);
  const fdrift = at(d.formulaDrift, name);
  const rdrift = at(d.rollupDrift, name);
  const cdrift = at(d.choiceDrift, name);
  const extra = at(d.extra, name);
  const live = tables.find((t) => t.name === name);
  if (!live) continue;
  /* Neither rollupUnreadable nor choice differences count as faults — see
     schema-diff.mjs. A tick here means "nothing a script should act on". */
  const problems = miss.length + wrong.length + fdrift.length + rdrift.length;

  console.log(`${problems ? "✗" : "✓"} ${name.padEnd(19)} ${live.fields.length} field(s)`);
  miss.forEach((m) => console.log(`     missing   ${m.field.name}  (${m.field.type})`));
  wrong.forEach((w) => console.log(`     type      ${w.field} is ${w.was}, schema says ${w.want}`));
  /* The old and the new, both printed. "Drifted" on its own is not actionable;
     seeing that the base says rung 24 and the schema says 23 is. */
  fdrift.forEach((f) => {
    console.log(`     FORMULA   ${f.field}`);
    console.log(`       base    ${short(f.was)}`);
    console.log(`       schema  ${short(f.want)}`);
  });
  rdrift.forEach((f) => {
    console.log(`     ROLLUP    ${f.field}`);
    console.log(`       base    ${short(f.was)}`);
    console.log(`       schema  ${short(f.want)}`);
  });
  /* Counted, not listed, and explicitly not a fault: the meta API does not
     report a rollup's aggregation on this account, so we cannot check it. An
     earlier version printed all of them as "drifted" on the strength of a
     field the API never sent. */
  const unread = at(d.rollupUnreadable, name);
  if (unread.length)
    console.log(`     rollups   ${unread.length} not checked — Airtable does not report ` +
                `their aggregation (not a fault)`);
  /* Counted, with a couple of examples. Printing 23 stage codes per field
     filled the screen with something that is not a fault — every write uses
     typecast, so Airtable adds a choice the first time a record needs it. */
  cdrift.forEach((c) => {
    const some = (list) => list.slice(0, 3).join(", ") + (list.length > 3 ? `, +${list.length - 3} more` : "");
    console.log(`     choices   ${c.field}: ` +
      [c.absent.length ? `${c.absent.length} unused (${some(c.absent)})` : "",
       c.surplus.length ? `${c.surplus.length} from before this schema (${some(c.surplus)})` : ""]
        .filter(Boolean).join("; ") + "  (not a fault)");
  });
  if (extra.length) console.log(`     extra     ${extra.map((x) => x.field).join(", ")}  (harmless)`);
}

d.missingReverse.forEach((r) =>
  console.log(`MISSING LINK   ${r.table}.${r.name} — the reverse half of a link the rollups read through`));

/* ── the verdict ───────────────────────────────────────────────────── */
console.log();
if (cleanExceptExtras(d)) {
  console.log(`Everything in the schema is present, correctly typed, and matches — ` +
              `${d.checked} field(s) compared including every formula, rollup and choice list.`);
  process.exit(0);
}

if (d.choiceDrift.length || d.rollupUnreadable.length)
  console.log(`\nNot faults: ${d.choiceDrift.length} select(s) whose choice list differs ` +
              `(typecast adds one on first use), ${d.rollupUnreadable.length} rollup(s) whose ` +
              `aggregation Airtable does not report.`);

const lines = [];
if (d.missingTables.length) lines.push(`${d.missingTables.length} table(s) missing`);
if (d.missingFields.length) lines.push(`${d.missingFields.length} field(s) missing`);
if (d.wrongType.length) lines.push(`${d.wrongType.length} of the wrong type`);
if (d.formulaDrift.length) lines.push(`${d.formulaDrift.length} formula(s) drifted`);
if (d.rollupDrift.length) lines.push(`${d.rollupDrift.length} rollup(s) drifted`);

if (d.missingReverse.length) lines.push(`${d.missingReverse.length} reverse link(s) missing`);
console.log(lines.join(", ") + ".");

/* What to run, rather than "fix by hand". */
if (d.missingFields.length) console.log(`  repair-base.mjs                   adds the missing fields`);
if (d.formulaDrift.length) console.log(`  repair-base.mjs --update-formulas  rewrites the drifted formulas`);
if (d.formulaDrift.some((f) => /KPI Stage/.test(f.field)))
  console.log(`  migrate-ladder.mjs                 then migrate the stored ranks — a formula\n` +
              `                                     change alone leaves old rank values meaning\n` +
              `                                     the wrong stage`);
if (manualCount(d) - d.missingTables.length > 0)
  console.log(`  the Airtable UI                    for rollups, choices and wrong types: the\n` +
              `                                     update endpoint takes only options.formula`);
if (d.missingTables.length)
  console.log(`  create-base.mjs                    for the missing tables (it refuses if any exist)`);
process.exit(1);
