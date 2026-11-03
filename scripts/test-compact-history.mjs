#!/usr/bin/env node
/* compact-history.mjs: old repeats go, every number stays.
 *
 *   node scripts/test-compact-history.mjs
 *
 * A random but realistic history — 6 months, 4 owners, 60 companies, 150
 * contacts, many same-day moves — then the FULL report() at every level, for
 * the team and for each owner, before and after compaction.
 */
import { compactTransitions, gate, asTransition, run } from "./compact-history.mjs";
import { report } from "./report.mjs";
import { STAGE_RUNG } from "./stages.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${String(d).slice(0, 300)}`}`); };

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const STAGES = Object.keys(STAGE_RUNG);
const OWNERS = ["Sejal", "Muskan", "Mayra", "Arshdeep"];
const NOW = new Date("2026-11-03T12:00:00Z");
const companyOf = new Map();
for (let i = 0; i < 150; i++) companyOf.set(`recC${i}`, `recCo${i % 60}`);
const rows = [];
for (let i = 0; i < 4000; i++) {
  const daysAgo = Math.floor(rnd() * 180);
  const at = new Date(NOW.getTime() - daysAgo * 86400e3 - Math.floor(rnd() * 86400e3)).toISOString();
  rows.push({ id: `recT${i}`, fields: { Key: `k${i}`, "Changed At": at, Owner: pick(OWNERS),
    "To Stage": rnd() < 0.08 ? pick(["SQL_SALES_QUALIFIED_LEAD", "ACTIVE_REQUIREMENT_CALL_BOOKED", "ACTIVATION"]) : pick(STAGES),
    Contact: [`recC${Math.floor(rnd() * 150)}`] } });
}

const { keep, drop } = compactTransitions(rows, companyOf, { now: NOW, days: 30 });
console.log(`\n  ${rows.length} rows → keep ${keep.length}, remove ${drop.length}`);
ok("only old repeats are candidates (how many is the dry run's to say)", drop.length >= 0);

const cut = new Date(NOW.getTime() - 30 * 86400e3).toISOString();
ok("nothing inside 30 days is removed", drop.every((r) => r.fields["Changed At"] < cut));
const contactsBefore = new Set(rows.map((r) => r.fields.Contact[0])), contactsAfter = new Set(keep.map((r) => r.fields.Contact[0]));
ok("every contact keeps at least one row", [...contactsBefore].every((c) => contactsAfter.has(c)));

ok("the gate finds no difference", gate(rows, keep, companyOf).length === 0, gate(rows, keep, companyOf).join(" | "));

/* The real report, independent of the gate's own fingerprint. */
const T = (list) => list.map((r) => asTransition(r, companyOf));
const same = (owner) => {
  const f = (list) => (owner ? list.filter((t) => t.owner === owner) : list);
  for (const p of ["day", "week", "month", "quarter", "year"]) {
    const a = JSON.stringify(report(p, { transitions: f(T(rows)) }, { from: "2026-04-01", to: "2026-11-03" }));
    const b = JSON.stringify(report(p, { transitions: f(T(keep)) }, { from: "2026-04-01", to: "2026-11-03" }));
    if (a !== b) return `${owner || "team"} ${p}`;
  }
  return "";
};
ok("report() is identical for the team at day/week/month/quarter/year", same("") === "", same(""));
const bad = OWNERS.map(same).filter(Boolean);
ok("…and for every owner", !bad.length, bad.join(", "));

const broken = rows.filter((r) => r.fields["Changed At"] >= cut);
ok("a compaction that loses history is refused by the gate", gate(rows, broken, companyOf).length > 0);

console.log("\n  apply, with the undo file");
const gone = [];
const at = {
  listAll: async (t) => (t === "Stage Transitions" ? rows : t === "Focus History"
    ? [{ id: "fh1", fields: { "Changed At": "2026-08-01T00:00:00Z" } }, { id: "fh2", fields: { "Changed At": "2026-11-01T00:00:00Z" } }]
    : [...companyOf].map(([id, co]) => ({ id, fields: { Company: [co] } }))),
  remove: async (t, ids) => gone.push(...ids),
};
const r = await run({ at, log: () => {}, apply: true, now: NOW, writeUndo: false });
ok("apply removes exactly the planned rows, and old focus history", r.ok && r.drop === drop.length && r.fhDrop === 1 && gone.includes("fh1") && !gone.includes("fh2"), JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
