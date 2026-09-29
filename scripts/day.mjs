/* DAYS, AND WHERE ONE ENDS.
 *
 * Every date on every screen is a CALENDAR DAY in the associate's timezone —
 * midnight to midnight, IST — and nothing here is a rolling twenty-four
 * hours or a UTC date. Ayush, 2026-09-29: "All dates should be calculated in
 * midnight to midnight."
 *
 * Both mistakes were in the tree, in about twenty places, and they read as
 * correct right up until the hour they do not:
 *
 *   `new Date(iso).toISOString().slice(0, 10)` is the UTC day. A call logged
 *   at 02:00 IST belongs to that morning; its UTC stamp is 20:30 the evening
 *   before, so the Today tab did not list it, the daily snapshot counted it
 *   yesterday, and a follow-up promised for that date read as overdue. Every
 *   call made between midnight and 05:30 IST landed on the wrong day, which
 *   is the early shift.
 *
 *   `Math.floor((Date.now() - t) / 864e5)` is a rolling day. A call at 23:00
 *   yesterday reads "0 days ago — Today" at 09:00 this morning, and the
 *   freshness dot beside it is green for an account nobody has touched since
 *   yesterday.
 *
 * So: one function that turns an instant into the day it fell on, and one
 * that subtracts two of those. The offset is explicit rather than the host's
 * — the Worker runs in UTC, the cron runs in UTC, and "the server's local
 * time" is not a thing that exists on Cloudflare.
 */

/* Minutes east of UTC. 330 is IST; env.TZ_OFFSET_MIN overrides it, which is
   the one knob to turn if the team ever works from another zone. */
export const IST_MIN = 330;
export const tzMinOf = (env = {}) => Number(env.TZ_OFFSET_MIN ?? IST_MIN);

/* The calendar day an instant fell on, as YYYY-MM-DD.
   A value that is ALREADY a plain date is returned untouched: Airtable's date
   fields have no time and no zone, and shifting one by five and a half hours
   would move a call-back promised for the 29th to the 28th. */
export function dayOf(value, tzMin = IST_MIN) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "";
  return new Date(t + tzMin * 60000).toISOString().slice(0, 10);
}

/* Today, there. */
export const today = (tzMin = IST_MIN, now = Date.now()) =>
  new Date(now + tzMin * 60000).toISOString().slice(0, 10);

/* N days from a day, as a day. Parsing YYYY-MM-DD gives UTC midnight and the
   arithmetic is whole days from there, so this never lands on the wrong side
   of a daylight-saving step — India has none, and this way it would not
   matter if it did. */
export const shiftDay = (dayStr, n) =>
  new Date(Date.parse(`${dayStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/* Whole days from a to b, counting MIDNIGHTS CROSSED and not elapsed hours.
   Both sides are reduced to their day first, so 23:00 yesterday to 09:00
   today is 1 and not 0. */
export function daysBetween(a, b, tzMin = IST_MIN) {
  const x = dayOf(a, tzMin), y = dayOf(b, tzMin);
  if (!x || !y) return null;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / 86400000);
}

/* How many days ago that day was. Positive is the past, 0 is today. */
export const daysAgo = (value, tzMin = IST_MIN, now = Date.now()) =>
  daysBetween(value, today(tzMin, now), tzMin);

/* Whether an instant fell on a given day there. */
export const isOnDay = (value, dayStr, tzMin = IST_MIN) => !!dayStr && dayOf(value, tzMin) === dayStr;
