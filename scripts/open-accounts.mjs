/* OPEN ACCOUNTS — an account a BD has picked stays in front of them until it
 * reaches SQL.
 *
 * Ayush, 2026-10-28: "ek baar account pakad liya, jab tak right POC identify nahi
 * hota mere pane mein dikhna chahiye … right POC → discovery → SQL, clearly
 * visible". Picked = the first call (console or the Kylas dialler), no click.
 * Shown, never blocking.
 *
 *   need "right"      called, no Right POC yet (no row with budget | timeline | pax)
 *   need "discovery"  Right POC, no successful discovery (no complete row)
 *   need "sql"        discovery done (or a meeting booked), not SQL
 *   null              not called yet, SQL reached, or every contact closed
 *
 * p is one entry of accountProgress().byCompany. Pure.
 */
import { MILESTONE } from "./stages.mjs";

export const NEEDS = { right: "Needs Right POC", discovery: "Needs discovery call", sql: "Needs SQL" };
export const STALE_DAYS = 5;

export function needOf(p) {
  if (!p) return null;
  if (!((p.calls || 0) + (p.dialCalls || 0) > 0)) return null;
  const rung = p.rung || 0;
  if (p.done || rung >= MILESTONE.sql.floor) return null;
  if (p.contacts && p.exited >= p.contacts) return null;
  if (p.discovery || rung >= MILESTONE.sqlMeetingBooked.floor) return "sql";
  if (p.right) return "discovery";
  return "right";
}

/* What /companies carries per account, so the console can sort, badge and count
   without a second request. */
export function openOf(p) {
  const need = needOf(p);
  if (!need) return null;
  const first = [p.firstCallAt, p.dialFirstAt].filter(Boolean).sort()[0] || null;
  const last = [p.lastCallAt, p.dialLastAt].filter(Boolean).sort().pop() || null;
  return { need, firstCallAt: first, lastCallAt: last, calls: (p.calls || 0) + (p.dialCalls || 0) };
}
