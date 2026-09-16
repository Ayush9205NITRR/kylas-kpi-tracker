#!/usr/bin/env node
/* Generates the stage tables from docs/stages.json.
 *
 *   node scripts/gen-stages.mjs
 *
 * The console runs in a browser and the scripts run in node, so the same data
 * has to exist in two forms. Generating both from one file is what stops them
 * drifting — a stage renamed in one place and not the other would silently
 * mis-rank contacts. Do not edit the generated files.
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = JSON.parse(readFileSync(new URL("../docs/stages.json", import.meta.url), "utf8"));
const S = src.stages;

/* sanity: the funnel must be a clean 1..24 with unique codes and ids */
const rungs = S.map((s) => s.rung).sort((a, b) => a - b);
const expect = Array.from({ length: S.length }, (_, i) => i + 1);
if (JSON.stringify(rungs) !== JSON.stringify(expect)) throw new Error(`rungs are not 1..${S.length}: ${rungs}`);
for (const key of ["code", "id", "label"]) {
  const seen = S.map((s) => s[key]);
  const dupe = seen.find((v, i) => seen.indexOf(v) !== i);
  if (dupe !== undefined) throw new Error(`duplicate ${key}: ${dupe}`);
}
for (const list of ["cncLadder", "exitStages", "meetingStages", "untouched"])
  for (const code of src[list])
    if (!S.some((s) => s.code === code)) throw new Error(`${list} names an unknown stage: ${code}`);

const byRung = [...S].sort((a, b) => a.rung - b.rung);        // 1 first
const byCall = [...S].sort((a, b) => b.rung - a.rung);        // call order
const q = (s) => JSON.stringify(s);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));

const HEAD = (how) => `/* GENERATED FROM docs/stages.json — do not edit.
   Regenerate with: node scripts/gen-stages.mjs
   ${how} */\n`;

/* ── browser ─────────────────────────────────────────────────────── */
writeFileSync(new URL("../extension/console/stages.js", import.meta.url),
HEAD("Loaded before console.js; everything below is a global.") + `
/* Call order: index 0 is dialled first. Funnel rung is the reverse. */
const STAGES = [
${byCall.map((s) => `  ${q(s.code)},`).join("\n")}
];

/* Kylas sets a picklist by id, not by code. A write sends this number. */
const STAGE_ID = {
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${s.id},`).join("\n")}
};

/* 24 is furthest along. callOrder = 25 - rung, so one list serves both. */
const STAGE_RUNG = {
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${s.rung},`).join("\n")}
};

const STAGE_PRIORITY = Object.fromEntries(
  Object.entries(STAGE_RUNG).map(([code, rung]) => [code, ${S.length + 1} - rung]));

const LABEL = {
  MR: "Mr.", MRS: "Mrs.", MISS: "Miss",
  GOOGLE: "Google", FACEBOOK: "Facebook", LINKEDIN: "LinkedIn",
  EXHIBITION: "Exhibition", COLD_CALLING: "Cold calling",
  JAN_MAR: "Jan–Mar", APR_JUN: "Apr–Jun", JUL_SEP: "Jul–Sep", OCT_DEC: "Oct–Dec",
  OFFICE: "Office", PERSONAL: "Personal", OTHER: "Other",
  MOBILE: "Mobile", WORK: "Work", HOME: "Home",
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${q(s.label)},`).join("\n")}
};

const CNC_LADDER = ${q(src.cncLadder)};
const EXIT_STAGES = ${q(src.exitStages)};
const MEETING_STAGES = ${q(src.meetingStages)};
const UNTOUCHED = ${q(src.untouched)};
`);

/* ── node ────────────────────────────────────────────────────────── */
writeFileSync(new URL("./stages.mjs", import.meta.url),
HEAD("Imported by schema.mjs and the writers.") + `
export const STAGES = [
${byCall.map((s) => `  ${q(s.code)},`).join("\n")}
];

export const STAGE_ID = {
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${s.id},`).join("\n")}
};

export const STAGE_RUNG = {
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${s.rung},`).join("\n")}
};

/* What a person reading the record calls it. */
export const STAGE_LABEL = {
${byCall.map((s) => `  ${pad(s.code + ":", 46)} ${q(s.label)},`).join("\n")}
};

/* [rung, label] lowest first, for the Airtable ladder formula. */
export const LADDER = [
${byRung.map((s) => `  [${s.rung}, ${q(String(s.rung).padStart(2, "0") + " · " + s.label)}],`).join("\n")}
];

export const CNC_LADDER = ${q(src.cncLadder)};
export const EXIT_STAGES = ${q(src.exitStages)};
export const MEETING_STAGES = ${q(src.meetingStages)};
export const UNTOUCHED = ${q(src.untouched)};
`);

console.log(`${S.length} stages → extension/console/stages.js and scripts/stages.mjs`);
console.log(`  top rung  ${byRung.at(-1).rung}  ${byRung.at(-1).label}`);
console.log(`  bottom    ${byRung[0].rung}  ${byRung[0].label}`);
