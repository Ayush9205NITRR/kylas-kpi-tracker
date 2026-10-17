#!/usr/bin/env node
/* A DEMO OF THE DUPLICATE CHECK, YOU CAN READ THE ANSWER OFF THE SCREEN.
 *
 *   node scripts/demo-dedupe.mjs
 *
 * Runs the REAL code — the Worker's /check-contact and /save routes, the real
 * dedupe.mjs, the real journal on a real SQLite — against the Kylas and Airtable
 * MOCKS. No live account is touched and no live data is shown. What the mocks
 * stand in for is stated at the top of the output, and so is what they cannot
 * tell you.
 *
 * Every scenario prints what was checked, which sources answered and what each
 * found, the verdict, every match with WHY it matched, and what the save will do.
 * The last table says, per scenario, what was expected and what came back.
 */
import { spawn } from "node:child_process";
import worker from "../worker/index.mjs";
import { fakeD1 } from "./d1-fake.mjs";
import { createAirtable } from "./airtable.mjs";
import { checkContact } from "./dedupe.mjs";
import { renderVerdict } from "./dedupe-report.mjs";

const KY = 9981, AT = 9982;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const kids = [];
process.on("exit", () => kids.forEach((k) => { try { k.kill("SIGKILL"); } catch { /* gone */ } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (url, headers) => { for (let i = 0; i < 50; i++) {
  try { const r = await fetch(url, { headers }); if (r.ok || r.status === 429) return true; } catch { /* not yet */ }
  await sleep(250); } return false; };
const start = (script, port, env = {}) => { const p = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "ignore", "inherit"] }); kids.push(p); return p; };

start("scripts/mock-kylas.mjs", KY);
start("scripts/mock-airtable.mjs", AT);
if (!await up(`http://127.0.0.1:${KY}/__writes`, { "api-key": "k" }) || !await up(`http://127.0.0.1:${AT}/__count`, { Authorization: "Bearer x" })) {
  console.error("! the mocks did not start"); process.exit(1);
}

const ENV = { KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}`, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK",
              AIRTABLE_BASE_URL: `http://127.0.0.1:${AT}`, VERSION: "demo", ALLOWED_ORIGIN: ORIGIN, AUTH: "none", DB: fakeD1() };
/* The Worker narrates itself to the console (auth warnings, cache notes). Useful
   in production, noise in a demo, so it is muted for the length of each request. */
const realLog = console.log;
const call = async (path, body) => { console.log = () => {}; try { return await callQuiet(path, body); } finally { console.log = realLog; } };
const callQuiet = (path, body) => worker.fetch(new Request(`https://bd.enout.website${path}`, {
  method: "POST", headers: { Origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }), ENV, { waitUntil() {} });
const at = createAirtable("pat_mock", "appMOCK", { apiUrl: `http://127.0.0.1:${AT}`, log: () => {} });
const tables = async () => (await fetch(`http://127.0.0.1:${AT}/__writes`, { headers: { Authorization: "Bearer x" } }).then((r) => r.json())).tables;

/* ── the world the demo runs in ─────────────────────────────────────────
   Kylas mock (already seeded by the mock itself):
     Hema Bharathi    9876501234  hema@seats.aero          company 1776620  owner 74725
     Shipra Gupta     9811122233  shipra@seats.aero        company 1776620  owner 74726
     Devanshi Kalro   9920477103  d.kalro@shorehouse...    company 903      owner 74726
   Airtable copy (what the hourly sync has seen): Hema, Shipra, and ONE contact
   Kylas does not have, Rohit Menon. Devanshi is deliberately NOT in the copy —
   she is the contact somebody created in Kylas since the last sync. */
const seedContact = (kid, name, phone, email, owner, ownerId, company) => at.upsert("Contacts", "Kylas Contact ID", {
  "Kylas Contact ID": String(kid), Name: name, Phone: phone, Phones: JSON.stringify([{ type: "MOBILE", value: phone, primary: true }]),
  Email: email, Emails: JSON.stringify([{ type: "OFFICE", value: email, primary: true }]),
  Owner: owner, "Kylas Owner ID": String(ownerId), "Company Kylas ID": String(company) });
await fetch(`http://127.0.0.1:${AT}/__reset`, { headers: { Authorization: "Bearer x" } });
await seedContact(112936, "Hema Bharathi", "9876501234", "hema@seats.aero", "Enout Super Admin", 74725, 1776620);
await seedContact(112937, "Shipra Gupta", "9811122233", "shipra@seats.aero", "Vaibhav Bhandari", 74726, 1776620);
await seedContact(555001, "Rohit Menon", "9000011111", "rohit@acme.example", "Enout Super Admin", 74725, 777);

const line = "─".repeat(100);
console.log(`\n${"═".repeat(100)}\nDUPLICATE CHECK · DEMO\n${"═".repeat(100)}`);
console.log(`
WHAT THIS RUNS     the real /check-contact and /save routes, the real dedupe code, the real journal.
WHAT IT RUNS AGAINST   a MOCK Kylas and a MOCK Airtable. No live data. Names and numbers below are fixtures.
WHAT IT CANNOT TELL YOU   whether Kylas' own free-text search reaches phone numbers on YOUR account. The mock says
                   it does. On the live account run, once:
                       node --env-file=.env.local scripts/dedupe.mjs --phone <a number you know is in Kylas>
                   and read the "Kylas search" line: "0 real matches" for a known number means it does not,
                   and the Airtable copy is then the only thing catching phones.

THE WORLD          Kylas has:           Hema Bharathi · Shipra Gupta · Devanshi Kalro
                   Airtable copy has:   Hema Bharathi · Shipra Gupta · Rohit Menon      (Devanshi was created in Kylas after the last sync;
                                                                                         Rohit is in the copy and not in Kylas)
`);

/* ── part 1 · the check, as the console asks it while a contact is typed ── */
const person = (name, phone, email, o = {}) => ({ pocName: name, companyId: o.companyId ?? "1776620", ownerId: o.ownerId ?? 74725,
  owner: "Enout Super Admin", phones: phone ? [{ type: "MOBILE", cc: "+91", value: phone, primary: true }] : [],
  emails: email ? [{ type: "OFFICE", value: email, primary: true }] : [] });
const SCEN = [
  ["A brand-new person",                       person("Anita Desai", "9123456780", "anita@newco.example"),                 "clear"],
  ["The same person, added a second time",     person("Hema Bharathi", "9876501234", "hema@seats.aero"),                   "existing"],
  ["Same person, number typed another way",    person("Hema Bharathi", "+91 98765-01234", ""),                             "existing"],
  ["Same person, email in capitals",           person("Hema Bharathi", "9000000009", "HEMA@SEATS.AERO"),                   "existing"],
  ["Somebody else's phone number",             person("Karan Mehta", "9811122233", "karan@seats.aero"),                    "flag"],
  ["Somebody else's email address",            person("Neha Kapoor", "9222233334", "shipra@seats.aero"),                   "flag"],
  ["Same person, but at a different company",  person("Hema Bharathi", "9876501234", "", { companyId: "903" }),             "flag"],
  ["Created in Kylas since the last sync",     person("Devanshi Kalro", "9920477103", "", { companyId: "903", ownerId: 74726 }), "existing"],
  ["In the Airtable copy, not in Kylas",       person("Rohit Menon", "9000011111", "", { companyId: "777" }),              "existing"],
  ["No phone and no email to check with",      person("Pooja Rao", "", ""),                                                "unverified"],
];
const got = [];
console.log(`${line}\nPART 1 · IS ANYBODY ALREADY HOLDING THIS PHONE OR EMAIL?   (what the console shows while a new contact is typed)\n${line}`);
let i = 0;
for (const [label, card, want] of SCEN) {
  i++;
  const r = await call("/check-contact", { contact: card });
  const v = await r.json();
  got.push({ label, want, got: v.verdict, action: v.action, kinds: (v.flags || []).map((f) => f.kind) });
  console.log(`\n▶ ${i}. ${label}`);
  console.log(renderVerdict(card, v, { indent: "    " }));
}

/* ── part 2 · when a source is down ──────────────────────────────────── */
console.log(`\n${line}\nPART 2 · WHEN A SOURCE CANNOT ANSWER   (the check must say so, and must never block a save over it)\n${line}`);
{
  const card = person("Hema Bharathi", "9876501234", "hema@seats.aero");
  const airtable = createAirtable("pat_mock", "appMOCK", { apiUrl: `http://127.0.0.1:${AT}`, log: () => {} });
  const kylasDown = { contactsMatching: async () => { throw new Error("GET /v1/search/contact -> 503: upstream timed out"); } };
  const kylasUp = { contactsMatching: async () => [] };
  const airtableDown = { listAll: async () => { throw new Error("GET /Contacts -> 503: Airtable is unavailable"); } };
  const cases = [
    ["Kylas search is down, the Airtable copy is up", { airtable, kylas: kylasDown }, "existing"],
    ["The Airtable copy is down, Kylas search is up (and finds nothing)", { airtable: airtableDown, kylas: kylasUp }, "clear"],
    ["BOTH are down", { airtable: airtableDown, kylas: kylasDown }, "unverified"],
  ];
  for (const [label, src, want] of cases) {
    i++;
    const v = await checkContact({ card, ...src, log: () => {} });
    got.push({ label, want, got: v.verdict, action: v.action, kinds: v.flags.map((f) => f.kind) });
    console.log(`\n▶ ${i}. ${label}`);
    console.log(renderVerdict(card, v, { indent: "    " }));
  }
}

/* ── part 3 · what a SAVE does about it ──────────────────────────────── */
console.log(`\n${line}\nPART 3 · WHAT A SAVE DOES ABOUT IT   (the real /save route; the server decides, whatever the console sent)\n${line}`);
const base = (lid, p) => ({ lid, kid: "", pendingCreate: true, stage: "MQL_MARKETING_QUALIFIED_LEAD", past: [], current: [], remarks: "",
  ...p, nextCallDate: "2026-10-22", nextCallTime: "11:00" });
const saveChecks = [];
const step = async (label, body, expect) => {
  i++;
  const r = await call("/save", body);
  const j = await r.json();
  const verdict = r.status === 409 ? "BLOCKED" : r.status === 200 && j.created ? "CREATED" : r.status === 200 ? "UPDATED" : `HTTP ${r.status}`;
  console.log(`\n▶ ${i}. ${label}`);
  console.log(`    HTTP ${r.status}  →  ${verdict}${j.kid ? `   new Kylas id ${j.kid}` : ""}`);
  if (r.status === 409) console.log(`    reason: ${j.error}`);
  if (j.duplicate?.kinds) console.log(`    flags kept: ${j.duplicate.kinds.join(", ")}   (recorded in Airtable: ${j.duplicate.recorded})`);
  saveChecks.push({ label, want: expect, got: verdict });
  return { r, j };
};
const creates = async () => (await fetch(`http://127.0.0.1:${KY}/__writes`, { headers: { "api-key": "k" } }).then((r) => r.json())).writes.filter((w) => w.kind === "create").length;
const before = await creates();
const hema2 = base("demo-hema2", person("Hema Bharathi", "9876501234", "hema@seats.aero"));
await step("Add Hema Bharathi again → the save is refused, and nothing is created", { contact: hema2, call: { at: new Date().toISOString(), outcome: "No answer", duration: 0 } }, "BLOCKED");
const after = await creates();
console.log(`    Kylas contacts created by that refused save: ${after - before}`);
saveChecks.push({ label: "…and Kylas really received no create call", want: "0 created", got: `${after - before} created` });
await step("…the associate says \"Create anyway\" → it is created, and logged for review", { contact: { ...hema2, dupeOverride: true }, call: { at: new Date().toISOString(), outcome: "No answer", duration: 0 } }, "CREATED");
const clash = base("demo-karan", person("Karan Mehta", "9811122233", "karan@seats.aero"));
await step("Karan Mehta, using Shipra's phone number → created, with a flag for an admin", { contact: clash }, "CREATED");
const fresh = base("demo-anita", person("Anita Desai", "9123456780", "anita@newco.example"));
const first = await step("Anita Desai, a clean new contact → created, nothing flagged", { contact: fresh }, "CREATED");
const again = await step("The same save is retried after its reply was lost → NOT refused, no second contact", { contact: fresh }, "UPDATED");
console.log(`    (same Kylas id both times: ${first.j.kid === again.j.kid ? "yes" : "NO"})`);
saveChecks.push({ label: "…and the retry reused the same contact", want: "same id", got: first.j.kid === again.j.kid ? "same id" : "different" });

/* ── what was kept ───────────────────────────────────────────────────── */
console.log(`\n${line}\nWHAT WAS KEPT   (read back from the Airtable table an admin would open)\n${line}`);
{
  const t = await tables();
  const flags = t["Duplicate Flags"] || [];
  console.log(`\nDuplicate Flags table: ${flags.length} row(s)`);
  for (const f of flags.map((x) => x.fields))
    console.log(`  • ${f.Contact.padEnd(16)} ${f.Kind.padEnd(14)} ${f.Status}   ${f.Why}`);
  const flagged = (t.Contacts || []).map((x) => x.fields).filter((f) => f["Duplicate Flag"]);
  console.log(`\nContacts flagged on the contact itself: ${flagged.length}`);
  for (const f of flagged) console.log(`  • ${String(f.Name || "").padEnd(16)} Duplicate Flag = ${f["Duplicate Flag"]}`);
  const clean = (t.Contacts || []).map((x) => x.fields).find((f) => f.Name === "Anita Desai");
  console.log(`\nThe clean contact (Anita Desai) carries no flag: ${clean && !clean["Duplicate Flag"] ? "yes" : "NO"}`);
  saveChecks.push({ label: "flags recorded for the override and the phone clash", want: "2+ rows", got: flags.length >= 2 ? "2+ rows" : `${flags.length}` });
  saveChecks.push({ label: "the clean contact carries no flag", want: "no flag", got: clean && !clean["Duplicate Flag"] ? "no flag" : "flagged" });
}

/* ── the answer, in one table ────────────────────────────────────────── */
console.log(`\n${"═".repeat(100)}\nRESULT\n${"═".repeat(100)}\n`);
console.log(`${"#".padEnd(5)}${"SCENARIO".padEnd(70)}${"EXPECTED".padEnd(12)}${"GOT".padEnd(12)}`);
let ok = 0, n = 0;
for (const g of [...got, ...saveChecks]) {
  n++;
  const pass = g.want === g.got;
  if (pass) ok++;
  console.log(`${pass ? "✔" : "✘"} ${String(n).padStart(2)} ${g.label.slice(0, 68).padEnd(70)}${String(g.want).padEnd(12)}${String(g.got).padEnd(12)}`);
}
console.log(`\n${ok} of ${n} behaved as designed.${ok === n ? "" : "   ← at least one did not; read that scenario's block above."}\n`);
process.exit(ok === n ? 0 : 1);
