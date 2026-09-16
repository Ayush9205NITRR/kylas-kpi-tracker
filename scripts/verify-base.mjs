#!/usr/bin/env node
/* Reads a live base and compares it against schema.mjs.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/verify-base.mjs
 *
 * Answers the only question that matters after a build: did every table and
 * every field actually land, with the right type. Read-only — it changes
 * nothing, so it is safe to run as often as you like.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");
  process.exit(1);
}

/* ── what the schema says should be there ──────────────────────────── */
const expected = new Map();   // table -> Map(field -> type)
for (const t of TABLES) expected.set(t.name, new Map(t.fields.map((f) => [f.name, f.type])));
for (const { table, field, reverse } of FOLLOWUPS) {
  expected.get(table).set(field.name, field.type);
  if (field.type === "multipleRecordLinks" && reverse)
    expected.get(field.options.linkedTable).set(reverse, "multipleRecordLinks");
}

/* ── what is actually there ────────────────────────────────────────── */
const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
  headers: { Authorization: `Bearer ${PAT}` },
});
if (!res.ok) {
  console.error(`GET tables -> ${res.status}\n${await res.text()}`);
  process.exit(1);
}
const live = new Map((await res.json()).tables.map((t) => [t.name, t]));

/* ── compare ───────────────────────────────────────────────────────── */
let missingTables = 0, missingFields = 0, wrongType = 0;
const extraTables = [...live.keys()].filter((n) => !expected.has(n));

for (const [tname, fields] of expected) {
  const t = live.get(tname);
  if (!t) { console.log(`MISSING TABLE  ${tname}`); missingTables++; continue; }

  const got = new Map(t.fields.map((f) => [f.name, f.type]));
  const miss = [], wrong = [];
  for (const [fname, ftype] of fields) {
    if (!got.has(fname)) miss.push(fname);
    else if (got.get(fname) !== ftype) wrong.push(`${fname} is ${got.get(fname)}, expected ${ftype}`);
  }
  missingFields += miss.length;
  wrongType += wrong.length;

  const ok = fields.size - miss.length - wrong.length;
  console.log(`${miss.length || wrong.length ? "✗" : "✓"} ${tname.padEnd(19)} ${String(ok).padStart(2)}/${fields.size} fields`);
  miss.forEach((m) => console.log(`     missing   ${m}`));
  wrong.forEach((w) => console.log(`     wrong     ${w}`));

  const extra = [...got.keys()].filter((n) => !fields.has(n));
  if (extra.length) console.log(`     extra     ${extra.join(", ")}  (harmless)`);
}

if (extraTables.length) console.log(`\nAlso in the base, not from this schema: ${extraTables.join(", ")}`);

const bad = missingTables + missingFields + wrongType;
console.log(bad
  ? `\n${missingTables} table(s), ${missingFields} field(s) missing, ${wrongType} of the wrong type.\n` +
    `Re-running create-base.mjs will refuse, since the tables exist. Fix by hand, or delete the tables and re-run.`
  : `\nEverything in the schema is present and correctly typed.`);
process.exit(bad ? 1 : 0);
