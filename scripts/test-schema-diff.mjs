#!/usr/bin/env node
/* The drift checks, against a synthetic live base.
 *
 *   node scripts/test-schema-diff.mjs
 *
 * The case that matters is the real one: a base carrying the OLD 24-rung
 * ladder, which both verify-base and repair-base reported as clean because
 * neither looked at a formula's text.
 */
import { execSync } from "node:child_process";
import { diffBase, normFormula, wantedFields, cleanExceptExtras } from "./schema-diff.mjs";
import { TABLES, FOLLOWUPS, ladderFormula } from "./schema.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

/* A live base built FROM the schema, so it matches by construction. Field ids
   are invented; the real API supplies them and the diff carries them through
   so a caller can PATCH. */
let n = 0;
const fid = () => "fld" + String(++n).padStart(14, "0");
function liveFromSchema() {
  const tables = TABLES.map((t) => ({
    id: "tbl" + t.name.replace(/\W/g, "").padEnd(14, "x").slice(0, 14),
    name: t.name,
    fields: t.fields.map((f) => ({ id: fid(), name: f.name, type: f.type, options: f.options })),
  }));
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const { table, field, reverse } of FOLLOWUPS) {
    byName.get(table).fields.push({ id: fid(), name: field.name, type: field.type,
      options: field.type === "multipleRecordLinks"
        ? { linkedTableId: byName.get(field.options.linkedTable).id } : field.options });
    if (reverse)
      byName.get(field.options.linkedTable).fields.push(
        { id: fid(), name: reverse, type: "multipleRecordLinks", options: {} });
  }
  return tables;
}
const find = (tables, table, field) =>
  tables.find((t) => t.name === table).fields.find((f) => f.name === field);

console.log("a base that matches");
{
  const d = diffBase(liveFromSchema());
  ok("clean", cleanExceptExtras(d));
  eq("no formula drift", d.formulaDrift.length, 0);
  eq("no missing", d.missingFields.length, 0);
  ok("something was actually compared", d.checked > 40);
}

console.log("\nTHE REAL ONE — the stale 24-rung ladder");
{
  /* The ladder as it was before Reschedule Pending was retired, rebuilt from
     the committed stages.json of the time rather than typed out here. */
  const oldStages = JSON.parse(execSync("git show fb590d3^:docs/stages.json").toString()).stages;
  const oldLadder = [...oldStages].sort((a, b) => a.rung - b.rung)
    .map((s) => [s.rung, String(s.rung).padStart(2, "0") + " · " + s.label]);
  const oldFormula = oldLadder.slice(1).reduceRight(
    (acc, [r, label]) => `IF({KPI Rank} = ${r}, "${label}", ${acc})`, `"${oldLadder[0][1]}"`);

  const tables = liveFromSchema();
  find(tables, "Contacts", "KPI Stage").options = { formula: oldFormula };
  find(tables, "Companies", "KPI Stage").options = { formula: oldFormula };

  const d = diffBase(tables);
  eq("two fields drifted", d.formulaDrift.map((x) => `${x.table}.${x.field}`).sort(),
     ["Companies.KPI Stage", "Contacts.KPI Stage"]);
  ok("nothing reported as missing", !d.missingFields.length);
  ok("nothing reported as the wrong type", !d.wrongType.length);
  ok("the old text is carried, for the report", d.formulaDrift[0].was.includes("Reschedule Pending"));
  ok("the wanted text is carried, for the PATCH", !d.formulaDrift[0].want.includes("Reschedule Pending"));
  ok("the field id is carried, so it can be PATCHed", /^fld/.test(d.formulaDrift[0].id));
  eq("the wanted text is the schema's", normFormula(d.formulaDrift[0].want),
     normFormula(ladderFormula("KPI Rank")));
  /* The point of the whole exercise: a name-and-type check sees nothing here. */
  const nameAndTypeOnly = d.missingFields.length + d.wrongType.length + d.missingTables.length;
  eq("a name-and-type check would have reported NOTHING", nameAndTypeOnly, 0);
}

console.log("\nAIRTABLE'S OWN SHAPE — field ids, not names");
{
  /* Exactly what Ayush's base returned. Every formula came back with ids, and
     the first version of this checker called all 20 of them drifted. */
  const tables = liveFromSchema();
  const names = new Map();
  for (const t of tables) for (const f of t.fields) names.set(f.name, f.id);

  /* Re-express each formula in id form, the way the API hands it back. */
  for (const t of tables)
    for (const f of t.fields)
      if ((f.type === "formula" || f.type === "rollup") && f.options?.formula)
        f.options = { ...f.options,
          formula: f.options.formula.replace(/\{([^}]+)\}/g,
            (whole, n) => (names.has(n) ? `{${names.get(n)}}` : whole)) };

  const d = diffBase(tables);
  eq("NOT drift — the same formula in id form", d.formulaDrift.map((x) => x.field), []);
  eq("nor the rollups", d.rollupDrift.map((x) => x.field), []);
  ok("and the base reads as clean", cleanExceptExtras(d));

  /* And a genuine difference still surfaces through the id form. */
  const f = find(tables, "Companies", "SQL");
  f.options = { formula: `IF({${names.get("KPI Rank")}} >= 22, 1, 0)` };
  eq("a real change still found", diffBase(tables).formulaDrift.map((x) => x.field), ["SQL"]);
}

console.log("\na field name with spaces survives");
{
  eq("braces are left alone", normFormula("IF( {Last Call At} , 1 , 0 )"), "IF({Last Call At},1,0)");
  eq("so is a label", normFormula('IF({R}=1,"19 · Discovery Call Booked","")'),
     'IF({R}=1,"19 · Discovery Call Booked","")');
  /* The bug this replaced: {Last Call At} became {LastCallAt}, so every
     schema formula referenced a field that does not exist. */
  ok("not collapsed", normFormula("{Last Call At}").includes(" "));
}

console.log("\na rollup the API will not describe is NOT drift");
{
  const tables = liveFromSchema();
  /* Ayush's base returns rollups with no formula in options at all. */
  for (const t of tables)
    for (const f of t.fields)
      if (f.type === "rollup") f.options = { recordLinkFieldId: "fldx", fieldIdInLinkedTable: "fldy" };
  const d = diffBase(tables);
  eq("nothing called drifted", d.rollupDrift.length, 0);
  ok("reported as unreadable instead", d.rollupUnreadable.length > 10);
  ok("and that alone does not fail the base", cleanExceptExtras(d));
}

console.log("\nwhitespace is not drift");
{
  const tables = liveFromSchema();
  const f = find(tables, "Companies", "SQL");
  f.options = { formula: "  IF( {KPI Rank}   >= 23 ,\n 1, 0 )  " };
  const d = diffBase(tables);
  /* Airtable reformats what it accepts. Only the whitespace differs here, and
     reporting that would make the check cry wolf on every run. */
  eq("reformatted formula is not drift",
     d.formulaDrift.filter((x) => x.field === "SQL").length, 0);

  const g = find(tables, "Companies", "SQL Meeting Done");
  g.options = { formula: "IF({KPI Rank} >= 22, 1, 0)" };      /* one digit out */
  const d2 = diffBase(tables);
  eq("a changed number IS drift",
     d2.formulaDrift.filter((x) => x.field === "SQL Meeting Done").length, 1);
}

console.log("\nwhitespace INSIDE a label still counts");
{
  const tables = liveFromSchema();
  const f = find(tables, "Contacts", "KPI Stage");
  /* Same formula, one label's spacing changed. The labels are the output of
     this field, so this is a real difference and must not be normalised away. */
  f.options = { formula: ladderFormula("KPI Rank").replace("19 · Discovery", "19 ·  Discovery") };
  const d = diffBase(tables);
  eq("a changed label is drift", d.formulaDrift.filter((x) => x.field === "KPI Stage").length, 1);
}

console.log("\nrollups and choices — detected, not patchable");
{
  const tables = liveFromSchema();
  find(tables, "Contacts", "Has Signal").options = { formula: "SUM(values)" };
  const d = diffBase(tables);
  eq("rollup drift found", d.rollupDrift.map((x) => x.field), ["Has Signal"]);
  eq("it is NOT in formulaDrift", d.formulaDrift.filter((x) => x.field === "Has Signal").length, 0);

  /* These selects hold stage CODES, not labels — sel(...STAGES). Using a label
     here would have tested the wrong thing and passed for the wrong reason. */
  const sel = find(tables, "Contacts", "Current Stage");
  sel.options = { choices: [{ name: "MQL_MARKETING_QUALIFIED_LEAD" },
                            { name: "RESCHEDULE_PENDING" }] };
  const d2 = diffBase(tables);
  const c = d2.choiceDrift.find((x) => x.field === "Current Stage");
  ok("choice drift found", c);
  ok("the retired choice is reported as surplus", c.surplus.includes("RESCHEDULE_PENDING"));
  ok("the absent ones are listed", c.absent.includes("SQL_SALES_QUALIFIED_LEAD"));
}

console.log("\nmissing things");
{
  const tables = liveFromSchema();
  const co = tables.find((t) => t.name === "Companies");
  co.fields = co.fields.filter((f) => f.name !== "SQL");
  const d = diffBase(tables);
  eq("missing field found", d.missingFields.map((x) => x.field.name), ["SQL"]);

  const gone = tables.filter((t) => t.name !== "Daily Snapshot");
  eq("missing table found", diffBase(gone).missingTables, ["Daily Snapshot"]);

  /* A wrong type is not something a script may fix: changing a field's type
     through the API discards what is in it. */
  const tables2 = liveFromSchema();
  find(tables2, "Contacts", "KPI Rank").type = "singleLineText";
  const d3 = diffBase(tables2);
  eq("wrong type found", d3.wrongType.map((x) => `${x.field}:${x.was}`), ["KPI Rank:singleLineText"]);
}

console.log("\nextras are named, never touched");
{
  const tables = liveFromSchema();
  tables.find((t) => t.name === "Contacts").fields.push(
    { id: fid(), name: "Ayush's own notes", type: "singleLineText" });
  const d = diffBase(tables);
  eq("extra named", d.extra.map((x) => x.field), ["Ayush's own notes"]);
  eq("and it is not drift", d.formulaDrift.length + d.missingFields.length, 0);
}

console.log("\nthe schema itself");
{
  const w = wantedFields();
  ok("every formula field has formula text",
     w.filter((x) => x.field.type === "formula").every((x) => x.field.options?.formula));
  ok("the ladder no longer mentions the retired stage",
     !ladderFormula("KPI Rank").includes("Reschedule Pending"));
  ok("the ladder tops out at 23", ladderFormula("KPI Rank").includes("= 23,"));
  ok("and has no rung 24", !ladderFormula("KPI Rank").includes("= 24,"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
