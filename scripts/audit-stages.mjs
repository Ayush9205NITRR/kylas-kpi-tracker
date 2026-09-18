#!/usr/bin/env node
/* Stage transitions nobody meant to make.
 *
 *   source .env.local && node scripts/audit-stages.mjs
 *   node scripts/audit-stages.mjs --days=60 --seconds=600 --csv > suspect.csv
 *
 * READ ONLY. It lists and counts; it never writes to Airtable or to Kylas.
 *
 * WHY THIS EXISTS
 * Until the fix in this repo's console, the keyboard handler ran its single-key
 * shortcuts on any keydown outside a field, whatever modifier was held. So
 * Cmd+1 to Cmd+4 — which on a Mac switch browser tabs — each called
 * setOutcome() on whatever record was open. That does three things:
 *
 *   - moves the stage (Cmd+1 walks the Could Not Connect ladder, Cmd+2 sets
 *     MQL, Cmd+3 Discovery Call Booked, Cmd+4 SQL),
 *   - fills the call-back date with tomorrow if it was empty,
 *   - STARTS AN ESTIMATED CALL TIMER, which keeps running until the record is
 *     saved.
 *
 * None of that reaches Airtable on its own. It lands only if the associate
 * then hit Save & next on that record without setting a real outcome after
 * the chord — a later outcome overwrites an earlier one. So this audit ranks
 * suspects; it cannot prove intent. The strongest single tell is the timer:
 * a call whose duration was ESTIMATED and ran for far longer than a call
 * lasts is a timer that started when somebody switched tabs.
 *
 * WHAT IT FLAGS
 *   backwards      the stage moved DOWN the ladder (STAGE_RUNG in stages.mjs)
 *   long-estimate  duration source "estimated", longer than --seconds
 *   chord-shaped   landed on exactly the stage one of Cmd+1..4 sets
 *   no-call        a transition with no Call Log row for the same save
 *
 * A row with three or four flags is worth opening in Kylas. One flag on its
 * own is usually just a real call.
 */
import { createAirtable } from "./airtable.mjs";
import { STAGE_RUNG, STAGE_LABEL, CNC_LADDER } from "./stages.mjs";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : dflt;
};
const DAYS = Number(arg("days", 30));
const LONG = Number(arg("seconds", 600));       /* an "estimated" call this long is a parked timer */
const CSV = process.argv.includes("--csv");

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_BASE — the same two the proxy uses.");
  console.error("  source .env.local && node scripts/audit-stages.mjs");
  process.exit(1);
}
const at = createAirtable(PAT, BASE, { log: (...a) => !CSV && console.error(...a) });

/* The stages Cmd+1..4 can produce. Everything else on the ladder needs the
   dropdown, which needs a deliberate click. */
const CHORD_STAGES = new Set([...CNC_LADDER,
  "MQL_MARKETING_QUALIFIED_LEAD", "DISCOVERY_CALL_BOOKED", "SQL_SALES_QUALIFIED_LEAD"]);

const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const label = (s) => STAGE_LABEL[s] || s || "(new)";
const mmss = (s) => `${Math.floor((s || 0) / 60)}m${String((s || 0) % 60).padStart(2, "0")}s`;

/* WHICH FIELDS THIS BASE ACTUALLY HAS. Naming one that is not there fails the
   whole request with a 422 — and a live base drifts from schema.mjs, which is
   the entire reason verify-base.mjs exists. So ask first, then ask only for
   what is there. Without the schema scope on the PAT this returns null and
   every read falls back to no projection, which fetches all fields and works
   regardless. */
const API = process.env.AIRTABLE_BASE_URL || "https://api.airtable.com/v0";
async function liveFields() {
  try {
    const res = await fetch(`${API}/meta/bases/${BASE}/tables`,
      { headers: { Authorization: `Bearer ${PAT}` } });
    if (!res.ok) return null;
    const out = new Map();
    for (const t of (await res.json()).tables || [])
      out.set(t.name, new Set((t.fields || []).map((f) => f.name)));
    return out;
  } catch { return null; }
}
const schema = await liveFields();
/* [] means "no projection" — listAll then returns every field. */
const pick = (table, wanted) => {
  const have = schema?.get(table);
  return have ? wanted.filter((f) => have.has(f)) : [];
};
for (const t of ["Stage Transitions", "Call Log", "Contacts"]) {
  if (schema && !schema.has(t)) {
    console.error(`This base has no "${t}" table, so there is nothing to audit.`);
    console.error("Run: node scripts/verify-base.mjs");
    process.exit(1);
  }
}

let trans, calls, contacts, companies;
try {
  [trans, calls, contacts, companies] = await Promise.all([
    at.listAll("Stage Transitions",
      { fields: pick("Stage Transitions",
          ["Key", "From Stage", "To Stage", "Changed At", "Owner", "Source", "Contact"]) }),
    at.listAll("Call Log",
      { fields: pick("Call Log",
          ["Key", "Called At", "Outcome", "Duration", "Duration Source", "Owner", "Stage Set"]) }),
    at.listAll("Contacts", { fields: pick("Contacts", ["Name", "Kylas Contact ID", "Company"]) }),
    at.listAll("Companies", { fields: pick("Companies", ["Name"]) }).catch(() => []),
  ]);
} catch (e) {
  console.error(`\nAirtable said no: ${e.message}\n`);
  if (e.status === 401 || e.status === 403)
    console.error("That is the token. It needs data.records:read on this base.");
  else if (e.status === 422)
    console.error("A field this script asks for is not in the base. Run: node scripts/verify-base.mjs");
  process.exit(1);
}

/* The company name lives on the Companies row, reached through the Contacts
   link field — Contacts carries no name of its own. */
const coName = new Map(companies.map((c) => [c.id, c.fields.Name || ""]));
const nameOf = new Map(contacts.map((c) => [c.id, c.fields.Name || c.fields["Kylas Contact ID"] || c.id]));
const coOf = new Map(contacts.map((c) => [c.id, coName.get((c.fields.Company || [])[0]) || ""]));

/* syncContact writes the two keys as mirrors of each other — the transition is
   `<contact>-<when>` and the call is `<when>-<contact>` — so one save joins
   exactly, with no time-window guessing. */
const callByKey = new Map(calls.map((c) => [c.fields.Key || "", c]));
const mirror = (k) => {
  const i = String(k).indexOf("-");
  return i < 0 ? "" : `${k.slice(i + 1)}-${k.slice(0, i)}`;
};

const rows = [];
for (const t of trans) {
  const f = t.fields;
  if (!f["Changed At"] || f["Changed At"] < since) continue;

  const call = callByKey.get(mirror(f.Key || ""))?.fields || null;
  const from = f["From Stage"] || "";
  const to = f["To Stage"] || "";
  const secs = Number(call?.Duration || 0);
  const est = call?.["Duration Source"] === "estimated";

  const flags = [];
  if (from && STAGE_RUNG[to] < STAGE_RUNG[from]) flags.push("backwards");
  if (est && secs > LONG) flags.push("long-estimate");
  if (CHORD_STAGES.has(to)) flags.push("chord-shaped");
  if (!call) flags.push("no-call");
  if (!flags.length) continue;

  const cid = (f.Contact || [])[0];
  rows.push({
    when: f["Changed At"],
    who: nameOf.get(cid) || "(unlinked)",
    company: coOf.get(cid) || "",
    owner: f.Owner || call?.Owner || "",
    move: `${label(from)} -> ${label(to)}`,
    outcome: call?.Outcome || "(none)",
    duration: call ? `${mmss(secs)} ${call["Duration Source"] || ""}`.trim() : "(no call row)",
    source: f.Source || "",
    flags,
  });
}
rows.sort((a, b) => (a.when < b.when ? 1 : -1));

if (CSV) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  console.log("Changed At,Contact,Company,Owner,Move,Outcome,Duration,Source,Flags");
  for (const r of rows)
    console.log([r.when, r.who, r.company, r.owner, r.move, r.outcome, r.duration, r.source,
                 r.flags.join(" ")].map(q).join(","));
} else {
  const scanned = trans.filter((t) => (t.fields["Changed At"] || "") >= since).length;
  console.log(`\n${scanned} stage transition(s) in the last ${DAYS} days · ${rows.length} worth a look\n`);
  for (const r of rows) {
    console.log(`${r.when.slice(0, 16).replace("T", " ")}  ${r.who}${r.company ? ` · ${r.company}` : ""}`);
    console.log(`    ${r.move}`);
    console.log(`    owner ${r.owner || "—"} · outcome ${r.outcome} · ${r.duration}`);
    console.log(`    ${r.flags.join(", ")}\n`);
  }
  const tally = {};
  for (const r of rows) for (const f of r.flags) tally[f] = (tally[f] || 0) + 1;
  console.log("by flag:", Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing");
  const worst = rows.filter((r) => r.flags.length >= 3);
  console.log(`\n${worst.length} row(s) carry three or more flags — open those in Kylas first.`);
  console.log("Nothing here was changed. Fix a wrong stage in Kylas; the console picks it up on the next fetch.\n");
}
