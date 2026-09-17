#!/usr/bin/env node
/* Adds fields the schema has and the live base does not.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/repair-base.mjs --dry-run
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/repair-base.mjs
 *
 * create-base.mjs refuses to touch a base whose tables exist, on purpose — a
 * half-merge is worse to unpick than a refusal. This is the other half: it
 * changes nothing that is already there, only adds what is absent, in the order
 * the dependencies need.
 *
 * Use it after the schema gains a field. Run verify-base.mjs first to see what
 * is missing, and again afterwards to confirm.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";

const DRY = process.argv.includes("--dry-run");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("Set AIRTABLE_PAT (schema.bases:write) and AIRTABLE_BASE (app...).");
  process.exit(1);
}

const META = "https://api.airtable.com/v0/meta";
async function call(method, path, body) {
  const res = await fetch(`${META}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  return text ? JSON.parse(text) : {};
}

const live = await call("GET", `/bases/${BASE}/tables`);
const byName = new Map(live.tables.map((t) => [t.name, t]));
const has = (table, field) => (byName.get(table)?.fields || []).some((f) => f.name === field);
const tableId = (name) => byName.get(name)?.id;

/* Everything the schema declares, in the order it would have been created. */
const wanted = [];
for (const t of TABLES) for (const f of t.fields) wanted.push({ table: t.name, field: f });
for (const step of FOLLOWUPS) wanted.push(step);

const missing = wanted.filter(({ table, field }) => byName.has(table) && !has(table, field.name));
const unknownTables = [...new Set(wanted.map((w) => w.table))].filter((t) => !byName.has(t));

if (unknownTables.length) {
  console.error(`These tables do not exist in ${BASE}: ${unknownTables.join(", ")}`);
  console.error(`This script only adds fields. Create the tables with create-base.mjs first.`);
  process.exit(1);
}

if (!missing.length) {
  console.log("Nothing missing — the base matches the schema.");
  process.exit(0);
}

console.log(`${missing.length} field(s) to add:\n`);
for (const { table, field } of missing) console.log(`  ${table}.${field.name}  (${field.type})`);
if (DRY) { console.log("\nDry run — nothing sent."); process.exit(0); }
console.log();

for (const { table, field, reverse } of missing) {
  const payload = { name: field.name, type: field.type };
  if (field.description) payload.description = field.description;

  if (field.type === "multipleRecordLinks") {
    payload.options = { linkedTableId: tableId(field.options.linkedTable) };
  } else if (field.options) {
    payload.options = { ...field.options };
  }

  const before = field.type === "multipleRecordLinks"
    ? (await call("GET", `/bases/${BASE}/tables`)).tables
        .find((t) => t.id === tableId(field.options.linkedTable))?.fields.map((f) => f.id) || []
    : null;

  await call("POST", `/bases/${BASE}/tables/${tableId(table)}/fields`, payload);
  console.log(`  + ${table}.${field.name}`);

  /* Airtable names the reverse half of a link itself; rename it to what the
     rollups expect, exactly as create-base.mjs does. */
  if (field.type === "multipleRecordLinks" && reverse) {
    const target = tableId(field.options.linkedTable);
    const after = (await call("GET", `/bases/${BASE}/tables`)).tables.find((t) => t.id === target)?.fields || [];
    const added = after.find((f) => !before.includes(f.id));
    if (added && added.name !== reverse) {
      await call("PATCH", `/bases/${BASE}/tables/${target}/fields/${added.id}`, { name: reverse });
      console.log(`    renamed reverse link "${added.name}" -> "${reverse}"`);
    }
  }
}

console.log(`\nDone. Run verify-base.mjs to confirm.`);
