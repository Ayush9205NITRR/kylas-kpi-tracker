#!/usr/bin/env node
/* Checks the schema without touching the network.
   The Airtable Meta API has no dry-run: a bad field definition fails partway
   and leaves a half-built base you then have to delete by hand. This catches
   those first.  Run: node scripts/validate-schema.mjs  */

import { TABLES, FOLLOWUPS } from "./schema.mjs";

const errors = [], warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* Options each field type requires, per the Meta API. */
const REQUIRED = {
  number: ["precision"], percent: ["precision"], currency: ["precision", "symbol"],
  duration: ["durationFormat"], date: ["dateFormat"],
  dateTime: ["dateFormat", "timeFormat", "timeZone"],
  checkbox: ["icon", "color"], rating: ["color", "icon", "max"],
  singleSelect: ["choices"], multipleSelects: ["choices"],
  formula: ["formula"], count: ["recordLinkFieldId"],
  multipleLookupValues: ["recordLinkFieldId", "fieldIdInLinkedTable"],
  rollup: ["recordLinkFieldId", "fieldIdInLinkedTable", "formula"],
};
const PRIMARY_OK = new Set(["singleLineText", "email", "url", "multilineText", "number",
  "percent", "currency", "duration", "date", "dateTime", "phoneNumber", "barcode", "autoNumber"]);
/* Types that cannot be created inside the initial createBase call. */
const FOLLOWUP_ONLY = new Set(["formula", "rollup", "count", "multipleLookupValues",
  "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "aiText"]);

/* Track what exists as the script would build it, in order. */
const live = new Map();   // table -> Map(fieldName -> field)
const linksTo = new Map(); // "table::linkField" -> target table

const has = (t, f) => live.has(t) && live.get(t).has(f);
const add = (t, f) => {
  const m = live.get(t);
  if (m.has(f.name)) err(`${t}: duplicate field "${f.name}"`);
  m.set(f.name, f);
};

function checkOptions(where, f) {
  for (const key of REQUIRED[f.type] || []) {
    const v = f.options && f.options[key];
    if (v === undefined || v === null) err(`${where}: ${f.type} "${f.name}" is missing options.${key}`);
  }
  if (f.type === "singleSelect" || f.type === "multipleSelects") {
    const names = (f.options?.choices || []).map((c) => c.name);
    if (!names.length) err(`${where}: "${f.name}" has no choices`);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) err(`${where}: "${f.name}" has duplicate choices: ${[...new Set(dupes)].join(", ")}`);
  }
}

/* ── 1. tables ─────────────────────────────────────────────────────── */
const tableNames = TABLES.map((t) => t.name);
tableNames.filter((n, i) => tableNames.indexOf(n) !== i)
  .forEach((n) => err(`duplicate table name "${n}"`));

for (const t of TABLES) {
  live.set(t.name, new Map());
  if (!t.fields?.length) { err(`${t.name}: no fields`); continue; }

  const primary = t.fields[0];
  if (!PRIMARY_OK.has(primary.type))
    err(`${t.name}: primary field "${primary.name}" is ${primary.type}, which cannot be a primary field`);

  for (const f of t.fields) {
    if (FOLLOWUP_ONLY.has(f.type))
      err(`${t.name}: "${f.name}" is ${f.type} — it must move to FOLLOWUPS, createBase rejects it`);
    checkOptions(t.name, f);
    add(t.name, f);
  }
}

/* ── 2. follow-up fields, in the order they are applied ────────────── */
const FIELD_REF = /\{([^}]+)\}/g;

FOLLOWUPS.forEach((step, i) => {
  const { table, field: f } = step;
  const at = `FOLLOWUPS[${i}] ${table}.${f.name}`;
  if (!live.has(table)) { err(`${at}: no such table`); return; }
  checkOptions(at, f);

  if (f.type === "multipleRecordLinks") {
    const target = f.options?.linkedTable;
    if (!target) err(`${at}: link has no linkedTable`);
    else if (!live.has(target)) err(`${at}: links to unknown table "${target}"`);
    else {
      linksTo.set(`${table}::${f.name}`, target);
      /* Airtable creates the other half on the target table. Model it, or every
         rollup that travels back down this link looks undefined. */
      if (!step.reverse) {
        err(`${at}: link does not declare its reverse field name`);
      } else {
        add(target, { name: step.reverse, type: "multipleRecordLinks", generated: true });
        linksTo.set(`${target}::${step.reverse}`, table);
      }
    }
  }

  if (f.type === "rollup" || f.type === "multipleLookupValues") {
    const via = f.options?.recordLinkFieldId;
    const target = f.options?.fieldIdInLinkedTable;
    if (!has(table, via)) {
      err(`${at}: rolls up through "${via}", which does not exist yet on ${table}`);
    } else {
      const linked = linksTo.get(`${table}::${via}`);
      if (!linked) err(`${at}: "${via}" is not a link field`);
      else if (!has(linked, target))
        err(`${at}: "${target}" does not exist on ${linked} at this point`);
    }
    const fx = f.options?.formula || "";
    if (fx && !/\bvalues\b/.test(fx)) err(`${at}: rollup formula must use "values" — got ${fx}`);
  }

  if (f.type === "formula") {
    const fx = f.options.formula;
    for (const m of fx.matchAll(FIELD_REF)) {
      const ref = m[1];
      if (ref === f.name) err(`${at}: formula refers to itself`);
      else if (!has(table, ref)) err(`${at}: formula refers to {${ref}}, which does not exist on ${table} yet`);
    }
    const open = (fx.match(/\(/g) || []).length, close = (fx.match(/\)/g) || []).length;
    if (open !== close) err(`${at}: unbalanced brackets in formula (${open} open, ${close} close)`);
    const quotes = (fx.match(/"/g) || []).length;
    if (quotes % 2) err(`${at}: odd number of double quotes in formula`);
  }

  add(table, f);
});

/* ── 3. things that are legal but probably wrong ───────────────────── */
for (const [t, fields] of live) {
  const names = [...fields.keys()];
  const lower = names.map((n) => n.toLowerCase());
  lower.filter((n, i) => lower.indexOf(n) !== i)
    .forEach((n) => err(`${t}: "${n}" collides case-insensitively, which Airtable rejects`));
  if (names.length > 80) warn(`${t}: ${names.length} fields`);
}
for (const t of ["Call Log", "Stage Transitions", "Daily Snapshot"]) {
  if (!has(t, "Key")) warn(`${t} is append-only but has no Key field to deduplicate retries`);
}
if (!has("Contacts", "Kylas Contact ID")) err("Contacts has no Kylas Contact ID — nothing to join on");

/* ── report ────────────────────────────────────────────────────────── */
const total = [...live.values()].reduce((n, m) => n + m.size, 0);
console.log(`${live.size} tables, ${total} fields, ${FOLLOWUPS.length} added after creation\n`);
for (const [t, m] of live) console.log(`  ${t.padEnd(19)} ${String(m.size).padStart(2)} fields`);
console.log();
warnings.forEach((w) => console.log(`  warn   ${w}`));
errors.forEach((e) => console.log(`  ERROR  ${e}`));
console.log(errors.length ? `\n${errors.length} error(s) — do not run create-base.mjs yet.`
                          : `\nSchema is consistent.${warnings.length ? ` ${warnings.length} warning(s).` : ""}`);
process.exit(errors.length ? 1 : 0);
