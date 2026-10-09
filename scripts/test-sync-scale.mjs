#!/usr/bin/env node
/* THE SYNC, AGAINST A CONTACTS TABLE PAST 20,000 ROWS.
 *
 *   node scripts/test-sync-scale.mjs
 *
 * Found 2026-10-09 while counting what the sync pushes: the live base holds
 * 37,249 contacts, and sync-kylas read Contacts with a 200-page ceiling —
 * 20,000 rows — twice:
 *
 *   the watermark        "newest Kylas Updated At" was the newest of a prefix
 *   the previous stage   a contact past row 20,000 read as never seen:
 *                          previous rank 0, so KPI Rank could be written DOWN
 *                          previous stage "", so a move made in Kylas was
 *                          never logged as a move
 *
 * The console's own new contacts are appended at the END of the table, which
 * is exactly where the prefix stopped reading. This stands up a base of that
 * shape, puts the contact that matters past row 20,000, and runs the real job.
 */
import { spawn } from "node:child_process";
import { run } from "./sync-kylas.mjs";

const AT_PORT = 9941, KY_PORT = 9940;
const AT = `http://127.0.0.1:${AT_PORT}`, KY = `http://127.0.0.1:${KY_PORT}`;
const FILL = 25_000;

let pass = 0, fail = 0;
const check = (what, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const start = (script, port) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port) },
                                                stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p);
};
process.on("exit", () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }));
start("scripts/mock-airtable.mjs", AT_PORT);
start("scripts/mock-kylas.mjs", KY_PORT);
const H = { Authorization: "Bearer x", "content-type": "application/json" };
for (let i = 0; i < 60; i++) {
  try {
    const [a, k] = await Promise.all([fetch(`${AT}/__count`, { headers: H }), fetch(`${KY}/__writes`)]);
    if (a.ok && k.ok) break;
  } catch { /* not up yet */ }
  await sleep(150);
}
await fetch(`${AT}/__reset`, { headers: H });
const bulk = (table, count, fields) => fetch(`${AT}/__bulk`, { method: "POST", headers: H,
  body: JSON.stringify({ table, count, fields }) }).then((r) => r.json());
const tables = async () => (await fetch(`${AT}/__writes`, { headers: H }).then((r) => r.json())).tables;

/* 25,000 contacts nobody is asking about, then the one that matters — LAST,
   where a new contact lands. Hema (112936) is MQL in the Kylas mock; Airtable
   says she reached SQL, and holds the newest "Kylas Updated At" in the base. */
await bulk("Companies", 1, { "Kylas Company ID": "1776620", Name: "Seats Aero" });
await bulk("Contacts", FILL, { "Kylas Contact ID": "bulk-#", Name: "contact-#",
  "Current Stage": "MQL_MARKETING_QUALIFIED_LEAD", "KPI Rank": 13,
  "Kylas Updated At": "2026-01-01T00:00:00.000Z" });
await bulk("Contacts", 1, { "Kylas Contact ID": "112936", Name: "Hema Bharathi",
  "Current Stage": "SQL_SALES_QUALIFIED_LEAD", "KPI Rank": 26,
  "Kylas Updated At": "2026-09-30T00:00:00.000Z" });
await bulk("Stage Transitions", 1, { Key: "seed", "To Stage": "MQL_MARKETING_QUALIFIED_LEAD",
  "Changed At": "2026-01-01T00:00:00.000Z" });
const count = await fetch(`${AT}/__count`, { headers: H }).then((r) => r.json());
if (count.Contacts !== FILL + 1) {
  console.error(`! the base did not fill (${JSON.stringify(count)}) — nothing below would mean anything.`);
  process.exit(1);
}
console.log(`\nthe base: ${count.Contacts.toLocaleString("en-IN")} contacts, the one that matters is row ${count.Contacts}`);

const ENV = { KYLAS_KEY: "k", KYLAS_BASE: KY, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK",
              AIRTABLE_BASE_URL: AT };
const hema = async () => (await tables()).Contacts.filter((r) => r.fields["Kylas Contact ID"] === "112936");

console.log("\n1 · the watermark is the newest row in the table, not in its first 20,000");
{
  const lines = [];
  await run({ env: ENV, log: (...a) => lines.push(a.join(" ")), apply: true, only: "contacts" });
  const said = lines.find((l) => /changed since|FULL pull/.test(l)) || "";
  check("it starts from row 25,001's stamp", said.includes("2026-09-30T00:00:00.000Z"), said.trim());
}

console.log("\n2 · a contact past row 20,000 keeps its rank and its move is logged");
{
  const lines = [];
  const before = (await tables())["Stage Transitions"].length;
  await run({ env: ENV, log: (...a) => lines.push(a.join(" ")), apply: true, only: "contacts",
              since: "2026-09-01T00:00:00.000Z" });
  const rows = await hema();
  check("still one row for her", rows.length === 1, `${rows.length}`);
  check("KPI Rank did not fall to MQL's", Number(rows[0]?.fields["KPI Rank"]) === 26,
        `KPI Rank ${rows[0]?.fields["KPI Rank"]}`);
  check("her stage now reads what Kylas says", rows[0]?.fields["Current Stage"] === "MQL_MARKETING_QUALIFIED_LEAD",
        rows[0]?.fields["Current Stage"]);
  const moved = (await tables())["Stage Transitions"].slice(before)
    .filter((r) => JSON.stringify(r.fields).includes("112936"));
  check("the move from SQL was written as a Stage Transition", moved.length === 1,
        `${moved.length} row(s) ${JSON.stringify(moved[0]?.fields || {}).slice(0, 120)}`);
}

console.log("\n3 · the same, through the whole-table read a big batch takes");
{
  /* Put her back where she was, and make every batch "big". */
  const t = await tables();
  const row = t.Contacts.find((r) => r.fields["Kylas Contact ID"] === "112936");
  await fetch(`${AT}/v0/appMOCK/Contacts`, { method: "PATCH", headers: H, body: JSON.stringify({
    records: [{ id: row.id, fields: { "Current Stage": "SQL_SALES_QUALIFIED_LEAD", "KPI Rank": 26 } }] }) });
  const before = (await tables())["Stage Transitions"].length;
  const lines = [];
  await run({ env: { ...ENV, SYNC_BY_ID_MAX: "0" }, log: (...a) => lines.push(a.join(" ")), apply: true,
              only: "contacts", since: "2026-09-01T00:00:00.000Z" });
  const rows = await hema();
  check("KPI Rank held at 26", Number(rows[0]?.fields["KPI Rank"]) === 26, `KPI Rank ${rows[0]?.fields["KPI Rank"]}`);
  const moved = (await tables())["Stage Transitions"].slice(before);
  /* Same Key as section 2's move, so it is an upsert onto that row, not a new one. */
  check("the move was seen (an upsert on the same key, not a second row)",
        lines.some((l) => /1 stage move/.test(l)) && moved.length === 0, lines.find((l) => /stage move/.test(l))?.trim());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
