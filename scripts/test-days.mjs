/* WHERE ONE DAY ENDS AND THE NEXT BEGINS.
 *
 * Every case here is an hour at which the old code was wrong. The two faults
 * it replaces both pass a casual reading and both fail at a boundary, so the
 * boundaries are what this file is made of: 23:59 and 00:01 IST, the 05:30
 * window where the UTC date still says yesterday, and a call at 23:00 read
 * the next morning.
 *
 * Run: node scripts/test-days.mjs
 */
import { dayOf, today, shiftDay, daysBetween, daysAgo, isOnDay, IST_MIN, tzMinOf } from "./day.mjs";

let pass = 0, fail = 0;
const is = (what, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

/* ── the early shift ────────────────────────────────────────────────── */
console.log("1. midnight to 05:30 IST is TODAY, though UTC still says yesterday");
/* 02:00 IST on the 30th is 20:30 UTC on the 29th. This is the whole bug: an
   associate on the early shift logged calls that the Today tab did not list,
   the snapshot counted on the previous day, and a call-back promised for that
   morning read as overdue before it was due. */
is("02:00 IST → that morning", dayOf("2026-09-29T20:30:00.000Z"), "2026-09-30");
is("...and the UTC day is indeed the day before",
  new Date("2026-09-29T20:30:00.000Z").toISOString().slice(0, 10), "2026-09-29");
is("00:01 IST → the new day", dayOf("2026-09-29T18:31:00.000Z"), "2026-09-30");
is("23:59 IST → still the old day", dayOf("2026-09-29T18:29:00.000Z"), "2026-09-29");
is("05:29 IST → still that day", dayOf("2026-09-29T23:59:00.000Z"), "2026-09-30");
is("05:31 IST → the same day", dayOf("2026-09-30T00:01:00.000Z"), "2026-09-30");

/* ── a plain date is a plain date ───────────────────────────────────── */
console.log("\n2. a date with no time is never shifted");
/* Airtable's date fields carry no time and no zone. Putting one through an
   offset moves a call-back promised for the 29th onto the 28th for anybody
   west of UTC, and onto the 30th for anybody far enough east. */
is("a Next Call Date stays put", dayOf("2026-09-29"), "2026-09-29");
is("...whatever the offset", dayOf("2026-09-29", -480), "2026-09-29");
is("...including at the far end", dayOf("2026-09-29", 840), "2026-09-29");
is("empty is empty", dayOf(""), "");
is("null is empty, not the epoch", dayOf(null), "");
is("nonsense is empty, not Invalid Date", dayOf("not a date"), "");

/* ── midnights crossed, not hours elapsed ───────────────────────────── */
console.log("\n3. days are midnights crossed");
/* THE ROLLING-DAY BUG. 23:00 yesterday to 09:00 today is ten hours, and the
   old code called that 0 — "Today", with a green freshness dot, for an
   account nobody had touched since the day before. */
const lateLastNight = "2026-09-28T17:30:00.000Z";   /* 23:00 IST on the 28th */
const thisMorning = "2026-09-29T03:30:00.000Z";     /* 09:00 IST on the 29th */
is("23:00 → 09:00 next morning is 1 day", daysBetween(lateLastNight, thisMorning), 1);
is("...which ten hours of elapsed time is not",
  Math.floor((Date.parse(thisMorning) - Date.parse(lateLastNight)) / 864e5), 0);
is("the same day is 0", daysBetween("2026-09-29T04:00:00Z", "2026-09-29T14:00:00Z"), 0);
is("backwards is negative", daysBetween(thisMorning, lateLastNight), -1);
is("a week", daysBetween("2026-09-01", "2026-09-08"), 7);
is("across a month end", daysBetween("2026-09-30", "2026-10-01"), 1);
is("across a year end", daysBetween("2026-12-31", "2027-01-01"), 1);
is("an unknown side is null, not 0", daysBetween("", "2026-09-29"), null);

/* ── today, and counting from it ────────────────────────────────────── */
console.log("\n4. today, and how long ago");
const NOW = Date.parse("2026-09-29T20:30:00.000Z");   /* 02:00 IST on the 30th */
is("today at 02:00 IST is the 30th", today(IST_MIN, NOW), "2026-09-30");
is("...and in UTC it would have been the 29th", today(0, NOW), "2026-09-29");
is("a call an hour ago is today", daysAgo("2026-09-29T19:30:00Z", IST_MIN, NOW), 0);
/* 23:00 IST on the 29th — three hours earlier, and a different day. */
is("a call three hours ago is yesterday", daysAgo("2026-09-29T17:30:00Z", IST_MIN, NOW), 1);
is("a date a week back", daysAgo("2026-09-23", IST_MIN, NOW), 7);
is("tomorrow is -1 days ago", daysAgo("2026-10-01", IST_MIN, NOW), -1);

console.log("\n5. shifting days");
is("forward", shiftDay("2026-09-29", 3), "2026-10-02");
is("back", shiftDay("2026-09-29", -3), "2026-09-26");
is("nowhere", shiftDay("2026-09-29", 0), "2026-09-29");
is("over a leap day", shiftDay("2028-02-28", 1), "2028-02-29");
is("...and off it", shiftDay("2028-02-29", 1), "2028-03-01");
/* A month of steps, each one landing where the one before it left off. */
let walk = "2026-01-30", steps = 0;
for (let i = 0; i < 400; i++) { const next = shiftDay(walk, 1); if (daysBetween(walk, next) !== 1) break; walk = next; steps++; }
is("400 single steps each move exactly one day", steps, 400);

console.log("\n6. on a given day");
ok("02:00 IST is on the 30th", isOnDay("2026-09-29T20:30:00Z", "2026-09-30"));
ok("...and not on the 29th", !isOnDay("2026-09-29T20:30:00Z", "2026-09-29"));
ok("no day means no", !isOnDay("2026-09-29T20:30:00Z", ""));

console.log("\n7. the offset is configurable and defaults to IST");
is("the default is IST", IST_MIN, 330);
is("an empty env gives IST", tzMinOf({}), 330);
is("TZ_OFFSET_MIN wins", tzMinOf({ TZ_OFFSET_MIN: "0" }), 0);
is("...including a negative one", tzMinOf({ TZ_OFFSET_MIN: -480 }), -480);
/* Somebody in California, where the same instant is a different date in the
   other direction: 17:00 UTC is 09:00 on the 29th there and 22:30 IST on the
   29th here — the two agree. 07:30 UTC is 23:30 on the 28th there and 13:00
   IST on the 29th here, and they do not. Which is the point: the day an
   instant fell on is a question about a place. */
is("UTC-8, late morning there", dayOf("2026-09-29T17:00:00Z", -480), "2026-09-29");
is("...the same instant in IST", dayOf("2026-09-29T17:00:00Z", IST_MIN), "2026-09-29");
is("UTC-8, before their midnight", dayOf("2026-09-29T07:30:00Z", -480), "2026-09-28");
is("...while in IST it is already the 29th", dayOf("2026-09-29T07:30:00Z", IST_MIN), "2026-09-29");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
