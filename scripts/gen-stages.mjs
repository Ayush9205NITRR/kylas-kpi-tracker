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

/* A milestone is a floor, so it must name a real stage. Emitting a rung of
   `undefined` would make every comparison false and read as "nobody ever got
   there" rather than as a broken table. */
const RUNG_OF = Object.fromEntries(S.map((s) => [s.code, s.rung]));
for (const [key, m] of Object.entries(src.milestones || {})) {
  if (!m || !m.floor) throw new Error(`milestone ${key} has no floor stage`);
  if (RUNG_OF[m.floor] === undefined) throw new Error(`milestone ${key} floors on an unknown stage: ${m.floor}`);
  if (!m.label) throw new Error(`milestone ${key} has no label`);
}

/* A retired stage has to name a real destination and a rung it actually
   occupied, or the migration it exists for cannot be derived. */
for (const r of src.retired || []) {
  if (!r.code) throw new Error("a retired stage has no code");
  if (RUNG_OF[r.code] !== undefined) throw new Error(`${r.code} is retired AND still in stages[]`);
  if (!Number.isInteger(r.wasRung) || r.wasRung < 1) throw new Error(`${r.code} has no valid wasRung`);
  if (!r.mapTo) throw new Error(`${r.code} has no mapTo — where should its records go?`);
  if (RUNG_OF[r.mapTo] === undefined) throw new Error(`${r.code} maps to an unknown stage: ${r.mapTo}`);
  /* Down, never up. Mapping a retired stage to a HIGHER rung silently promotes
     every record on it, and past a milestone floor that invents a KPI. */
  if (RUNG_OF[r.mapTo] >= r.wasRung)
    throw new Error(`${r.code} maps UP (rung ${r.wasRung} -> ${RUNG_OF[r.mapTo]}). ` +
                    `A retired stage must map to a lower rung; see docs/stages.json retiredNote.`);
}

/* THE OLD LADDER, reconstructed. Re-inserting each retired stage at the rung
   it occupied gives back the exact numbering the live base was built with, so
   the rank remap is derived from declared data rather than from git history. */
function oldLadder() {
  const list = byRungAsc.map((s) => ({ code: s.code, label: s.label }));
  for (const r of [...(src.retired || [])].sort((a, b) => a.wasRung - b.wasRung))
    list.splice(r.wasRung - 1, 0, { code: r.code, label: r.label, retired: true });
  return list.map((s, i) => ({ ...s, rung: i + 1 }));
}

/* old rung -> new rung. A retired stage's records go to its mapTo; everything
   else keeps its stage and takes that stage's current number. */
function rankRemap() {
  const map = {};
  for (const s of oldLadder()) {
    const to = s.retired
      ? RUNG_OF[(src.retired.find((r) => r.code === s.code) || {}).mapTo]
      : RUNG_OF[s.code];
    if (to !== s.rung) map[s.rung] = to;
  }
  return map;
}

/* One renderer for both outputs, so the two can never disagree. */
function milestoneLines() {
  return Object.entries(src.milestones || {}).map(([key, m]) =>
    `  ${pad(key + ":", 20)} { floor: ${RUNG_OF[m.floor]}, stage: ${q(m.floor)}, label: ${q(m.label)} },`
  ).join("\n");
}

const byRung = [...S].sort((a, b) => a.rung - b.rung);        // 1 first
const byRungAsc = byRung;
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

/* Funnel milestones, as a floor rung each. Rank only rises, so "ever reached"
   and "is at or past" are one question. */
const MILESTONE = {
${milestoneLines()}
};

/* RETIRED, RANK_REMAP and CODE_REMAP are deliberately NOT here. They exist for
   migrating what the Airtable base already stores, which is a job for
   scripts/migrate-ladder.mjs — the console only ever sees current stages, and
   shipping a remap to the browser would invite someone to apply it twice. */
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

/* Funnel milestones, as a floor rung each. See docs/stages.json. */
export const MILESTONE = {
${milestoneLines()}
};

/* Stages removed from the pipeline, and where their records go. The live base
   still holds both their code and the rank numbers from the ladder they were
   part of. See docs/stages.json retiredNote. */
export const RETIRED = ${q(src.retired || [])};

/* Stored KPI Rank remap, old numbering -> current. Derived by reconstructing
   the old ladder from RETIRED[].wasRung, so it cannot drift from the stage
   table. Anything absent here did not move. */
export const RANK_REMAP = ${q(rankRemap())};

/* Stage CODE remap for a value still sitting on a retired stage. */
export const CODE_REMAP = ${q(Object.fromEntries((src.retired || []).map((r) => [r.code, r.mapTo])))};
`);

const remap = rankRemap();
console.log(`${S.length} stages → extension/console/stages.js and scripts/stages.mjs`);
console.log(`  top rung  ${byRung.at(-1).rung}  ${byRung.at(-1).label}`);
console.log(`  bottom    ${byRung[0].rung}  ${byRung[0].label}`);
for (const [key, m] of Object.entries(src.milestones || {}))
  console.log(`  milestone ${pad(key, 18)} rung >= ${RUNG_OF[m.floor]}  (${m.label})`);
for (const r of src.retired || [])
  console.log(`  retired   ${pad(r.code, 18)} was rung ${r.wasRung} -> ${r.mapTo} (rung ${RUNG_OF[r.mapTo]})`);
if (Object.keys(remap).length)
  console.log(`  rank remap  ${Object.entries(remap).map(([a, b]) => `${a}->${b}`).join("  ")}`);
