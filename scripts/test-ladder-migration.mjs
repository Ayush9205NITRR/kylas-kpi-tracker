#!/usr/bin/env node
/* The ladder migration, end to end against the Airtable stand-in.
 *
 *   node scripts/test-ladder-migration.mjs
 *
 * Starts its own mock, seeds data on the OLD 24-rung ladder, and checks the
 * three things that matter: the dry run writes nothing, the apply leaves every
 * stored rank agreeing with its stage code, and a second run refuses.
 *
 * That last one is the point. The remap is not idempotent — run it twice and a
 * rank of 22 becomes 20 — so "it refuses" is a correctness property, not a
 * convenience.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { STAGE_RUNG, RANK_REMAP } from "./stages.mjs";

const PORT = 9917;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SEED = "/tmp/claude-0/test-ladder-seed.json";
/* ENV_FILE=/dev/null: a real .env.local on the developer's machine must not
   reach a script this test spawns. These already pin AIRTABLE_BASE_URL at the
   mock, so the isolation held by luck — this makes it the rule. */
const env = { ...process.env, ENV_FILE: "/dev/null", AIRTABLE_BASE_URL: BASE_URL, AIRTABLE_PAT: "testpat",
              AIRTABLE_BASE: "appTest", AIRTABLE_GAP: "20" };

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};
const ok = (what, cond) => eq(what, !!cond, true);

/* Contacts as the live base holds them: the rank from the OLD numbering, the
   stage code from the stage they are actually on. */
const CONTACTS = [
  { "Kylas Contact ID": "1", Name: "old SQL",        "KPI Rank": 24, "Current Stage": "SQL_SALES_QUALIFIED_LEAD" },
  { "Kylas Contact ID": "2", Name: "old awaiting",   "KPI Rank": 23, "Current Stage": "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS" },
  { "Kylas Contact ID": "3", Name: "old closing",    "KPI Rank": 22, "Current Stage": "CLOSING_LOOPS_LOW_VALUE" },
  /* The expensive one: left alone, rank 21 now reads as Closing Loops, which
     is the SQL Meeting Done floor — a meeting that never happened. */
  { "Kylas Contact ID": "4", Name: "on the retired stage", "KPI Rank": 21,
    "Current Stage": "RESCHEDULE_PENDING", "Previous Stage": "DISCOVERY_CALL_BOOKED" },
  { "Kylas Contact ID": "5", Name: "no-show",        "KPI Rank": 20, "Current Stage": "GHOSTED" },
  { "Kylas Contact ID": "6", Name: "mql",            "KPI Rank": 14, "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD" },
  { "Kylas Contact ID": "7", Name: "untouched",      "KPI Rank": 0,  "Current Stage": "" },
  { "Kylas Contact ID": "8", Name: "retired exit",   "KPI Rank": 21,
    "Current Stage": "RESCHEDULE_PENDING", "Exit Reason": "RESCHEDULE_PENDING" },
];

writeFileSync(SEED, JSON.stringify({
  Contacts: CONTACTS,
  "Call Log": [{ Key: "k1", "Stage Set": "RESCHEDULE_PENDING" }, { Key: "k2", "Stage Set": "GHOSTED" }],
  "Stage Transitions": [
    { Key: "t1", "From Stage": "DISCOVERY_CALL_BOOKED", "To Stage": "RESCHEDULE_PENDING" },
    { Key: "t2", "From Stage": "RESCHEDULE_PENDING", "To Stage": "CLOSING_LOOPS_LOW_VALUE" },
  ],
  "Schema Migrations": [],
}, null, 1));

const mock = spawn("node", [new URL("./mock-airtable.mjs", import.meta.url).pathname],
  { env: { ...env, PORT: String(PORT), MOCK_AIRTABLE_SEED: SEED }, stdio: "ignore" });
const stop = () => { try { mock.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(900);

const run = (...args) => new Promise((res) => {
  const p = spawn("node", [new URL("./migrate-ladder.mjs", import.meta.url).pathname, ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => res({ code, out }));
});

/* The stand-in rate-limits above 5 requests a second, like the real thing, and
   a 429 comes back as {error} with no records. Reading straight through it was
   giving "Cannot read properties of undefined" and looking like a bug in the
   migration rather than in the test. */
async function rows(table) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE_URL}/appTest/${encodeURIComponent(table)}?pageSize=100`,
      { headers: { Authorization: "Bearer testpat" } });
    const body = await r.json().catch(() => null);
    if (body?.records) return body.records;
    await sleep(400);
  }
  throw new Error(`could not read ${table} from the stand-in`);
}
const contacts = async () => (await rows("Contacts")).map((x) => x.fields);

console.log("the remap itself");
eq("derived from the declared retirement", RANK_REMAP, { 21: 20, 22: 21, 23: 22, 24: 26 });

console.log("\ndry run");
{
  const { code, out } = await run();
  eq("exits 0", code, 0);
  ok("says it wrote nothing", /Dry run — nothing written/.test(out));
  ok("counts every affected row", /8 row\(s\) to change/.test(out));
  ok("names the tables", /5 in Contacts/.test(out) && /2 in Stage Transitions/.test(out));
  ok("shows the destination stage, not just the number", /Closing Loops - Low Value/.test(out));
  const after = await contacts();
  eq("nothing actually changed", after.map((f) => f["KPI Rank"] ?? 0).sort((a, b) => a - b),
     CONTACTS.map((f) => f["KPI Rank"]).sort((a, b) => a - b));
}

console.log("\napply");
{
  const { code, out } = await run("--apply");
  eq("exits 0", code, 0);
  ok("reports the count", /8 row\(s\) updated/.test(out));
  ok("records itself", /Recorded in Schema Migrations/.test(out));

  const after = await contacts();
  /* THE ASSERTION THAT MATTERS: every stored rank now agrees with the rung its
     own stage code sits at. Before the migration, five of these disagreed. */
  const wrong = after.filter((f) => {
    const stage = f["Current Stage"];
    if (!stage) return false;
    return Number(f["KPI Rank"] ?? 0) !== STAGE_RUNG[stage];
  }).map((f) => `${f.Name}: rank ${f["KPI Rank"]} but ${f["Current Stage"]} is rung ${STAGE_RUNG[f["Current Stage"]]}`);
  eq("every rank agrees with its stage", wrong, []);

  const byName = Object.fromEntries(after.map((f) => [f.Name, f]));
  eq("old SQL 24 -> 26", byName["old SQL"]["KPI Rank"], 26);
  eq("old closing 22 -> 21", byName["old closing"]["KPI Rank"], 21);
  eq("retired stage -> GHOSTED", byName["on the retired stage"]["Current Stage"], "GHOSTED");
  eq("and DOWN to rung 20, not up to 21", byName["on the retired stage"]["KPI Rank"], 20);
  eq("no-show untouched", byName["no-show"]["KPI Rank"], 20);
  eq("mql untouched", byName.mql["KPI Rank"], 14);
  eq("untouched stays 0", byName.untouched["KPI Rank"] ?? 0, 0);
  eq("exit reason migrated too", byName["retired exit"]["Exit Reason"], "GHOSTED");
  eq("previous stage left alone when not retired",
     byName["on the retired stage"]["Previous Stage"], "DISCOVERY_CALL_BOOKED");

  /* No record anywhere may still carry the retired code. */
  const other = async (table, field) =>
    (await rows(table)).filter((x) => x.fields[field] === "RESCHEDULE_PENDING").length;
  eq("Call Log clean", await other("Call Log", "Stage Set"), 0);
  eq("Stage Transitions From clean", await other("Stage Transitions", "From Stage"), 0);
  eq("Stage Transitions To clean", await other("Stage Transitions", "To Stage"), 0);
}

console.log("\nsecond run must refuse");
{
  const before = await contacts();
  const { code, out } = await run("--apply");
  eq("exits 0 rather than erroring", code, 0);
  ok("says it is already applied", /Already applied/.test(out));
  ok("explains what a repeat would do", /move every rank down a second time/.test(out));
  ok("says how to force it", /delete that row from Schema Migrations/.test(out));
  const after = await contacts();
  eq("and it changed NOTHING", after.map((f) => f["KPI Rank"] ?? 0), before.map((f) => f["KPI Rank"] ?? 0));
}

console.log("\nwith no Schema Migrations table it refuses to migrate at all");
{
  /* Migrating with nowhere to record it leaves the base one blind re-run away
     from moving every rank a second time. So this must refuse, and it must say
     why rather than just failing.

     The stand-in creates a table on first touch, so MOCK_AIRTABLE_404 is what
     makes a genuinely absent table testable at all. */
  const P2 = PORT + 1;
  const seed2 = SEED.replace(".json", "-notable.json");
  writeFileSync(seed2, JSON.stringify({ Contacts: CONTACTS }, null, 1));
  const m2 = spawn("node", [new URL("./mock-airtable.mjs", import.meta.url).pathname],
    { env: { ...env, PORT: String(P2), MOCK_AIRTABLE_SEED: seed2,
             MOCK_AIRTABLE_404: "Schema Migrations" }, stdio: "ignore" });
  await sleep(900);
  const env2 = { ...env, AIRTABLE_BASE_URL: `http://127.0.0.1:${P2}` };
  const p = await new Promise((res) => {
    const q = spawn("node", [new URL("./migrate-ladder.mjs", import.meta.url).pathname, "--apply"],
      { env: env2, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; q.stdout.on("data", (d) => (out += d)); q.stderr.on("data", (d) => (out += d));
    q.on("close", (code) => res({ code, out }));
  });
  eq("exits non-zero", p.code, 1);
  ok("names the table", /Schema Migrations/.test(p.out));
  ok("says what to run", /repair-base/.test(p.out));
  ok("says why it will not proceed", /twice|second/.test(p.out));

  /* And it wrote nothing. */
  let stale = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`http://127.0.0.1:${P2}/appTest/Contacts?pageSize=100`,
      { headers: { Authorization: "Bearer testpat" } });
    const body = await r.json().catch(() => null);
    if (body?.records) { stale = body.records.map((x) => x.fields["KPI Rank"] ?? 0); break; }
    await sleep(400);
  }
  eq("left the data exactly as it was", stale, CONTACTS.map((f) => f["KPI Rank"]));
  try { m2.kill(); } catch { /* gone */ }
}

stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
