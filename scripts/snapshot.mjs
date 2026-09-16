#!/usr/bin/env node
/* Freezes a day's numbers into the Daily Snapshot table.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/snapshot.mjs
 *   ... node scripts/snapshot.mjs --date 2026-09-15      # a specific day
 *   ... node scripts/snapshot.mjs --dry-run
 *
 * Run it once a day, after the day is over — a cron at 00:30 works. A day that
 * already has a row is left alone: the whole point is that last Tuesday reads
 * the same tomorrow as it does today.
 */
import { createAirtable } from "./airtable.mjs";
import { STAGE_RUNG } from "./stages.mjs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes("--dry-run");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...)."); process.exit(1); }

/* Yesterday by default: today is still happening and must not be frozen. */
const DATE = arg("date") || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
if (DATE >= today) {
  console.error(`${DATE} is not over yet. A day is counted once, after it ends.`);
  process.exit(1);
}

const at = createAirtable(PAT, BASE, { log: (m) => console.log("  " + m) });
const day = (v) => String(v || "").slice(0, 10);
const filled = (v) => String(v || "").trim() !== "";

console.log(`Freezing ${DATE}…`);

/* ── the day's activity, from the append-only logs ──────────────────── */
const calls = (await at.list("Call Log", "", 1000)).filter((r) => day(r.fields["Called At"]) === DATE);
const moves = (await at.list("Stage Transitions", "", 1000)).filter((r) => day(r.fields["Changed At"]) === DATE);

/* ── where things stood at the end of it ───────────────────────────── */
const contacts = await at.list("Contacts", "", 1000);
const rows = await at.list("Event Rows", "", 1000);
const byContact = new Map();
for (const r of rows) for (const id of r.fields.Contact || []) {
  if (!byContact.has(id)) byContact.set(id, []);
  byContact.get(id).push(r.fields);
}

const signal = (id) => (byContact.get(id) || []).some((f) => filled(f.Budget) || filled(f.Timeline) || filled(f.Pax));
const complete = (id) => (byContact.get(id) || []).some((f) => filled(f.Budget) && filled(f.Timeline) && filled(f.Pax));

/* Company is the unit every KPI is counted in. */
const companies = new Map();
for (const c of contacts) {
  const co = (c.fields.Company || [])[0];
  if (!co) continue;
  if (!companies.has(co)) companies.set(co, { reached: false, picked: false, right: false, discovery: false, booked: false, sql: false });
  const g = companies.get(co);
  const rank = Number(c.fields["KPI Rank"] || 0);
  if (rank > 0) g.reached = true;
  if (c.fields["Ever Picked"]) g.picked = true;
  if (signal(c.id)) g.right = true;
  if (complete(c.id)) g.discovery = true;
  if (rank >= STAGE_RUNG.DISCOVERY_CALL_BOOKED) g.booked = true;
  if (rank >= STAGE_RUNG.SQL_SALES_QUALIFIED_LEAD) g.sql = true;
}
/* Cumulative, so the funnel reads straight down. */
for (const g of companies.values()) {
  g.discovery = g.discovery || g.sql;
  g.right = g.right || g.discovery;
  g.picked = g.picked || g.right;
  g.reached = g.reached || g.picked;
}
const count = (k) => [...companies.values()].filter((g) => g[k]).length;

/* A movement is a rung that was climbed ON this day — not a total. */
const rose = (floor) => moves.filter((m) => (STAGE_RUNG[m.fields["To Stage"]] || 0) >= floor
  && (STAGE_RUNG[m.fields["From Stage"]] || 0) < floor).length;

const owner = [...new Set(calls.map((c) => c.fields.Owner).filter(Boolean))].join(", ") || "all";
const dials = calls.length;
const connects = calls.filter((c) => c.fields.Outcome && c.fields.Outcome !== "No answer").length;

const fields = {
  Key: `${DATE} · ${owner}`,
  Date: DATE,
  Owner: owner,

  /* activity — these add up across a week */
  Dials: dials,
  Connects: connects,
  "New Right POC": rose(STAGE_RUNG.MQL_MARKETING_QUALIFIED_LEAD),
  "New Discovery": rose(STAGE_RUNG.DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS),
  "New SQL Booked": rose(STAGE_RUNG.DISCOVERY_CALL_BOOKED),
  "New SQL Accepted": rose(STAGE_RUNG.SQL_SALES_QUALIFIED_LEAD),
  "Companies Touched": new Set(calls.flatMap((c) => c.fields.Contact || [])).size,
  "Contacts Added": calls.filter((c) => c.fields["Created Here"]).length,
  "Talk Seconds": calls.reduce((n, c) =>
    n + (c.fields["Duration Source"] === "dialed" ? Number(c.fields.Duration || 0) : 0), 0),

  /* standing totals — read the latest day, never sum these */
  "Companies At Right POC": count("right"),
  "Companies At Discovery": count("discovery"),
  "Companies At SQL Booked": count("booked"),
  "Companies At SQL Accepted": count("sql"),
  "Companies Reached To Date": count("reached"),

  "Connect Rate": dials ? Math.round((connects / dials) * 100) / 100 : 0,
  "Frozen At": new Date().toISOString(),
};

console.log(`\n  ${dials} dial(s), ${connects} connected, ${companies.size} compan${companies.size === 1 ? "y" : "ies"}`);
for (const [k, v] of Object.entries(fields)) if (k !== "Key" && k !== "Frozen At") console.log(`  ${k.padEnd(28)} ${v}`);

if (DRY) { console.log("\nDry run — nothing written."); process.exit(0); }

/* Never rewrite a frozen day. */
const existing = await at.find("Daily Snapshot", `{Key} = '${fields.Key.replace(/'/g, "\\'")}'`);
if (existing) {
  console.log(`\n${DATE} is already frozen (${existing.fields["Frozen At"]}). Left untouched — that is the point.`);
  process.exit(0);
}
await at.create("Daily Snapshot", [fields]);
console.log(`\nFrozen. ${DATE} will read the same tomorrow as it does now.`);
