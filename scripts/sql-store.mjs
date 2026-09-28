/* AIRTABLE VALUES ↔ SQL VALUES. One file, because three things need this
 * agreement and two of them check each other: the backfill writes rows, the
 * reconciler compares them, and the shadow writer (Gate 2) will write them
 * again from the live save path. If any of those three disagreed about what
 * an unchecked checkbox or a blank number means, the reconciler would report
 * drift that is not there — or, worse, miss drift that is.
 *
 * The rules, and why each one is a rule rather than an accident:
 *
 *   BLANK IS NULL. Airtable omits a field that was never filled. It comes
 *   back absent, not as "" or 0, and it has to stay absent — a 0 in a number
 *   column reads as a measurement.
 *
 *   EXCEPT A CHECKBOX. Airtable omits an unchecked box too, and there the
 *   absence genuinely means false. So checkbox is the one type where missing
 *   becomes 0 rather than NULL.
 *
 *   A SELECT MAY ARRIVE TWO WAYS. The REST API returns the choice name as a
 *   plain string; some clients return { id, name, color }. Both are read.
 *
 *   A LINK IS A LIST OF RECORD IDS. All five links here are many-to-one, so
 *   the first id is the parent. It is resolved to the local row id through a
 *   map the caller supplies, because the parent must already be in the
 *   database — which is what fixes the order the backfill runs in.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";
import { tableName, columnName } from "./sql-schema.mjs";

const fieldsOf = (t) => TABLES.find((x) => x.name === t)?.fields || [];

/* Parent-first. A child's foreign key cannot be written before the row it
   points at exists, so the order is not a preference. */
export const BACKFILL_ORDER = [
  "Companies", "Contacts",
  "Event Rows", "Call Log", "Stage Transitions", "RCA",
  "Focus", "Focus History", "Research",
  "Daily Snapshot", "Call Rollup", "Team", "Schema Migrations",
];

export const LINKS_BY_TABLE = FOLLOWUPS
  .filter((f) => f.field?.type === "multipleRecordLinks")
  .reduce((m, f) => {
    (m[f.table] ||= []).push({ name: f.field.name, to: f.field.options.linkedTable,
                               col: `${columnName(f.field.name)}_id` });
    return m;
  }, {});

/* One Airtable cell → the value that belongs in its column. */
export function cellToSql(field, raw) {
  const missing = raw === undefined || raw === null || raw === "";
  switch (field.type) {
    case "checkbox":
      return raw === true || raw === 1 ? 1 : 0;
    case "number":
    case "percent": {
      if (missing) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "singleSelect": {
      if (missing) return null;
      return typeof raw === "object" ? (raw.name ?? null) : String(raw);
    }
    default:
      if (missing) return null;
      return typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
}

/* A whole Airtable record → { column: value }. `parentIdOf(table, recordId)`
   answers with the local row id of a parent already written, or null. */
export function recordToRow(table, rec, parentIdOf = () => null) {
  const row = { airtable_id: rec.id };
  const f = rec.fields || {};
  for (const field of fieldsOf(table)) row[columnName(field.name)] = cellToSql(field, f[field.name]);
  for (const l of LINKS_BY_TABLE[table] || []) {
    const ids = f[l.name];
    const first = Array.isArray(ids) ? ids[0] : ids;
    row[l.col] = first ? parentIdOf(l.to, String(first)) : null;
  }
  return row;
}

/* THE UPSERT. Keyed on airtable_id, so running the backfill twice writes the
   same rows twice rather than a second copy of everything — which is the only
   property that makes a half-finished backfill safe to simply re-run. */
export function upsertSql(table) {
  const tbl = tableName(table);
  const cols = ["airtable_id",
    ...fieldsOf(table).map((f) => columnName(f.name)),
    ...(LINKS_BY_TABLE[table] || []).map((l) => l.col)];
  const set = cols.filter((c) => c !== "airtable_id")
    .map((c) => `"${c}" = excluded."${c}"`).concat(`"synced_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  return {
    cols,
    sql: `INSERT INTO "${tbl}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
         `VALUES (${cols.map(() => "?").join(", ")}) ` +
         `ON CONFLICT ("airtable_id") DO UPDATE SET ${set.join(", ")}`,
  };
}

/* ── comparing the two sides ─────────────────────────────────────────
   Not string equality. The reconciler asks "do these mean the same thing",
   which is a different question per type: a number written 5 and 5.0, a
   date-time Airtable normalises to milliseconds, a select that arrived as an
   object. Comparing the raw values would report drift on every row. */
export function sameValue(field, airtableRaw, sqlValue) {
  const want = cellToSql(field, airtableRaw);
  if (want === null && sqlValue === null) return true;
  if (want === null || sqlValue === null) return false;
  switch (field.type) {
    case "number":
    case "percent":
      return Math.abs(Number(want) - Number(sqlValue)) < 1e-9;
    case "checkbox":
      return Number(want) === Number(sqlValue);
    case "dateTime":
      /* Airtable stores milliseconds and hands them back with a Z; two
         strings for the same instant must not read as a difference. */
      return Date.parse(String(want)) === Date.parse(String(sqlValue));
    default:
      return String(want) === String(sqlValue);
  }
}

/* Every difference between one Airtable record and one SQL row, as a list of
   field names. Empty means they agree. */
export function diffRecord(table, rec, row) {
  const out = [];
  const f = rec.fields || {};
  for (const field of fieldsOf(table))
    if (!sameValue(field, f[field.name], row[columnName(field.name)])) out.push(field.name);
  return out;
}

export const naturalKeyOf = (table) => ({
  Companies: "Kylas Company ID", Contacts: "Kylas Contact ID", "Event Rows": "Row Key",
  "Call Log": "Key", "Stage Transitions": "Key", "Daily Snapshot": "Key", "Call Rollup": "Key",
  Focus: "Kylas Company ID", "Focus History": "Key", Research: "Kylas Company ID",
  RCA: "Key", Team: "Name", "Schema Migrations": "Key",
}[table]);
