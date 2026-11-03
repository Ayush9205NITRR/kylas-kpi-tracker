#!/usr/bin/env node
/* OLD HISTORY, COMPACTED — IN AIRTABLE, WITH THE NUMBERS PROVEN UNCHANGED (2026-11-03).
 *
 *   node --env-file=.env.local scripts/compact-history.mjs            # DRY RUN
 *   node --env-file=.env.local scripts/compact-history.mjs --apply
 *   node --env-file=.env.local scripts/compact-history.mjs --restore compact-undo-<time>.json
 *
 * Ayush: "simple rakhna hai — ek hi jagah saara data." The base has a 50,000
 * record cap and Stage Transitions grow ~3,700 a month. Everything stays in
 * Airtable; what goes is only the rows NO NUMBER READS — the same idea as Call
 * Log -> Call Rollup.
 *
 * STAGE TRANSITIONS older than 30 days: kept are
 *   - per company, owner and ladder floor (booked / done / sql): the FIRST arrival.
 *     Per OWNER, because a one-person report filters before it dedupes;
 *   - per company, owner and day: the first row (worked) and the first connected
 *     row (picked) — what touchEvents counts, one per company per period;
 *   - per company: the first qualified row (progress.mjs: done, sqlAt);
 *   - per contact: the first row, so its "Stage Transitions" link never empties
 *     (the prune and contactWorked read it).
 * Every other old row is a repeat. A row inside 30 days is never touched.
 *
 * THE GATE. Before anything is deleted the ladder's inputs are computed on ALL
 * rows and on the KEPT rows — first arrivals for the team and for every owner,
 * every worked/picked touch by day, week, month, quarter and year, and each
 * company's qualified date. One difference and nothing is deleted.
 *
 * FOCUS HISTORY: nothing reads it (checked); rows older than 30 days go.
 *
 * Every deleted row is written to compact-undo-<time>.json first.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import { createAirtable, listTolerant } from "./airtable.mjs";
import { firstArrivals, touchEvents, dayKey, weekKey, monthKey, quarterKey, yearKey } from "./report.mjs";
import { STAGE_RUNG, MILESTONE } from "./stages.mjs";
import { QUALIFIED } from "./progress.mjs";

const DAY = 86400e3;
const FLOOR_LIST = ["sqlMeetingBooked", "sqlMeetingDone", "sql"].map((k) => MILESTONE[k]?.floor).filter(Boolean);

/* An Airtable transition row in the report's shape. */
export function asTransition(r, companyOf) {
  const f = r.fields || {};
  const contact = (f.Contact || [])[0] || "";
  return { id: r.id, at: f["Changed At"], owner: f.Owner, to: f["To Stage"], contact,
           company: companyOf.get(contact) || contact };
}

/* Which rows to keep. rows: Airtable rows; companyOf: contact rec -> company rec. */
export function compactTransitions(rows, companyOf, { now = new Date(), days = 30 } = {}) {
  const cut = new Date(now.getTime() - days * DAY).toISOString();
  const keep = new Set();
  const first = new Map();                       /* key -> [at, id] */
  const take = (k, t) => { const h = first.get(k); if (!h || String(t.at) < h[0]) first.set(k, [String(t.at), t.id]); };
  for (const r of rows) {
    const t = asTransition(r, companyOf);
    if (!t.at || !t.to || String(t.at) >= cut) { keep.add(r.id); continue; }
    const rung = STAGE_RUNG[t.to] || 0;
    const o = String(t.owner || "");
    for (const fl of FLOOR_LIST) if (rung >= fl) take(`floor|${t.company}|${o}|${fl}`, t);
    const d = `${dayKey(t.at)}|${yearKey(t.at)}`;
    take(`worked|${t.company}|${o}|${d}`, t);
    if (touchEvents({ transitions: [t] }).some((e) => e.metric === "picked")) take(`picked|${t.company}|${o}|${d}`, t);
    if (QUALIFIED.includes(t.to)) take(`qual|${t.company}`, t);
    take(`contact|${t.contact}`, t);
  }
  for (const [, [, id]] of first) keep.add(id);
  return { keep: rows.filter((r) => keep.has(r.id)), drop: rows.filter((r) => !keep.has(r.id)) };
}

/* Everything the numbers read from transitions, as comparable text. */
export function fingerprint(rows, companyOf) {
  const ts = rows.map((r) => asTransition(r, companyOf));
  const out = [];
  const owners = [...new Set(ts.map((t) => String(t.owner || "")))].sort();
  const strip = (list) => list.map(({ metric, company, owner, at }) => `${metric}|${company}|${owner}|${at}`).join("\n");
  out.push("ALL\n" + strip(firstArrivals({ transitions: ts })));
  for (const o of owners) out.push(`OWNER ${o}\n` + strip(firstArrivals({ transitions: ts.filter((t) => String(t.owner || "") === o) })));
  const touches = new Set();
  for (const e of touchEvents({ transitions: ts }))
    for (const [lvl, kf] of [["d", dayKey], ["w", weekKey], ["m", monthKey], ["q", quarterKey], ["y", yearKey]])
      touches.add(`${lvl}|${kf(e.at)}|${e.metric}|${e.company}|${e.owner || ""}`);
  out.push("TOUCH\n" + [...touches].sort().join("\n"));
  const qual = new Map();
  for (const t of ts) if (QUALIFIED.includes(t.to) && t.at && (!qual.has(t.company) || t.at < qual.get(t.company))) qual.set(t.company, t.at);
  out.push("QUAL\n" + [...qual].sort().map((x) => x.join("|")).join("\n"));
  return out;
}

export function gate(all, kept, companyOf) {
  const a = fingerprint(all, companyOf), b = fingerprint(kept, companyOf);
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const al = new Set((a[i] || "").split("\n")), bl = new Set((b[i] || "").split("\n"));
    const missing = [...al].filter((x) => !bl.has(x)).slice(0, 3), extra = [...bl].filter((x) => !al.has(x)).slice(0, 3);
    diffs.push(`${(a[i] || b[i]).split("\n")[0]}: lost ${missing.join(" ; ") || "-"} · gained ${extra.join(" ; ") || "-"}`);
  }
  return diffs;
}

async function removeAll(at, table, ids, log, max = Infinity) {
  let gone = 0;
  for (let i = 0; i < ids.length && gone < max; i += 10) {
    const part = ids.slice(i, i + 10);
    for (let a = 0; ; a++) {
      try { await at.remove(table, part); break; }
      catch (e) {
        if (/NOT_FOUND|404/.test(e.message)) break;
        if (a >= 5) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** a));
      }
    }
    gone += part.length;
    if ((i / 10) % 100 === 0 && i) log(`  ${table}: removed ${gone} of ${ids.length}`);
  }
  return gone;
}

export async function run({ env = process.env, log = console.log, apply = false, at = null, now = new Date(),
                            days = Number(env.HISTORY_KEEP_DAYS || 30), undoDir = ".", maxDeletes = Infinity,
                            writeUndo = true } = {}) {
  at ||= createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  const ALL = { pageSize: 100, maxPages: 2000 };
  log("Reading Stage Transitions, Contacts and Focus History…");
  const [trans, contacts, focusHist] = await Promise.all([
    at.listAll("Stage Transitions", ALL),
    listTolerant(at, "Contacts", { fields: ["Company"], ...ALL }),
    listTolerant(at, "Focus History", { fields: ["Changed At"], ...ALL }).catch(() => []),
  ]);
  const companyOf = new Map(contacts.map((r) => [r.id, (r.fields?.Company || [])[0] || r.id]));
  const { keep, drop } = compactTransitions(trans, companyOf, { now, days });
  const cut = now.getTime() - days * DAY;
  const fhDrop = focusHist.filter((r) => { const t = Date.parse(r.fields?.["Changed At"] || r.createdTime || ""); return Number.isFinite(t) && t < cut; });

  const diffs = gate(trans, keep, companyOf);
  log(`\nStage Transitions: ${trans.length} · keep ${keep.length} · remove ${drop.length} (repeats older than ${days} days)`);
  log(`Focus History:     ${focusHist.length} · remove ${fhDrop.length} (older than ${days} days; nothing reads it)`);
  log(`Records freed:     ${drop.length + fhDrop.length}`);
  if (diffs.length) {
    log(`\n✗ GATE: the numbers would change — nothing will be deleted.`);
    for (const d of diffs.slice(0, 10)) log(`  ${d.slice(0, 300)}`);
    return { ok: false, diffs, drop: drop.length, fhDrop: fhDrop.length };
  }
  log(`✓ GATE: ladder, worked/picked by day–year, every owner's first arrivals and qualified dates — identical.`);
  if (!apply) { log(`\nDRY RUN — nothing deleted. To delete: add --apply`); return { ok: true, applied: false, drop: drop.length, fhDrop: fhDrop.length }; }

  let undo = null;
  if (writeUndo) {
    undo = `${undoDir}/compact-undo-${now.toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(undo, JSON.stringify({ "Stage Transitions": drop.map((r) => ({ id: r.id, fields: r.fields })),
      "Focus History": fhDrop.map((r) => ({ id: r.id, fields: r.fields })) }, null, 1));
    log(`\nSaved every row to ${undo}`);
  }
  const t1 = await removeAll(at, "Stage Transitions", drop.map((r) => r.id), log, maxDeletes);
  const t2 = await removeAll(at, "Focus History", fhDrop.map((r) => r.id), log, Math.max(0, maxDeletes - t1));
  log(`\nRemoved ${t1} transition(s) and ${t2} focus-history row(s).`);
  return { ok: true, applied: true, drop: t1, fhDrop: t2, undo };
}

/* Put the rows back (writable fields; links included). */
export async function restore({ env = process.env, log = console.log, file, at = null } = {}) {
  at ||= createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null });
  const data = JSON.parse(readFileSync(file, "utf8"));
  let n = 0;
  for (const [table, rows] of Object.entries(data)) {
    if (!rows.length) continue;
    await at.upsertMany(table, "Key", rows.map((r) => r.fields));
    n += rows.length;
  }
  log(`Restored ${n} row(s).`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--restore");
  (i >= 0 ? restore({ file: process.argv[i + 1] }) : run({ apply: process.argv.includes("--apply") }))
    .then((r) => process.exit(r?.ok === false ? 1 : 0)).catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
