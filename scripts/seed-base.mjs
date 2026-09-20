#!/usr/bin/env node
/* Loads what the overlay captured into the Airtable base.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/seed-base.mjs export.json
 *   ... --dry-run     to see what would be written
 *
 * export.json is the file from the console's Data -> Export JSON button.
 *
 * This is the proxy's write path in miniature: resolve the company, upsert the
 * contact, append its event rows and calls, and compute the monotonic KPI rank.
 * Getting it right here is what makes the real writer straightforward.
 */
/* Loads .env.local if it is there, so nothing needs sourcing first. Must come
   before any import that reads process.env at module scope. */
import "./env.mjs";
import { requireEnv } from "./env.mjs";
import { readFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const FILE = process.argv.find((a) => a.endsWith(".json"));
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;

if (!FILE) { console.error("Pass the exported json: node scripts/seed-base.mjs export.json"); process.exit(1); }
if (!DRY) requireEnv("AIRTABLE_PAT", "AIRTABLE_BASE");

const dump = JSON.parse(readFileSync(FILE, "utf8"));
const contacts = dump.contacts || [];
const callLog = dump.callLog || [];

/* ── the ladder, same rules as kpi-spec.md §8 ──────────────────────── */
const INITIATED = ["LinkedIn Outreach Initiated", "Cold Call Initiated"];
const rows = (c) => [...(c.past || []), ...(c.current || [])];
const filled = (v) => String(v || "").trim() !== "";
/* Event type is not signal — see docs/kpi-spec.md §5. */
const hasSignal = (c) => rows(c).some((r) => filled(r.budget) || filled(r.timeline) || filled(r.pax));
const isComplete = (c) => rows(c).some((r) => filled(r.budget) && filled(r.timeline) && filled(r.pax));
const connected = (c) => c.stage && c.stage !== "Could Not Connect" && !INITIATED.includes(c.stage);

function rank(c, calls) {
  if (c.stage === "SQL — Active") return 8;
  if (c.stage === "Discovery Call Booked") return 6;
  if (isComplete(c)) return 4;
  if (hasSignal(c)) return 3;
  if (connected(c)) return 2;
  if (calls.length) return 1;
  return 0;
}

/* ── api ───────────────────────────────────────────────────────────── */
let sent = 0;
async function post(table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    sent++;
    if (DRY) {
      console.log(`POST ${table}  ${chunk.length} record(s)`);
      if (i === 0) console.log("  e.g. " + JSON.stringify(chunk[0].fields).slice(0, 160) + "…");
      chunk.forEach((_, n) => out.push({ id: `recDRY${table.slice(0,3)}${i + n}` }));
      continue;
    }
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk, typecast: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${table} -> ${res.status}\n${text}`);
    JSON.parse(text).records.forEach((r) => out.push(r));
    await new Promise((r) => setTimeout(r, 250));   // Airtable allows 5 req/s per base
  }
  return out;
}

const clean = (o) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== "" && v !== null && v !== undefined));

async function main() {
  console.log(DRY ? "Dry run — nothing will be written.\n" : `Seeding ${BASE} from ${FILE}…\n`);

  /* ── companies ──────────────────────────────────────────────────── */
  const seen = new Map();
  for (const c of contacts) if (c.company && !seen.has(String(c.companyId || c.company)))
    seen.set(String(c.companyId || c.company), { Name: c.company, "Kylas Company ID": String(c.companyId || "") });

  const coRecs = await post("Companies", [...seen.values()].map((fields) => ({ fields: clean(fields) })));
  const coId = new Map([...seen.keys()].map((k, i) => [k, coRecs[i].id]));
  console.log(`  ${coRecs.length} companies`);

  /* ── contacts ───────────────────────────────────────────────────── */
  const callsFor = (c) => callLog.filter((e) => (e.kid && e.kid === c.kid) || (!e.kid && e.pocName === c.pocName));

  const payload = contacts.map((c) => {
    const calls = callsFor(c);
    const r = rank(c, calls);
    const last = calls.map((e) => e.at).sort().pop();
    return { fields: clean({
      Name: c.pocName,
      "Kylas Contact ID": c.kid || "",
      Designation: c.designation,
      LinkedIn: c.linkedin ? (/^https?:/i.test(c.linkedin) ? c.linkedin : "https://" + c.linkedin) : "",
      Owner: c.owner,
      "Current Stage": c.stage,
      "Vendor Info": c.vendorInfo,
      "Mode of Meeting": c.modeOfMeeting,
      "Service Offering": !!c.serviceOffering,
      "Ever Picked": connected(c),
      "KPI Rank": r,
      "KPI Rank At": r > 0 ? (last || c.lastCallAt || new Date().toISOString()) : undefined,
      "Pending Create": !!c.pendingCreate,
      Flagged: !!c.flagged,
      Company: coId.has(String(c.companyId || c.company)) ? [coId.get(String(c.companyId || c.company))] : undefined,
    }) };
  });
  const cRecs = await post("Contacts", payload);
  const cId = new Map(contacts.map((c, i) => [c, cRecs[i].id]));
  console.log(`  ${cRecs.length} contacts`);

  /* ── event rows ─────────────────────────────────────────────────── */
  const events = [];
  for (const c of contacts)
    for (const [period, list] of [["Past", c.past || []], ["Current", c.current || []]])
      list.forEach((r, i) => events.push({ fields: clean({
        "Row Key": r.rowKey || `${c.kid || c.pocName}-${period}-${i}`,
        Period: period, "Event Type": r.eventType, Budget: r.budget,
        Timeline: r.timeline, Pax: r.pax, Remarks: r.remarks,
        Contact: [cId.get(c)],
      }) }));
  if (events.length) await post("Event Rows", events);
  console.log(`  ${events.length} event rows`);

  /* ── calls ──────────────────────────────────────────────────────── */
  const byContact = new Map(contacts.map((c) => [c.kid || c.pocName, cId.get(c)]));
  const calls = callLog.map((e, i) => ({ fields: clean({
    Key: `${e.at}-${e.kid || e.pocName || i}`,
    "Called At": e.at,
    Outcome: e.outcome || undefined,
    Duration: e.duration ?? undefined,
    "Duration Source": e.durationSource || "none",
    Owner: e.owner,
    "Stage Set": e.stageSet,
    "Created Here": !!e.createdHere,
    Contact: byContact.has(e.kid || e.pocName) ? [byContact.get(e.kid || e.pocName)] : undefined,
  }) }));
  if (calls.length) await post("Call Log", calls);
  console.log(`  ${calls.length} calls`);

  console.log(DRY ? `\nDry run complete — ${sent} request(s) would be sent.`
                  : `\nDone. Open the base: the rollups on Companies should now have numbers in them.`);
}

main().catch((e) => { console.error("\n" + e.message); process.exit(1); });
