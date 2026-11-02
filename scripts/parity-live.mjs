#!/usr/bin/env node
/* EVERY RECORD, EVERY FIELD: does Cloudflare hold what Airtable holds?
 *
 *   node --env-file=.env.local scripts/parity-live.mjs                       # D1 over the API (CF_* in .env.local)
 *   D1_SQLITE=db/kpi.sqlite node --env-file=.env.local scripts/parity-live.mjs   # against the local copy
 *   … --cut 2026-11-04T18:00:00Z     after the switch: rows D1 changed since then are expected to differ
 *   … --out parity.json              the numbers, for cutover-report.mjs
 *
 * Read-only on both sides. Reads every table from Airtable and from D1, both
 * through the same client the console uses, joins on the record id, and
 * compares every field — stored ones and computed ones (Right POC, KPI Rank,
 * SQL Meeting Booked/Done, Reached, Call Count …), because the computed ones
 * are where two stores can quietly disagree.
 *
 * It also lists every field the live base has that the D1 schema does not
 * carry. A field there is data that would stop being visible on the switch,
 * so it is a finding, not a footnote.
 *
 * The KPI totals per owner — the numbers on the dashboard — are added up from
 * each side's Companies and printed side by side.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { TABLES } from "./schema.mjs";
import { BACKFILL_ORDER } from "./sql-store.mjs";
import { airtableOverD1 } from "./airtable-d1.mjs";

/* Fields that differ for a reason that is not a difference in the data. */
export const KNOWN = {
  "Companies.Ever Picked": "Airtable's MAX over a checkbox reads blank (schema.mjs); nothing reads it — Phone Picked uses First Picked At",
};
const AS_SETS = new Set(["Companies.Right POC Contacts", "Companies.Discovery Contacts"]);
export const KPI_FLAGS = ["Reached", "Phone Picked", "Right POC", "Successful Discovery",
  "SQL Meeting Booked", "SQL Meeting Done", "SQL"];

const blank = (v) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length);
function norm(key, v) {
  if (blank(v)) return null;
  if (Array.isArray(v)) return v.map((x) => norm(key, x)).filter((x) => x !== null).map(String).sort().join("|");
  if (typeof v === "object") return JSON.stringify(v.name ?? v);
  if (v === true) return "1";
  if (AS_SETS.has(key)) return String(v).split(",").map((s) => s.trim()).filter(Boolean).sort().join("|");
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return String(Math.round(Number(s) * 1e6) / 1e6);
  if (/^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s))) return new Date(Date.parse(s)).toISOString();
  return s;
}

export async function run({ env = process.env, log = console.log, d1 = undefined, airtable = null, cut = null,
                            tables = BACKFILL_ORDER } = {}) {
  const at = airtable || createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  const cf = createAirtable(env.AIRTABLE_PAT || "d1", env.AIRTABLE_BASE || "appKPI",
    { log: () => {}, d1: d1 ?? (await import("./airtable.mjs")).nodeD1() });
  const model = airtableOverD1({ prepare() {} }).model;
  const cutMs = cut ? Date.parse(cut) : null;
  const out = { at: new Date().toISOString(), cut, tables: [], notCarried: [], kpi: null };
  let companiesA = [], companiesB = [];

  for (const table of tables) {
    const m = model(table);
    const started = Date.now();
    let A;
    try { A = await listTolerant(at, table, { pageSize: 100, maxPages: 100000 }); }
    catch (e) {
      if (/404|NOT_FOUND|not exist/i.test(e.message)) { A = []; }
      else throw e;
    }
    const B = await cf.listAll(table, { pageSize: 100, maxPages: 100000 });
    if (table === "Companies") { companiesA = A; companiesB = B; }
    const byB = new Map(B.map((r) => [r.id, r]));
    const extra = new Map();
    let same = 0, diffRecs = 0, onlyA = 0, onlyB = 0, afterCut = 0;
    const fieldDiffs = new Map(), known = new Map(), examples = [];
    for (const a of A) {
      for (const k of Object.keys(a.fields)) if (!m.fields.has(k)) extra.set(k, (extra.get(k) || 0) + 1);
      const b = byB.get(a.id);
      if (!b) { onlyA++; if (examples.length < 20) examples.push({ id: a.id, what: "in Airtable, not in Cloudflare" }); continue; }
      byB.delete(a.id);
      if (cutMs && Date.parse(b.createdTime) > cutMs) { afterCut++; continue; }
      let bad = false;
      for (const name of m.fields.keys()) {
        const key = `${table}.${name}`;
        const x = norm(key, a.fields[name]), y = norm(key, b.fields[name]);
        if (x === y) continue;
        if (KNOWN[key]) { known.set(name, (known.get(name) || 0) + 1); continue; }
        bad = true;
        fieldDiffs.set(name, (fieldDiffs.get(name) || 0) + 1);
        if (examples.length < 20) examples.push({ id: a.id, field: name, airtable: a.fields[name] ?? null, cloudflare: b.fields[name] ?? null });
      }
      bad ? diffRecs++ : same++;
    }
    for (const b of byB.values()) {
      if (cutMs && Date.parse(b.createdTime) > cutMs) { afterCut++; continue; }
      onlyB++; if (examples.length < 20) examples.push({ id: b.id, what: "in Cloudflare, not in Airtable" });
    }
    const row = { table, airtable: A.length, cloudflare: B.length, same, differ: diffRecs, onlyAirtable: onlyA,
      onlyCloudflare: onlyB, changedAfterCut: afterCut, fields: Object.fromEntries(fieldDiffs),
      known: Object.fromEntries(known), examples, seconds: Math.round((Date.now() - started) / 1000) };
    out.tables.push(row);
    for (const [k, n] of extra) out.notCarried.push({ table, field: k, records: n });
    const okRow = !diffRecs && !onlyA && !onlyB;
    log(`${okRow ? "✓" : "✗"} ${table.padEnd(18)} Airtable ${String(A.length).padStart(6)} · Cloudflare ${String(B.length).padStart(6)}` +
        ` · identical ${same}` + (diffRecs ? ` · DIFFER ${diffRecs} (${[...fieldDiffs].map(([k, n]) => `${k} ×${n}`).join(", ")})` : "") +
        (onlyA ? ` · missing in Cloudflare ${onlyA}` : "") + (onlyB ? ` · only in Cloudflare ${onlyB}` : "") +
        (afterCut ? ` · ${afterCut} written after the cut` : "") +
        (known.size ? ` · known: ${[...known.keys()].join(", ")}` : ""));
  }

  /* The dashboard's own numbers, per owner, from each side. */
  const tally = (recs) => {
    const t = {};
    for (const r of recs) {
      const o = r.fields.Owner || "(no owner)";
      t[o] ||= Object.fromEntries(KPI_FLAGS.map((f) => [f, 0]));
      t.All ||= Object.fromEntries(KPI_FLAGS.map((f) => [f, 0]));
      for (const f of KPI_FLAGS) if (Number(r.fields[f]) === 1) { t[o][f]++; t.All[f]++; }
    }
    return t;
  };
  out.kpi = { airtable: tally(companiesA), cloudflare: tally(companiesB) };
  const owners = [...new Set([...Object.keys(out.kpi.airtable), ...Object.keys(out.kpi.cloudflare)])];
  out.kpiDiffers = owners.filter((o) => KPI_FLAGS.some((f) => (out.kpi.airtable[o]?.[f] || 0) !== (out.kpi.cloudflare[o]?.[f] || 0)));
  log(`\nKPI totals (companies) — Airtable | Cloudflare`);
  for (const o of ["All", ...owners.filter((x) => x !== "All").sort()])
    log(`  ${o.padEnd(22)} ${KPI_FLAGS.map((f) => `${f} ${out.kpi.airtable[o]?.[f] || 0}|${out.kpi.cloudflare[o]?.[f] || 0}`).join("  ")}`);
  if (out.notCarried.length) {
    log(`\n! Fields the live base has that Cloudflare does not carry (they would stop being visible):`);
    for (const n of out.notCarried) log(`  ${n.table}.${n.field} — on ${n.records} record(s)`);
  }
  out.ok = out.tables.every((t) => !t.differ && !t.onlyAirtable && !t.onlyCloudflare) && !out.kpiDiffers.length && !out.notCarried.length;
  log(out.ok ? `\n0 differences. Cloudflare holds exactly what Airtable holds.`
             : `\nDIFFERENCES FOUND — see above. Do not switch until this reads 0.`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  run({ cut: arg("--cut") || null })
    .then((o) => { if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(o, null, 2)); process.exit(o.ok ? 0 : 1); })
    .catch((e) => { console.error(e.message || String(e)); process.exit(2); });
}
