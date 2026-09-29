#!/usr/bin/env node
/* THE LIVE WRITE PROBE — one contact, one field at a time, restored after.
 *
 *   KYLAS_KEY=... node scripts/probe-write.mjs --contact 112936
 *   KYLAS_KEY=... node scripts/probe-write.mjs --contact 112936 --write
 *
 * Without --write it READS ONLY: it resolves the field map off the live field
 * list and prints the exact payload each step would send. Nothing changes.
 * With --write it sends them, reads the contact back after each one, and says
 * field by field what Kylas KEPT, what it changed, and what it silently
 * dropped — then puts every value back the way it found it.
 *
 * WHY ONE FIELD AT A TIME. Kylas answers a bad value with a 400 that names
 * neither the field nor the rule, and rejects the WHOLE request over it. A
 * payload with eight fields that comes back 400 tells you nothing; eight
 * payloads of one field each tell you exactly which one it was. It is slower
 * and it is the only version of this that answers the question.
 *
 * WHAT IT WILL NOT DO. It never creates a contact, never touches a second one,
 * and never writes a call log. Use a contact you do not mind editing — the
 * restore is best-effort and a field Kylas normalises (a phone number, a
 * picklist) may come back in a different shape than it went in.
 */
import { resolveWriteFields, extraCustomFields, describeWriteMap } from "./kylas-write-map.mjs";
import { toKylasContact, renderRemarks, mergeRemarks } from "./kylas.mjs";
import { STAGE_ID } from "./stages.mjs";

const KEY = process.env.KYLAS_KEY;
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const CONTACT = arg("contact");
const WRITE = process.argv.includes("--write");
const TZ = Number(process.env.TZ_OFFSET_MIN ?? 330);

if (!KEY) { console.error("Set KYLAS_KEY — app.kylas.io/setup/integrations/api-keys/list"); process.exit(1); }
if (!CONTACT) { console.error("Pass --contact <id> — a contact you do not mind editing."); process.exit(1); }

/* Kylas rate-limits hard; everything goes through one queue with a gap. */
const GAP = Number(process.env.KYLAS_GAP || 450);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(() => sleep(GAP)).then(fn));

async function api(method, path, body) {
  return queue(async () => {
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`https://api.kylas.io${path}`, {
        method, headers: { "api-key": KEY, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      return { ok: res.ok, status: res.status, json, text };
    }
    return { ok: false, status: 429, json: null, text: "rate limited after 4 tries" };
  });
}

const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${"─".repeat(t.length)}`);
const show = (v) => (v === undefined ? "(absent)" : JSON.stringify(v));

/* ── 1 · the field map, off the live account ───────────────────────────── */
head("1 · which fields this account actually has");
const fl = await api("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
if (!fl.ok) { console.error(`  could not read the field list — ${fl.status} ${fl.text.slice(0, 200)}`); process.exit(1); }
const raw = Array.isArray(fl.json) ? fl.json : fl.json?.content || fl.json?.data || [];
const fields = raw.map((f) => ({ name: f.name, label: f.displayName, type: f.type }));

/* Options live at a different depth per field type. */
function findOptions(field, depth = 0) {
  if (!field || depth > 4) return null;
  if (Array.isArray(field)) {
    if (field.length && field.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
      return field.map((x) => ({ id: x.id, code: x.name || x.displayName, label: x.displayName || x.name }));
    for (const x of field) { const hit = findOptions(x, depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof field === "object")
    for (const k of Object.keys(field)) { const hit = findOptions(field[k], depth + 1); if (hit) return hit; }
  return null;
}
const picklists = {};
for (const f of raw) { const o = findOptions(f); if (o && (f.name || f.displayName)) picklists[f.name || f.displayName] = o; }

console.log(`  ${fields.length} fields, ${Object.keys(picklists).length} with options`);
const map = resolveWriteFields(fields, picklists);
describeWriteMap(map).forEach((l) => console.log(`  ${l}`));
if (map.offsite?.options?.length)
  console.log(`    options: ${map.offsite.options.map((o) => `${o.id}=${o.label || o.code}`).join(" · ")}`);
/* Everything that looked plausible, so a wrong pick is visible rather than
   silent — this is the line to read if the offsite write goes nowhere. */
const near = fields.filter((f) => /off\s*-?site|next.*call|call.*back|follow.*up/i.test(`${f.label} ${f.name}`));
if (near.length) console.log(`  candidates seen: ${near.map((f) => `${f.name} (${f.type})`).join(", ")}`);

/* ── 2 · the contact as it stands ──────────────────────────────────────── */
head("2 · the contact before anything is written");
const before = await api("GET", `/v1/contacts/${CONTACT}`);
if (!before.ok) { console.error(`  could not read contact ${CONTACT} — ${before.status} ${before.text.slice(0, 200)}`); process.exit(1); }
const c0 = before.json;
console.log(`  ${c0.firstName || ""} ${c0.lastName || ""} · id ${c0.id}`);
const cf0 = c0.customFieldValues || {};
console.log(`  custom fields set: ${Object.keys(cf0).join(", ") || "(none)"}`);
const watched = [map.nextCall?.name, map.offsite?.name, "cfPipelineStageBd", "cfSourceOfData"].filter(Boolean);
for (const k of watched) console.log(`    ${k.padEnd(28)} ${show(cf0[k])}`);
console.log(`    ${"remarks".padEnd(28)} ${show((c0.remarks || "").slice(0, 60))}`);

/* ── 3 · the payloads ──────────────────────────────────────────────────── */
head("3 · what the console would send");
/* A card shaped the way the console shapes one, with a call-back tomorrow at
   16:00 and an offsite named for the quarter after next. */
const tomorrow = new Date(Date.now() + 86400e3 + TZ * 60000).toISOString().slice(0, 10);
const card = {
  kid: String(CONTACT),
  pocName: `${c0.firstName || ""} ${c0.lastName || ""}`.trim() || "Unknown",
  stage: "MQL_MARKETING_QUALIFIED_LEAD",
  owner: "", phones: [], emails: [],
  nextCallDate: tomorrow, nextCallTime: "16:00",
  past: [], current: [{ eventType: "Employee offsites", budget: "8L", timeline: "Aug, week 2", pax: "120", remarks: "probe" }],
};
const quarters = ["JUL_SEP"];              /* what "Aug" derives — offsite.js */
const extra = extraCustomFields(map, card, { tzMin: TZ, quarters });
console.log(`  customFieldValues the map adds: ${JSON.stringify(extra)}`);

const STEPS = [
  { what: "pipeline stage", body: { customFieldValues: { cfPipelineStageBd: STAGE_ID[card.stage] } },
    check: "cfPipelineStageBd" },
  { what: "remarks block", body: { remarks: mergeRemarks(c0.remarks || "", renderRemarks(card, { stageLabel: "MQL" })) },
    check: "remarks" },
  ...(map.nextCall ? [{ what: `next call (${map.nextCall.name})`,
    body: { customFieldValues: { [map.nextCall.name]: extra[map.nextCall.name] } }, check: map.nextCall.name }] : []),
  ...(map.offsite ? [{ what: `offsite timeline (${map.offsite.name})`,
    body: { customFieldValues: { [map.offsite.name]: extra[map.offsite.name] } }, check: map.offsite.name }] : []),
  { what: "the whole payload at once", body: toKylasContact(card, { extra }), check: null },
];
for (const s of STEPS) console.log(`  ${s.what.padEnd(34)} ${JSON.stringify(s.body).slice(0, 150)}`);

if (!WRITE) {
  console.log(`\nRead-only. Nothing was written. Add --write to send these and read them back.`);
  process.exit(0);
}

/* ── 4 · write, read back, report ──────────────────────────────────────── */
head("4 · writing, one field at a time");
const results = [];
for (const s of STEPS) {
  const put = await api("PUT", `/v1/contacts/${CONTACT}`, s.body);
  if (!put.ok) {
    const why = put.json?.message || put.json?.errors?.map?.((e) => e.message).join("; ") || put.text.slice(0, 160);
    results.push({ what: s.what, verdict: "REJECTED", detail: `${put.status} ${why}` });
    console.log(`  ✗ ${s.what.padEnd(34)} ${put.status} ${why}`);
    continue;
  }
  const after = await api("GET", `/v1/contacts/${CONTACT}`);
  const got = s.check === "remarks" ? after.json?.remarks : after.json?.customFieldValues?.[s.check];
  if (!s.check) {
    results.push({ what: s.what, verdict: "ACCEPTED", detail: "200" });
    console.log(`  ✓ ${s.what.padEnd(34)} 200`);
    continue;
  }
  const kept = got !== undefined && got !== null && got !== "";
  /* ACCEPTED BUT EMPTY is the outcome worth the whole script: Kylas answers
     200 and stores nothing when a custom field is not writable by the key's
     role, or when the value is of a shape it quietly discards. */
  results.push({ what: s.what, verdict: kept ? "KEPT" : "DROPPED (200, nothing stored)",
                 detail: show(typeof got === "string" ? got.slice(0, 70) : got) });
  console.log(`  ${kept ? "✓" : "!"} ${s.what.padEnd(34)} ${kept ? "kept" : "200 but nothing stored"}  ${show(typeof got === "string" ? got.slice(0, 70) : got)}`);
}

/* ── 5 · put it back ───────────────────────────────────────────────────── */
head("5 · restoring");
const restore = { remarks: c0.remarks ?? "", customFieldValues: {} };
for (const k of watched) restore.customFieldValues[k] = cf0[k] ?? null;
const back = await api("PUT", `/v1/contacts/${CONTACT}`, restore);
console.log(back.ok ? `  restored the ${watched.length} field(s) and the remarks`
                    : `  ! could not restore — ${back.status} ${back.text.slice(0, 160)}\n    ${JSON.stringify(restore).slice(0, 300)}`);

head("verdict");
for (const r of results) console.log(`  ${r.verdict.padEnd(30)} ${r.what}  ${r.detail}`);
const bad = results.filter((r) => r.verdict !== "KEPT" && r.verdict !== "ACCEPTED");
console.log(bad.length
  ? `\n${bad.length} of ${results.length} did not land. The DROPPED ones are a permissions or shape\nproblem, not a code one — the request was accepted and the value is not there.`
  : `\nEvery field written was stored. The write-back is real on this account.`);
process.exit(bad.length ? 1 : 0);
