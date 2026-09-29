/* The column → type → operator map, asserted against the two places that
 * disagree in practice: the code and the page that documents it.
 *
 * This exists because the failure it catches is silent. A column added to
 * ACOLS with no `ff` block still renders — it just cannot be filtered on, and
 * nobody files that as a bug. A column whose type is changed (Next call was a
 * set of buckets before it was a date) leaves docs/FILTERS.md quietly wrong,
 * which is worse than having no page at all.
 *
 * Run: node scripts/test-filter-types.mjs
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

const views = readFileSync(new URL("../extension/console/views.js", import.meta.url), "utf8");
const doc = readFileSync(new URL("../docs/FILTERS.md", import.meta.url), "utf8");

/* ── the types the builder knows, read off FB_OPS ──────────────────── */
console.log("1. every type the columns claim is a type the builder implements");
const opsBlock = views.slice(views.indexOf("const FB_OPS = {"), views.indexOf("const FB_TYPE_LABEL"));
const TYPES = [...opsBlock.matchAll(/^\s{4}(\w+): \{/gm)].map((m) => m[1]);
ok(`FB_OPS defines ${TYPES.length} types: ${TYPES.join(", ")}`, TYPES.length === 6);
/* Each type's operators, so the doc can be checked against them. */
const opsOf = (t) => {
  const from = opsBlock.indexOf(`\n    ${t}: {`);
  const body = opsBlock.slice(from, opsBlock.indexOf("},", from));
  return [...body.matchAll(/(\w+): "([^"]+)"/g)].map((m) => m[2]);
};
for (const t of TYPES) ok(`  ${t} has operators`, opsOf(t).length >= 4, opsOf(t).join(" · "));

/* Every operator any type offers must be evaluated by fbTest, and must say
   how many values it wants. An operator in the dropdown that fbTest has no
   case for is a filter that silently matches everything. */
console.log("\n2. every operator is declared and evaluated");
const needs = views.slice(views.indexOf("const FB_TYPES = {"), views.indexOf("const FB_INPUT"));
const testBody = views.slice(views.indexOf("function fbTest(co, c) {"), views.indexOf("function fbMatchNode"));
for (const t of TYPES) {
  for (const label of opsOf(t)) {
    const key = [...opsBlock.matchAll(/(\w+): "([^"]+)"/g)].find((m) => m[2] === label)[1];
    ok(`${t}.${key} — declared in FB_TYPES`, new RegExp(`\\b${key}:`).test(needs));
    ok(`${t}.${key} — has a case in fbTest`, new RegExp(`case "${key}"`).test(testBody));
  }
}

/* ── the columns ───────────────────────────────────────────────────── */
console.log("\n3. every column declares a type the builder knows");
const acols = views.slice(views.indexOf("const ACOLS = ["), views.indexOf("const COL_DEFAULTS"));
/* One entry per `{ k: "…", label: "…"`, and the ff.type that follows it. */
const entries = [...acols.matchAll(/\{ k: "(\w+)", label: "([^"]+)"/g)].map((m, i, all) => {
  const from = m.index, to = i + 1 < all.length ? all[i + 1].index : acols.length;
  const type = /ff: \{ type: "(\w+)"/.exec(acols.slice(from, to))?.[1] || null;
  return { k: m[1], label: m[2], type };
});
ok(`${entries.length} columns found`, entries.length >= 17, entries.map((e) => e.k).join(", "));
for (const e of entries) {
  /* THE SILENT ONE. A column with no ff is a column nobody can filter on, and
     it looks exactly like one they can until somebody goes looking. */
  ok(`${e.label} (${e.k}) is filterable`, !!e.type, "no ff block — add one, or say here why not");
  if (e.type) ok(`  ...as ${e.type}`, TYPES.includes(e.type), `FB_OPS has no "${e.type}"`);
}

/* ── the page says the same thing ──────────────────────────────────── */
console.log("\n4. docs/FILTERS.md agrees with the code");
const TYPE_DOC = { text: "Text", enum: "Single select", multi: "Multiple select",
                   num: "Number", date: "Date", link: "Link" };
for (const e of entries) {
  if (!e.type) continue;
  /* The row for this column, as a markdown table line starting with it. */
  const row = doc.split("\n").find((l) => l.startsWith(`| ${e.label} |`));
  ok(`${e.label} has a row`, !!row);
  if (row) ok(`  ...typed ${TYPE_DOC[e.type]}`, row.includes(TYPE_DOC[e.type]),
    `the page says "${row.split("|")[2]?.trim()}"`);
}
/* And the other way: a row on the page for a column that no longer exists. */
const labels = new Set(entries.map((e) => e.label));
const EXTRA = new Set(["Focus list", "Last call, banded", "Days since last call",
                       "column", "field", "type"]);
for (const l of doc.split("\n").filter((x) => /^\| [A-Z]/.test(x)).map((x) => x.split("|")[1].trim()))
  ok(`the page's "${l}" is a real column`, labels.has(l) || EXTRA.has(l),
    "no column by that name — was it renamed?");

/* Each type's operator list is spelled out on the page, verbatim. */
for (const t of TYPES) {
  const want = opsOf(t);
  const line = doc.split("\n").find((l) => l.startsWith(`| **${TYPE_DOC[t]}**`));
  ok(`the page lists ${TYPE_DOC[t]}'s operators`, !!line && want.every((o) => line.includes(o)),
    line ? `missing ${want.filter((o) => !line.includes(o)).join(", ")}` : "no row for this type");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
