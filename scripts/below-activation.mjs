/* CALLED, BUT STILL BELOW ACTIVATION — THE DAILY TRACKER MAIL.
 *
 * Ayush, 2026-10-22: "ek notification — accounts which are called but have
 * been in below activation state in rung, toh usko hum tag kar paaye … har din
 * ka update: pehli call -> CNC mein thi, ab usse track karna". By mail.
 *
 * WHICH ACCOUNTS (his choice, 2026-10-22):
 *   - CALLED: at least one call in the Call Log;
 *   - BELOW ACTIVATION: the furthest any of its contacts has reached is under
 *     rung 13 (docs/stages.json) — CNC 1/2/3, Followup-CNC, Connect Later,
 *     Wrong POC, NDM, POC changed, still at LinkedIn Outreach Initiated;
 *   - NOT CLOSED, NOT A CONVERSATION THAT HAPPENED: Not Interested, Invalid
 *     Contact (closed) and Offsite Delayed / Offsite Done (Late Reachout) —
 *     below 13 on the ladder but a talk was had — are left out.
 * No threshold: tracked from the first call, every day, until it climbs.
 *
 * WHAT THE MAIL SAYS, per day: how many, who holds them, what changed since
 * yesterday (climbed to Activation or above, newly in, dropped out as closed),
 * and per owner the accounts longest stuck first — stage, days since the first
 * call, calls made, days since the last one.
 *
 * Pure: rows in, report out. The handlers feed it progress() and the company
 * list; test-below-activation.mjs feeds it fixtures. The day-to-day comparison
 * is against yesterday's snapshot, which the caller keeps.
 */
import { daysBetween, IST_MIN } from "./day.mjs";

export const ACTIVATION_RUNG = 13;
const gap = (from, to, tzMin) => { const d = from ? daysBetween(from, to, tzMin) : null; return d == null ? null : Math.max(0, d); };
/* Below 13 and still left out — see the header. */
export const NOT_STUCK = new Set(["NOT_INTERESTED", "INVALID_CONTACT", "CLOSING_LOOPS_LOW_VALUE",
  "OFFSITE_DELAYED", "OFFSITE_DONE_LATE_REACHOUT"]);

/* byCompany: accountProgress().byCompany (kid -> { rung, stage, calls,
   firstCallAt, lastCallAt }). companies: [{ id, name, owner }] — the owner as
   Kylas has it now. labels: stage code -> what people read. */
export function stuckAccounts({ byCompany, companies = [], today, tzMin = IST_MIN, labels = {} }) {
  const info = new Map(companies.map((c) => [String(c.id), c]));
  const out = [];
  for (const [kid, p] of byCompany || []) {
    /* Called = a call logged in the console OR placed from the Kylas dialler. */
    const calls = (p?.calls || 0) + (p?.dialCalls || 0);
    if (!p || !(calls > 0)) continue;
    const firstAt = [p.firstCallAt, p.dialFirstAt].filter(Boolean).sort()[0] || null;
    const lastAt = [p.lastCallAt, p.dialLastAt].filter(Boolean).sort().pop() || null;
    if ((p.rung || 0) >= ACTIVATION_RUNG) continue;
    if (NOT_STUCK.has(p.stage)) continue;
    const c = info.get(String(kid)) || {};
    out.push({
      id: String(kid), name: c.name || `Company ${kid}`, owner: c.owner || "—",
      stage: p.stage || "", stageLabel: labels[p.stage] || p.stage || "no stage yet", rung: p.rung || 0,
      calls, firstCallAt: firstAt, lastCallAt: lastAt,
      days: gap(firstAt, today, tzMin),
      sinceLast: gap(lastAt, today, tzMin),
    });
  }
  return out.sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.name.localeCompare(b.name));
}

/* What changed since yesterday. prev: { [id]: { rung, stage } } from the last
   mail (null on the first day). byCompany is today's, so an account that left
   the list can say WHY: it climbed, or it closed. */
export function changes(prev, stuck, byCompany) {
  const now = new Map(stuck.map((s) => [s.id, s]));
  if (!prev) return { first: true, added: [], climbed: [], closed: [], moved: [] };
  const added = stuck.filter((s) => !prev[s.id]);
  const climbed = [], closed = [], moved = [];
  for (const [id, was] of Object.entries(prev)) {
    if (now.has(id)) {
      const n = now.get(id);
      if (n.rung !== was.rung) moved.push({ ...n, wasStage: was.stage, wasRung: was.rung });
      continue;
    }
    const p = byCompany?.get?.(id);
    if (p && (p.rung || 0) >= ACTIVATION_RUNG) climbed.push({ id, name: was.name, owner: was.owner, stage: p.stage, wasStage: was.stage });
    else closed.push({ id, name: was.name, owner: was.owner, stage: p?.stage || "", wasStage: was.stage });
  }
  return { first: false, added, climbed, closed, moved };
}

export const snapshotOf = (stuck) => Object.fromEntries(stuck.map((s) => [s.id,
  { rung: s.rung, stage: s.stage, name: s.name, owner: s.owner }]));

/* ── the mail ───────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const byOwner = (list) => {
  const m = new Map();
  for (const s of list) { if (!m.has(s.owner)) m.set(s.owner, []); m.get(s.owner).push(s); }
  return [...m].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
};
const ago = (n) => (n == null ? "—" : n === 0 ? "today" : n === 1 ? "1 day" : `${n} days`);

export function subjectOf(day, stuck, ch) {
  const delta = ch.first ? "" : ` · +${ch.added.length} new, ${ch.climbed.length} climbed`;
  return `BD · called, below Activation · ${day} · ${stuck.length} account${stuck.length === 1 ? "" : "s"}${delta}`;
}

export function renderText(day, stuck, ch, { labels = {}, perOwner = 25 } = {}) {
  const L = (c) => labels[c] || c || "—";
  const lines = [`Called, but still below Activation — ${day}`, "",
    `${stuck.length} account(s): called at least once, furthest contact under Activation (rung 13).`,
    `Not counted: Not Interested, Invalid Contact, Offsite Delayed, Offsite Done (Late Reachout).`, ""];
  if (ch.first) lines.push("First day of tracking — tomorrow's mail shows what changed.", "");
  else {
    lines.push(`Since yesterday: ${ch.climbed.length} climbed to Activation or above · ${ch.added.length} newly here · ${ch.closed.length} closed or left.`);
    for (const c of ch.climbed) lines.push(`  ↑ ${c.name} (${c.owner}): ${L(c.wasStage)} → ${L(c.stage)}`);
    for (const m of ch.moved) lines.push(`  · ${m.name} (${m.owner}): ${L(m.wasStage)} → ${L(m.stage)}, still below`);
    lines.push("");
  }
  lines.push("By owner:");
  for (const [owner, list] of byOwner(stuck)) lines.push(`  ${owner}: ${list.length}`);
  for (const [owner, list] of byOwner(stuck)) {
    lines.push("", `${owner} — ${list.length}, longest first:`);
    for (const s of list.slice(0, perOwner))
      lines.push(`  ${s.name} · ${s.stageLabel} · first call ${ago(s.days)} ago · ${s.calls} call(s) · last ${ago(s.sinceLast)} ago`);
    if (list.length > perOwner) lines.push(`  …and ${list.length - perOwner} more`);
  }
  return lines.join("\n");
}

export function renderHtml(day, stuck, ch, { labels = {}, perOwner = 25 } = {}) {
  const L = (c) => esc(labels[c] || c || "—");
  const td = 'style="padding:4px 10px 4px 0;font:13px/1.35 system-ui;color:#333;vertical-align:top"';
  const th = 'style="padding:4px 10px 4px 0;font:600 12px/1.35 system-ui;color:#666;text-align:left"';
  const head = `<p style="font:600 15px/1.3 system-ui;color:#111;margin:0 0 6px">Called, but still below Activation · ${esc(day)}</p>` +
    `<p style="font:13px/1.4 system-ui;color:#444;margin:0 0 12px"><b>${stuck.length}</b> account(s) called at least once whose furthest contact is under Activation (rung 13). ` +
    `Not Interested, Invalid Contact and the two Offsite stages are left out.</p>`;
  const delta = ch.first ? `<p style="font:13px system-ui;color:#666">First day of tracking — tomorrow's mail shows what changed.</p>`
    : `<p style="font:13px/1.4 system-ui;color:#333;margin:0 0 6px">Since yesterday: <b style="color:#15803d">${ch.climbed.length} climbed</b> · ` +
      `<b>${ch.added.length} newly here</b> · ${ch.closed.length} closed or left</p>` +
      (ch.climbed.length ? `<ul style="font:13px/1.4 system-ui;color:#333;margin:0 0 12px;padding-left:18px">${ch.climbed.map((c) =>
        `<li>↑ <b>${esc(c.name)}</b> (${esc(c.owner)}): ${L(c.wasStage)} → ${L(c.stage)}</li>`).join("")}</ul>` : "");
  const owners = byOwner(stuck).map(([owner, list]) => `<p style="font:600 14px system-ui;color:#111;margin:16px 0 4px">${esc(owner)} — ${list.length}</p>` +
    `<table cellspacing="0" cellpadding="0"><tr><th ${th}>Account</th><th ${th}>Stage</th><th ${th}>First call</th><th ${th}>Calls</th><th ${th}>Last call</th></tr>` +
    list.slice(0, perOwner).map((s) => `<tr><td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.stageLabel)}</td>` +
      `<td ${td}>${ago(s.days)} ago</td><td ${td}>${s.calls}</td><td ${td}>${ago(s.sinceLast)} ago</td></tr>`).join("") +
    `</table>${list.length > perOwner ? `<p style="font:12px system-ui;color:#666">…and ${list.length - perOwner} more</p>` : ""}`).join("");
  return `<div style="max-width:680px">${head}${delta}${owners}</div>`;
}
