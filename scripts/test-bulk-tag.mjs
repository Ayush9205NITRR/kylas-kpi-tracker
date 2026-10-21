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

/* spawnSync blocks this process's event loop while the script runs — longer than
   the mock's keep-alive timeout now that the canary does more — so the socket a
   later fetch reuses may already be closed on the other side. Retry once. */
const fetchR = async (...a) => {
  for (let i = 0; ; i++) {
    try { return await fetch(...a); }
    catch (e) { if (i >= 2) throw e; await sleep(150); }
  }
};

let mock = null;
async function startMock(mode, extra = {}) {
  /* Wait for the old one to be GONE: a new mock that cannot bind the port
     dies quietly, and the old one — other mode, other data — keeps answering. */
  if (mock && mock.exitCode === null) { const old = mock; await new Promise((r) => { old.once("exit", r); old.kill(); }); }
  mock = spawn(process.execPath, ["scripts/mock-kylas.mjs"], {
    env: { ...process.env, PORT: String(PORT), MOCK_COMPANY_PUT: mode, ...extra }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetchR(`${BASE}/v1/companies/903`, { headers: H })).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("mock did not start");
}
process.on("exit", () => mock?.kill());
/* The mock throttles above 4 req/s, as Kylas does — a read here waits it out. */
const co = async (id) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}/v1/companies/${id}`, { headers: H });
    if (r.status !== 429) return r.json();
    await sleep(400);
  }
  throw new Error("still throttled");
};
const writes = async () => (await (await fetchR(`${BASE}/__writes`, { headers: H })).json());

const dir = mkdtempSync(join(tmpdir(), "bulktag-"));
const ids = join(dir, "ids.txt");
writeFileSync(ids, "# test\n1776620\n903\n");
const run = (...a) => {
  const r = spawnSync(process.execPath, [SCRIPT, "--ids", ids, ...a],
    { cwd: dir, env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: BASE }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const clearCanary = () => { try { writeFileSync(join(dir, ".bulk-tag-canary.json"), "{}"); } catch { /* none */ } };

console.log("\n1 · a Kylas that erases the owner, and an owner endpoint that cannot put it back");
/* Before 2026-10-15 nothing could put an owner back (lucidity). Now the owner
   endpoint can — so the case that must still refuse is the one where it can't. */
await startMock("replace-drop-owner", { MOCK_OWNER_ENDPOINT: "ignore" });
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
  await startMock("replace-drop-owner", { MOCK_OWNER_ENDPOINT: "ignore" });
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

/* The owner as the search sees it, whatever a single read does with it. */
const ownerBySearch = async (id) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}/v1/search/company?page=0&size=5`, { method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ fields: ["id", "ownerId"], jsonRule: { condition: "AND", valid: true,
        rules: [{ id: "id", field: "id", type: "long", input: "number", operator: "equal", value: id }] } }) });
    if (r.status === 429) { await sleep(400); continue; }
    return ((await r.json()).content || []).find((c) => c.id === id)?.ownerId ?? null;
  }
};

console.log("\n5 · as the live account read on 2026-10-12: a single company read carries no ownerId");
await startMock("replace-keep-owner", { MOCK_COMPANY_GET_OWNER: "none" });
clearCanary();
{
  const dry = run();
  ok("the dry run still finds every owner — through the search", /0 with no owner found/.test(dry.out) && /"search":2/.test(dry.out),
     dry.out.split("\n").filter((l) => /owner (read|found)|no owner/.test(l)).join(" | "));
  ok("...and prints what the record does carry", /owner-like fields on 1776620/.test(dry.out));
  const c = run("--canary");
  ok("the canary can test, and passes", c.code === 0 && /a real BD user/.test(c.out) && /PASSED/.test(c.out), c.out.trim().split("\n").slice(-3).join(" | "));
  const a = run("--apply", "--all");
  ok("both tagged", /2 tagged/.test(a.out), a.out.trim().split("\n").slice(-1)[0]);
  ok("...owners still there, by the search", (await ownerBySearch(1776620)) === 74725 && (await ownerBySearch(903)) === 74726);
}

console.log("\n6 · a single company read carrying the owner as owner: {id, name}");
await startMock("replace-keep-owner", { MOCK_COMPANY_GET_OWNER: "owner" });
clearCanary();
{
  const dry = run();
  ok("read from the owner field", /"owner":2/.test(dry.out) && /0 with no owner found/.test(dry.out),
     dry.out.split("\n").filter((l) => /owner read from/.test(l)).join(""));
  const c = run("--canary");
  ok("the canary passes", c.code === 0 && /a real BD user/.test(c.out) && /PASSED/.test(c.out), c.out.trim().split("\n").slice(-3).join(" | "));
}

console.log("\n7 · nobody knows the owner: the script must not guess");
await startMock("replace-keep-owner", { MOCK_COMPANY_GET_OWNER: "none", MOCK_NO_ID_SEARCH: "1" });
clearCanary();
{
  const c = run("--canary");
  ok("the canary cannot test, so it does not pass", c.code === 1 && /cannot test/.test(c.out) && !/PASSED/.test(c.out),
     c.out.trim().split("\n").filter((l) => /cannot test|refused/.test(l)).join(" | ").slice(0, 200));
  const a = run("--apply", "--all");
  ok("...and --apply refuses", a.code === 1 && /Refusing/.test(a.out));
}

console.log("\n8 · --view: the months from an Airtable view, the owner never touched");
await startMock("replace-keep-owner");
clearCanary();
{
  const AT_PORT = 9953, AT = `http://127.0.0.1:${AT_PORT}`, AH = { authorization: "Bearer x", "content-type": "application/json" };
  const at = spawn(process.execPath, ["scripts/mock-airtable.mjs"], { env: { ...process.env, PORT: String(AT_PORT) }, stdio: ["ignore", "ignore", "inherit"] });
  process.on("exit", () => at.kill());
  for (let i = 0; i < 50; i++) { try { if ((await fetchR(`${AT}/__count`, { headers: AH })).ok) break; } catch { /* not yet */ } await sleep(100); }
  const seed = [["1776620", "lifetime-MQL-SQL October, November"], ["1776620", "lifetime-MQL-SQL December"],
                ["903", "lifetime-MQL-SQL November"], ["", "lifetime-MQL-SQL October"], ["777", "GPTW"]];
  for (const [kid, src] of seed) {
    await fetchR(`${AT}/v0/appCO/Company%20List`, { method: "POST", headers: AH,
      body: JSON.stringify({ records: [{ fields: { "Kylas Company Id": kid, "Source (MQL-SQL)": src } }] }) });
    await sleep(250);
  }
  const env = { AIRTABLE_PAT: "pat", AIRTABLE_API: AT, AIRTABLE_COMPANY_BASE_ID: "appCO" };
  const runV = (...a) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--view", "Oct/Nov/Dec", ...a],
      { cwd: dir, env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: BASE, ...env }, encoding: "utf8" });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const dry = runV();
  ok("the view is read: duplicate rows merged, rows with no id or no month skipped",
     dry.code === 0 && /5 rows -> 2 Kylas companies/.test(dry.out) && /1 rows without a Kylas Company Id/.test(dry.out) && /1 with no month/.test(dry.out), dry.out.split("\n").slice(0, 4).join(" | "));
  ok("...says the owner rule out loud", /OWNER: never read from Airtable, never changed/.test(dry.out));
  ok("...and writes nothing", (await co(1776620)).customFieldValues.cfSourceOfData === "COLD_CALLING");
  const before = await co(1776620), before903 = await co(903);
  const c = runV("--canary");
  ok("the canary passes first", c.code === 0 && /PASSED/.test(c.out), c.out.trim().split("\n").slice(-2).join(" | "));
  const a = runV("--apply", "--all", "--ids-only");
  const x = await co(1776620), y = await co(903);
  ok("no lifetime tag in Kylas: what was there stays, the tag + months are added", x.customFieldValues.cfSourceOfData === "COLD_CALLING + lifetime-MQL-SQL October, November, December", x.customFieldValues.cfSourceOfData);
  ok("an empty source gets 'lifetime-MQL-SQL <month>'", y.customFieldValues.cfSourceOfData === "lifetime-MQL-SQL November", y.customFieldValues.cfSourceOfData);
  ok("OWNERS UNCHANGED on both", x.ownerId === before.ownerId && y.ownerId === before903.ownerId, `${before.ownerId}->${x.ownerId}, ${before903.ownerId}->${y.ownerId}`);
  ok("...and the run says so", /OWNER CHECK: 2 of 2/.test(a.out), a.out.trim().split("\n").slice(-3).join(" | "));
  ok("--ids-only prints no company names", !/seats|Shorehouse/.test(a.out), a.out);
  ok("every other field kept", x.customFieldValues.cfBatch === before.customFieldValues.cfBatch && x.name === before.name);
  const again = runV("--apply", "--all");
  ok("a second run writes nothing", /0 tagged · 2 skipped/.test(again.out), again.out.trim().split("\n").slice(-1)[0]);

  /* Kylas holds the tag with more after it: the months go right after the tag. */
  const cur = await co(903);
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}/v1/companies/903`, { method: "PUT", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ name: cur.name, customFieldValues: { cfSourceOfData: "lifetime-MQL-SQL + Lost Deal (25 Oct | 40 lac)" } }) });
    if (r.status !== 429) break;
    await sleep(400);
  }
  runV("--apply", "--all");
  const z = await co(903);
  ok("lifetime-MQL-SQL with more after it: the month goes right after the tag, the rest stays",
     z.customFieldValues.cfSourceOfData === "lifetime-MQL-SQL November + Lost Deal (25 Oct | 40 lac)", z.customFieldValues.cfSourceOfData);
  ok("...owner still unchanged", z.ownerId === before903.ownerId);
  at.kill();
}

console.log("\n9 · LIVE KYLAS: a company PUT hands the record to the API user");
/* What kylas-airtable-sync saw live (2026-07-01) and the first --view canary
   could not see: its test company already belonged to the API user. */
await startMock("replace-api-owner");
clearCanary();
{
  const c = run("--canary");
  ok("the canary gives its test company to a REAL owner first", /owner 74726 \(a real BD user; the API user is 74725\)/.test(c.out), c.out.trim().split("\n").slice(0, 4).join(" | "));
  ok("...sees Kylas move it, gives it back, and passes", c.code === 0 && /owner endpoint gave it back/.test(c.out) && /PASSED/.test(c.out), c.out.trim().split("\n").slice(-3).join(" | "));
  const b0 = await co(903);
  const r = run("--apply", "--all");
  const b1 = await co(903);
  ok("the real company's owner is the one it had before", b1.ownerId === b0.ownerId && b1.ownerId === 74726, `${b0.ownerId} -> ${b1.ownerId}`);
  ok("...the write took", b1.customFieldValues.cfSourceOfData === TAG, b1.customFieldValues.cfSourceOfData);
  ok("...and the run says the owner was given back", /given back/.test(r.out) && /OWNER CHECK: 2 of 2/.test(r.out), r.out.trim().split("\n").slice(-3).join(" | "));
}

console.log("\n10 · an owner who has been DEACTIVATED: never written");
await startMock("replace-api-owner", { MOCK_COMPANY_DEAD_OWNER: "903" });
clearCanary();
{
  const dry = run();
  ok("the dry run names it", /903 .*owner 74727 is DEACTIVATED/.test(dry.out) && /1 with a deactivated owner/.test(dry.out), dry.out.split("\n").filter((l) => /DEACTIV|deactivated/.test(l)).join(" | "));
  /* Every other company here belongs to the API user, which leaves the canary
     nobody real to test with (correctly). Give 1776620 to an active BD user. */
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}/v1/companies/1776620/owner`, { method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ ownerId: 74726 }) });
    if (r.status !== 429) break;
    await sleep(400);
  }
  const cc = run("--canary");
  ok("the canary tests with the active owner, never the deactivated one", cc.code === 0 && /owner 74726 \(a real BD user/.test(cc.out), cc.out.trim().split("\n").slice(0, 3).join(" | "));
  const r = run("--apply", "--all");
  const b = await co(903);
  ok("it is skipped: not written, owner untouched", !b.customFieldValues?.cfSourceOfData && b.ownerId === 74727, JSON.stringify(b).slice(0, 160));
  ok("...the other company still goes", /1 tagged/.test(r.out) && /1 with a deactivated owner/.test(r.out), r.out.trim().split("\n").slice(-3).join(" | "));
}

console.log("\n11 · Kylas refuses one company (400, as 1773567 did live)");
await startMock("replace-api-owner", { MOCK_COMPANY_PUT_REFUSE: "1776620" });
clearCanary();
{
  run("--canary");
  const a0 = await co(1776620);
  const r = run("--apply", "--all");
  const a1 = await co(1776620), b1 = await co(903);
  ok("the refused one is skipped, unchanged, owner checked", /1776620 — Kylas refused the write/.test(r.out) && JSON.stringify(a1.customFieldValues) === JSON.stringify(a0.customFieldValues) && a1.ownerId === a0.ownerId,
     r.out.split("\n").filter((l) => /refused/.test(l)).join(" | "));
  ok("...and the run goes on to the next", b1.customFieldValues.cfSourceOfData === TAG && b1.ownerId === 74726 && r.code === 0, `${r.code} ${b1.customFieldValues.cfSourceOfData}`);
}

console.log("\n12 · LIVE KYLAS 2026-10-21: the one-field PATCH — the PUT refused, the owner never moved");
await startMock("replace-api-owner", { MOCK_COMPANY_PATCH: "json-patch", MOCK_COMPANY_PUT_REFUSE: "1776620" });
clearCanary();
{
  const c = run("--canary");
  ok("the canary passes with the PATCH, first", c.code === 0 && /PASSED with ownerMode "patch"/.test(c.out) && /the owner was never moved/.test(c.out),
     c.out.trim().split("\n").slice(-4).join(" | "));
  const a0 = await co(1776620), b0 = await co(903);
  const r = run("--apply", "--all");
  const a1 = await co(1776620), b1 = await co(903);
  ok("the company whose PUT Kylas refuses is tagged through the PATCH", a1.customFieldValues.cfSourceOfData === `COLD_CALLING + ${TAG}`, a1.customFieldValues.cfSourceOfData);
  ok("OWNERS NEVER MOVED — nothing given back", a1.ownerId === a0.ownerId && b1.ownerId === b0.ownerId && !/given back/.test(r.out) && /no owner was ever moved/.test(r.out),
     r.out.trim().split("\n").slice(-4).join(" | "));
  const { cfSourceOfData: _x, ...restBefore } = a0.customFieldValues, { cfSourceOfData: _y, ...restAfter } = a1.customFieldValues;
  ok("every other field exactly as it was", JSON.stringify(restBefore) === JSON.stringify(restAfter) && a1.name === a0.name);
  let w;
  for (let i = 0; i < 10 && !Array.isArray(w); i++) { w = (await writes()).writes; if (!Array.isArray(w)) await sleep(400); }  /* a 429 */
  ok("only PATCHes went out — no company PUT at all", w.some((x) => x.kind === "company-patch") && !w.some((x) => x.kind === "company-update"),
     JSON.stringify(w.map((x) => x.kind)));
  ok("...each carrying Source of Data alone", w.filter((x) => x.kind === "company-patch").every((x) => x.body.length === 1 && x.body[0].path === "/customFieldValues/cfSourceOfData"));
}

console.log("\n13 · a DEACTIVATED owner with the PATCH: skipped unless --include-deactivated");
await startMock("replace-api-owner", { MOCK_COMPANY_PATCH: "json-patch", MOCK_COMPANY_DEAD_OWNER: "903" });
clearCanary();
{
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${BASE}/v1/companies/1776620/owner`, { method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ ownerId: 74726 }) });
    if (r.status !== 429) break;
    await sleep(400);
  }
  const c = run("--canary");
  ok("the canary passes with the PATCH", /PASSED with ownerMode "patch"/.test(c.out), c.out.trim().split("\n").slice(-3).join(" | "));
  const r1 = run("--apply", "--all");
  ok("without the flag it is skipped, and says how to include it", !(await co(903)).customFieldValues?.cfSourceOfData && /--include-deactivated writes these/.test(r1.out),
     r1.out.split("\n").filter((l) => /903/.test(l)).join(" | "));
  const r2 = run("--apply", "--all", "--include-deactivated");
  const b = await co(903);
  ok("with it: tagged, and the deactivated owner is still the owner", b.customFieldValues.cfSourceOfData === TAG && b.ownerId === 74727 && /1 of them belong to a deactivated user/.test(r2.out),
     `${b.ownerId} ${b.customFieldValues.cfSourceOfData} | ${r2.out.trim().split("\n").slice(-3).join(" | ")}`);
}

console.log("\n14 · a PATCH that erases the owner is never used");
await startMock("replace-api-owner", { MOCK_COMPANY_PATCH: "json-patch-drop-owner" });
clearCanary();
{
  const c = run("--canary");
  ok("the canary rejects the PATCH", /patch\s+FAILED/.test(c.out) && !/PASSED with ownerMode "patch"/.test(c.out), c.out.trim().split("\n").slice(0, 8).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
