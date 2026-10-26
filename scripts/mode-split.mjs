/* STAGE × MODE OF MEETING — the admin's split.
 *
 * Ayush, 2026-10-26: "mode of meeting ka dashboard — stage ke hisab se … Stage
 * -> mode of meeting split (sirf admin ko dikhe)". Mode of Meeting is a contact
 * field (In Person | Virtual | Calls | Text, docs/kpi-spec.md §6) the console
 * requires at the moment of a successful discovery; Current Stage is where that
 * contact stands now. So the table is: for each stage, how many contacts hold
 * each mode.
 *
 * CONTACTS, not companies — the mode belongs to a person's meeting and one
 * company can hold two modes. Only stages where somebody has a mode are listed,
 * with the stage's whole head-count beside it so the coverage is visible: "12 of
 * 300 contacts at Discovery have a mode" is itself the finding.
 *
 * Pure: rows in, table out. handlers.mjs feeds it the Contacts table.
 */
import { STAGE_LABEL, STAGE_RUNG } from "./stages.mjs";

export const MODES = ["In Person", "Virtual", "Calls", "Text"];

/* contacts: [{ fields: { "Current Stage", "Mode of Meeting", Owner } }] — select
   values arrive as strings (the Airtable REST API) or { name } (older reads).
   Stage may be the code or the label; both are folded to the code's label. */
const txt = (v) => (v && typeof v === "object" ? v.name ?? "" : v ?? "");
const stageKey = (v) => String(txt(v)).trim();

export function stageModeSplit(contacts = [], { owner = "" } = {}) {
  const want = String(owner || "").trim().toLowerCase();
  const byStage = new Map();
  let total = 0, withMode = 0;
  for (const c of contacts) {
    const f = c?.fields || {};
    if (want && String(txt(f.Owner)).trim().toLowerCase() !== want) continue;
    const stage = stageKey(f["Current Stage"]);
    const mode = String(txt(f["Mode of Meeting"])).trim();
    total++;
    if (!byStage.has(stage)) byStage.set(stage, { stage, all: 0, withMode: 0, counts: Object.fromEntries(MODES.map((m) => [m, 0])), other: 0 });
    const row = byStage.get(stage);
    row.all++;
    if (!mode) continue;
    row.withMode++; withMode++;
    if (MODES.includes(mode)) row.counts[mode]++; else row.other++;
  }
  const rows = [...byStage.values()].filter((r) => r.withMode > 0)
    .map((r) => ({ ...r, code: r.stage, label: STAGE_LABEL[r.stage] || r.stage || "No stage", rung: STAGE_RUNG[r.stage] || 0 }))
    .sort((a, b) => b.rung - a.rung || a.label.localeCompare(b.label));
  const sum = (k) => rows.reduce((a, r) => a + (k === "other" ? r.other : r.counts[k]), 0);
  return { modes: MODES, rows, owner,
           totals: { ...Object.fromEntries(MODES.map((m) => [m, sum(m)])), other: sum("other"), withMode, contacts: total } };
}
