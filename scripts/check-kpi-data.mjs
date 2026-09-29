#!/usr/bin/env node
/* IS THE BASE COMPUTING WHAT IT SAYS IT COMPUTES?
 *
 *   node --env-file=.env.local scripts/check-kpi-data.mjs
 *   node --env-file=.env.local scripts/check-kpi-data.mjs --json
 *
 * Read-only. verify-base.mjs runs this at the end of its own run, so there is
 * usually no reason to run it by hand.
 *
 * WHY IT EXISTS, IN ONE FAULT. Companies.Ever Picked is declared MAX(values)
 * over Contacts.Ever Picked, which is a CHECKBOX — and Airtable returns blank
 * for the maximum of a set of checkboxes. Phone Picked read that rollup, so it
 * was 0 on all 98 companies in the live base while 71 of them had a contact
 * who had picked up. Every picked-up number on every screen was zero.
 *
 * Nothing that compares the base to schema.mjs could see it. The field was
 * present, the type was right, the formula text was right, and the meta API
 * does not report a rollup's aggregation at all (see d.rollupUnreadable in
 * verify-base.mjs). The only place the fault existed was in the VALUES.
 *
 * So this reads the rows and recomputes each Companies rollup from the
 * contacts underneath it, in JS, and compares. Two shapes of trouble:
 *
 *   DEAD   — blank or 0 on every single row, while the recomputation says it
 *            should be set on at least one. This is the Ever Picked signature
 *            and it is the one that costs a quarter of KPIs silently.
 *   DRIFT  — disagrees on some rows but not all. A link that did not get
 *            written, usually, rather than a broken field.
 *
 * Plus the per-row invariants: a formula that is defined as "1 when this other
 * field is set" is checked against that other field on every row, which is how
 * a formula pointed at the wrong input gets caught even when its text parses.
 *
 * It CANNOT fix anything. A rollup's aggregation is not writable through the
 * API (repair-base.mjs says the same) — a DEAD rollup is repaired in the
 * Airtable UI, or routed around by repointing the formulas that read it, which
 * is what was done on 2026-09-29.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { FOLLOWUPS } from "./schema.mjs";
import { MILESTONE } from "./stages.mjs";

/* ── which derived fields are known to be dead, and why that is allowed ──
   A rollup here is one Airtable cannot compute and NOTHING READS. Adding a
   name to this list is a claim that the second half is still true; if a
   formula starts reading it again, take it off the list and repair it. */
export const KNOWN_DEAD = {
  "Companies.Ever Picked":
    "MAX(values) over a checkbox — Airtable returns blank for that, and the " +
    "aggregation cannot be changed through the API. Phone Picked reads " +
    "First Picked At instead, so nothing depends on this field.",
};

/* ── the aggregations the schema actually uses ─────────────────────────── */
const blank = (v) => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0);
const num = (v) => (v === true ? 1 : v === false ? 0 : Number(v));
const stamp = (v) => Date.parse(String(v));
const isStamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && /\d{4}-\d\d-\d\d/.test(v);

/* MAX and MIN are the interesting pair: over numbers and dates they do what
   the name says, and over checkboxes Airtable does not compute them at all.
   Recomputing them as "any ticked" is deliberately the ANSWER THE SCHEMA
   MEANT — the disagreement it produces against a blank live value is the
   report, not a bug here. */
const pick = (vals, cmp) => {
  const live = vals.filter((v) => !blank(v));
  if (!live.length) return "";
  if (live.every((v) => typeof v === "boolean")) return live.some(Boolean) ? 1 : 0;
  if (live.every(isStamp))
    return live.reduce((a, b) => (cmp(stamp(b), stamp(a)) ? b : a));
  const ns = live.map(num).filter(Number.isFinite);
  if (ns.length === live.length) return ns.reduce((a, b) => (cmp(b, a) ? b : a));
  return live.map(String).sort()[cmp(1, 0) ? live.length - 1 : 0];
};

const AGG = {
  "MAX(values)": (vals) => pick(vals, (b, a) => b > a),
  "MIN(values)": (vals) => pick(vals, (b, a) => b < a),
  "SUM(values)": (vals) => vals.reduce((n, v) => n + (Number.isFinite(num(v)) ? num(v) : 0), 0),
  "COUNTA(values)": (vals) => vals.filter((v) => !blank(v)).length,
  "COUNTALL(values)": (vals) => vals.length,
  "ARRAYJOIN(values)": (vals) => vals.map((v) => (blank(v) ? "" : String(v))).join(","),
  "ARRAYJOIN(ARRAYCOMPACT(values), ', ')":
    (vals) => vals.filter((v) => !blank(v)).map(String).join(", "),
};
/* Order is not part of the answer for these — Airtable follows link order,
   this follows read order, and "Hema, Shipra" is "Shipra, Hema". */
const SET_JOIN = new Set(["ARRAYJOIN(ARRAYCOMPACT(values), ', ')", "ARRAYJOIN(values)"]);

function agrees(formula, expected, live) {
  const a = Array.isArray(live) && live.length <= 1 ? live[0] : live;
  /* Blank and 0 are the same statement in a base: Airtable omits an empty
     formula result rather than sending 0. */
  if ((blank(a) || a === 0) && (blank(expected) || expected === 0)) return true;
  if (blank(a) || blank(expected)) return false;
  if (SET_JOIN.has(formula)) {
    const parts = (x) => String(x).split(",").map((s) => s.trim()).filter(Boolean).sort().join("|");
    return parts(a) === parts(expected);
  }
  if (isStamp(a) && isStamp(expected)) return Math.abs(stamp(a) - stamp(expected)) < 1000;
  const na = num(a), ne = num(expected);
  if (Number.isFinite(na) && Number.isFinite(ne)) return Math.abs(na - ne) < 1e-6;
  return String(a) === String(expected);
}

/* ── per-row invariants: a formula against the field it is defined from ──
   Each one restates a formula in schema.mjs. If the two ever disagree it is
   because somebody edited the base by hand, or edited the formula and not
   this — either way it is worth the noise. */
const set = (f, k) => (blank(f[k]) ? 0 : 1);
export const INVARIANTS = [
  { table: "Companies", field: "Reached", from: "Last Call At",
    holds: (f) => num(f.Reached || 0) === set(f, "Last Call At") },
  /* THE ONE THIS FILE WAS WRITTEN FOR. */
  { table: "Companies", field: "Phone Picked", from: "First Picked At",
    holds: (f) => num(f["Phone Picked"] || 0) === set(f, "First Picked At") },
  { table: "Companies", field: "Right POC", from: "Right POC Contacts",
    holds: (f) => num(f["Right POC"] || 0) === set(f, "Right POC Contacts") },
  { table: "Companies", field: "Successful Discovery", from: "Discovery Contacts",
    holds: (f) => num(f["Successful Discovery"] || 0) === set(f, "Discovery Contacts") },
  { table: "Companies", field: "SQL", from: "KPI Rank",
    holds: (f) => num(f.SQL || 0) === (num(f["KPI Rank"] || 0) >= MILESTONE.sql.floor ? 1 : 0) },
  { table: "Companies", field: "SQL Meeting Booked", from: "KPI Rank",
    holds: (f) => num(f["SQL Meeting Booked"] || 0) ===
      (num(f["KPI Rank"] || 0) >= MILESTONE.sqlMeetingBooked.floor ? 1 : 0) },
  { table: "Companies", field: "SQL Meeting Done", from: "KPI Rank",
    holds: (f) => num(f["SQL Meeting Done"] || 0) ===
      (num(f["KPI Rank"] || 0) >= MILESTONE.sqlMeetingDone.floor ? 1 : 0) },
];

/* ── the check ─────────────────────────────────────────────────────────── */
const LINKS = FOLLOWUPS.filter((f) => f.field?.type === "multipleRecordLinks");

/* Where a rollup's values come from: the table, and the field on whichever
   side carries the link. Derived from the link declarations rather than
   listed, so a rollup added later is checked without anyone remembering. */
function sourceOf(table, via) {
  const child = LINKS.find((l) => l.field.options.linkedTable === table && l.reverse === via);
  if (child) return { table: child.table, key: child.field.name, side: "child" };
  const fwd = LINKS.find((l) => l.table === table && l.field.name === via);
  if (fwd) return { table: fwd.field.options.linkedTable, key: via, side: "parent" };
  return null;
}

export async function checkKpiData(at, { tables = ["Companies"], sample = 4, log = () => {} } = {}) {
  const rollups = FOLLOWUPS.filter((f) => f.field?.type === "rollup" && tables.includes(f.table));
  const needed = new Set(tables);
  for (const r of rollups) {
    const src = sourceOf(r.table, r.field.options.recordLinkFieldId);
    if (src) needed.add(src.table);
  }

  const rows = {};
  for (const t of needed) {
    log(`  reading ${t}…`);
    rows[t] = await listTolerant(at, t, { pageSize: 100, maxPages: 5000, throwIfMore: true });
  }
  const byId = {};
  for (const t of needed) byId[t] = new Map(rows[t].map((r) => [r.id, r]));

  const findings = [];
  for (const r of rollups) {
    const name = r.field.name, owner = r.table;
    const via = r.field.options.recordLinkFieldId;
    const target = r.field.options.fieldIdInLinkedTable;
    const formula = r.field.options.formula;
    const agg = AGG[formula];
    const src = sourceOf(owner, via);
    if (!agg || !src) {
      findings.push({ kind: "skipped", owner, name,
        note: !agg ? `aggregation ${formula} is not recomputed here` : `no link declared for "${via}"` });
      continue;
    }

    /* Group the source rows by the owner they point at, once per rollup —
       cheap, and the link field differs per rollup. */
    const kids = new Map();
    if (src.side === "child") {
      for (const row of rows[src.table])
        for (const id of row.fields?.[src.key] || [])
          (kids.get(id) || kids.set(id, []).get(id)).push(row);
    } else {
      for (const row of rows[owner])
        kids.set(row.id, (row.fields?.[src.key] || [])
          .map((id) => byId[src.table].get(id)).filter(Boolean));
    }

    let checked = 0, differ = 0, liveSet = 0, wantSet = 0;
    const examples = [];
    for (const row of rows[owner]) {
      const vals = (kids.get(row.id) || []).map((k) => k.fields?.[target]);
      const expected = agg(vals);
      const live = row.fields?.[name];
      checked++;
      if (!blank(live) && live !== 0) liveSet++;
      if (!blank(expected) && expected !== 0) wantSet++;
      if (!agrees(formula, expected, live)) {
        differ++;
        if (examples.length < sample)
          examples.push(`${row.fields?.Name || row.id}: base=${JSON.stringify(live ?? null)} ` +
                        `contacts say ${JSON.stringify(expected)}`);
      }
    }
    if (!differ) continue;
    const dead = liveSet === 0 && wantSet > 0;
    findings.push({ kind: dead ? "dead" : "drift", owner, name, formula,
      via: `${src.table}.${target}`, checked, differ, wantSet, examples,
      known: KNOWN_DEAD[`${owner}.${name}`] || null });
  }

  /* per-row invariants */
  for (const inv of INVARIANTS) {
    if (!rows[inv.table]) continue;
    let differ = 0; const examples = [];
    for (const row of rows[inv.table]) {
      if (inv.holds(row.fields || {})) continue;
      differ++;
      if (examples.length < sample)
        examples.push(`${row.fields?.Name || row.id}: ${inv.field}=` +
          `${JSON.stringify(row.fields?.[inv.field] ?? null)} while ${inv.from}=` +
          `${JSON.stringify(row.fields?.[inv.from] ?? null)}`);
    }
    if (differ)
      findings.push({ kind: "invariant", owner: inv.table, name: inv.field, from: inv.from,
        checked: rows[inv.table].length, differ, examples, known: null });
  }

  const counted = Object.fromEntries(Object.entries(rows).map(([t, r]) => [t, r.length]));
  const faults = findings.filter((f) => (f.kind === "dead" || f.kind === "drift" || f.kind === "invariant") && !f.known);
  return { counted, findings, faults, clean: faults.length === 0 };
}

/* ── run it ────────────────────────────────────────────────────────────── */
export function printKpiData(out) {
  const { counted, findings } = out;
  console.log(Object.entries(counted).map(([t, n]) => `${n} ${t}`).join(", ") + " read.");
  for (const f of findings) {
    if (f.kind === "skipped") { console.log(`  ·  ${f.owner}.${f.name} — not checked: ${f.note}`); continue; }
    if (f.known) {
      console.log(`  ·  ${f.owner}.${f.name} is dead on all ${f.checked} row(s), as expected.`);
      console.log(`       ${f.known}`);
      continue;
    }
    const head = f.kind === "dead"
      ? `DEAD   ${f.owner}.${f.name} is blank or 0 on ALL ${f.checked} row(s), ` +
        `while ${f.wantSet} of them should be set`
      : f.kind === "drift"
        ? `DRIFT  ${f.owner}.${f.name} disagrees on ${f.differ} of ${f.checked} row(s)`
        : `WRONG  ${f.owner}.${f.name} does not follow from ${f.from} on ` +
          `${f.differ} of ${f.checked} row(s)`;
    console.log(`  ✗  ${head}`);
    if (f.via) console.log(`       ${f.formula} over ${f.via}`);
    f.examples.forEach((e) => console.log(`       ${e}`));
    if (f.kind === "dead")
      console.log(`       A rollup's aggregation cannot be set through the API. Fix it in the\n` +
                  `       Airtable UI, or repoint whatever reads it at a field that works.`);
  }
  console.log(out.clean
    ? `\nEvery derived field matches the rows underneath it.`
    : `\n${out.faults.length} derived field(s) do not compute what the schema says.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const PAT = process.env.AIRTABLE_PAT, BASE = process.env.AIRTABLE_BASE;
  if (!PAT || !BASE) { console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...)."); process.exit(1); }
  const at = createAirtable(PAT, BASE, { log: () => {},
    ...(process.env.AIRTABLE_BASE_URL ? { apiUrl: process.env.AIRTABLE_BASE_URL } : {}) });
  const tables = process.argv.includes("--all") ? ["Companies", "Contacts"] : ["Companies"];
  const out = await checkKpiData(at, { tables, log: (s) => process.argv.includes("--json") || console.log(s) });
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else printKpiData(out);
  process.exit(out.clean ? 0 : 1);
}
