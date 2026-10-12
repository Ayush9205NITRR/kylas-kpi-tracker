#!/usr/bin/env node
/* bulk-tag-companies.mjs against a Kylas that behaves three ways.
 *
 *   node scripts/test-bulk-tag.mjs
 *
 * The script writes companies, which is the one write this repo has already
 * got wrong on a live account (lucidity lost its owner, docs/STATE.md §3e).
 * So the mock is made to do exactly that — MOCK_COMPANY_PUT=replace-drop-owner
 * — and the script must refuse, or stop at the first company. Then the two
 * behaviours under which the write is safe, where it must tag every company
 * and keep every owner and every other field.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/bulk-tag-companies.mjs");
const PORT = 9952, BASE = `http://127.0.0.1:${PORT}`;
const TAG = "Lifetime MQL-SQL | October";
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${d}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { "api-key": "k" };

let mock = null;
async function startMock(mode) {
  /* Wait for the old one to be GONE: a new mock that cannot bind the port
     dies quietly, and the old one — other mode, other data — keeps answering. */
  if (mock && mock.exitCode === null) { const old = mock; await new Promise((r) => { old.once("exit", r); old.kill(); }); }
  mock = spawn(process.execPath, ["scripts/mock-kylas.mjs"], {
    env: { ...process.env, PORT: String(PORT), MOCK_COMPANY_PUT: mode }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/v1/companies/903`, { headers: H })).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("mock did not start");
}
process.on("exit", () => mock?.kill());
/* The mock throttles above 4 req/s, as Kylas does — a read here waits it out. */
const co = async (id) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${BASE}/v1/companies/${id}`, { headers: H });
    if (r.status !== 429) return r.json();
    await sleep(400);
  }
  throw new Error("still throttled");
};
const writes = async () => (await (await fetch(`${BASE}/__writes`, { headers: H })).json());

const dir = mkdtempSync(join(tmpdir(), "bulktag-"));
const ids = join(dir, "ids.txt");
writeFileSync(ids, "# test\n1776620\n903\n");
const run = (...a) => {
  const r = spawnSync(process.execPath, [SCRIPT, "--ids", ids, ...a],
    { cwd: dir, env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: BASE }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const clearCanary = () => { try { writeFileSync(join(dir, ".bulk-tag-canary.json"), "{}"); } catch { /* none */ } };

console.log("\n1 · a Kylas that erases the owner (what happened to lucidity)");
await startMock("replace-drop-owner");
{
  const dry = run();
  ok("the dry run lists both and writes nothing", dry.code === 0 && /2 to tag/.test(dry.out), dry.out.split("\n").slice(-3).join(" | "));
  const before = await co(1776620);
  const c = run("--canary");
  ok("the canary fails", c.code === 1 && /NO WRITE KEPT THE OWNER/.test(c.out), c.out.trim().split("\n").slice(-2).join(" | "));
  const w = await writes();
  const made = (w.writes || w).filter?.((x) => x.kind === "company-create") || [];
  const gone = (w.writes || w).filter?.((x) => x.kind === "company-delete") || [];
  ok("...and deletes every test company it made", made.length >= 1 && made.length === gone.length, `${made.length} made, ${gone.length} deleted`);
  const a = run("--apply", "--all");
  ok("--apply refuses after a failed canary", a.code === 1 && /Refusing/.test(a.out), a.out.trim().slice(0, 120));
  const after = await co(1776620);
  ok("...and no real company was touched", JSON.stringify(after) === JSON.stringify(before),
     JSON.stringify(after) === JSON.stringify(before) ? "" : `${JSON.stringify(before).slice(0, 150)} => ${JSON.stringify(after).slice(0, 150)}`);
}

console.log("\n2 · a Kylas that keeps the owner on a replacing update");
await startMock("replace-keep-owner");
clearCanary();
{
  const noCanary = run("--apply", "--limit", "1");
  ok("--apply refuses without a passing canary", noCanary.code === 1 && /Refusing/.test(noCanary.out));
  const c = run("--canary");
  ok("the canary passes, owner left out of the body", c.code === 0 && /PASSED with ownerMode "omit"/.test(c.out), c.out.trim().split("\n").slice(-2).join(" | "));
  const noLimit = run("--apply");
  ok("--apply asks how many", noLimit.code === 1 && /--limit 1/.test(noLimit.out));
  const before = await co(1776620);
  const one = run("--apply", "--limit", "1");
  const a = await co(1776620), b = await co(903);
  ok("--limit 1 tags exactly one", one.code === 0 && /1 tagged/.test(one.out) && !b.customFieldValues?.cfSourceOfData, one.out.trim().split("\n").slice(-2).join(" | "));
  ok("...appending to what was there", a.customFieldValues.cfSourceOfData === `COLD_CALLING + ${TAG}`, a.customFieldValues.cfSourceOfData);
  ok("...owner kept", a.ownerId === before.ownerId, `${before.ownerId} -> ${a.ownerId}`);
  ok("...every other custom field kept", a.customFieldValues.cfBatch === "B-11" && a.customFieldValues.cfAccountHealthBd === "AMBER"
     && a.customFieldValues.cfWebsite === before.customFieldValues.cfWebsite, JSON.stringify(a.customFieldValues).slice(0, 160));
  ok("...name kept", a.name === before.name);
  const snaps = readdirSync(dir).filter((f) => f.startsWith("bulk-tag-snapshot-"));
  ok("a before-image was written", snaps.length === 1 && JSON.parse(readFileSync(join(dir, snaps[0]), "utf8"))[0]?.before?.name === "seats");
  const all = run("--apply", "--all");
  const b2 = await co(903);
  ok("--all does the rest, skipping the tagged one", /1 tagged · 1 skipped/.test(all.out) && b2.customFieldValues.cfSourceOfData === TAG && b2.ownerId === 74726,
     all.out.trim().split("\n").slice(-1)[0]);
  const again = run("--apply", "--all");
  ok("re-running writes nothing", /0 tagged · 2 skipped/.test(again.out));
}

console.log("\n3 · the canary passed, then Kylas starts erasing owners mid-run");
{
  /* The canary file from section 2 still says "passed". The live behaviour
     changes underneath it — the per-company check is what has to catch it. */
  await startMock("replace-drop-owner");
  const r = run("--apply", "--all");
  const a = await co(1776620), b = await co(903);
  ok("it stops at the FIRST company that comes back wrong", r.code === 1 && /STOPPED at 1776620/.test(r.out) && /OWNER IS GONE/.test(r.out),
     r.out.trim().split("\n").filter((l) => /STOPPED|OWNER/.test(l)).join(" | "));
  ok("...and never reaches the second", !b.customFieldValues?.cfSourceOfData && b.ownerId === 74726);
  const latest = readdirSync(dir).filter((f) => f.startsWith("bulk-tag-snapshot-")).sort().pop();
  const snap = JSON.parse(readFileSync(join(dir, latest), "utf8"));
  ok("...the damaged one's before-image holds its owner", a.ownerId == null && snap.length === 1 && snap[0].before.ownerId === 74725,
     `${latest}: ${JSON.stringify(snap.map((x) => [x.id, x.before.ownerId]))}`);
}

console.log("\n4 · the default (merging) mock");
await startMock("merge");
clearCanary();
{
  const c = run("--canary");
  ok("the canary passes", c.code === 0 && /PASSED/.test(c.out));
  const r = run("--apply", "--all");
  ok("both tagged, owners kept", /2 tagged/.test(r.out) && (await co(1776620)).ownerId === 74725 && (await co(903)).ownerId === 74726);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
