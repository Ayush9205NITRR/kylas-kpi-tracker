#!/usr/bin/env node
/* T3: do the SQL views produce the numbers Airtable produces?
 *
 *   node --env-file=.env.local scripts/verify-kpis.mjs --db db/kpi.sqlite
 *   node --env-file=.env.local scripts/verify-kpis.mjs --db db/kpi.sqlite --json
 *
 * Read-only on both sides. Airtable computes its rollups and formulas and
 * hands the results back with the record, so they can be compared directly
 * against the views rather than against a re-implementation of them.
 *
 * WHY THIS IS THE TEST THAT MATTERS. A missing row fails loudly and a missing
 * field fails loudly. A rollup that reads slightly differently does not: one
 * company sits one rung lower than it should, nothing on screen looks broken,
 * and the BD works the wrong account for a week. Run on every company, never
 * a sample.
 *
 * THREE KINDS OF DIFFERENCE ARE NOT DIFFERENCES, and each is handled rather
 * than tolerated, because a verifier that cries wolf gets ignored:
 *
 *   ORDER — Airtable's ARRAYJOIN follows link order, SQLite's group_concat
 *   follows whatever we tell it to. "Hema, Shipra" and "Shipra, Hema" are the
 *   same answer, so the name lists compare as sets.
 *
 *   PRECISION — a rollup sum arrives as 120 or 120.0.
 *
 *   BLANK — Airtable omits an empty formula result; the view returns '' or 0.
 *   Those mean the same thing and are compared as such, per field type.
 */
import { DatabaseSync } from "node:sqlite";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { columnName } from "./sql-schema.mjs";
import { FOLLOWUPS } from "./schema.mjs";
import { VIEW_FOR } from "./sql-derived.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DB = arg("--db", "db/kpi.sqlite");
const JSON_OUT = process.argv.includes("--json");
const SAMPLE = Number(arg("--sample", "8"));
const PAT = process.env.AIRTABLE_PAT, BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("verify-kpis needs AIRTABLE_PAT and AIRTABLE_BASE"); process.exit(1); }

const at = createAirtable(PAT, BASE, { log: () => {},
  ...(process.env.AIRTABLE_BASE_URL ? { apiUrl: process.env.AIRTABLE_BASE_URL } : {}) });
const db = new DatabaseSync(DB, { readOnly: true });

/* Which derived fields to check, per table, read from the schema rather than
   listed here — a rollup added later is checked without anyone remembering. */
const derivedOf = (table) => FOLLOWUPS
  .filter((f) => f.table === table && f.field && f.field.type !== "multipleRecordLinks")
  .map((f) => f.field.name);

/* Fields whose ORDER is not part of the answer. */
const SET_FIELDS = new Set(["Right POC Contacts", "Discovery Contacts"]);
/* Fields Airtable computes from a moment we do not store to the same
   precision. KPI Stage At is derived from a score whose low half is whole
   seconds, so a sub-second difference is arithmetic, not drift. */
const INSTANT_FIELDS = new Set(["KPI Stage At", "Last Call At", "First Call At",
  "First Worked At", "First Picked At", "Last Stage Change At", "First Stage Change At"]);

const blank = (v) => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0);

function agrees(field, airtableRaw, sqlValue) {
  /* A rollup can arrive wrapped in an array. */
  const a = Array.isArray(airtableRaw) && airtableRaw.length <= 1 ? airtableRaw[0] : airtableRaw;
  if (blank(a) && (blank(sqlValue) || sqlValue === 0)) return true;
  if (blank(a) || blank(sqlValue)) return false;
  if (SET_FIELDS.has(field)) {
    const parts = (x) => String(x).split(",").map((s) => s.trim()).filter(Boolean).sort().join("|");
    return parts(a) === parts(sqlValue);
  }
  if (INSTANT_FIELDS.has(field)) {
    const ta = Date.parse(String(a)), ts = Date.parse(String(sqlValue));
    if (Number.isFinite(ta) && Number.isFinite(ts)) return Math.abs(ta - ts) < 1000;
  }
  const na = Number(a), ns = Number(sqlValue);
  if (Number.isFinite(na) && Number.isFinite(ns)) return Math.abs(na - ns) < 1e-6;
  return String(a) === String(sqlValue);
}

const report = [];
for (const [table, view] of Object.entries(VIEW_FOR)) {
  const fields = derivedOf(table);
  let recs;
  try { recs = await listTolerant(at, table, { pageSize: 100, maxPages: 5000, throwIfMore: true }); }
  catch (e) { report.push({ table, error: e.message.slice(0, 160) }); continue; }
  let rows;
  try { rows = db.prepare(`SELECT * FROM "${view}"`).all(); }
  catch (e) { report.push({ table, error: `no view "${view}" — ${e.message.slice(0, 80)}` }); continue; }

  const byId = new Map(rows.map((r) => [r.airtable_id, r]));
  const perField = Object.fromEntries(fields.map((f) => [f, 0]));
  const examples = [];
  let checked = 0, notInCopy = 0;

  for (const rec of recs) {
    const row = byId.get(rec.id);
    if (!row) { notInCopy++; continue; }
    checked++;
    const bad = [];
    for (const f of fields) {
      const col = columnName(f);
      if (!(col in row)) continue;          /* covered by test-sql-derived */
      if (!agrees(f, rec.fields?.[f], row[col])) {
        perField[f]++;
        bad.push(`${f}: airtable=${JSON.stringify(rec.fields?.[f])} sql=${JSON.stringify(row[col])}`);
      }
    }
    if (bad.length && examples.length < SAMPLE)
      examples.push({ key: rec.fields?.Name || rec.id, bad });
  }
  const differing = Object.values(perField).reduce((a, b) => a + b, 0);
  report.push({ table, view, checked, notInCopy, differing,
                byField: Object.fromEntries(Object.entries(perField).filter(([, n]) => n)),
                examples });
}
db.close();

const bad = report.filter((r) => r.error || r.differing || r.notInCopy);
if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), clean: bad.length === 0, report }, null, 2));
} else {
  for (const r of report) {
    if (r.error) { console.log(`\n  ${r.table}: ${r.error}`); continue; }
    console.log(`\n  ${r.table} → ${r.view}`);
    console.log(`    ${r.checked} row(s) checked` +
      (r.notInCopy ? `, ${r.notInCopy} not in the copy (run the backfill)` : "") +
      `, ${r.differing} field value(s) disagree`);
    for (const [f, n] of Object.entries(r.byField)) console.log(`      ${f}: ${n}`);
    for (const e of r.examples) console.log(`      ${e.key} — ${e.bad.join(" · ")}`);
  }
  console.log(bad.length ? `\nThe KPI numbers do NOT match.` : `\nEvery KPI number matches Airtable.`);
}
process.exit(bad.length ? 1 : 0);
