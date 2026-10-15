#!/usr/bin/env node
/* CAN AN ACCOUNT'S OWNER BE MOVED? — the probe's verdict, in all three worlds.
 *
 *   node scripts/test-owner-endpoint.mjs
 *
 * Ayush, 2026-10-15: "Why are the owner not changing."
 *
 * The answer rests on one live probe —
 * `probe-reassign.mjs --company <id> --reassign-endpoint <userId>` — and the
 * only part of it anybody acts on is the verdict at the bottom. If that
 * sentence is wrong, the wrong thing gets built: either an account cascade
 * against an endpoint that silently does nothing (which is how lucidity lost
 * its owner), or a permanent "cannot be done" against an endpoint that works.
 *
 * So the probe is run against a mock that can BE each of the three worlds, and
 * what is asserted is the conclusion it draws:
 *
 *   404    the path is not there       -> "NEITHER MOVED ... leads endpoint"
 *   lead   contacts yes, companies no  -> "THE METHOD IS RIGHT AND COMPANIES
 *                                          DO NOT EXPOSE IT"
 *   works  both                        -> "THE COMPANY OWNER IS SETTABLE"
 *
 * The `ignore` world — 200 with nothing changed — is the trap this API
 * actually sets, and it must read as a refusal, never as success.
 */
import { spawn, spawnSync } from "node:child_process";

const KY = 9981;
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${d}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
process.on("exit", () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }));

/* One mock per world: MOCK_OWNER_ENDPOINT is read at request time, but the
   company's owner is mutated in memory, so a fresh process per world keeps
   each run's starting state honest. */
const upFor = async (url) => { for (let i = 0; i < 40; i++) {
  try { const r = await fetch(url, { headers: { "api-key": "k" } }); if (r.ok || r.status === 429) return true; }
  catch { /* not yet */ } await sleep(300); } return false; };

/* 1776620 is the mock's account whose contact is owned by the key's user
   (74725), so handing it to 74726 is a real change and the control can run. */
const CO = "1776620", TO = "74726";

async function world(mode) {
  const p = spawn(process.execPath, ["scripts/mock-kylas.mjs"],
    { env: { ...process.env, PORT: String(KY), MOCK_OWNER_ENDPOINT: mode },
      stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
  if (!await upFor(`http://127.0.0.1:${KY}/v1/users/me`)) return { out: "", code: -1 };
  const r = spawnSync(process.execPath,
    ["scripts/probe-reassign.mjs", "--company", CO, "--reassign-endpoint", TO],
    { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
  p.kill();
  await sleep(400);
  return { out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

console.log("\n1 · the path is not there at all");
{
  const { out, code } = await world("404");
  ok("the verdict is that /owner is a leads endpoint", /NEITHER MOVED/.test(out),
     (out.match(/NEITHER MOVED[^\n]*/) || ["(no verdict)"])[0]);
  ok("...and it exits non-zero, so a script cannot read it as a win", code === 1, `exit ${code}`);
  ok("every body it tried is named", /as documented for leads/.test(out) && /the plural path/.test(out));
  ok("...and each one read the record back", (out.match(/owner after/g) || []).length >= 6,
     `${(out.match(/owner after/g) || []).length} readbacks`);
}

console.log("\n2 · 200 with nothing changed — the trap");
{
  const { out, code } = await world("ignore");
  ok("a 200 that moved nothing is called out as exactly that",
     /ACCEPTED AND IGNORED/.test(out), (out.match(/=> ACCEPTED AND IGNORED[^\n]*/) || ["(absent)"])[0]);
  ok("...and is NOT reported as the owner being settable", !/IS SETTABLE/.test(out));
  ok("...and still exits non-zero", code === 1, `exit ${code}`);
}

console.log("\n3 · contacts yes, companies no — what the live account is expected to say");
{
  const { out, code } = await world("lead");
  ok("the control moves, so the method is proved", /=> LANDED/.test(out));
  ok("the verdict separates the method from the entity",
     /THE METHOD IS RIGHT AND COMPANIES/.test(out),
     (out.match(/THE METHOD IS RIGHT[^\n]*/) || ["(no verdict)"])[0]);
  ok("...and says account owners must change in Kylas itself",
     /Kylas' own UI/.test(out) || /own UI/.test(out));
  /* The control is OUR write on somebody's live data. It goes back. */
  ok("the contact the control moved is put back", /control undone\?\s+yes/.test(out),
     (out.match(/control undone\?[^\n]*/) || ["(never said)"])[0]);
  ok("...and the summary repeats it", /control undone\s+: yes/.test(out),
     (out.match(/control undone\s+:[^\n]*/) || [""])[0]);
  ok("it exits non-zero, because the company did not move", code === 1, `exit ${code}`);
}

console.log("\n4 · it works on both — the cascade goes back in");
{
  const { out, code } = await world("works");
  ok("the verdict is that the company owner is settable",
     /THE COMPANY OWNER IS SETTABLE/.test(out),
     (out.match(/THE COMPANY OWNER IS SETTABLE[^\n]*/) || ["(no verdict)"])[0]);
  ok("...and it prints the exact request that worked",
     /PUT \/v1\/companies\/\d+\/owner/.test(out) && /\{"ownerId":\d+\}/.test(out));
  ok("...and notes it does not replace the record",
     /does NOT replace the record/.test(out));
  ok("only then does it exit zero", code === 0, `exit ${code}`);
}

console.log("\n5 · it refuses to conclude from a no-op");
{
  /* Handing the account to the owner its contacts are ALREADY on. The first
     live run of this probe reported LANDED on exactly that, because the
     readback matched without anything having happened. */
  const p = spawn(process.execPath, ["scripts/mock-kylas.mjs"],
    { env: { ...process.env, PORT: String(KY), MOCK_OWNER_ENDPOINT: "works" },
      stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
  if (!await upFor(`http://127.0.0.1:${KY}/v1/users/me`)) ok("the mock came up", false);
  else {
    const r = spawnSync(process.execPath,
      ["scripts/probe-reassign.mjs", "--company", "903", "--reassign-endpoint", "74726"],
      { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    ok("an account already on the target is declared inconclusive",
       /INCONCLUSIVE/.test(out), (out.match(/INCONCLUSIVE[^\n]*/) || ["(no verdict)"])[0]);
    ok("...and never claims it landed", !/IS SETTABLE/.test(out));
    p.kill();
  }
}

console.log("\n6 · a user id that is not a person is refused before anything is written");
{
  const p = spawn(process.execPath, ["scripts/mock-kylas.mjs"],
    { env: { ...process.env, PORT: String(KY), MOCK_OWNER_ENDPOINT: "works" },
      stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
  if (!await upFor(`http://127.0.0.1:${KY}/v1/users/me`)) ok("the mock came up", false);
  else {
    const r = spawnSync(process.execPath,
      ["scripts/probe-reassign.mjs", "--company", CO, "--reassign-endpoint", "999999"],
      { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    ok("an unknown id stops the run", /no user 999999/i.test(out), (out.match(/no user[^\n]*/i) || [""])[0]);
    ok("...before any PUT went out", !/owner after/.test(out));
    const w = spawnSync(process.execPath,
      ["scripts/probe-reassign.mjs", "--company", CO, "--reassign-endpoint", "nobody"],
      { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
    ok("...and so does a value that is not an id at all",
       /wants a Kylas USER ID/.test((w.stdout || "") + (w.stderr || "")));
    p.kill();
  }
}

console.log("\n7 · the company readback must not be blind");
{
  /* GET /v1/companies/{id} does not carry ownerId on the live account — all
     273 companies of the October batch read "owner NONE" through it, and
     aristocrat read "(none)" while the SEARCH said 82867 in the same session.
     The probe read the single GET, saw "(none)" before and after, and called
     it ACCEPTED AND IGNORED. All it had shown was that the field is invisible
     to that read. The owner now comes off the search. */
  const p = spawn(process.execPath, ["scripts/mock-kylas.mjs"],
    { env: { ...process.env, PORT: String(KY), MOCK_OWNER_ENDPOINT: "works",
             MOCK_COMPANY_GET_OWNER: "none" },
      stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
  if (!await upFor(`http://127.0.0.1:${KY}/v1/users/me`)) ok("the mock came up", false);
  else {
    const r = spawnSync(process.execPath,
      ["scripts/probe-reassign.mjs", "--company", CO, "--reassign-endpoint", TO],
      { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    /* The readback now names WHICH key answered — search:ownedBy or
       search:ownerId — because asking for only one of them is how it went
       blind in the first place. */
    ok("the owner is read through the search, not the blind GET",
       /\[via search:(ownedBy|ownerId)\]/.test(out), (out.match(/its owner now[^\n]*/) || ["(absent)"])[0]);
    ok("...so a write that DID land is seen as landing",
       /THE COMPANY OWNER IS SETTABLE/.test(out) && r.status === 0,
       (out.match(/=> [A-Z][^\n]*/) || ["(no verdict)"])[0]);
    p.kill();
  }
  await sleep(400);
}

console.log("\n8 · a control it cannot put back is never started");
{
  /* The live run moved Vaibhav Bhandari off Charu Rathi, who had since been
     DEACTIVATED, and the restore came back 400 — leaving somebody's contact on
     the wrong person. Kylas will not hand a record to an inactive user, so an
     inactive current owner makes the control a one-way trip. */
  const p = spawn(process.execPath, ["scripts/mock-kylas.mjs"],
    { env: { ...process.env, PORT: String(KY), MOCK_OWNER_ENDPOINT: "works",
             MOCK_CONTACT_DEAD_OWNER: "1" },
      stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
  if (!await upFor(`http://127.0.0.1:${KY}/v1/users/me`)) ok("the mock came up", false);
  else {
    const r = spawnSync(process.execPath,
      ["scripts/probe-reassign.mjs", "--company", "1776620", "--reassign-endpoint", TO],
      { env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}` }, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    ok("a contact owned by a deactivated user is refused as the control",
       /DEACTIVATED/.test(out), (out.match(/- \d+ is owned by[^\n]*/) || ["(not refused)"])[0]);
    ok("...and the reason names Kylas' rule, not just 'skipped'",
       /will not give a record back to an inactive user/.test(out));
    ok("...and nothing was written to it",
       !/=> LANDED — the owner is now the target/.test(out.split("2 · THE COMPANY")[0] || ""));
    p.kill();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
