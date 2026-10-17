#!/usr/bin/env node
/* THE NIGHTLY PUSH LEAVES A RECORD, AND THE RECORD IS TRUE.
 *
 *   node scripts/test-push-track.mjs
 *
 * Every scenario runs the real push-kylas run() against the Kylas and Airtable
 * mocks and then reads the Push Log and Field Map TABLES BACK, because "the log
 * says pushed" is only worth anything if the log is what a person opens.
 *
 *   happy path        every value lands, is read back from Kylas, and says Pushed
 *   a quiet second night   nothing differs, so no contact rows — only the run row
 *   DROPPED           Kylas answers 200 and stores nothing: Partly pushed, named
 *   UNMAPPED          the account has no such field: counted, run row names it
 *   REFUSED           Kylas 400s the whole contact: Not pushed, with its message
 *   a dry run         writes nothing, records nothing
 *   no table          the Push Log being absent is said, and never fails a push
 */
import { spawn } from "node:child_process";
import { run } from "./push-kylas.mjs";
import { createAirtable } from "./airtable.mjs";
import { recordPush, storeFieldMap, readPushLog, summarisePush } from "./push-log.mjs";
import { summarise, renderText } from "./digest.mjs";

const KY = 9971, AT = 9972;
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${d}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: "Bearer x", "content-type": "application/json" };
const kids = [];
process.on("exit", () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }));

const up = async (url, headers) => { for (let i = 0; i < 40; i++) {
  try { const r = await fetch(url, { headers }); if (r.ok || r.status === 429) return true; } catch { /* not yet */ }
  await sleep(250); } return false; };
const spawnMock = (script, port, env = {}) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p); return p;
};
let kylasProc = null;
const kylasWith = async (env = {}) => {
  if (kylasProc) { kylasProc.kill(); await sleep(250); }
  kylasProc = spawnMock("scripts/mock-kylas.mjs", KY, env);
  if (!await up(`http://127.0.0.1:${KY}/__writes`, { "api-key": "k" })) throw new Error("the Kylas mock did not start");
};

spawnMock("scripts/mock-airtable.mjs", AT);
if (!await up(`http://127.0.0.1:${AT}/__count`, H)) { console.error("! the Airtable mock did not start"); process.exit(1); }

const ENV = { KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}`, AIRTABLE_PAT: "pat_mock",
              AIRTABLE_BASE: "appMOCK", AIRTABLE_BASE_URL: `http://127.0.0.1:${AT}` };
const at = createAirtable("pat_mock", "appMOCK", { apiUrl: ENV.AIRTABLE_BASE_URL, log: () => {} });
const tables = async () => (await fetch(`http://127.0.0.1:${AT}/__writes`, { headers: H }).then((r) => r.json())).tables;
const rowsOf = async (t) => ((await tables())[t] || []).map((r) => r.fields);
const reset = () => fetch(`http://127.0.0.1:${AT}/__reset`, { headers: H });

/* The console's side: two contacts that exist in the Kylas mock, each with a
   call-back, one with an offsite timeline that derives to a quarter. */
const seed = async () => {
  await reset();
  const a = await at.upsert("Contacts", "Kylas Contact ID", { Name: "Hema Bharathi", "Kylas Contact ID": "112936", "Next Call Date": "2026-10-20", "Next Call Time": "10:00" });
  await at.upsert("Contacts", "Kylas Contact ID", { Name: "Shipra Gupta", "Kylas Contact ID": "112937", "Next Call Date": "2026-10-22" });
  await at.upsert("Event Rows", "Row Key", { "Row Key": "r1", Contact: [a.id], Period: "Current", "Event Type": "Offsite", Timeline: "Aug, week 2" });
};
const go = async (opts = {}) => {
  const lines = [];
  const out = await run({ env: ENV, log: (...x) => lines.push(x.join(" ")), apply: true, ...opts });
  return { out, text: lines.join("\n") };
};

console.log("\n1 · a whole account: every value lands, and is read back");
{
  await kylasWith();
  await seed();
  const r = await go();
  ok("both contacts were written", r.out.wrote === 2, JSON.stringify(r.out));
  ok("...and both were verified by reading the record back", r.out.pushed === 2 && r.out.partly === 0 && r.out.notPushed === 0, JSON.stringify(r.out));
  const log = await rowsOf("Push Log");
  const contactRows = log.filter((x) => x.Contact !== "(run)");
  ok("the Push Log has a row per contact", contactRows.length === 2, JSON.stringify(log.map((x) => x.Contact)));
  ok("...each says Pushed and Verified", contactRows.every((x) => x.Status === "Pushed" && x.Verified === true));
  const hema = contactRows.find((x) => x["Kylas ID"] === "112936");
  ok("a contact with both values names both as pushed", /Next call/.test(hema?.Pushed) && /Offsite/.test(hema?.Pushed), hema?.Pushed);
  const detail = JSON.parse(hema?.Detail || "[]");
  ok("the detail has the value sent and the value read back", detail.every((d) => d.sent !== undefined && d.got !== undefined && d.s === "pushed"), hema?.Detail);
  const runRow = log.find((x) => x.Contact === "(run)");
  ok("there is a (run) row, and it is not flagged", runRow && runRow.Status === "Pushed" && runRow.Verified === true, JSON.stringify(runRow));
  const fm = await rowsOf("Field Map");
  ok("the Field Map table was written, one row per datum", fm.length >= 14, String(fm.length));
  const nc = fm.find((x) => x.Key === "nextCall");
  ok("...next call: mapped, to the field this account calls it", nc?.Status === "mapped" && nc["Kylas Field"] === "cfNextCallDate", JSON.stringify(nc));
  ok("...and it records WHEN it last pushed", !!nc?.["Last Pushed At"]);
  ok("...offsite is mapped to its picklist", fm.find((x) => x.Key === "offsite")?.Status === "mapped");
  ok("...nothing in the map is flagged", !fm.some((x) => ["unmapped", "type", "unknown"].includes(x.Status)), JSON.stringify(fm.filter((x) => x.Status !== "mapped" && x.Status !== "assumed").map((x) => x.Key)));
}

console.log("\n2 · a quiet second night");
{
  const before = (await rowsOf("Push Log")).length;
  const r = await go();
  ok("nothing differed, so nothing was written", r.out.wrote === 0 && r.out.changed === 0, JSON.stringify(r.out));
  const after = await rowsOf("Push Log");
  /* The run row is keyed on the minute, so a second run in the same minute
     replaces it rather than adding one — which is why this asks for "no new
     CONTACT rows", not for a particular total. */
  ok("...so no contact rows were added", after.filter((x) => x.Contact !== "(run)").length === 2 && after.length >= before, `${before} -> ${after.length}`);
  ok("...and there is a run row for the night", after.some((x) => x.Contact === "(run)"));
}

console.log("\n3 · DROPPED: Kylas answers 200 and stores nothing");
{
  await kylasWith({ MOCK_DROP_FIELD: "cfOffsiteTimelineBdNew" });
  await seed();
  const r = await go();
  ok("both PUTs were accepted", r.out.wrote === 2 && r.out.failed === 0, JSON.stringify(r.out));
  ok("...but only the contact with no offsite is fully pushed", r.out.pushed === 1 && r.out.partly === 1, JSON.stringify(r.out));
  const row = (await rowsOf("Push Log")).find((x) => x["Kylas ID"] === "112936");
  ok("Hema is Partly pushed", row?.Status === "Partly pushed", JSON.stringify(row));
  ok("...the next call landed", /Next call/.test(row?.Pushed || ""));
  ok("...the offsite did not, and the row says so", /Offsite/.test(row?.["Not Pushed"] || ""), row?.["Not Pushed"]);
  ok("...with the reason in plain words", /holds nothing/.test(row?.Reason || ""), row?.Reason);
  ok("...and it is not Verified", row?.Verified === false);
  const fm = (await rowsOf("Field Map")).find((x) => x.Key === "offsite");
  ok("the Field Map remembers the last error for that datum", /holds nothing/.test(fm?.["Last Error"] || ""), JSON.stringify(fm));
  const s = summarisePush(await readPushLog(at, { fromIso: "2000-01-01T00:00:00Z", toIso: "2100-01-01T00:00:00Z" }));
  ok("the digest's reader sees one partly pushed", s?.partly === 1 && s.problems[0]?.what.includes("Hema"), JSON.stringify(s));
  const text = renderText(summarise([], { day: "2026-10-16", push: s }));
  ok("...and the morning mail names the contact and the reason", /Hema/.test(text) && /holds nothing/.test(text), text);
}

console.log("\n4 · UNMAPPED: the account has no such field");
{
  await kylasWith({ MOCK_NO_FIELD: "cfOffsiteTimelineBdNew" });
  await seed();
  const r = await go();
  ok("the push still goes for the field that exists", r.out.wrote === 2 && r.out.pushed === 2, JSON.stringify(r.out));
  ok("...and counts the contact that had a value with nowhere to put it", r.out.unmapped === 1, String(r.out.unmapped));
  ok("the map problem is reported by the run", r.out.mapProblems.some((p) => p.key === "offsite" && p.status === "unmapped"), JSON.stringify(r.out.mapProblems));
  const run = (await rowsOf("Push Log")).find((x) => x.Contact === "(run)");
  ok("the run row is flagged and names the field", run?.Status !== "Pushed" && /Offsite quarter/.test(run?.Reason || ""), JSON.stringify(run));
  ok("the Field Map says unmapped", (await rowsOf("Field Map")).find((x) => x.Key === "offsite")?.Status === "unmapped");
  ok("the log line says it out loud", /field map: Offsite quarter — unmapped/.test(r.text), r.text.slice(0, 300));
}

console.log("\n5 · REFUSED: Kylas rejects the contact");
{
  await kylasWith({ MOCK_PUT_REFUSE: "112936" });
  await seed();
  const r = await go();
  ok("one write failed, the other did not", r.out.failed === 1 && r.out.wrote === 1, JSON.stringify(r.out));
  const row = (await rowsOf("Push Log")).find((x) => x["Kylas ID"] === "112936");
  ok("the refused contact is Not pushed", row?.Status === "Not pushed", JSON.stringify(row));
  ok("...with Kylas's own words", /Invalid value/.test(row?.Reason || ""), row?.Reason);
  ok("the other contact is still Pushed", (await rowsOf("Push Log")).find((x) => x["Kylas ID"] === "112937")?.Status === "Pushed");
}

console.log("\n6 · a dry run records nothing");
{
  await kylasWith();
  await seed();
  const r = await go({ apply: false });
  ok("nothing was written to Kylas", r.out.wrote === 0);
  ok("...and nothing was recorded", (await rowsOf("Push Log")).length === 0 && (await rowsOf("Field Map")).length === 0);
  ok("...and it says why", /not recorded|dry run/i.test(r.out.tracked.why || ""), JSON.stringify(r.out.tracked));
  ok("...but it still reports what it would change", r.out.changed === 2, JSON.stringify(r.out));
}

console.log("\n7 · no Push Log table: said, and never fatal");
{
  const refuse = { upsertMany: async () => { throw new Error('PATCH /Push%20Log -> 403: {"error":{"type":"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}}'); } };
  const lines = [];
  const out = await recordPush(refuse, [{ Key: "x" }], { log: (m) => lines.push(m) });
  ok("a missing table returns stored:false instead of throwing", out.stored === false);
  ok("...and names the command that creates it", /repair-base/.test(out.why), out.why);
  const fm = await storeFieldMap(refuse, [{ key: "k", label: "K", via: "save", entity: "contact", airtableTable: "T", airtableField: "F", airtableType: "x", sends: "text", status: "mapped" }]);
  ok("the Field Map table being absent is the same", fm.stored === false && /repair-base/.test(fm.why));
  const none = await readPushLog({ listAll: async () => { throw new Error("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"); }, log: () => {} }, { fromIso: "a", toIso: "b" });
  ok("reading a missing log is null, which the digest prints as 'not tracked yet'", none === null);
}

console.log("\n8 · the CLIs, run as the entry point (not imported)");
{
  /* Imported, field-map.mjs worked; run from a terminal it hung on a circular
     import with push-kylas.mjs ("Detected unsettled top-level await") and printed
     nothing. Only a child process can see that. */
  await kylasWith();
  await reset();
  const cli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/field-map.mjs", ...args], { env: { ...process.env, ...ENV } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); resolve({ code: "timeout", out, err }); }, 20000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  const a = await cli([]);
  ok("field-map.mjs prints the map and exits", a.code === 0 && /DATUM/.test(a.out), `${a.code} ${a.err.slice(0, 200)}`);
  ok("...with no unsettled top-level await", !/unsettled/.test(a.err), a.err.slice(0, 200));
  const b = await cli(["--store"]);
  ok("--store writes the Field Map table", /Field Map: \d+ row\(s\) written/.test(b.out) && (await rowsOf("Field Map")).length > 0, `${b.code} ${b.out.slice(-200)} ${b.err.slice(0, 200)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
