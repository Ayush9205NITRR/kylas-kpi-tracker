/* Compares a live Airtable base against schema.mjs.
 *
 * WHY THIS EXISTS. verify-base.mjs and repair-base.mjs both compared a live
 * base against the schema by NAME and TYPE only. Neither ever looked at a
 * formula's text, a rollup's aggregation or a select's choices — so the base
 * could hold a formula that had not matched the schema for weeks and both
 * scripts reported a clean ✓.
 *
 * That is exactly what happened. Retiring "Reschedule Pending" renumbered the
 * ladder from 24 rungs to 23, and `Contacts.KPI Stage` and `Companies.KPI
 * Stage` in the live base kept the old 24-rung formula. Every label above rung
 * 20 was one stage off, and nothing in the repo could see it.
 *
 * Pure functions, no network: the caller fetches, this compares. That is what
 * makes it testable — see scripts/test-schema-diff.mjs.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";

/* ── what the schema says ──────────────────────────────────────────── */
/* One flat list of every field the schema declares, with its full definition
   rather than just its type, because that is what a drift check needs. */
export function wantedFields() {
  const out = [];
  for (const t of TABLES) for (const f of t.fields) out.push({ table: t.name, field: f });
  for (const step of FOLLOWUPS) out.push(step);
  return out;
}

/* Airtable reformats a formula it accepts — it adds and removes spaces around
   operators, commas and brackets — so comparing raw strings reports drift that
   is not there, and a check that cries wolf every run is a check nobody reads.
   Whitespace OUTSIDE a string literal is never significant in an Airtable
   formula, so all of it goes.
   
   Inside a literal it is the opposite: the ladder's labels are quoted strings
   full of spaces ("19 · Discovery Call Booked"), and collapsing those would
   make two genuinely different ladders compare equal. So this walks the string
   and tracks whether it is inside quotes, rather than reaching for one regex
   that cannot know the difference. */
export function normFormula(input) {
  const s = String(input == null ? "" : input);
  let out = "", quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < s.length) { out += s[++i]; continue; }   /* escaped */
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (/\s/.test(ch)) continue;                       /* outside a literal: drop it */
    out += ch;
  }
  return out;
}

/* Reads the formula out of a live field, whichever shape it arrives in. */
const liveFormula = (f) => normFormula(f?.options?.formula);

const choiceNames = (f) => (f?.options?.choices || []).map((c) => c.name);

/* ── the comparison ────────────────────────────────────────────────── */
/* Returns everything that differs, grouped by what can be done about it,
   because that distinction is the whole point:

     missingTables   create-base.mjs territory; this cannot fix it
     missingFields   repair-base.mjs adds these
     wrongType       a field of the wrong type has to be deleted by hand —
                     changing a type through the API loses the data in it
     formulaDrift    PATCHable. options.formula is the one option the update
                     endpoint accepts
     rollupDrift     NOT patchable. The update endpoint takes only
                     options.formula, so a rollup has to be fixed in the UI
     choiceDrift     NOT patchable either, and an ADDED choice is all we ever
                     report: deleting one orphans every record using it
     extra           in the base, not in the schema. Reported, never touched */
export function diffBase(liveTables) {
  const byName = new Map(liveTables.map((t) => [t.name, t]));
  const wanted = wantedFields();

  /* The reverse half of every link, which Airtable creates on the other table
     and create-base.mjs renames. It has no schema definition of its own, so it
     is checked for presence only. */
  const reverses = [];
  for (const { field, reverse } of FOLLOWUPS)
    if (field.type === "multipleRecordLinks" && reverse)
      reverses.push({ table: field.options.linkedTable, name: reverse });

  const out = { missingTables: [], missingFields: [], wrongType: [],
                formulaDrift: [], rollupDrift: [], choiceDrift: [], extra: [],
                missingReverse: [], checked: 0 };

  out.missingTables = [...new Set(wanted.map((w) => w.table))].filter((t) => !byName.has(t));

  for (const { table, field } of wanted) {
    const t = byName.get(table);
    if (!t) continue;                     /* already reported as a missing table */
    const live = (t.fields || []).find((f) => f.name === field.name);
    if (!live) { out.missingFields.push({ table, field }); continue; }
    out.checked++;

    if (live.type !== field.type) {
      out.wrongType.push({ table, field: field.name, was: live.type, want: field.type });
      /* No point comparing the options of a field that is the wrong type. */
      continue;
    }

    if (field.type === "formula") {
      const want = normFormula(field.options.formula);
      const got = liveFormula(live);
      if (want !== got)
        out.formulaDrift.push({ table, field: field.name, id: live.id, was: got, want });
    }

    if (field.type === "rollup") {
      const want = normFormula(field.options.formula);
      const got = liveFormula(live);
      if (want !== got)
        out.rollupDrift.push({ table, field: field.name, id: live.id, was: got, want,
                               why: "rollup aggregation" });
    }

    if (field.type === "singleSelect" || field.type === "multipleSelects") {
      const want = (field.options.choices || []).map((c) => c.name);
      const got = choiceNames(live);
      const absent = want.filter((c) => !got.includes(c));
      const surplus = got.filter((c) => !want.includes(c));
      if (absent.length || surplus.length)
        out.choiceDrift.push({ table, field: field.name, id: live.id, absent, surplus });
    }
  }

  for (const { table, name } of reverses) {
    const t = byName.get(table);
    if (!t) continue;
    if (!(t.fields || []).some((f) => f.name === name)) out.missingReverse.push({ table, name });
  }

  /* Extras, for information. A field somebody added by hand is their business;
     naming it is how they find out we cannot see it. */
  const wantByTable = new Map();
  for (const { table, field } of wanted) {
    if (!wantByTable.has(table)) wantByTable.set(table, new Set());
    wantByTable.get(table).add(field.name);
  }
  for (const { table, name } of reverses) wantByTable.get(table)?.add(name);
  for (const [table, names] of wantByTable) {
    const t = byName.get(table);
    if (!t) continue;
    for (const f of t.fields || []) if (!names.has(f.name)) out.extra.push({ table, field: f.name });
  }

  return out;
}

/* Everything that differs and cannot be fixed by a script, so a caller can say
   so in one line instead of the reader having to add it up. */
export const manualCount = (d) =>
  d.wrongType.length + d.rollupDrift.length + d.choiceDrift.length + d.missingTables.length;

export const cleanExceptExtras = (d) =>
  !d.missingTables.length && !d.missingFields.length && !d.wrongType.length &&
  !d.formulaDrift.length && !d.rollupDrift.length && !d.choiceDrift.length &&
  !d.missingReverse.length;
