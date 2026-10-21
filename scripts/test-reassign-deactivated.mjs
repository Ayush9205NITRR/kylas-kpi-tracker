#!/usr/bin/env node
/* reassign-deactivated.mjs AGAINST THE MOCK.
 *
 *   node scripts/test-reassign-deactivated.mjs
 *
 * Three companies on a deactivated user (74727), one on an active one; five
 * BDs (MOCK_BD_TEAM) plus an inactive namesake. What must hold: only the
 * deactivated owners' accounts move, round robin, never to the API user,
 * contacts first and with them, every owner read back.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9961, BASE = `http://127.0.0.1:${PORT}`, H = { "api-key": "k" };
const SCRIPT = new URL("./reassign-deactivated.mjs", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${String(d).slice(0, 300)}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchR = async (...a) => { for (let i = 0; ; i++) { try { return await fetch(...a); } catch (e) { if (i >= 2) throw e; await sleep(150); } } };

let mock = null;
async function startMock(extra = {}) {
  if (mock && mock.exitCode === null) { const old = mock; await new Promise((r) => { old.once("exit", r); old.kill(); }); }
  mock = spawn(process.execPath, ["scripts/mock-kylas.mjs"], {
    env: { ...process.env, PORT: String(PORT), MOCK_USER_LIST: "1", MOCK_BD_TEAM: "1",
           MOCK_DEAD_COMPANIES: "903,1778327,1810449", ...extra }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetchR(`${BASE}/v1/companies/903`, { headers: H })).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("mock did not start");
}
process.on("exit", () => mock?.kill());
const get = async (path) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}${path}`, { headers: H });
    if (r.status !== 429) return r.json();
    await sleep(400);
  }
  throw new Error("still throttled");
};
const owner = async (id) => (await get(`/v1/companies/${id}`)).ownerId;
const contactOwner = async (id) => (await get(`/v1/contacts/${id}`)).ownerId;

const dir = mkdtempSync(join(tmpdir(), "reassign-"));
const ids = join(dir, "ids.txt");
writeFileSync(ids, "1776620\n903\n1778327\n1810449\n");
const TEAM = "sejal,anjali,muskan,arshdeep,mayra";
const run = (...a) => {
  const r = spawnSync(process.execPath, [SCRIPT, "--ids", ids, ...a],
    { cwd: dir, env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: BASE }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

console.log("\n1 · the plan");
await startMock();
{
  const d = run("--to", TEAM);
  ok("only the three deactivated owners' companies are planned; the active one is left alone",
     d.code === 0 && /3 companies with a DEACTIVATED owner · 1 with an active owner/.test(d.out), d.out.split("\n").filter((l) => /DEACTIVATED owner/.test(l)).join(" | "));
  ok("a name matches the ACTIVE user, never the inactive namesake", /sejal = 80001/.test(d.out) && !/80006/.test(d.out));
  ok("round robin over ids sorted: 903 -> sejal, 1778327 -> anjali, 1810449 -> muskan",
     /903 .*-> sejal\s+80001/.test(d.out) && /1778327 .*-> anjali\s+80002/.test(d.out) && /1810449 .*-> muskan\s+80003/.test(d.out),
     d.out.split("\n").filter((l) => /->/.test(l)).join(" | "));
  ok("the contacts that would follow are counted, with who holds them", /Contacts that move with their accounts: 1 — now held by: 0 a deactivated user · 0 the API user · 1 an ACTIVE BD/.test(d.out),
     d.out.split("\n").filter((l) => /Contacts that move/.test(l)).join(""));
  ok("the dry run writes nothing", (await owner(903)) === 74727 && (await contactOwner(38470)) === 74726);
  ok("no company or contact names in the output", !/seats|Shorehouse|bbb|Temp|Devanshi/.test(d.out));
}

console.log("\n2 · the names must be right, and never the super admin");
{
  const a = run("--to", "sejal,nobody");
  ok("a name with no active user stops it", a.code === 1 && /"nobody": no active user matches/.test(a.out), a.out.trim());
  const b = run("--to", "sejal,enout");
  ok("the API user / Enout Super Admin is refused as a target", b.code === 1 && /Enout Super Admin/.test(b.out), b.out.trim());
  const c = run("--to", "sejal,80001");
  ok("the same person twice is refused", c.code === 1 && /same user/.test(c.out), c.out.trim());
  const e = run("--to", "80002,80003");
  ok("user ids work too", e.code === 0 && /80002/.test(e.out) && /80003/.test(e.out));
  ok("...and nothing was written by any of these", (await owner(903)) === 74727);
}

console.log("\n3 · the first account");
{
  const r = run("--to", TEAM, "--apply");
  ok("--apply asks how many", r.code === 1 && /--limit 1/.test(r.out));
  const one = run("--to", TEAM, "--apply", "--limit", "1");
  ok("--limit 1 moves exactly one account", one.code === 0 && /OWNER CHECK: 1 account/.test(one.out), one.out.trim().split("\n").slice(-4).join(" | "));
  ok("...903 now Sejal's (80001)", (await owner(903)) === 80001);
  ok("...and its contact moved with it", (await contactOwner(38470)) === 80001);
  ok("...nobody else touched", (await owner(1778327)) === 74727 && (await owner(1810449)) === 74727 && (await owner(1776620)) === 74725);
}

console.log("\n4 · the rest — the split stays even after the stop");
{
  const all = run("--to", TEAM, "--apply", "--all");
  ok("both remaining accounts move", all.code === 0 && /OWNER CHECK: 2 account/.test(all.out), all.out.trim().split("\n").slice(-4).join(" | "));
  const o = [await owner(903), await owner(1778327), await owner(1810449)];
  ok("three different BDs, Sejal not given a second one", new Set(o).size === 3 && o.filter((x) => x === 80001).length === 1, JSON.stringify(o));
  ok("never the API user", !o.includes(74725));
  ok("the active owner's company is still untouched", (await owner(1776620)) === 74725);
  const again = run("--to", TEAM);
  ok("a re-run finds nothing left to move", /0 companies with a DEACTIVATED owner/.test(again.out));
}

console.log("\n5 · Kylas refuses an account's owner: it stops there");
await startMock({ MOCK_OWNER_ENDPOINT: "ignore" });
{
  const r = run("--to", TEAM, "--apply", "--limit", "1");
  ok("an owner that does not read back STOPS the run", r.code === 1 && /STOPPED at 903: its owner reads back as 74727/.test(r.out), r.out.trim().split("\n").slice(-3).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
