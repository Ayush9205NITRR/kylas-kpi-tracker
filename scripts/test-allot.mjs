#!/usr/bin/env node
/* reassign.mjs allot() — EACH ACCOUNT TO ITS OWN PERSON, WITH ITS PEOPLE.
 *
 *   node scripts/test-allot.mjs
 *
 * Against mock-kylas: 903 on a deactivated user (74727) with one contact an
 * active BD (Priya, 74726) holds; 1776620 on the API user (74725) with one
 * contact of its own and one of Priya's.
 */
import { spawn } from "node:child_process";
import { createClient } from "./kylas.mjs";
import { allot, MAX_ALLOT } from "./reassign.mjs";

const PORT = 9962, BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${String(d).slice(0, 300)}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mock = null;
async function startMock(extra = {}) {
  if (mock && mock.exitCode === null) { const old = mock; await new Promise((r) => { old.once("exit", r); old.kill(); }); }
  mock = spawn(process.execPath, ["scripts/mock-kylas.mjs"], {
    env: { ...process.env, PORT: String(PORT), MOCK_BD_TEAM: "1", MOCK_DEAD_COMPANIES: "903", ...extra }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/v1/companies/903`, { headers: { "api-key": "k" } })).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("mock did not start");
}
process.on("exit", () => mock?.kill());
const kylas = () => createClient("k", { base: BASE, log: () => {}, gap: 120 });
const get = async (path) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${BASE}${path}`, { headers: { "api-key": "k" } });
    if (r.status !== 429) return r.json();
    await sleep(400);
  }
};
const owner = async (id) => (await get(`/v1/companies/${id}`)).ownerId;
const cOwner = async (id) => (await get(`/v1/contacts/${id}`)).ownerId;
const isActive = async (id) => ({ 74725: true, 74726: true, 74727: false, 80001: true, 80005: true })[id] ?? null;

console.log("\n1 · two accounts, two people, contacts an active BD holds stay");
await startMock();
{
  const r = await allot({ kylas: kylas(), apiUser: "74725", isActive,
    assignments: [{ company: 903, ownerId: 80001 }, { company: 1776620, ownerId: 80005 }] });
  ok("both accounts read back with their new owner", r.accounts === 2 && r.results.every((x) => x.ok), JSON.stringify(r.results));
  ok("...in Kylas too", (await owner(903)) === 80001 && (await owner(1776620)) === 80005);
  ok("the API user's contact on 1776620 moved with it", (await cOwner(112936)) === 80005);
  ok("Priya's contacts stayed with Priya (an active BD is working them)", (await cOwner(38470)) === 74726 && (await cOwner(112937)) === 74726);
  ok("...and it says so", r.kept === 2 && r.contacts === 1, JSON.stringify({ kept: r.kept, contacts: r.contacts }));
  ok("each result names where it came from", r.results.find((x) => x.id === "903").from === "74727");
}

console.log("\n2 · leaveActive: false — every contact follows");
await startMock();
{
  const r = await allot({ kylas: kylas(), apiUser: "74725", isActive, leaveActive: false,
    assignments: [{ company: 903, ownerId: 80001 }] });
  ok("the account and Priya's contact both move", r.accounts === 1 && (await cOwner(38470)) === 80001, JSON.stringify(r.results));
}

console.log("\n3 · the previous owner's contacts always follow, even when that owner is active");
await startMock({ MOCK_COMPANY_OWNERS: "1776620:74726" });
{
  const r = await allot({ kylas: kylas(), apiUser: "74725", isActive, assignments: [{ company: 1776620, ownerId: 80001 }] });
  ok("Priya was the account's owner, so her contact moves with it", r.accounts === 1 && (await cOwner(112937)) === 80001, JSON.stringify(r.results));
}

console.log("\n4 · refusals, before anything is written");
await startMock();
{
  const e1 = await allot({ kylas: kylas(), apiUser: "74725", isActive, assignments: [{ company: 903, ownerId: 74725 }] }).catch((e) => e);
  ok("never to the API user", e1 instanceof Error && /never allotted to the API user/.test(e1.message), e1?.message);
  const many = Array.from({ length: MAX_ALLOT + 1 }, (_, i) => ({ company: 1000 + i, ownerId: 80001 }));
  const e2 = await allot({ kylas: kylas(), apiUser: "74725", isActive, assignments: many }).catch((e) => e);
  ok(`more than ${MAX_ALLOT} in one request is refused, not truncated`, e2 instanceof Error && e2.status === 400, e2?.message);
  const e3 = await allot({ kylas: kylas(), assignments: [{ company: 903, ownerId: 80001 }, { company: 903, ownerId: 80005 }] }).catch((e) => e);
  ok("the same account twice is refused", e3 instanceof Error && /twice/.test(e3.message), e3?.message);
  ok("...and nothing moved", (await owner(903)) === 74727);
}

console.log("\n5 · an owner endpoint that answers 200 and does nothing");
await startMock({ MOCK_OWNER_ENDPOINT: "ignore" });
{
  const r = await allot({ kylas: kylas(), apiUser: "74725", isActive, assignments: [{ company: 903, ownerId: 80001 }] });
  ok("the read-back catches it: not ok, and why", r.accounts === 0 && r.failed === 1 && /reads back as 74727/.test(r.results[0].why), JSON.stringify(r.results));
}

console.log("\n6 · an account Kylas cannot find does not stop the others");
await startMock();
{
  const r = await allot({ kylas: kylas(), apiUser: "74725", isActive, assignments: [{ company: 4040404, ownerId: 80001 }, { company: 903, ownerId: 80001 }] });
  ok("404 reported, the other one moved", r.failed === 1 && r.accounts === 1 && (await owner(903)) === 80001, JSON.stringify(r.results));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
