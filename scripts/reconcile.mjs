#!/usr/bin/env node
/* GATE 1: does the SQL copy still say what Airtable says?
 *
 *   node --env-file=.env.local scripts/reconcile.mjs --db db/kpi.sqlite
 *   node --env-file=.env.local scripts/reconcile.mjs --db db/kpi.sqlite --json
 *
 * This is the instrument the whole migration is read through, so it is
 * written to be harder to fool than the thing it measures.
 *
 * WHAT IT REFUSES TO DO. It does not compare what it managed to fetch against
 * what it managed to fetch. Airtable pages, and a reader that stops early and
 * then reports agreement is comparing a prefix to a prefix — which is how a
 * month of numbers once turned out to be the first 4,000 calls. Every table
 * is read whole, and a read that hits the page ceiling is a failure, not a
 * result.
 *
 * Three questions per table, answered separately because they have different
 * causes: rows Airtable has and SQL does not (the copy is behind), rows SQL
 * has and Airtable does not (something was deleted, or written twice), and
 * rows both have that disagree (a field mapped wrongly).
 *
 * Exit code is 0 only when every table agrees, so this can be a cron that
 * pages you rather than a report somebody remembers to read.
 */
import { DatabaseSync } from "node:sqlite";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { tableName, columnName } from "./sql-schema.mjs";
import { BACKFILL_ORDER, diffRecord, naturalKeyOf } from "./sql-store.mjs";

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = arg("--db", "db/kpi.sqlite");
const ONLY = arg("--only");
const JSON_OUT = process.argv.includes("--json");
const SAMPLE = Number(arg("--sample", "5"));
const PAT = process.env.AIRTABLE_PAT, BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("reconcile needs AIRTABLE_PAT and AIRTABLE_BASE"); process.exit(1); }

const at = createAirtable(PAT, BASE, {
  log: () => {},
  ...(process.env.AIRTABLE_BASE_URL ? { apiUrl: process.env.AIRTABLE_BASE_URL } : {}),
});
const db = new DatabaseSync(DB, { readOnly: true });

const report = [];
for (const table of (ONLY ? [ONLY] : BACKFILL_ORDER)) {
  const tbl = tableName(table);
  let recs;
  try {
    recs = await listTolerant(at, table, { pageSize: 100, maxPages: 5000, throwIfMore: true });
  } catch (e) {
    report.push({ table, error: e.message.slice(0, 160) });
    continue;
  }
  let rows;
  try { rows = db.prepare(`SELECT * FROM "${tbl}"`).all(); }
  catch (e) { report.push({ table, error: `no table "${tbl}" — ${e.message.slice(0, 80)}` }); continue; }

  const byAirtableId = new Map(rows.map((r) => [r.airtable_id, r]));
  const seen = new Set();
  const missing = [], differing = [];
  const key = naturalKeyOf(table);
  const nameOf = (rec) => (key ? rec.fields?.[key] : null) || rec.id;

  for (const rec of recs) {
    const row = byAirtableId.get(rec.id);
    if (!row) { missing.push(nameOf(rec)); continue; }
    seen.add(rec.id);
    const fields = diffRecord(table, rec, row);
    if (fields.length) differing.push({ key: nameOf(rec), fields });
  }
  /* Rows on our side that Airtable no longer has. Until Gate 5 this should
     always be zero: Airtable is the source, and anything here that is not
     there came from a bug rather than from a deletion. */
  const extra = rows.filter((r) => !seen.has(r.airtable_id))
    .map((r) => (key ? r[columnName(key)] : null) || r.airtable_id);

  report.push({ table, airtable: recs.length, sql: rows.length,
                missing: missing.length, extra: extra.length, differing: differing.length,
                sampleMissing: missing.slice(0, SAMPLE),
                sampleExtra: extra.slice(0, SAMPLE),
                sampleDiffering: differing.slice(0, SAMPLE) });
}
db.close();

const bad = report.filter((r) => r.error || r.missing || r.extra || r.differing);

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), clean: bad.length === 0, report }, null, 2));
} else {
  console.log(`\n  ${"table".padEnd(18)} ${"airtable".padStart(9)} ${"sql".padStart(8)} ` +
              `${"missing".padStart(8)} ${"extra".padStart(6)} ${"differing".padStart(10)}`);
  console.log(`  ${"-".repeat(64)}`);
  for (const r of report) {
    if (r.error) { console.log(`  ${r.table.padEnd(18)} ${r.error}`); continue; }
    const flag = (r.missing || r.extra || r.differing) ? " <" : "";
    console.log(`  ${r.table.padEnd(18)} ${String(r.airtable).padStart(9)} ${String(r.sql).padStart(8)} ` +
      `${String(r.missing).padStart(8)} ${String(r.extra).padStart(6)} ${String(r.differing).padStart(10)}${flag}`);
  }
  for (const r of bad) {
    if (r.error) continue;
    console.log(`\n  ${r.table}:`);
    if (r.sampleMissing.length) console.log(`    not copied yet : ${r.sampleMissing.join(", ")}`);
    if (r.sampleExtra.length) console.log(`    only in SQL    : ${r.sampleExtra.join(", ")}`);
    for (const d of r.sampleDiffering) console.log(`    disagrees      : ${d.key} — ${d.fields.join(", ")}`);
  }
  console.log(bad.length ? `\n${bad.length} table(s) disagree.` : `\nEvery table agrees.`);
}
process.exit(bad.length ? 1 : 0);
