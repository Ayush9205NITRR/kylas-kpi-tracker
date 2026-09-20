#!/usr/bin/env node
/* Brings a live base up to the schema.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/repair-base.mjs --dry-run
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/repair-base.mjs
 *   ...                                      node scripts/repair-base.mjs --update-formulas
 *
 * create-base.mjs refuses to touch a base whose tables exist, on purpose — a
 * half-merge is worse to unpick than a refusal. This is the other half.
 *
 * TWO KINDS OF CHANGE, and the difference is deliberate:
 *
 *   ADDING an absent field is safe and happens by default. Nothing that exists
 *   is touched, so the worst case is a column nobody uses.
 *
 *   CHANGING a formula that is already there is not safe by default — it
 *   changes what every existing row reports. It needs --update-formulas, and
 *   --dry-run prints the old and new text so it can be read before it is run.
 *
 * Neither the rollup aggregation nor a select's choices can be changed through
 * the API at all: the update endpoint accepts `options.formula` and nothing
 * else. Those are reported with what to do about them, not silently skipped.
 *
 * Run verify-base.mjs first to see the state, and again afterwards to confirm.
 */
/* Loads .env.local if it is there, so nothing needs sourcing first. Must come
   before any import that reads process.env at module scope. */
import "./env.mjs";
import { requireEnv } from "./env.mjs";
import { TABLES, FOLLOWUPS } from "./schema.mjs";
import { diffBase } from "./schema-diff.mjs";

const DRY = process.argv.includes("--dry-run");
const FORMULAS = process.argv.includes("--update-formulas");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
requireEnv("AIRTABLE_PAT", "AIRTABLE_BASE");

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
const tableId = (name) => byName.get(name)?.id;

const d = diffBase(live.tables);

/* Order matters in the schema — a rollup cannot exist before the link it rolls
   up through — so the add list is rebuilt in declaration order rather than
   taken from the diff, which groups by kind. */
const wanted = [];
for (const t of TABLES) for (const f of t.fields) wanted.push({ table: t.name, field: f });
for (const step of FOLLOWUPS) wanted.push(step);
const absent = new Set(d.missingFields.map(({ table, field }) => `${table}.${field.name}`));
const missing = wanted.filter(({ table, field }) => absent.has(`${table}.${field.name}`));

/* A MISSING TABLE used to be a hard stop with "use create-base.mjs" — which
   refuses outright on a base whose tables exist, so the advice was a dead end.
   Adding a table nobody has is as safe as adding a field nobody has, so it is
   done here, with its own columns, before the field pass. */
let createdTables = 0;
if (d.missingTables.length) {
  console.log(`${d.missingTables.length} table(s) to create: ${d.missingTables.join(", ")}`);
  if (DRY) {
    for (const name of d.missingTables) {
      const t = TABLES.find((x) => x.name === name);
      console.log(`  + ${name}  (${(t?.fields || []).map((f) => f.name).join(", ")})`);
    }
  } else {
    for (const name of d.missingTables) {
      const t = TABLES.find((x) => x.name === name);
      if (!t) { console.error(`  ! ${name} is not in the schema — nothing to create from`); continue; }
      /* This used to test t.fields for a record link and refuse. It never
         fired: a link is declared in FOLLOWUPS, not on the table, so no
         TABLES entry has ever carried one and the guard was reading a list
         that cannot contain what it was looking for.

         The real constraint is the one below. diffBase does not report the
         fields of a table that does not exist, so a link pointing INTO a
         table created by this run is invisible to this run — the table is
         made, and its link is not. Rather than refuse, create it and say
         plainly that a second run finishes the job, because a table that
         exists but rolls up nothing is the failure that hides. */
      const linkAfter = FOLLOWUPS.filter((s) => s.table === name && s.field.type === "multipleRecordLinks");
      const made = await call("POST", `/bases/${BASE}/tables`, {
        name: t.name, description: t.description,
        fields: t.fields.map((f) => ({ name: f.name, type: f.type,
          ...(f.description ? { description: f.description } : {}),
          ...(f.options ? { options: f.options } : {}) })),
      });
      byName.set(t.name, { id: made.id, name: t.name, fields: made.fields || [] });
      createdTables++;
      console.log(`  + ${name} created with ${t.fields.length} field(s)`);
      if (linkAfter.length)
        console.log(`    ! run this again — ${name}.${linkAfter.map((s) => s.field.name).join(", ")} ` +
                    `is a link and\n      was not visible while the table did not exist`);
    }
    console.log();
  }
}

/* ── report ────────────────────────────────────────────────────────── */
const short = (s, n = 74) => (s.length > n ? s.slice(0, n) + "…" : s);

if (missing.length) {
  console.log(`${missing.length} field(s) to add:`);
  for (const { table, field } of missing) console.log(`  + ${table}.${field.name}  (${field.type})`);
  console.log();
}

if (d.formulaDrift.length) {
  console.log(`${d.formulaDrift.length} formula(s) differ from the schema:`);
  for (const f of d.formulaDrift) {
    console.log(`  ~ ${f.table}.${f.field}`);
    console.log(`      in the base  ${short(f.was)}`);
    console.log(`      the schema   ${short(f.want)}`);
  }
  console.log(FORMULAS
    ? "  These WILL be updated — every existing row's value changes with them.\n"
    : "  Pass --update-formulas to write these. Not done by default: it changes\n" +
      "  what every existing row reports.\n");
}

/* Things no script may fix, each with the reason and the remedy. Printed even
   on a plain run, because the whole failure this was written for was a
   difference nobody could see. */
if (d.rollupDrift.length) {
  console.log(`${d.rollupDrift.length} rollup(s) differ, and the API cannot change a rollup:`);
  for (const f of d.rollupDrift) {
    console.log(`  ! ${f.table}.${f.field}`);
    console.log(`      in the base  ${short(f.was)}`);
    console.log(`      the schema   ${short(f.want)}`);
  }
  console.log("  Fix these in the Airtable UI, or delete the field and re-run this script\n" +
              "  to have it recreated from the schema.\n");
}

/* Choices are informational. Every write goes out with typecast:true, so
   Airtable adds a choice the first time a record uses it — an absent one
   usually means nobody has been on that stage yet. Printed as a count, because
   printing 23 stage codes per field buried the things that ARE faults. */
if (d.choiceDrift.length)
  console.log(`${d.choiceDrift.length} select field(s) have a different choice list. ` +
              `Not a fault:\n  typecast adds a choice on first use, and a leftover one ` +
              `is a value from before this\n  schema — deleting it would blank it on every ` +
              `record still carrying it.\n`);

if (d.rollupUnreadable.length)
  console.log(`${d.rollupUnreadable.length} rollup(s) could not be checked — Airtable does ` +
              `not report their\n  aggregation. Not a fault, just a gap in what can be ` +
              `verified.\n`);

if (d.wrongType.length) {
  console.log(`${d.wrongType.length} field(s) are the wrong type:`);
  for (const f of d.wrongType) console.log(`  ! ${f.table}.${f.field} is ${f.was}, schema says ${f.want}`);
  console.log("  Changing a field's type through the API discards what is in it, so this\n" +
              "  script will not. Convert it in the UI, or delete it and re-run.\n");
}

const willDo = missing.length + (FORMULAS ? d.formulaDrift.length : 0);
if (!willDo) {
  const stuck = d.rollupDrift.length + d.choiceDrift.length + d.wrongType.length
    + (FORMULAS ? 0 : d.formulaDrift.length);
  if (createdTables) console.log(`${createdTables} table(s) created.`);
  console.log(stuck ? "Nothing else this script can do — see above."
    : createdTables ? "Run verify-base.mjs to confirm." : "The base matches the schema.");
  process.exit(0);
}
if (DRY) { console.log("Dry run — nothing sent."); process.exit(0); }

let failed = 0;

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

/* ── formulas ──────────────────────────────────────────────────────── */
/* options.formula is the ONE option the update endpoint accepts. Confirmed
   against the official Airtable MCP server's update_field contract, which
   documents exactly this and nothing else — so a rollup or a select's choices
   are reported above rather than attempted here. */
if (FORMULAS && d.formulaDrift.length) {
  console.log();
  for (const f of d.formulaDrift) {
    try {
      await call("PATCH", `/bases/${BASE}/tables/${tableId(f.table)}/fields/${f.id}`,
                 { options: { formula: f.want } });
      console.log(`  ~ ${f.table}.${f.field} updated`);
    } catch (e) {
      /* If Airtable refuses, say so with its own words and carry on with the
         rest — one stubborn field must not leave the others stale. Exits
         non-zero at the end so a caller can tell. */
      failed++;
      console.error(`  ! ${f.table}.${f.field} NOT updated`);
      console.error(`    ${String(e.message).split("\n").slice(0, 2).join(" ")}`);
      console.error(`    Paste this into the field in Airtable instead:\n      ${f.want}`);
    }
  }
}

console.log(`\nDone. Run verify-base.mjs to confirm.`);
if (failed) {
  console.error(`\n${failed} field(s) could not be updated through the API — see above.`);
  process.exit(1);
}
