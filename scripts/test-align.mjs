#!/usr/bin/env node
/* align.mjs — every contact on an account goes to whoever owns the account.
 *
 *   node scripts/test-align.mjs
 *
 * classify() on fixtures; then verify() and the fix (allot() to the owner the
 * account already has, keepOwner) against mock-kylas.
 */
import { spawn } from "node:child_process";
import { createClient } from "./kylas.mjs";
import { allot, companyOwnerOf, contactsOfCompany } from "./reassign.mjs";
import { classify, verify, offAccounts } from "./align.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${String(d).slice(0, 300)}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n0 · one contact crawl, joined to the accounts");
{
  const accts = [{ id: "1", owner: "80001" }, { id: "2", owner: "80005" }];
  const cs = [{ id: 11, ownerId: 80001, company: 1 }, { id: 12, ownerId: { id: 74725 }, company: { id: 1 } },
              { id: 21, ownerId: 80001, company: 2 }, { id: 22, ownerId: 74726, company: 2 },
              { id: 31, ownerId: 80001, company: 3 }, { id: 41, ownerId: 80001 }];
  const off = offAccounts(accts, cs);
  ok("names the accounts with a contact on somebody else, most first", off.map((o) => o.id).join() === "2,1", JSON.stringify(off));
  ok("...with who holds each, lookups read as ids", off[1].off[0].id === "12" && off[1].off[0].from === "74725");
  ok("contacts on accounts not in the list, or on none, are ignored", !off.some((o) => o.id === "3"));
}

console.log("\n1 · what is fixed and what is only reported");
const users = { 80001: { active: true }, 80005: { active: true }, 74726: { active: true }, 74727: { active: false } };
const userOf = async (id) => users[id] || null;
const ppl = [{ id: 1, ownerId: 80001 }, { id: 2, ownerId: { id: 74725 } }, { id: 3, ownerId: null }];
const f = await classify({ owner: "80001", people: ppl, apiUser: "74725", userOf });
ok("account on an active BD: fix, every contact not theirs — Super Admin's and unowned too", f.status === "fix" && f.move.map((m) => m.id).join() === "2,3", JSON.stringify(f));
ok("account on the Super Admin: reported, not fixed", (await classify({ owner: "74725", people: ppl, apiUser: "74725", userOf })).status === "super-admin");
ok("account on a deactivated user: reported, not fixed", (await classify({ owner: "74727", people: ppl, apiUser: "74725", userOf })).status === "deactivated");
ok("account with no owner: reported", (await classify({ owner: "", people: ppl, apiUser: "74725", userOf })).status === "no-owner");
ok("everyone already on the owner: aligned", (await classify({ owner: "80001", people: [ppl[0]], apiUser: "74725", userOf })).status === "aligned");

console.log("\n2 · against Kylas (mock)");
const PORT = 9963, BASE = `http://127.0.0.1:${PORT}`;
const mock = spawn(process.execPath, ["scripts/mock-kylas.mjs"], {
  env: { ...process.env, PORT: String(PORT), MOCK_BD_TEAM: "1", MOCK_DEAD_COMPANIES: "903" }, stdio: ["ignore", "ignore", "inherit"] });
process.on("exit", () => mock.kill());
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/v1/companies/903`, { headers: { "api-key": "k" } })).ok) break; } catch { /* not yet */ } await sleep(100); }
const kylas = createClient("k", { base: BASE, log: () => {}, gap: 120 });
const get = async (path) => { for (let i = 0; i < 10; i++) { const r = await fetch(`${BASE}${path}`, { headers: { "api-key": "k" } }); if (r.status !== 429) return r.json(); await sleep(400); } };
const mockUsers = async (id) => ({ 74725: { active: true }, 74726: { active: true }, 74727: { active: false }, 80001: { active: true }, 80005: { active: true } })[id] || null;

/* 1776620: on the Super Admin, one contact of its own and one of Priya's (74726). */
let v = await verify({ kylas, items: ["1776620", "903", "999999"], apiUser: "74725", userOf: mockUsers, companyOwnerOf, contactsOfCompany });
ok("an account on the Super Admin is reported, not fixed", v[0].status === "super-admin", JSON.stringify(v[0]));
ok("an account on a deactivated user is reported", v[1].status === "deactivated", JSON.stringify(v[1]));
ok("a deleted account is skipped", v[2].status === "gone", JSON.stringify(v[2]));

/* Allot it to Mayra keeping Priya's contact — the state the check exists for. */
await allot({ kylas, apiUser: "74725", isActive: async (id) => (await mockUsers(id))?.active ?? null, leaveActive: true,
  assignments: [{ company: 1776620, ownerId: 80005 }] });
ok("set-up: Priya's contact stayed with Priya", (await get("/v1/contacts/112937")).ownerId === 74726);
v = await verify({ kylas, items: ["1776620"], apiUser: "74725", userOf: mockUsers, companyOwnerOf, contactsOfCompany });
ok("now it is a fix: Priya's contact is on somebody other than the account's owner", v[0].status === "fix" && v[0].owner === "80005" &&
   v[0].move.length === 1 && v[0].move[0].id === "112937" && v[0].move[0].from === "74726", JSON.stringify(v[0]));
/* keepOwner: a check that still thinks the account is Sejal's must not hand it back. */
const stale = await allot({ kylas, apiUser: "74725", leaveActive: false, keepOwner: true, assignments: [{ company: v[0].id, ownerId: 80001 }] });
ok("keepOwner: an account no longer on that person is left alone", !stale.results[0].ok && stale.results[0].contactsMoved === 0 &&
   (await get("/v1/companies/1776620")).ownerId === 80005 && (await get("/v1/contacts/112937")).ownerId === 74726, JSON.stringify(stale.results[0]));
const known = await verify({ kylas, items: [{ id: "1776620", owner: "80005" }], apiUser: "74725", userOf: mockUsers, companyOwnerOf, contactsOfCompany });
ok("an owner from the crawl skips the account read and decides the same", known[0].status === "fix" && known[0].move.length === 1, JSON.stringify(known[0]));
const r = await allot({ kylas, apiUser: "74725", leaveActive: false, keepOwner: true, assignments: [{ company: v[0].id, ownerId: v[0].owner }] });
ok("the fix moves the contact and leaves the account where it was", r.results[0].ok && r.results[0].from === "80005" && r.results[0].contactsMoved === 1, JSON.stringify(r.results[0]));
ok("...in Kylas: the contact is on the account's owner", (await get("/v1/contacts/112937")).ownerId === 80005);
ok("...the account's owner unchanged", (await get("/v1/companies/1776620")).ownerId === 80005);
v = await verify({ kylas, items: ["1776620"], apiUser: "74725", userOf: mockUsers, companyOwnerOf, contactsOfCompany });
ok("checked again: aligned", v[0].status === "aligned", JSON.stringify(v[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
