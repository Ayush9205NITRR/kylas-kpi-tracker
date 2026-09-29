/* DAYS, AND WHERE ONE ENDS — the browser's half. scripts/day.mjs is the
 * server's, and the two agree by construction: a calendar day, midnight to
 * midnight, in the associate's own timezone. Ayush, 2026-09-29: "All dates
 * should be calculated in midnight to midnight."
 *
 * Here the timezone is simply the machine's, because the machine belongs to
 * the person reading the screen. On the server it has to be named, and is.
 *
 * TWO THINGS THIS REPLACES, both of which were in the tree and both of which
 * read as correct until the hour they do not:
 *
 *   `new Date().toISOString().slice(0, 10)` is the UTC day, not this one. In
 *   IST that is yesterday's date until 05:30, so a call logged at 02:00 was
 *   missing from the Today tab and from the day's count.
 *
 *   `Math.floor((Date.now() - t) / 864e5)` is a rolling twenty-four hours. A
 *   call at 23:00 yesterday reads "Today" at 09:00 this morning, with a green
 *   freshness dot, for an account nobody has touched since yesterday.
 *
 * Everything below counts MIDNIGHTS CROSSED.
 */
(function (global) {
  "use strict";

  /* "sv" is Swedish, whose date format is ISO — the shortest honest way to
     get a LOCAL calendar day out of the platform. toISOString() would give
     the UTC one, which is the bug this file exists to end. */
  const local = (d) => d.toLocaleDateString("sv");

  /* The calendar day an instant fell on. A value that is already a plain date
     is returned untouched: Airtable's date fields carry no time and no zone,
     and putting one through a timezone would move a call-back promised for
     the 29th onto the 28th for anybody west of UTC. */
  function dayOf(value) {
    const s = String(value ?? "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = Date.parse(s);
    return Number.isFinite(t) ? local(new Date(t)) : "";
  }

  const today = () => local(new Date());

  /* N days either side of a day, as a day. YYYY-MM-DD parses as UTC midnight
     and the arithmetic is whole days from there, so it cannot drift across a
     daylight-saving step. */
  const shiftDay = (dayStr, n) =>
    new Date(Date.parse(dayStr + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const shift = (n) => shiftDay(today(), n);

  /* Whole days from a to b — midnights crossed, not hours elapsed. */
  function daysBetween(a, b) {
    const x = dayOf(a), y = dayOf(b);
    if (!x || !y) return null;
    return Math.round((Date.parse(y + "T00:00:00Z") - Date.parse(x + "T00:00:00Z")) / 86400000);
  }

  /* How many days ago, counting from midnight. 0 is today, 1 is yesterday —
     never "0" for something that happened before midnight. */
  const daysAgo = (value) => daysBetween(value, today());
  /* Days until. Negative is overdue, 0 is today. */
  const daysUntil = (value) => daysBetween(today(), value);
  const isToday = (value) => !!value && dayOf(value) === today();

  global.Day = { dayOf, today, shift, shiftDay, daysBetween, daysAgo, daysUntil, isToday };
})(typeof globalThis !== "undefined" ? globalThis : window);
