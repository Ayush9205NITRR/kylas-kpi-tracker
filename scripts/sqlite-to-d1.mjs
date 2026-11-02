#!/usr/bin/env node
/* THE FIRST COPY INTO D1 GOES FROM THE LAPTOP (2026-11-03).
 *
 * The Worker's shadow copy pulls Airtable a page at a time on the minute cron,
 * and a Worker invocation cannot read a 35,000-row table whole. So the first
 * lap is done here: backfill.mjs fills a local SQLite file from Airtable, and
 * this turns that file into one SQL script for `wrangler d1 execute`. It also
 * seeds `shadow_state` with a watermark a few hours before now, so the Worker
 * then only carries on from there — the overlap is re-read and upserted, which
 * is free.
 *
 *   node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite
 *   node scripts/sqlite-to-d1.mjs --db db/kpi.sqlite --out db/d1-import.sql
 *   npx wrangler d1 execute enout-kpi --remote --file db/d1-import.sql
 *
 * Read-only against the SQLite file. Writes only --out.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { sqlSchema, tableName } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { BACKFILL_ORDER } from "./sql-store.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DB = arg("--db", "db/kpi.sqlite"), OUT = arg("--out", "db/d1-import.sql");
const OVERLAP_H = Number(arg("--overlap-hours", "6"));

const db = new DatabaseSync(DB, { readOnly: true });
const lit = (v) => v === null || v === undefined ? "NULL"
  : typeof v === "number" || typeof v === "bigint" ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

const out = ["PRAGMA defer_foreign_keys = true;", sqlSchema(), sqlDerived(),
  `CREATE TABLE IF NOT EXISTS shadow_state (tbl TEXT PRIMARY KEY, since TEXT, rows INTEGER DEFAULT 0, ran_at TEXT, last_error TEXT);`];
const since = new Date(Date.now() - OVERLAP_H * 3600e3).toISOString();
let total = 0;
for (const t of BACKFILL_ORDER) {
  const name = tableName(t);
  let rows;
  try { rows = db.prepare(`SELECT * FROM "${name}"`).all(); }
  catch { console.log(`  ${t.padEnd(18)} not in the file — skipped`); continue; }
  if (rows.length) {
    /* Generated columns (Measured Seconds, Has Any Signal, Is Complete) are
       computed by the database and refuse an INSERT, so only stored ones go. */
    const gen = new Set(db.prepare(`PRAGMA table_xinfo("${name}")`).all().filter((c) => c.hidden >= 2).map((c) => c.name));
    const cols = Object.keys(rows[0]).filter((c) => !gen.has(c));
    /* Small statements: D1 caps one statement's size, not the file's. */
    for (let i = 0; i < rows.length; i += 50) {
      out.push(`INSERT OR REPLACE INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES\n` +
        rows.slice(i, i + 50).map((r) => `(${cols.map((c) => lit(r[c])).join(", ")})`).join(",\n") + ";");
    }
  }
  out.push(`INSERT INTO shadow_state (tbl, since, rows, ran_at, last_error) VALUES (${lit(t)}, ${lit(since)}, ${rows.length}, ${lit(new Date().toISOString())}, NULL)
ON CONFLICT (tbl) DO UPDATE SET since = excluded.since, rows = excluded.rows, ran_at = excluded.ran_at, last_error = NULL;`);
  total += rows.length;
  console.log(`  ${t.padEnd(18)} ${String(rows.length).padStart(7)} rows`);
}
writeFileSync(OUT, out.join("\n\n") + "\n");
console.log(`\n${total} rows → ${OUT}. The Worker carries on from ${since} (an ${OVERLAP_H}h overlap).`);
console.log(`Next: npx wrangler d1 execute enout-kpi --remote --file ${OUT}`);
