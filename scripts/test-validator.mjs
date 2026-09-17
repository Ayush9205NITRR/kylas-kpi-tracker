#!/usr/bin/env node
/* Checks that validate-schema.mjs fails when it should. A validator that only
   ever says "fine" is worse than none. */
import { writeFileSync, mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAULTS = [
  ["primary field of an illegal type",
   (s) => s.replace('{ name: "Name", type: "singleLineText" },\n      { name: "Kylas Company ID"',
                    '{ name: "Name", type: "checkbox", options: check },\n      { name: "Kylas Company ID"')],
  ["number field with no precision",
   (s) => s.replace('{ name: "Dials", type: "number", options: num },', '{ name: "Dials", type: "number" },')],
  ["duplicate field name",
   (s) => s.replace('{ name: "Owner", type: "singleLineText" },\n      { name: "Current Stage"',
                    '{ name: "Owner", type: "singleLineText" },\n      { name: "owner", type: "singleLineText" },\n      { name: "Current Stage"')],
  ["formula referring to a missing field",
   (s) => s.replace('formula("Companies", "Reached", `IF({Last Call At}, 1, 0)`)',
                    'formula("Companies", "Reached", `IF({Nonexistent Field}, 1, 0)`)')],
  ["rollup through a field that is not a link",
   (s) => s.replace('rollup("Contacts", "Call Count", "Call Log", "Called At", "COUNTA(values)")',
                    'rollup("Contacts", "Call Count", "Owner", "Called At", "COUNTA(values)")')],
  ["rollup onto a column the linked table does not have",
   (s) => s.replace('rollup("Contacts", "Talk Seconds", "Call Log", "Measured Seconds", "SUM(values)")',
                    'rollup("Contacts", "Talk Seconds", "Call Log", "No Such Column", "SUM(values)")')],
  ["formula field declared in createBase instead of afterwards",
   (s) => s.replace('{ name: "Frozen At", type: "dateTime", options: dateTime },',
                    '{ name: "Frozen At", type: "dateTime", options: dateTime },\n      { name: "Oops", type: "formula", options: { formula: "1" } },')],
  ["unbalanced brackets in a formula",
   (s) => s.replace('formula("Contacts", "Is Right POC", `IF({Has Signal} = 1, 1, 0)`)',
                    'formula("Contacts", "Is Right POC", `IF({Has Signal} = 1, 1, 0`)')],
  ["link with no reverse declared",
   (s) => s.replace('link("Call Log", "Contact", "Contacts", "Call Log")',
                    'link("Call Log", "Contact", "Contacts")')],
  ["select with duplicate choices",
   (s) => s.replace('sel("Past", "Current")', 'sel("Past", "Current", "Past")')],
];

/* Resolve against this file, not the shell's cwd: run from the repo root and a
   cwd-relative read dies on ENOENT before a single fault is checked. */
const HERE = import.meta.dirname;
const mine = (f) => join(HERE, f);

const src = readFileSync(mine("schema.mjs"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "schema-"));
copyFileSync(mine("validate-schema.mjs"), join(dir, "validate-schema.mjs"));
/* schema.mjs imports the generated stage tables, so they have to travel with
   it. Without this every run dies on a missing module and each fault looks
   "caught" when nothing was actually validated. */
copyFileSync(mine("stages.mjs"), join(dir, "stages.mjs"));

let pass = 0;
for (const [name, mutate] of FAULTS) {
  const broken = mutate(src);
  if (broken === src) { console.log(`  ?? ${name} — fault did not apply, test is stale`); continue; }
  writeFileSync(join(dir, "schema.mjs"), broken);
  let failed = false, out = "", err = "";
  try { execFileSync("node", [join(dir, "validate-schema.mjs")], { encoding: "utf8" }); }
  catch (e) { failed = true; out = e.stdout || ""; err = e.stderr || ""; }
  const first = (out.match(/ERROR {2}(.+)/) || [])[1] || "";
  /* A crash is not a catch. The run has to fail *with a reported error*,
     otherwise a broken import would make every fault look detected. */
  const caught = failed && Boolean(first);
  console.log(`  ${caught ? "caught " : failed ? "CRASHED" : "MISSED "} ${name}`);
  if (caught) { pass++; console.log(`           ${first.slice(0, 96)}`); }
  else if (failed) console.log(`           ${(err.split("\n").find((l) => l.trim()) || "").slice(0, 96)}`);
}

/* and the real schema must still pass */
let clean = true;
try { execFileSync("node", [mine("validate-schema.mjs")], { encoding: "utf8" }); } catch { clean = false; }
console.log(`\n  ${clean ? "ok     " : "FAILED "} the real schema validates`);
console.log(`\n${pass}/${FAULTS.length} faults caught`);
process.exit(pass === FAULTS.length && clean ? 0 : 1);
