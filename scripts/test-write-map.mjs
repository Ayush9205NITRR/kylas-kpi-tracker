/* THE TWO FIELDS THE CONSOLE NEVER WROTE BACK.
 *
 * Every case here is a way the write could go wrong silently: the right field
 * name on the wrong account, the opposite field picked because its label also
 * says "call", a quarter sent as text to a picklist that takes ids, and a
 * call-back at 10:00 landing at 15:30 because nobody applied the timezone.
 *
 * Field lists are the shapes Kylas actually returns, taken from
 * docs/kylas-api-notes.md and the probe output.
 *
 * Run: node scripts/test-write-map.mjs
 */
import { resolveWriteFields, nextCallValue, offsiteValue, optionForQuarter,
         extraCustomFields, describeWriteMap } from "./kylas-write-map.mjs";

let pass = 0, fail = 0;
const is = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${what}`); return; }
  fail++; console.log(`  FAIL  ${what} — got ${g}, want ${w}`);
};
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

const FIELDS = [
  { name: "firstName", label: "First Name", type: "TEXT_FIELD" },
  { name: "cfPipelineStageBd", label: "Pipeline Stage - BD", type: "PICK_LIST" },
  { name: "cfLastCalledAtDate", label: "Last Called At", type: "DATE_PICKER" },
  { name: "cfNextCallDate", label: "Next Call Date", type: "DATE_PICKER" },
  { name: "cfOffsiteTimelineBdNew", label: "Offsite Timeline (BD - New)", type: "MULTI_PICKLIST" },
  { name: "cfSourceOfData", label: "Source of Data", type: "PICK_LIST" },
];
const PICKS = {
  cfOffsiteTimelineBdNew: [
    { id: 9001, code: "JAN_MAR", label: "Jan - Mar" },
    { id: 9002, code: "APR_JUN", label: "Apr - Jun" },
    { id: 9003, code: "JUL_SEP", label: "Jul - Sep" },
    { id: 9004, code: "OCT_DEC", label: "Oct - Dec" },
  ],
};

console.log("1. finding the fields");
const map = resolveWriteFields(FIELDS, PICKS);
is("next call", map.nextCall?.name, "cfNextCallDate");
is("offsite timeline", map.offsite?.name, "cfOffsiteTimelineBdNew");
ok("...and it knows the offsite field takes more than one", map.offsite?.multi === true);
is("...with its options", map.offsite?.options.length, 4);
/* THE ONE THAT WOULD HAVE BEEN WRITTEN BY A LOOSER MATCH. Last Called At is a
   date field whose label contains "call", and overwriting it would rewrite the
   account's own call history with a future date. */
ok("Last Called At is never the next-call field", map.nextCall?.name !== "cfLastCalledAtDate");

console.log("\n2. an account whose admin named them differently");
const other = resolveWriteFields([
  { name: "cfCallBackOn", label: "Call back on", type: "DATE_TIME_PICKER" },
  { name: "cfOffsite", label: "Offsite quarter", type: "PICK_LIST" },
], { cfOffsite: [{ id: 1, label: "Q3 (Jul-Sep)" }] });
is("a differently named call-back", other.nextCall?.name, "cfCallBackOn");
is("...and a single-value offsite", other.offsite?.name, "cfOffsite");
ok("...which is not multi", other.offsite?.multi === false);

console.log("\n3. an account that has neither");
const none = resolveWriteFields(FIELDS.slice(0, 3), {});
is("no next-call field", none.nextCall, null);
is("no offsite field", none.offsite, null);
/* The write must go out WITHOUT them rather than not go out. */
is("so nothing is added to the payload",
  extraCustomFields(none, { nextCallDate: "2026-10-02" }, { quarters: ["JUL_SEP"] }), {});

console.log("\n4. the call-back, as the field can hold it");
is("a date field takes the day",
  nextCallValue(map.nextCall, "2026-10-02", "15:30"), "2026-10-02");
/* 10:00 promised in Delhi is 04:30Z. Sending "10:00Z" would move every
   call-back five and a half hours later, which is the next working day's
   morning for anything after 18:30. */
is("a date-time field takes the instant, in IST",
  nextCallValue(other.nextCall, "2026-10-02", "10:00"), "2026-10-02T04:30:00.000Z");
is("...defaulting to 09:00 when no time was promised",
  nextCallValue(other.nextCall, "2026-10-02", ""), "2026-10-02T03:30:00.000Z");
is("no date, nothing to write", nextCallValue(other.nextCall, "", "10:00"), undefined);
is("nonsense is not a date", nextCallValue(other.nextCall, "next tuesday", ""), undefined);

console.log("\n5. the quarter, matched by what the option MEANS");
/* The spelling is the admin's: "Jul - Sep", "Q3 (Jul-Sep)", "JUL_SEP". All
   three name the same three months, and offsite.js already reads any of them. */
is("Jul - Sep", optionForQuarter(PICKS.cfOffsiteTimelineBdNew, "JUL_SEP")?.id, 9003);
is("as does a Q-form on another account",
  optionForQuarter([{ id: 5, label: "Q3 (Jul-Sep)" }], "JUL_SEP")?.id, 5);
is("and a code with no label at all",
  optionForQuarter([{ id: 6, code: "OCT_DEC" }], "OCT_DEC")?.id, 6);
is("a quarter the picklist does not offer", optionForQuarter(PICKS.cfOffsiteTimelineBdNew, "NOPE"), null);

console.log("\n6. what is sent");
is("two quarters to a multi field", offsiteValue(map.offsite, ["JUL_SEP", "JAN_MAR"]), [9001, 9003]);
is("...always in calendar order", offsiteValue(map.offsite, ["OCT_DEC", "APR_JUN"]), [9002, 9004]);
is("one quarter to a single field", offsiteValue(other.offsite, ["JUL_SEP"]), 1);
is("nothing derived, nothing sent", offsiteValue(map.offsite, []), undefined);
/* A value the picklist does not know fails the WHOLE contact write, not just
   this field, so an unmatched quarter is dropped rather than sent as text. */
is("a quarter with no option is dropped, not sent as text",
  offsiteValue({ ...other.offsite, options: [{ id: 1, label: "Jan - Mar" }] }, ["JUL_SEP"]), undefined);

console.log("\n7. both together, on the payload");
is("the two fields, under their own names",
  extraCustomFields(map, { nextCallDate: "2026-10-02", nextCallTime: "16:00" },
                    { quarters: ["OCT_DEC"] }),
  { cfNextCallDate: "2026-10-02", cfOffsiteTimelineBdNew: [9004] });
is("a call-back with no offsite",
  extraCustomFields(map, { nextCallDate: "2026-10-02" }, { quarters: [] }),
  { cfNextCallDate: "2026-10-02" });

console.log("\n8. it says what it found");
ok("both named", describeWriteMap(map).every((l) => /cf/.test(l)), describeWriteMap(map).join(" · "));
ok("and says so when there is nothing",
  describeWriteMap(none).every((l) => /no field on this account/.test(l)));

/* ── READING IT BACK ───────────────────────────────────────────────────
   Ayush, 2026-10-04: "next call date is getting wiped — if I set it, the next
   time it does not pull up, rather asks me to assign it again."

   It was never wiped. The save wrote it to Kylas on every save, and the
   Kylas -> console mapper hardcoded `nextCallDate: ""`, so a contact served
   from Kylas instead of the Airtable copy came back with no promise on it.
   The data was there the whole time; nothing read it. */
console.log("\n9. the call-back, read back out of Kylas");
const { nextCallFrom } = await import("./kylas-write-map.mjs");
const DT = { name: "cfNextCall", type: "DATETIME_PICKER" };
const D = { name: "cfNextCall", type: "DATE_PICKER" };

/* THE ROUND TRIP IS THE REAL TEST. 10:00 promised in Delhi is stored 04:30Z;
   reading the UTC clock straight off would show 04:30 and move every call-back
   five and a half hours earlier. */
for (const [date, time] of [["2026-10-02", "16:00"], ["2026-10-02", "09:00"],
                            ["2026-01-01", "00:30"], ["2026-12-31", "23:45"]]) {
  const stored = nextCallValue(DT, date, time, 330);
  is(`${date} ${time} survives the round trip`, nextCallFrom(DT, stored, 330), { date, time });
}
/* The midnight-crossing pair, which is where a wrong sign shows up. */
is("00:30 IST is stored the previous day in UTC",
  nextCallValue(DT, "2026-01-01", "00:30", 330), "2025-12-31T19:00:00.000Z");
is("...and still reads back as 1 Jan",
  nextCallFrom(DT, "2025-12-31T19:00:00.000Z", 330), { date: "2026-01-01", time: "00:30" });

console.log("\n9b. a date-only field keeps the day it was given");
is("the day round-trips", nextCallFrom(D, nextCallValue(D, "2026-10-02", "16:00", 330), 330),
  { date: "2026-10-02", time: "" });
/* Kylas can hand midnight UTC back for a day. Shifting THAT into IST would
   move it to the next day, so a date-only field never gets the shift. */
is("midnight UTC on a date-only field is not nudged into the next day",
  nextCallFrom(D, "2026-10-02T00:00:00.000Z", 330), { date: "2026-10-02", time: "" });

console.log("\n9c. nothing to read is not a crash");
for (const [what, v] of [["empty", ""], ["null", null], ["undefined", undefined],
                         ["nonsense", "not a date"], ["an object with no value", {}]])
  is(`${what} reads as no call-back`, nextCallFrom(DT, v, 330), { date: "", time: "" });
is("no field at all reads as no call-back", nextCallFrom(null, "2026-10-02", 330), { date: "2026-10-02", time: "" });
/* Kylas wraps some values as {value} or {id}. */
is("a wrapped value is unwrapped", nextCallFrom(D, { value: "2026-10-02" }, 330),
  { date: "2026-10-02", time: "" });

/* ── REQ-04 · THE OFFSITE QUARTER, READ BACK ───────────────────────────
   The console SET this on Kylas from the first release and never read it, so
   `offsiteTimeline` arrived hardcoded "". Less costly than the call-back was,
   because the quarter is DERIVED — recomputed from the timeline text, which
   round-trips through Airtable — so no associate lost work. What had no way
   in was a quarter set in KYLAS directly. */
console.log("\n10. the offsite quarter, read back out of Kylas");
const { offsiteFrom } = await import("./kylas-write-map.mjs");
/* The live account's field, as resolved on 2026-09-29. */
const OFF = { name: "cfOffsiteTimelineBdNew", type: "MULTI_PICKLIST", multi: true, options: [
  { id: 2880424, label: "Jan - Mar" }, { id: 2880425, label: "Apr - Jun" },
  { id: 2880426, label: "Jul - Sep" }, { id: 2880427, label: "Oct - Dec" }] };
for (const q of ["JAN_MAR", "APR_JUN", "JUL_SEP", "OCT_DEC"])
  is(`${q} survives the round trip`, offsiteFrom(OFF, offsiteValue(OFF, [q])), [q]);
is("two quarters come back as both",
  offsiteFrom(OFF, offsiteValue(OFF, ["JAN_MAR", "JUL_SEP"])), ["JAN_MAR", "JUL_SEP"]);
/* Order is the console's, never the order Kylas happened to store them in, so
   two contacts holding the same pair read identically. */
is("...in the console's order, not Kylas' storage order",
  offsiteFrom(OFF, [2880427, 2880424]), ["JAN_MAR", "OCT_DEC"]);
is("a value Kylas wrapped as {id} is unwrapped", offsiteFrom(OFF, [{ id: 2880426 }]), ["JUL_SEP"]);
/* An account whose field holds one option at a time stores a bare id. */
is("a single-select account round-trips too",
  offsiteFrom({ ...OFF, multi: false }, offsiteValue({ ...OFF, multi: false }, ["OCT_DEC"])), ["OCT_DEC"]);
for (const [what, v] of [["empty", ""], ["null", null], ["undefined", undefined],
                         ["an empty array", []], ["an id nothing matches", [99999]]])
  is(`${what} reads as no quarter`, offsiteFrom(OFF, v), []);
is("no field on the account reads as no quarter", offsiteFrom(null, [2880424]), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
