#!/usr/bin/env node
/* Puts back the KPI Ranks the sync wrote down, and the dates it moved.
 *
 *   node --env-file=.env.local scripts/repair-kpi-rank.mjs           # the plan
 *   node --env-file=.env.local scripts/repair-kpi-rank.mjs --apply   # write it
 *
 * Dry by default. Nothing is written without --apply.
 *
 * WHY
 * Until Worker 1.56.1, sync-kylas read only the first 20,000 rows of Contacts
 * and the base holds 37,000+. A contact past row 20,000 read as never seen, so
 * every hourly run that touched it wrote
 *
 *   KPI Rank     = the rung of its CURRENT Kylas stage — lower, if it had been
 *                  higher and come back down (Follow Up 1 → Could Not Connect)
 *   KPI Rank At  = the time of that run, because 0 → anything is a rise
 *
 * Checked on 2026-10-09: 25 contacts held a rank below the highest stage
 * their own Stage Transitions show them reaching, and the hourly :42 runs had
 * re-stamped KPI Rank At on about 200 more. KPI Rank At dates Right POC and
 * Discovery in the report, so a re-stamp moves that arrival to another day.
 *
 * THE RULE — from the transitions, which the sync never rewrote
 *   KPI Rank     = MAX(stored, highest rung any transition reached). It only
 *                  ever rises, the same as every writer.
 *   KPI Rank At  = the FIRST transition that reached that rank. Rank only
 *                  rises, so the first arrival at the top rung IS the last time
 *                  it rose, which is what the field means. Rewritten only when
 *                  the stored value is more than 10 minutes off it: a console
 *                  save stamps the field seconds after its own transition, and
 *                  those are left exactly as they are.
 * A contact with no transitions has nothing to check against and is skipped.
 */
import { createAirtable, listTolerant } from "./airtable.mjs";
import { STAGE_RUNG } from "./stages.mjs";

const APPLY = process.argv.includes("--apply");
const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE;
if (!PAT || !BASE) { console.error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...)."); process.exit(1); }
const at = createAirtable(PAT, BASE, {
  log: (m) => console.log("  " + m),
  ...(process.env.AIRTABLE_BASE_URL ? { apiUrl: process.env.AIRTABLE_BASE_URL } : {}),
});

/* Whole tables, and a failure rather than a prefix — a prefix is the bug. */
const ALL = { pageSize: 100, maxPages: 2000, throwIfMore: true };
console.log("reading Stage Transitions and Contacts (Contacts is ~375 requests, about a minute)...");
const [transitions, contacts] = await Promise.all([
  listTolerant(at, "Stage Transitions", { fields: ["To Stage", "Changed At", "Contact"], ...ALL }),
  listTolerant(at, "Contacts", { fields: ["Name", "Owner", "KPI Rank", "KPI Rank At"], ...ALL }),
]);

const moves = new Map();
for (const t of transitions) {
  const who = (t.fields?.Contact || [])[0];
  const rung = STAGE_RUNG[t.fields?.["To Stage"]] || 0;
  if (!who || !rung || !t.fields?.["Changed At"]) continue;
  (moves.get(who) || moves.set(who, []).get(who)).push({ at: t.fields["Changed At"], rung });
}

const SLACK_MS = 10 * 60 * 1000;
const istDay = (s) => new Date(Date.parse(s) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const plan = [];
for (const r of contacts) {
  const ts = moves.get(r.id);
  if (!ts) continue;
  const f = r.fields || {};
  const stored = Number(f["KPI Rank"] || 0);
  const rank = Math.max(stored, ...ts.map((t) => t.rung));
  const firstAt = ts.filter((t) => t.rung === rank).map((t) => t.at).sort()[0] || "";
  const storedAt = f["KPI Rank At"] || "";
  const fields = {};
  if (rank > stored) fields["KPI Rank"] = rank;
  if (firstAt && (!storedAt || Math.abs(Date.parse(storedAt) - Date.parse(firstAt)) > SLACK_MS))
    fields["KPI Rank At"] = firstAt;
  if (Object.keys(fields).length)
    plan.push({ id: r.id, name: f.Name || r.id, owner: f.Owner || "", stored, storedAt, fields,
                dayMoved: !!(storedAt && fields["KPI Rank At"] && istDay(storedAt) !== istDay(firstAt)) });
}

const raised = plan.filter((p) => p.fields["KPI Rank"]);
const redated = plan.filter((p) => p.fields["KPI Rank At"]);
console.log(`\n${contacts.length} contacts · ${transitions.length} transitions · ${moves.size} contacts with moves`);
console.log(`  ${raised.length} KPI Rank to RAISE back to the highest stage reached`);
for (const p of raised)
  console.log(`    ${p.name.padEnd(28)} ${p.owner.padEnd(18)} ${String(p.stored).padStart(2)} -> ${p.fields["KPI Rank"]}`);
console.log(`  ${redated.length} KPI Rank At to correct, ${redated.filter((p) => p.dayMoved).length} of them onto a different day`);
for (const p of redated.filter((x) => x.dayMoved).slice(0, 15))
  console.log(`    ${p.name.padEnd(28)} ${istDay(p.storedAt)} -> ${istDay(p.fields["KPI Rank At"])}`);

if (!plan.length) { console.log("\nNothing to repair."); process.exit(0); }
if (!APPLY) { console.log("\nNothing was changed. Re-run with --apply."); process.exit(0); }

/* Airtable takes 10 records per update. typecast for the date field. */
let done = 0;
for (let i = 0; i < plan.length; i += 10) {
  const batch = plan.slice(i, i + 10);
  await at.call("PATCH", `/${encodeURIComponent("Contacts")}`, {
    records: batch.map((p) => ({ id: p.id, fields: p.fields })), typecast: true });
  done += batch.length;
}
console.log(`\nrepaired ${done} contact(s).`);
