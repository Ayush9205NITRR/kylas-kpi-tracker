#!/usr/bin/env node
/* THE WAY BACK: everything D1 holds that Airtable does not, copied into Airtable.
 *
 * After the cut-over (STORE=d1) Airtable is frozen and D1 takes every write.
 * If the switch has to be undone, this puts the rows written or changed in D1
 * since a moment — the cut-over — back into the Airtable base, so that
 * STORE=airtable can be set and deployed with nothing lost.
 *
 *   node --env-file=.env.local scripts/d1-to-airtable.mjs --since 2026-11-04T18:00:00Z          # dry run
 *   node --env-file=.env.local scripts/d1-to-airtable.mjs --since 2026-11-04T18:00:00Z --apply
 *
 * Reads D1 through the same client the console uses (STORE=d1, so D1_SQLITE
 * or CF_ACCOUNT_ID + CF_API_TOKEN + KPI_DB_ID), writes Airtable with the
 * Airtable token. Parent tables first, so a contact born in D1 can be linked
 * to a company born in D1: a D1 record id is translated to the Airtable record
 * the upsert made for it, by the parent's key.
 *
 * Upserts on each table's key, so running it twice writes the same rows twice
 * and never a second copy. Only stored fields go across — Airtable recomputes
 * its own rollups and formulas from them.
 *
 * NOT CARRIED BACK: a row DELETED in D1. Nothing in the console deletes KPI
 * rows (an event row is marked Removed At, not destroyed), so this is listed
 * rather than guessed at.
 */
import { pathToFileURL } from "node:url";
import { createAirtable, upsertManyTolerant } from "./airtable.mjs";
import { TABLES } from "./schema.mjs";
import { airtableOverD1 } from "./airtable-d1.mjs";
import { BACKFILL_ORDER, LINKS_BY_TABLE } from "./sql-store.mjs";

const KEY_OF = Object.fromEntries(TABLES.map((t) => [t.name,
  t.fields.some((f) => f.name === "Key") ? "Key"
    : { Companies: "Kylas Company ID", Contacts: "Kylas Contact ID", Team: "Name" }[t.name] || t.fields[0].name]));

export async function run({ env = process.env, log = console.log, since, apply = false, d1 = undefined, airtable = null } = {}) {
  if (!since || !Number.isFinite(Date.parse(since))) throw new Error("--since <ISO time of the cut-over> is required.");
  const PAT = env.AIRTABLE_PAT, BASE = env.AIRTABLE_BASE;
  if (!airtable && (!PAT || !BASE)) throw new Error("Set AIRTABLE_PAT and AIRTABLE_BASE (the base to copy back into).");
  /* Two clients on one base id: the D1 one forced on, the Airtable one forced off. */
  const fromD1 = createAirtable(PAT || "d1", BASE || "appKPI", { log: () => {}, d1: d1 ?? (await import("./airtable.mjs")).nodeD1() });
  const toAt = airtable || createAirtable(PAT, BASE, { log: () => {}, d1: null,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });

  const iso = new Date(Date.parse(since)).toISOString();
  /* Only what is STORED goes back: rollups, formulas and the reverse link
     lists are Airtable's to compute, and writing a reverse list would relink
     children behind the copy's back. The engine's model says which is which. */
  const model = airtableOverD1({ prepare() {} }).model;
  const stored = (table, k) => ["base", "link"].includes(model(table)?.fields.get(k)?.kind);
  /* D1 record id → Airtable record id, per table, filled as parents land. */
  const idMap = new Map();
  const report = [];

  for (const table of BACKFILL_ORDER) {
    const key = KEY_OF[table];
    const rows = await fromD1.listAll(table, {
      formula: `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${iso}'))`, pageSize: 100, maxPages: 100000 });
    const links = LINKS_BY_TABLE[table] || [];
    const out = [], unkeyed = [];
    for (const r of rows) {
      if (!String(r.fields[key] ?? "").trim()) { unkeyed.push(r.id); continue; }
      const fields = {};
      for (const [k, v] of Object.entries(r.fields)) {
        if (!stored(table, k)) continue;
        const l = links.find((x) => x.name === k);
        if (l) {
          const parent = (v || [])[0];
          const mapped = parent && (idMap.get(l.to)?.get(parent) || parent);
          if (mapped) fields[k] = [mapped];
          continue;
        }
        fields[k] = v;
      }
      out.push({ d1Id: r.id, fields });
    }
    report.push({ table, changed: rows.length, unkeyed: unkeyed.length });
    log(`${table.padEnd(18)} ${String(rows.length).padStart(6)} changed since ${iso}` +
        (unkeyed.length ? ` · ${unkeyed.length} with no ${key} — cannot be matched, skipped` : ""));
    if (!apply || !out.length) {
      /* A dry run still needs the id map, or a child would look unlinkable. */
      continue;
    }
    const { recs, dropped } = await upsertManyTolerant(toAt, table, key, out.map((x) => x.fields));
    if (dropped?.length) log(`   ! Airtable has no ${dropped.join(", ")} on ${table} — those columns were not copied back`);
    const m = idMap.get(table) || new Map();
    out.forEach((x, i) => recs?.[i]?.id && m.set(x.d1Id, recs[i].id));
    idMap.set(table, m);
  }
  const total = report.reduce((s, r) => s + r.changed, 0);
  log(`\n${apply ? "copied back" : "would copy back"} ${total} row(s).`);
  if (!apply) log("Nothing was written. Re-run with --apply.");
  return { report, total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  run({ since: arg("--since"), apply: process.argv.includes("--apply") })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
