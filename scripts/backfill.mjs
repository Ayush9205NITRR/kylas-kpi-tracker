#!/usr/bin/env node
/* GATE 1: copy Airtable into the SQL database, and do it again safely.
 *
 *   node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite
 *   node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite --only Contacts
 *
 * READ-ONLY AGAINST AIRTABLE. It never writes, updates or deletes there. The
 * only thing it changes is the local SQLite file named by --db.
 *
 * RE-RUNNABLE BY CONSTRUCTION. Every row is upserted on its Airtable record
 * id, so a second pass updates the rows the first one wrote instead of
 * inserting a second copy. That is what makes a backfill that died halfway
 * something you re-run rather than something you clean up after.
 *
 * PARENT FIRST. A contact's company has to exist before the contact can point
 * at it, so the table order in sql-store.mjs is load-bearing, not tidy.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { sqlSchema, tableName } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { BACKFILL_ORDER, recordToRow, upsertSql, LINKS_BY_TABLE } from "./sql-store.mjs";

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = arg("--db", "db/kpi.sqlite");
const ONLY = arg("--only");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("backfill needs AIRTABLE_PAT and AIRTABLE_BASE.\n" +
    "  node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite");
  process.exit(1);
}

const at = createAirtable(PAT, BASE, {
  log: () => {},
  ...(process.env.AIRTABLE_BASE_URL ? { apiUrl: process.env.AIRTABLE_BASE_URL } : {}),
});

mkdirSync(dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);
db.exec("PRAGMA foreign_keys = ON");
db.exec(sqlSchema());
/* The views are rebuilt on every run. They hold no data — dropping and
   recreating them costs nothing and means a copy can never be left with the
   view definitions of an older build. */
db.exec(sqlDerived());

/* Airtable record id → the local row id, per table, so a child can find its
   parent. Read from the database rather than kept from this run: a re-run
   that only does one table still resolves links written by an earlier one. */
const idCache = new Map();
function parentIdOf(table, airtableId) {
  const key = `${table}:${airtableId}`;
  if (idCache.has(key)) return idCache.get(key);
  const row = db.prepare(`SELECT id FROM "${tableName(table)}" WHERE airtable_id = ?`).get(airtableId);
  const id = row?.id ?? null;
  idCache.set(key, id);
  return id;
}

const tables = ONLY ? [ONLY] : BACKFILL_ORDER;
let total = 0, orphans = 0;
for (const table of tables) {
  let recs;
  try {
    /* maxPages high on purpose: a cap here would copy a PREFIX and report
       success, which is the exact shape of the bug that once made a month of
       numbers the first 4,000 calls. */
    recs = await listTolerant(at, table, { pageSize: 100, maxPages: 5000 });
  } catch (e) {
    console.log(`  ${table.padEnd(18)} skipped — ${e.message.slice(0, 80)}`);
    continue;
  }
  const { sql, cols } = upsertSql(table);
  const stmt = db.prepare(sql);
  let wrote = 0, missingParent = 0;
  for (const rec of recs) {
    const row = recordToRow(table, rec, parentIdOf);
    /* A child whose parent is not here yet is reported, not dropped in
       silence — it is the signal that the order or the source is wrong. Read
       from the schema's link list, not from column names ending in _id: three
       real fields end that way and none of them is a link. */
    for (const l of LINKS_BY_TABLE[table] || [])
      if (row[l.col] === null && (rec.fields?.[l.name] || []).length) missingParent++;
    stmt.run(...cols.map((c) => row[c] ?? null));
    idCache.set(`${table}:${rec.id}`, db.prepare(
      `SELECT id FROM "${tableName(table)}" WHERE airtable_id = ?`).get(rec.id)?.id ?? null);
    wrote++;
  }
  total += wrote; orphans += missingParent;
  const have = db.prepare(`SELECT COUNT(*) n FROM "${tableName(table)}"`).get().n;
  console.log(`  ${table.padEnd(18)} ${String(wrote).padStart(6)} read → ${String(have).padStart(6)} in the database` +
    (missingParent ? `  · ${missingParent} with a parent not found` : ""));
}

console.log(`\n${total} row(s) copied into ${DB}`);
if (orphans) console.log(`${orphans} row(s) link to a parent that is not in the copy — run the parent table first`);
db.close();
