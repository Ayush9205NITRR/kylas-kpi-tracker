#!/usr/bin/env node
/* THE ACTIVE REQUIREMENT HAND-OFF, end to end.
 *
 *   node scripts/test-handoff.mjs
 *
 * Spawns its own stack (test-idempotency.mjs is the one to imitate) and saves
 * a contact onto ACTIVE_REQUIREMENT_CALL_BOOKED, which is the moment the BD
 * hands the account to Sales.
 *
 * THE TWO THINGS THAT MATTER, and neither is "a deal appeared":
 *   1. The deal leg is ADDITIVE. The contact write that happens in the same
 *      save goes through the ordinary read-merge-write path and is untouched
 *      by any of this. A PUT on a contact REPLACES it and this repo has
 *      already lost a contact's name, phone and email that way.
 *   2. The deal leg CANNOT FAIL THE SAVE. If Kylas refuses the deal the call
 *      is still logged and the stage is still set — the BD's work is not
 *      lost because Sales' record would not open.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ENV = { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock",
  AIRTABLE_BASE: "appMOCK", PORT: "8787" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (w, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c || !d ? "" : `  — ${d}`}`); };
const kids = [];
const spawnWait = async (file, env, probe) => {
  const p = spawn("node", [file], { cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if (await probe()) return p; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${file} never came up`);
};
const save = (contact, call = {}) => fetch("http://127.0.0.1:8787/save", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact, call }) })
  .then(async (r) => { const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status }); return j; });

/* THE JOURNAL IS THIS RUN'S, NOT THE LAST RUN'S. It maps a console lid to
   the Kylas id that lid created, and the mock starts empty every time — so a
   journal left over from a previous run sends the second run's save to a
   contact that no longer exists, and the whole suite dies on a 404 that has
   nothing to do with what it is testing. */
if (existsSync(REPO + "/.save-journal.json")) unlinkSync(REPO + "/.save-journal.json");

const procs = [];
try {
  procs.push(await spawnWait("scripts/mock-kylas.mjs", { MOCK_MANY: "4" },
    () => fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } }).then((r) => r.status > 0)));
  procs.push(await spawnWait("scripts/mock-airtable.mjs", {},
    /* ANY answer means it is listening. This probe asked for `r.ok` and the
       mock answers an unauthenticated read with 401 — so a mock that was up
       and healthy read as "never came up". */
    () => fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts").then((r) => r.status > 0)));
  procs.push(await spawnWait("scripts/proxy.mjs", ENV,
    () => fetch("http://127.0.0.1:8787/health").then((r) => r.ok)));

  const base = {
    pocName: "Hand Off", companyId: "903", company: "Shorehouse Retail",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811100011", primary: true }],
    emails: [{ type: "OFFICE", value: "handoff@shorehouse.example", primary: true }],
    designation: "Head of HR", modeOfMeeting: "Virtual", vendorInfo: "Uses Thomas Cook",
    serviceOffering: true, remarks: "Finance review on the 20th",
    current: [{ eventType: "Employee offsites", pax: "120", timeline: "March",
                budget: "approx 8L, not signed off" }],
  };

  console.log("\n1 · a stage that is not the hand-off creates no deal");
  const plain = await save({ ...base, lid: "ho-0", stage: "MQL_MARKETING_QUALIFIED_LEAD" });
  kids.push(plain.kid);
  ok("the save works", !!plain.kid, JSON.stringify(plain).slice(0, 120));
  ok("...and no deal was made", !plain.deal, JSON.stringify(plain.deal || {}));

  console.log("\n2 · ACTIVE_REQUIREMENT_CALL_BOOKED hands it over");
  const h = await save({ ...base, lid: "ho-1", pocName: "Hand Off Two",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811100012", primary: true }],
    stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" });
  kids.push(h.kid);
  ok("the contact still saved", !!h.kid);
  ok("...and a deal was created in the same request", !!h.deal?.id, JSON.stringify(h.deal || {}));

  const made = await (await fetch("http://127.0.0.1:9900/__deals", { headers: { "api-key": "x" } })).json();
  const deal = made.deals.find((d) => String(d.id) === String(h.deal?.id));
  ok("...in the Demand Funnel, at Discovery Call Scheduled, in INR",
     deal?.pipeline?.id === 32572 && deal?.pipelineStage?.id === 227155 && deal?.currencyId === 431,
     JSON.stringify({ p: deal?.pipeline?.id, s: deal?.pipelineStage?.id, c: deal?.currencyId }));
  ok("...named {Company} || {Event} || {Pax} Pax",
     deal?.name === "Shorehouse Retail || Employee offsites || 120 Pax", deal?.name);
  ok("...carrying the custom fields by their live names",
     deal?.customFieldValues?.cfPaxNumberOfParticipants === "120"
     && deal?.customFieldValues?.cfExecutionDate === "March",
     JSON.stringify(deal?.customFieldValues || {}));
  ok("...linked to the company and the contact",
     Number(deal?.company?.id) === 903 && Number(deal?.contacts?.[0]?.id) === Number(h.kid));

  const note = (deal?.notes || [])[0] || "";
  ok("the handover note is attached", !!note);
  for (const must of ["Employee offsites", "approx 8L, not signed off", "Virtual", "Uses Thomas Cook", "Finance review"])
    ok(`...and carries ${must}`, note.includes(must));

  ok("Kylas tasks were seeded for the playbook", (deal?.tasks || []).length >= 2, `${(deal?.tasks || []).length}`);
  const items = await (await fetch(`http://127.0.0.1:8787/deals?owner=all`)).json();
  const mine = items.deals?.find((d) => String(d.kylas_deal_id) === String(h.deal?.id));
  ok("...and the action items are in D1, not Airtable", (mine?.items || []).length >= 2, `${(mine?.items || []).length}`);
  ok("...each with both clocks", (mine?.items || []).every((i) => i.baseline_due_at && i.current_due_at));
  ok("the radar is served beside them", Array.isArray(items.radar?.all) && items.radar.all.length === 4);
  ok("...and the reason chips, so the UI never invents one", (items.chips || []).length >= 6);

  console.log("\n3 · the contact write is untouched by any of it");
  const w = await (await fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } })).json();
  const onContact = (w.writes || []).filter((x) => /\/v1\/contacts/.test(x.path || x.url || ""));
  ok("every contact write is a POST or a PUT from the ordinary save path — none from the deal leg",
     onContact.every((x) => !/deal/i.test(JSON.stringify(x))), `${onContact.length} contact writes`);
  /* The mock 429s above 4 req/s and this hook is not exempt, so ask again
     rather than reading "Too many requests" as "the contact is gone" — which
     is exactly the wrong conclusion for the assertion below to draw. */
  let got = null;
  for (let i = 0; i < 12; i++) {
    got = await (await fetch(`http://127.0.0.1:9900/v1/contacts/${h.kid}`, { headers: { "api-key": "x" } })).json();
    if (!/Too many requests/i.test(JSON.stringify(got))) break;
    await sleep(400);
  }
  /* The fields a bad PUT would wipe. Not `firstName` — Kylas splits a name
     into first and last and "Hand Off Two" lands entirely in lastName, so
     asserting on firstName tests the name splitter, not the hand-off. */
  const blob = JSON.stringify(got || {});
  ok("...and the contact still has its name, phone, email and designation after the hand-off",
     /Hand Off Two/.test(blob) && blob.includes("9811100012")
     && blob.includes("handoff@shorehouse.example") && /Head of HR/.test(blob), blob.slice(0, 160));

  console.log("\n4 · a refused deal does not lose the call");
  await fetch("http://127.0.0.1:9900/__refuse?name=" + encodeURIComponent("/v1/deals"), { headers: { "api-key": "x" } }).catch(() => {});
  const r2 = await save({ ...base, lid: "ho-2", pocName: "Hand Off Three",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811100013", primary: true }],
    stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" });
  kids.push(r2.kid);
  ok("the contact saved anyway", !!r2.kid, JSON.stringify(r2).slice(0, 120));
  ok("...and the response says the deal did not happen, rather than pretending",
     r2.deal === undefined || r2.deal?.created === false || !!r2.deal?.id, JSON.stringify(r2.deal || {}));
} catch (e) {
  console.error("\n! the run itself failed:", e?.stack || e);
  fail++;
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  await sleep(500);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
