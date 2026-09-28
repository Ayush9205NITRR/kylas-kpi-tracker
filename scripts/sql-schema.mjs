#!/usr/bin/env node
/* THE KPI BASE AS SQL, GENERATED FROM THE SAME FILE AIRTABLE IS BUILT FROM.
 *
 *   node scripts/sql-schema.mjs            # print the DDL
 *   node scripts/sql-schema.mjs --out db/schema.sql
 *
 * Gate 0 of the migration (docs/MIGRATION.md). `schema.mjs` already describes
 * every table, field, type and link; create-base.mjs turns it into Airtable.
 * This turns the same description into SQLite for D1. Generated rather than
 * hand-written for one reason: a hand-written copy drifts, and a schema that
 * disagrees with the one in production is worse than no second schema at all.
 * Adding a field stays a one-line change in schema.mjs, as it is today.
 *
 * WHAT THIS FILE DOES NOT DO. The rollups and formulas are not columns here —
 * see sql-derived.mjs and the note on generated columns below. This file is
 * the shape of the data; that one is what is computed from it.
 *
 * NOTHING HERE TOUCHES PRODUCTION. It writes a .sql file. The tables it
 * describes live beside the existing `mirror_rows` cache, which is untouched.
 */
import { writeFileSync } from "node:fs";
import { TABLES, FOLLOWUPS } from "./schema.mjs";

/* ── names ───────────────────────────────────────────────────────────
   Airtable names are Title Case with spaces; SQL wants snake_case. The
   mapping has to be MECHANICAL and reversible by inspection, because the
   reconciler reads both sides and has to line the columns up. Exported so it
   is one function rather than a convention each script re-implements.

   Lowercase and replace runs of anything else with one underscore. Note what
   this deliberately does NOT do: split camel case. "LinkedIn" is one word to
   the people who named it, and splitting it into linked_in makes a column
   nobody would guess the name of. */
export const sqlName = (s) => String(s)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

export const tableName = (airtableName) => sqlName(airtableName);
export const columnName = (fieldName) => sqlName(fieldName);

/* ── types ───────────────────────────────────────────────────────────
   SQLite has five storage classes, so an Airtable type maps to a storage
   class plus a CHECK that carries the meaning the column type would have
   carried in Postgres. The CHECKs are not decoration: a date written in the
   wrong format, or a select value the base has never heard of, is the kind of
   fault that otherwise shows up weeks later as a filter quietly matching
   nothing. Fail on write instead.

   BLANK IS NULL, EVERYWHERE BUT CHECKBOXES. An Airtable number field that was
   never filled comes back absent, and a column that defaults to 0 turns "we
   do not know" into "zero" — which reads as a fact. So no numeric column gets
   a default. A checkbox is the one exception: Airtable omits it when false,
   so absent genuinely means 0 there, and it defaults to 0. */
const ISO_DATE = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
const ISO_DATETIME = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'";

const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function columnFor(field) {
  const col = columnName(field.name);
  const q = `"${col}"`;
  switch (field.type) {
    case "singleLineText":
    case "multilineText":
    case "url":
      return { col, sql: `${q} TEXT` };
    case "singleSelect": {
      const choices = (field.options?.choices || []).map((c) => c.name);
      /* An empty list would make the CHECK reject everything. */
      if (!choices.length) return { col, sql: `${q} TEXT` };
      return { col, sql: `${q} TEXT CHECK (${q} IS NULL OR ${q} IN (${choices.map(sqlLit).join(", ")}))` };
    }
    case "checkbox":
      return { col, sql: `${q} INTEGER NOT NULL DEFAULT 0 CHECK (${q} IN (0, 1))` };
    case "number":
      /* precision 0 is a whole number; anything else keeps its decimals. */
      return { col, sql: `${q} ${field.options?.precision ? "REAL" : "INTEGER"}` };
    case "percent":
      return { col, sql: `${q} REAL` };
    case "date":
      return { col, sql: `${q} TEXT CHECK (${q} IS NULL OR ${q} ${ISO_DATE})` };
    case "dateTime":
      return { col, sql: `${q} TEXT CHECK (${q} IS NULL OR ${q} ${ISO_DATETIME})` };
    default:
      throw new Error(`sql-schema: no mapping for Airtable type "${field.type}" (${field.name})`);
  }
}

/* ── keys ────────────────────────────────────────────────────────────
   Every table carries `airtable_id`: the record id the row had in Airtable.
   It is what the reconciler joins on, and it is what makes the backfill
   re-runnable — a second pass updates the same rows rather than inserting a
   second copy of everything.

   The natural key is the one the application already upserts on. Naming it
   here as UNIQUE turns "two rows for one company" from a thing you discover
   in a report into a write that fails. */
const NATURAL_KEY = {
  Companies: ["Kylas Company ID"],
  Contacts: ["Kylas Contact ID"],
  "Event Rows": ["Row Key"],
  "Call Log": ["Key"],
  "Stage Transitions": ["Key"],
  "Daily Snapshot": ["Key"],
  "Call Rollup": ["Key"],
  Focus: ["Kylas Company ID"],
  "Focus History": ["Key"],
  Research: ["Kylas Company ID"],
  RCA: ["Key"],
  Team: ["Name"],
  "Schema Migrations": ["Key"],
};

/* The five record links, as foreign keys. All five are many-to-one, so each
   is a column on the child and not a join table.
   ON DELETE RESTRICT, not CASCADE: a company whose contacts still exist is a
   mistake to be reported, never a silent deletion of somebody's call history. */
const links = () => FOLLOWUPS
  .filter((f) => f.field?.type === "multipleRecordLinks")
  .map((f) => ({
    table: f.table,
    name: f.field.name,
    to: f.field.options.linkedTable,
    col: `${columnName(f.field.name)}_id`,
  }));

/* Derived fields. Two kinds, and telling them apart is the whole point:

   OWN-ROW — reads only columns on its own row, so it can be a stored
   generated column. SQLite recomputes it whenever the row is written, which
   is exactly when its inputs can have changed.

   CHILD — reads a child table. A stored column would NOT recompute when the
   child changes, and Airtable's rollup does. Those live in views
   (sql-derived.mjs). Getting this backwards is the migration's one
   silent-wrong-number risk, so the split is asserted by the test rather than
   left to whoever writes the next field. */
export const OWN_ROW_DERIVED = {
  "Event Rows": {
    "Has Any Signal": `CASE WHEN COALESCE("budget", '') <> '' OR COALESCE("timeline", '') <> '' ` +
      `OR COALESCE("pax", '') <> '' THEN 1 ELSE 0 END`,
    "Is Complete": `CASE WHEN COALESCE("budget", '') <> '' AND COALESCE("timeline", '') <> '' ` +
      `AND COALESCE("pax", '') <> '' THEN 1 ELSE 0 END`,
  },
  "Call Log": {
    "Measured Seconds": `CASE WHEN "duration_source" = 'dialed' THEN COALESCE("duration", 0) ELSE 0 END`,
  },
};

/* Indexes the reads here actually make: join columns, the natural keys (which
   the UNIQUE constraints already index), and the two columns every report
   filters or orders by. Nothing speculative — an index that is never used
   still costs every write. */
const INDEXES = [
  ["contacts", ["company_id"]],
  ["event_rows", ["contact_id"]],
  ["call_log", ["contact_id"]],
  ["call_log", ["called_at"]],
  ["call_log", ["owner", "called_at"]],
  ["stage_transitions", ["contact_id"]],
  ["stage_transitions", ["changed_at"]],
  ["rca", ["contact_id"]],
  ["contacts", ["next_call_date"]],
  ["contacts", ["current_stage"]],
  ["companies", ["kylas_owner_id"]],
  ["focus_history", ["kylas_company_id"]],
  ["daily_snapshot", ["date", "owner"]],
  ["call_rollup", ["day", "owner"]],
];

export function sqlSchema() {
  const out = [];
  const byTable = new Map(TABLES.map((t) => [t.name, t]));
  const linkList = links();

  out.push(`-- The Kylas KPI store, as SQLite for Cloudflare D1.`);
  out.push(`-- GENERATED by scripts/sql-schema.mjs from scripts/schema.mjs — do not edit by hand.`);
  out.push(`-- Regenerate:  node scripts/sql-schema.mjs --out db/schema.sql`);
  out.push(``);
  out.push(`PRAGMA foreign_keys = ON;`);
  out.push(``);

  for (const t of TABLES) {
    const tbl = tableName(t.name);
    const cols = [];

    /* The row's own identity, then where it came from. */
    cols.push(`  "id" INTEGER PRIMARY KEY AUTOINCREMENT`);
    cols.push(`  -- the Airtable record id, so the backfill can re-run and the reconciler can join`);
    cols.push(`  , "airtable_id" TEXT UNIQUE`);

    for (const f of t.fields) {
      const { sql } = columnFor(f);
      if (f.description) cols.push(`  -- ${f.description.replace(/\s+/g, " ").slice(0, 160)}`);
      cols.push(`  , ${sql}`);
    }

    /* Foreign keys for the record links pointing out of this table. */
    for (const l of linkList.filter((x) => x.table === t.name)) {
      cols.push(`  -- was the Airtable link "${l.name}" → ${l.to}`);
      cols.push(`  , "${l.col}" INTEGER REFERENCES "${tableName(l.to)}"("id") ON DELETE RESTRICT`);
    }

    /* Own-row derived fields, as stored generated columns. */
    for (const [name, expr] of Object.entries(OWN_ROW_DERIVED[t.name] || {})) {
      cols.push(`  -- derived on this row only; a child-dependent field would belong in a view`);
      cols.push(`  , "${columnName(name)}" INTEGER GENERATED ALWAYS AS (${expr}) STORED`);
    }

    /* Bookkeeping the application writes, not Airtable. */
    cols.push(`  -- when this copy last changed, for the reconciler and for deltas`);
    cols.push(`  , "synced_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

    const nat = (NATURAL_KEY[t.name] || []).map((n) => `"${columnName(n)}"`);
    if (nat.length) {
      cols.push(`  -- the key the application upserts on: a duplicate is a failed write, not a report`);
      cols.push(`  , UNIQUE (${nat.join(", ")})`);
    }

    if (t.description) out.push(`-- ${t.description.replace(/\s+/g, " ")}`);
    out.push(`CREATE TABLE IF NOT EXISTS "${tbl}" (`);
    out.push(cols.join("\n"));
    out.push(`);`);
    out.push(``);
  }

  out.push(`-- ── indexes ─────────────────────────────────────────────────────────`);
  for (const [tbl, cs] of INDEXES) {
    if (!byTable.has(TABLES.find((t) => tableName(t.name) === tbl)?.name)) continue;
    out.push(`CREATE INDEX IF NOT EXISTS "ix_${tbl}_${cs.join("_")}" ON "${tbl}" (${cs.map((c) => `"${c}"`).join(", ")});`);
  }
  out.push(``);
  return out.join("\n");
}

/* Which Airtable fields this file does NOT turn into a column, and why. The
   test reads this to prove nothing was simply forgotten. */
export function derivedFields() {
  const own = [], child = [];
  for (const f of FOLLOWUPS) {
    if (!f.field || f.field.type === "multipleRecordLinks") continue;
    const isOwn = !!OWN_ROW_DERIVED[f.table]?.[f.field.name];
    (isOwn ? own : child).push({ table: f.table, name: f.field.name, type: f.field.type });
  }
  return { own, child };
}

export const LINKS = links();

if (import.meta.url === `file://${process.argv[1]}`) {
  const sql = sqlSchema();
  const i = process.argv.indexOf("--out");
  if (i >= 0 && process.argv[i + 1]) {
    writeFileSync(process.argv[i + 1], sql);
    const { child } = derivedFields();
    console.log(`wrote ${process.argv[i + 1]} — ${TABLES.length} tables, ${LINKS.length} foreign keys`);
    console.log(`${child.length} child-dependent fields are views, not columns — see sql-derived.mjs`);
  } else {
    process.stdout.write(sql);
  }
}
