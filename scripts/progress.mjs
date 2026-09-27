/* WHERE EACH ACCOUNT STANDS, AND HOW FAST IT IS BEING WORKED.
 *
 * Pure: rows in, answers out. The handlers feed it the D1 copy of Airtable;
 * test-progress.mjs feeds it fixtures.
 *
 * Per company (keyed by Kylas company id):
 *   rung, stage   the furthest any of its contacts has reached
 *   sqlAt         the first time any contact moved to SQL (or Activation)
 *   done          reached SQL — a focus account is "exhausted" only then
 *   closed        every contact it has is at a dead end (exit stage)
 *   lastCallAt    the latest call logged to any of its contacts
 *   nextCall      the earliest call-back set on a contact still in play
 *
 * Follow-up adherence (TAT), per owner: every call that promised a call-back
 * ("Next Call Date" on the Call Log row) is matched to the next call made to
 * the same contact. On time = that call happened on or before the promised
 * day. A promise whose day has passed with no call yet is late and open.
 */
import { STAGE_RUNG, EXIT_STAGES } from "./stages.mjs";

export const QUALIFIED = ["SQL_SALES_QUALIFIED_LEAD", "ACTIVATION"];
const DAY = 864e5;
const day = (iso) => String(iso || "").slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / DAY);

export function accountProgress({ companies = [], contacts = [], transitions = [], calls = [], today }) {
  const t = day(today || new Date().toISOString());
  const kidOf = new Map(companies.map((r) => [r.id, String(r.fields?.["Kylas Company ID"] || "")]));
  const contactCo = new Map();                 /* contact record id -> kid */
  const byCo = new Map();
  const co = (kid) => {
    if (!byCo.has(kid)) byCo.set(kid, { rung: 0, stage: "", sqlAt: null, done: false, contacts: 0,
                                        exited: 0, lastCallAt: null, nextCall: null });
    return byCo.get(kid);
  };

  for (const r of contacts) {
    const f = r.fields || {};
    const kid = kidOf.get((f.Company || [])[0]) || "";
    if (!kid) continue;
    contactCo.set(r.id, kid);
    const p = co(kid);
    const stage = f["Current Stage"] || "";
    const rung = Math.max(Number(f["KPI Rank"] || 0), STAGE_RUNG[stage] || 0);
    p.contacts++;
    if (EXIT_STAGES.includes(stage)) p.exited++;
    if (rung > p.rung) { p.rung = rung; p.stage = stage; }
    if (QUALIFIED.includes(stage)) p.done = true;
    /* A call-back only counts while the contact is still in play. */
    const next = day(f["Next Call Date"]);
    if (next && !EXIT_STAGES.includes(stage) && (!p.nextCall || next < p.nextCall)) p.nextCall = next;
  }

  for (const r of transitions) {
    const f = r.fields || {};
    if (!QUALIFIED.includes(f["To Stage"])) continue;
    const kid = contactCo.get((f.Contact || [])[0]);
    if (!kid) continue;
    const p = co(kid);
    p.done = true;
    if (f["Changed At"] && (!p.sqlAt || f["Changed At"] < p.sqlAt)) p.sqlAt = f["Changed At"];
  }

  /* Calls per contact, in time order, for last-call and follow-up adherence. */
  const perContact = new Map();
  for (const r of calls) {
    const f = r.fields || {};
    const cid = (f.Contact || [])[0];
    if (!cid || !f["Called At"]) continue;
    const kid = contactCo.get(cid);
    if (kid) {
      const p = co(kid);
      if (!p.lastCallAt || f["Called At"] > p.lastCallAt) p.lastCallAt = f["Called At"];
    }
    if (!perContact.has(cid)) perContact.set(cid, []);
    perContact.get(cid).push({ at: f["Called At"], promised: day(f["Next Call Date"]), owner: f.Owner || "" });
  }

  const followups = new Map();                 /* owner -> { due, onTime, late, open, delays[] } */
  const fu = (o) => {
    if (!followups.has(o)) followups.set(o, { due: 0, onTime: 0, late: 0, open: 0, delays: [] });
    return followups.get(o);
  };
  for (const list of perContact.values()) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    list.forEach((c, i) => {
      if (!c.promised) return;
      const nxt = list[i + 1];
      const o = fu(c.owner || "—");
      if (nxt) {
        o.due++;
        const late = daysBetween(c.promised, nxt.at);
        if (late <= 0) o.onTime++; else { o.late++; o.delays.push(late); }
      } else if (c.promised < t) {
        o.due++; o.open++; o.late++; o.delays.push(daysBetween(c.promised, t));
      }
    });
  }

  for (const p of byCo.values()) p.closed = !p.done && p.contacts > 0 && p.exited === p.contacts;
  return { byCompany: byCo, followups };
}

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/* A focus account's standing, for the reminder pane: what is owed today. */
export function focusStanding(entry, p, today) {
  const t = day(today || new Date().toISOString());
  const pickedAt = entry?.setAt || null;
  const daysOpen = pickedAt ? daysBetween(pickedAt, t) : null;
  const base = { daysOpen, stage: p?.stage || "", rung: p?.rung || 0, lastCallAt: p?.lastCallAt || null,
                 nextCall: p?.nextCall || null, sqlAt: p?.sqlAt || null };
  if (p?.done) return { ...base, state: "done",
                        tatDays: pickedAt && p.sqlAt ? Math.max(0, daysBetween(pickedAt, p.sqlAt)) : null };
  if (p?.closed) return { ...base, state: "closed" };
  if (!p?.nextCall) return { ...base, state: "no-date" };
  const d = daysBetween(t, p.nextCall);
  return { ...base, state: d < 0 ? "overdue" : d === 0 ? "today" : "later", dueIn: d };
}
