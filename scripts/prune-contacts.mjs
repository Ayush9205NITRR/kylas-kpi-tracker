#!/usr/bin/env node
/* GET THE KPI BASE UNDER AIRTABLE'S 50,000-RECORD CAP (2026-11-03).
 *
 *   node --env-file=.env.local scripts/prune-contacts.mjs            # DRY RUN: counts only
 *   node --env-file=.env.local scripts/prune-contacts.mjs --apply    # delete
 *   node --env-file=.env.local scripts/prune-contacts.mjs --restore prune-undo-<time>.json
 *
 * Ayush: "it cannot be that we need more than 50K records." The base held
 * ~57,000, and ~37,500 of them were Contacts — every Kylas contact, copied by
 * the sync whether or not anybody ever called it. The sync now writes only the
 * contacts of WORKED companies (contact-row.mjs); this removes the rest.
 *
 * KEPT:
 *   - every contact of a worked company (so its card stays whole). A company is
 *     worked when any of its contacts has a call, a saved row, a stage past the
 *     first rung, an RCA or a flag (contactWorked), or it is on the Focus list;
 *   - any contact that is itself worked, or has ANY linked row (Call Log, Event
 *     Rows, Stage Transitions, RCA) — checked again just before each delete.
 * REMOVED: contacts of companies nobody has worked. Their Companies row stays;
 * the card for such a company is read from Kylas, as for any new account.
 *
 * Every deleted row is written first to prune-undo-<time>.json (gitignored), so
 * --restore puts them back exactly.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import { createAirtable } from "./airtable.mjs";
import { TABLES } from "./schema.mjs";
import { contactWorked } from "./contact-row.mjs";

export const CAP = 50_000;
const SIGNAL_FIELDS = ["Kylas Contact ID", "Company", "KPI Rank", "Current Stage", "Call Count", "Call Log",
  "Event Rows", "Stage Transitions", "RCA", "Has Signal", "First Worked At", "Duplicate Flag"];
const LINKS = ["Call Log", "Event Rows", "Stage Transitions", "RCA"];

/* Read with these fields, dropping any the base lacks rather than failing. */
async function readTolerant(at, table, fields, log) {
  let f = [...fields];
  for (let i = 0; i <= fields.length; i++) {
    try { return await at.listAll(table, { fields: f, pageSize: 100, maxPages: 2000, throwIfMore: true }); }
    catch (e) {
      const which = /Unknown field name:\s*\\?"([^"\\]+)/.exec(e.message)?.[1];
      if (!which || !f.includes(which)) throw e;
      log(`  (${table} has no "${which}" — judged without it)`);
      f = f.filter((x) => x !== which);
    }
  }
  throw new Error(`${table}: could not read`);
}

export async function plan(at, { log = console.log } = {}) {
  const contacts = await readTolerant(at, "Contacts", SIGNAL_FIELDS, log);
  const companies = await readTolerant(at, "Companies", ["Kylas Company ID"], log);
  const coIdOf = new Map(companies.map((r) => [r.id, String(r.fields?.["Kylas Company ID"] || "")]));
  const worked = new Set();                               /* Airtable company record ids */
  for (const r of contacts) if (contactWorked(r.fields)) for (const co of r.fields?.Company || []) worked.add(co);
  try {
    const focus = await readTolerant(at, "Focus", ["Kylas Company ID"], log);
    const recOf = new Map([...coIdOf].map(([rec, kid]) => [kid, rec]));
    for (const r of focus) { const rec = recOf.get(String(r.fields?.["Kylas Company ID"] || "")); if (rec) worked.add(rec); }
  } catch (e) { log(`  (no Focus table: ${e.message.slice(0, 60)})`); }

  const drop = contacts.filter((r) => {
    const f = r.fields || {};
    if (contactWorked(f)) return false;
    if (LINKS.some((k) => (f[k] || []).length)) return false;
    return !(f.Company || []).some((co) => worked.has(co));
  });
  return { contacts: contacts.length, companies: companies.length, workedCompanies: worked.size,
           drop, keep: contacts.length - drop.length };
}

/* Records per table, the number Airtable counts against the cap. */
export async function census(at, { log = console.log } = {}) {
  const out = {};
  for (const t of TABLES) {
    const first = t.fields?.[0]?.name;
    try { out[t.name] = (await at.listAll(t.name, { fields: first ? [first] : [], pageSize: 100, maxPages: 2000 })).length; }
    catch (e) { if (!/NOT_FOUND|404/.test(e.message)) log(`  ${t.name}: ${e.message.slice(0, 80)}`); }
  }
  return out;
}

export async function run({ env = process.env, log = console.log, apply = false, at = null, now = new Date(),
                            undoDir = "." } = {}) {
  at ||= createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  log("Reading the base…");
  const counts = await census(at, { log });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const p = await plan(at, { log });
  const after = total - p.drop.length;
  log(`\nRecords now: ${total.toLocaleString("en-IN")} of ${CAP.toLocaleString("en-IN")}`);
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) if (n) log(`  ${t.padEnd(20)} ${n}`);
  log(`\nContacts: ${p.contacts} · worked companies: ${p.workedCompanies} of ${p.companies}`);
  log(`  keep ${p.keep} (every contact of a worked company, every worked or linked contact)`);
  log(`  remove ${p.drop.length} (companies nobody has worked — their cards read from Kylas)`);
  log(`\nRecords after: ${after.toLocaleString("en-IN")} of ${CAP.toLocaleString("en-IN")}` +
      (after < CAP * 0.9 ? "  ✓ under the cap with room" : after < CAP ? "  ! under the cap, but close" : "  ✗ still over the cap"));
  if (!apply) { log(`\nDRY RUN — nothing deleted. To delete: add --apply`); return { total, after, drop: p.drop.length, applied: false }; }

  const undo = `${undoDir}/prune-undo-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  /* The whole record, every field, before it goes. */
  const dropIds = new Set(p.drop.map((r) => r.id));
  const full = (await at.listAll("Contacts", { pageSize: 100, maxPages: 2000, throwIfMore: true }))
    .filter((r) => dropIds.has(r.id));
  writeFileSync(undo, JSON.stringify(full.map((r) => ({ id: r.id, fields: r.fields })), null, 1));
  log(`\nSaved every row to ${undo} (to undo: --restore ${undo})`);
  let gone = 0, spared = 0;
  for (let i = 0; i < full.length; i += 10) {
    /* Re-checked right before the delete: a call logged since the plan was read spares it. */
    const batch = full.slice(i, i + 10).filter((r) => !LINKS.some((k) => (r.fields?.[k] || []).length) && !contactWorked(r.fields));
    spared += Math.min(10, full.length - i) - batch.length;
    /* A timeout or a 5xx is retried (2026-11-03: one timeout stopped the live run at 2,010).
       A batch already deleted answers NOT_FOUND on the retry, which counts as done. */
    if (batch.length) {
      for (let a = 0; ; a++) {
        try { await at.remove("Contacts", batch.map((r) => r.id)); break; }
        catch (e) {
          if (/NOT_FOUND|404/.test(e.message)) break;
          if (a >= 5) throw e;
          log(`  retrying after: ${String(e.message).slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 2000 * 2 ** a));
        }
      }
      gone += batch.length;
    }
    if ((i / 10) % 100 === 0) log(`  removed ${gone} of ${full.length}`);
  }
  log(`\nRemoved ${gone} contacts${spared ? ` (${spared} spared — worked since the plan)` : ""}. Base now ~${(total - gone).toLocaleString("en-IN")} records.`);
  return { total, after: total - gone, drop: gone, applied: true, undo };
}

/* Put the deleted rows back: writable fields only, keyed on Kylas Contact ID. */
export async function restore({ env = process.env, log = console.log, file, at = null } = {}) {
  at ||= createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null });
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const def = TABLES.find((t) => t.name === "Contacts");
  const writable = new Set((def?.fields || []).filter((f) => !/formula|rollup|lookup|count|autoNumber|createdTime|lastModified/i.test(f.type)).map((f) => f.name));
  writable.add("Company");
  const out = rows.map((r) => Object.fromEntries(Object.entries(r.fields).filter(([k]) => writable.has(k))));
  await at.upsertMany("Contacts", "Kylas Contact ID", out);
  log(`Restored ${out.length} contacts.`);
  return out.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--restore");
  (i >= 0 ? restore({ file: process.argv[i + 1] }) : run({ apply: process.argv.includes("--apply") }))
    .then(() => process.exit(0)).catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
