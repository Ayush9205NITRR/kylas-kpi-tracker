/* THE SPEC HAS TO STAY TRUE.
 *
 *   node scripts/test-kpi-spec.mjs
 *
 * docs/kpi-spec.md §0 is the one table the team reads to settle "what counts
 * as worked". A spec that drifts from the code is worse than no spec: it is
 * read with confidence and it is wrong. So every claim §0 makes is asserted
 * here against the source it came from — the floors, the no-answer list, which
 * rungs repeat per period and which are once-ever, and what Right POC and
 * Discovery actually require.
 *
 * If this fails, ONE of the two is wrong. Decide which, then fix that one —
 * do not edit the test to agree with whichever you looked at last.
 */
import { readFileSync } from "node:fs";

const stages = readFileSync("extension/console/stages.js", "utf8");
const report = readFileSync("scripts/report.mjs", "utf8");
const views = readFileSync("extension/console/views.js", "utf8");
const spec = readFileSync("docs/kpi-spec.md", "utf8");

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

/* ── the no-answer list ─────────────────────────────────────────────── */
console.log("\n1. what counts as a no-answer, for Picked");
const NOT_CONNECTED = JSON.parse(stages.match(/const NOT_CONNECTED = (\[[^\]]*\])/)[1]);
const EXPECTED = ["YET_TO_BE_MINED", "CNC_COULD_NOT_CONNECT", "CNC_COULD_NOT_CONNECT_2",
                  "CNC_COULD_NOT_CONNECT_3", "FOLLOWUP_CNC"];
ok("the code lists exactly the five the spec names",
   JSON.stringify(NOT_CONNECTED) === JSON.stringify(EXPECTED), JSON.stringify(NOT_CONNECTED));
for (const s of EXPECTED) ok(`  the spec names ${s}`, spec.includes(s));
/* The one everybody gets wrong: somebody answered and asked to be rung back,
   so it is a connect. */
ok("CONNECT_LATER is NOT a no-answer, so it counts as Picked",
   !NOT_CONNECTED.includes("CONNECT_LATER"));
ok("...and the spec says so in as many words",
   /CONNECT_LATER.*counts as\s*\*?\*?Picked/s.test(spec));

/* ── the SQL floors ─────────────────────────────────────────────────── */
console.log("\n2. the three SQL floors");
const floors = {};
for (const [, k, f] of stages.matchAll(/(\w+):\s*\{ floor: (\d+)/g)) floors[k] = Number(f);
for (const [name, key, want] of [
  ["SQL booked", "sqlMeetingBooked", 23],
  ["SQL done", "sqlMeetingDone", 25],
  ["SQL", "sql", 26],
]) {
  ok(`${name} is rung >= ${want} in the code`, floors[key] === want, String(floors[key]));
  ok(`...and the spec says >= ${want}`, new RegExp(`rung ≥ ${want}`).test(spec));
}

/* ── per-period vs once-ever ────────────────────────────────────────── */
console.log("\n3. which rungs repeat, and which arrive once");
const kind = {};
for (const [, k, , kd] of report.matchAll(/\{ key: "(\w+)", label: "([^"]*)", kind: "(\w+)" \}/g)) kind[k] = kd;
/* THE SPLIT THAT EXPLAINS ALMOST EVERY "WRONG" NUMBER. */
ok("Worked is a per-period touch", kind.worked === "touch", kind.worked);
ok("Picked is a per-period touch", kind.picked === "touch", kind.picked);
for (const k of ["right", "discovery", "booked", "done", "sql"])
  ok(`${k} is a once-ever first arrival`, kind[k] === "first", kind[k]);
ok("Calls logged and Calls picked are flows, not rungs",
   kind.calls === "flow" && kind.connects === "flow");
ok("the spec draws the per-period / once-ever line",
   /PER-PERIOD activity.*ONCE-EVER arrivals/s.test(spec));

/* ── what the two data rungs require ────────────────────────────────── */
console.log("\n4. Right POC and Discovery");
ok("Right POC is budget OR timeline OR pax",
   /filled\(r\.budget\) \|\| filled\(r\.timeline\) \|\| filled\(r\.pax\)/.test(views));
ok("Discovery is budget AND timeline AND pax, on ONE row",
   /filled\(r\.budget\) && filled\(r\.timeline\) && filled\(r\.pax\)/.test(views));
ok("the spec says OR for Right POC", /budget \*\*OR\*\* timeline|\*\*budget OR timeline OR pax\*\*/.test(spec));
ok("the spec says AND for Discovery, on one row",
   /\*\*budget AND timeline AND pax\*\*/.test(spec) && /one single row/.test(spec));

/* ── how worked and picked are emitted ──────────────────────────────── */
console.log("\n5. what fires each of the bottom two");
ok("Worked fires on ANY transition", /out\.push\(\{ metric: "worked"/.test(report));
ok("Picked fires only when the stage landed on is not a no-answer",
   /if \(!NOT_CONNECTED\.includes\(t\.to\)\)/.test(report));

/* ── Reached is not a ladder rung ───────────────────────────────────── */
console.log("\n6. Reached");
ok("Reached means at least one call logged",
   /reached:\s*\{ label: "Reached",\s*sub: "at least one call logged"/.test(views));
ok("the spec says it is not a ladder rung",
   /\*\*Reached\*\* is not a ladder rung/.test(spec));

/* ── one name per rung, still ───────────────────────────────────────── */
console.log("\n7. no rung is named two things");
const RUNG = {};
for (const [, k, v] of views.match(/const RUNG = \{[\s\S]*?\n  \};/)[0]
  .matchAll(/(\w+):\s*\{ label: "([^"]*)"/g)) RUNG[k] = v;
const byLabel = {};
for (const [k, v] of Object.entries(RUNG)) (byLabel[v] = byLabel[v] || []).push(k);
const dupes = Object.entries(byLabel).filter(([, ks]) => ks.length > 1);
ok("no two rungs share a label", dupes.length === 0, JSON.stringify(dupes));
/* The ladder, the funnel, the buckets and the email all read from RUNG. The
   ladder's own list was missed the first time and kept the long old names. */
ok("the ladder builds its rows from RUNG", /const RUNGS = LADDER_ORDER\.map/.test(views));
ok("the report's labels match RUNG's",
   /{ key: "worked", label: "Worked"/.test(report) && /{ key: "booked", label: "SQL booked"/.test(report));

/* ── the stages themselves ──────────────────────────────────────────── */
/* Ayush, 2026-10-04: "check for pipeline stages, check also for all the
   ambiguity which I asked — there should not be any alteration." These were
   run by hand once; run by hand once is how the ladder kept its long names
   for a week after they were supposedly fixed. */
console.log("\n8. the pipeline stages");
const label = {};
for (const [, k, v] of stages.matchAll(/^  "?([A-Z0-9_–]+)"?:\s+"([^"]*)",$/gm)) label[k] = v;
const byStageLabel = {};
for (const [k, v] of Object.entries(label)) (byStageLabel[v] = byStageLabel[v] || []).push(k);
const stageDupes = Object.entries(byStageLabel).filter(([, ks]) => ks.length > 1);
ok(`${Object.keys(label).length} stages, no two sharing a display name`,
   stageDupes.length === 0, JSON.stringify(stageDupes));

const families = JSON.parse(stages.match(/const STAGE_FAMILIES = (\[.*?\]);/s)[1]);
const homes = {};
for (const f of families) for (const s of f.stages) (homes[s] = homes[s] || []).push(f.key);
ok("no stage sits in two families",
   Object.entries(homes).filter(([, k]) => k.length > 1).length === 0,
   JSON.stringify(Object.entries(homes).filter(([, k]) => k.length > 1)));
const famNames = families.map((f) => f.label);
ok("no two families share a name", new Set(famNames).size === famNames.length, famNames.join(" | "));
for (const s of Object.keys(homes))
  ok(`  ${s} has a display name`, !!label[s]);

console.log("\n9. the long names are gone, and stay gone");
/* Each of these was a second name for a state that already had one. They were
   removed on 2026-09-30, and the ladder's copy survived until 10-01 because
   nothing asserted their absence. */
for (const old of ["Right POC connected", "Successful discovery call",
                   "SQL meeting booked", "SQL meeting done", "Reached only",
                   "Companies worked", "Companies picked"])
  ok(`"${old}" appears in no live label`,
     !new RegExp(`name: "${old}"|label: "${old}"`).test(views + report));

console.log("\n10. every derived list is built from RUNG, not written out again");
for (const [what, re] of [
  ["FUNNEL", /const FUNNEL = RUNG_ORDER\.map/],
  ["BUCKETS", /const BUCKETS = \[\.\.\.RUNG_ORDER\]/],
  ["STEPS", /const STEPS = RUNG_ORDER\.slice/],
  ["RUNGS, the ladder's own", /const RUNGS = LADDER_ORDER\.map/],
  /* The sixth list. Progress stopped at SQL booked, so the two rungs the
     funnel exists to reach were on the ladder and missing from the table
     beside it — and it kept "→ Booked" while everything else said
     "SQL booked", because nothing checked this one either. */
  ["COUNT_COLS, the Progress table", /const COUNT_COLS = \[\{ key: "calls".*\n\s*\.\.\.LADDER_ORDER\.map/],
  ["RATE_COLS, its conversions", /const RATE_COLS = LADDER_ORDER\.slice\(1\)/],
]) ok(`${what} is built from RUNG`, re.test(views));

console.log("\n11. Progress shows the WHOLE ladder");
/* LADDER_ORDER must be declared before every list that reads it — left where
   the ladder used it, Progress was a dead reference at module load. */
ok("LADDER_ORDER is declared before the lists that use it",
   views.indexOf("const LADDER_ORDER") < views.indexOf("const COUNT_COLS") &&
   views.indexOf("const LADDER_ORDER") < views.indexOf("const RUNGS"));
const ladder = JSON.parse((views.match(/const LADDER_ORDER = (\[[^\]]*\])/) || [])[1]
  .replace(/'/g, '"'));
for (const k of ["worked", "picked", "right", "discovery", "booked", "done", "sql"])
  ok(`  ${k} is on the ladder, so it is in Progress too`, ladder.includes(k));
ok("seven rungs, no more and no fewer", ladder.length === 7, String(ladder.length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
