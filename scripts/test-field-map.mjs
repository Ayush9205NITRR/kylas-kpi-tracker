#!/usr/bin/env node
/* THE FIELD MAP: THE REGISTRY, THE TYPE RULES, AND THE END-STATE VERDICT.
 *
 *   node scripts/test-field-map.mjs
 *
 * The registry is only worth having if it cannot drift from the two things it
 * describes, so the first two sections pin it in both directions:
 *   - every Airtable field it names exists in schema.mjs, with that type;
 *   - every Kylas field toKylasContact / toKylasCallLog ACTUALLY writes is on
 *     the map. A field added to the save and not to the map is invisible to
 *     every check this file exists for.
 * Then the rules themselves, with the shapes Kylas really returns.
 */
import { FIELD_MAP, lackingOnSave, kindOfKylas, kindOfAirtable, kindOfValue, checkValue, resolveFieldMap, problemsOf,
         normalise, holds, verdict } from "./field-map.mjs";
import { TABLES } from "./schema.mjs";
import { toKylasContact, toKylasCallLog } from "./kylas.mjs";
import { resolveWriteFields, extraCustomFields } from "./kylas-write-map.mjs";
import { contactRow, runRow, summarisePush } from "./push-log.mjs";
import { summarise, renderText, renderHtml, attention } from "./digest.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${d}` : ""}`); };
const is = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\n1 · the registry matches the base");
{
  const keys = FIELD_MAP.map((e) => e.key);
  ok("keys are unique", new Set(keys).size === keys.length);
  ok("every entry says which flow carries it", FIELD_MAP.every((e) => e.via?.length && e.via.every((v) => v === "save" || v === "push")));
  const byTable = Object.fromEntries(TABLES.map((t) => [t.name, Object.fromEntries(t.fields.map((f) => [f.name, f.type]))]));
  for (const e of FIELD_MAP.filter((x) => x.airtable)) {
    const { table, field, type } = e.airtable;
    if (type === "multipleRecordLinks") { ok(`${e.key}: ${table}.${field} is a link, defined by the schema's link list`, !!byTable[table]); continue; }
    ok(`${e.key}: ${table}.${field} exists as ${type}`, byTable[table]?.[field] === type, `schema says ${byTable[table]?.[field]}`);
  }
  ok("every Airtable type it names is one this file reads", FIELD_MAP.filter((e) => e.airtable).every((e) => kindOfAirtable(e.airtable.type)));
}

console.log("\n2 · everything the save writes is on the map");
{
  const FIELDS = [
    { name: "cfNextCallDate", label: "Next Call Date", type: "DATE_PICKER" },
    { name: "cfOffsiteTimelineBdNew", label: "Offsite Timeline", type: "MULTI_PICKLIST" },
  ];
  const wm = resolveWriteFields(FIELDS, { cfOffsiteTimelineBdNew: [{ id: 9103, code: "JUL_SEP", label: "Jul - Sep" }] });
  const card = { pocName: "Asha Rao", designation: "Head", linkedin: "https://linkedin.com/in/a",
                 emails: [{ type: "OFFICE", value: "a@x.com", primary: true }],
                 phones: [{ type: "MOBILE", value: "9876543210", cc: "+91", primary: true }],
                 companyId: "1776620", ownerId: "74725", stage: "SQL - Sales Qualified Lead", source: "Round-Robin",
                 nextCallDate: "2026-10-20", nextCallTime: "10:00" };
  const extra = extraCustomFields(wm, card, { tzMin: 330, quarters: ["JUL_SEP"] });
  const body = toKylasContact(card, { remarks: "r", extra });
  const named = new Set(FIELD_MAP.filter((e) => e.kylas.entity === "contact").map((e) => e.kylas.name || wm[e.kylas.resolve]?.name));
  const written = [...Object.keys(body).filter((k) => k !== "customFieldValues"), ...Object.keys(body.customFieldValues || {})];
  const stray = written.filter((k) => !named.has(k));
  ok("every contact field a save writes is on the map", !stray.length, `missing from FIELD_MAP: ${stray.join(", ")}`);
  ok("...including both resolved custom fields", named.has("cfNextCallDate") && named.has("cfOffsiteTimelineBdNew"));

  const log = toKylasCallLog({ kid: "1", phones: [{ value: "9876543210", cc: "+91", primary: true }] },
                             { outcome: "Right POC", at: "2026-10-16T10:00:00Z", duration: 61, note: "n" });
  const calls = new Set(FIELD_MAP.filter((e) => e.kylas.entity === "call-log").map((e) => e.kylas.name));
  const strayCall = Object.keys(log).filter((k) => !calls.has(k));
  ok("every call-log field a save writes is on the map", !strayCall.length, `missing: ${strayCall.join(", ")}`);
}

console.log("\n3 · Kylas types, read into kinds");
{
  const t = (x) => kindOfKylas(x);
  is("TEXT_FIELD", t("TEXT_FIELD"), "text");
  is("PARAGRAPH_TEXT", t("PARAGRAPH_TEXT"), "text");
  is("PICK_LIST", t("PICK_LIST"), "option");
  is("MULTI_PICKLIST", t("MULTI_PICKLIST"), "options");
  is("DATE_PICKER", t("DATE_PICKER"), "date");
  is("DATETIME_PICKER", t("DATETIME_PICKER"), "datetime");
  is("NUMBER", t("NUMBER"), "number");
  is("LOOK_UP", t("LOOK_UP"), "lookup");
  is("PHONE", t("PHONE"), "list");
  is("a type nobody has heard of is null, not a guess", t("HOLOGRAM"), null);
  is("a missing type is null", t(""), null);
}

console.log("\n4 · is this VALUE the kind the field takes");
{
  ok("a day into a date field", checkValue("date", "2026-10-20").ok);
  ok("an instant into a date field is refused", !checkValue("date", "2026-10-20T04:30:00.000Z").ok);
  ok("a bare day into a date-TIME field is refused", !checkValue("datetime", "2026-10-20").ok);
  ok("an instant into a date-time field", checkValue("datetime", "2026-10-20T04:30:00.000Z").ok);
  ok("an option id into a picklist", checkValue("option", 9103).ok);
  ok("a list of option ids into a multi-picklist", checkValue("options", [9103, 9104]).ok);
  ok("a LIST into a single picklist is refused", !checkValue("option", [9103]).ok);
  const named = checkValue("option", "Round-Robin", { options: [{ id: 9001, code: "Round-Robin", label: "Round-Robin" }] });
  ok("a NAME into a picklist is refused, and says it was a name", !named.ok && /name/.test(named.why), named.why);
  ok("...but a name the picklist knows is `soft`, so the existing save behaviour is not broken by it", named.soft === true);
  ok("a name the picklist does not know is not soft", checkValue("option", "Nope", { options: [{ id: 1, code: "A", label: "A" }] }).soft === false);
  ok("an id that is not one of the options is refused", !checkValue("options", [9999], { options: [{ id: 9103 }] }).ok);
  ok("text into a number field is refused", !checkValue("number", "Acme").ok);
  ok("digits as text into a number field are fine", checkValue("number", "74725").ok);
  ok("a number into a text field is refused", !checkValue("text", 5).ok);
  ok("nothing is not a value", !checkValue("text", undefined).ok);
  const why = checkValue("number", "Acme").why;
  ok("the reason names what was sent AND what Kylas takes", /Acme/.test(why) && /number/.test(why), why);
}

console.log("\n5 · the registry resolved against an account");
{
  const base = [
    { name: "firstName", label: "First Name", type: "TEXT_FIELD" },
    { name: "cfPipelineStageBd", label: "Pipeline Stage - BD", type: "PICK_LIST" },
    { name: "cfSourceOfData", label: "Source of Data", type: "TEXT_FIELD" },
    { name: "cfNextCallDate", label: "Next Call Date", type: "DATE_PICKER" },
    { name: "cfOffsiteTimelineBdNew", label: "Offsite Timeline", type: "MULTI_PICKLIST" },
  ];
  const picks = { cfOffsiteTimelineBdNew: [{ id: 9103, code: "JUL_SEP", label: "Jul - Sep" }] };
  const go = (fields) => resolveFieldMap({ kylasFields: fields, writeMap: resolveWriteFields(fields, picks), picklists: picks });
  const st = (rows, k) => rows.find((r) => r.key === k)?.status;

  const whole = go(base);
  is("a whole account: next call is mapped", st(whole, "nextCall"), "mapped");
  is("...offsite is mapped", st(whole, "offsite"), "mapped");
  is("...stage is mapped", st(whole, "stage"), "mapped");
  is("...a core field the list describes is mapped", st(whole, "firstName"), "mapped");
  is("...a core field it does not describe is assumed, not claimed", st(whole, "lastName"), "assumed");
  is("...and nothing is flagged", problemsOf(whole), []);
  ok("the call-back field resolved to the right name", whole.find((r) => r.key === "nextCall").kylasField === "cfNextCallDate");

  const noOffsite = go(base.filter((f) => f.name !== "cfOffsiteTimelineBdNew"));
  is("no offsite field: UNMAPPED", st(noOffsite, "offsite"), "unmapped");
  ok("...and it is the only problem", problemsOf(noOffsite).length === 1 && problemsOf(noOffsite)[0].key === "offsite", JSON.stringify(problemsOf(noOffsite)));
  ok("...with a note that says the value is left off every write", /left off/.test(problemsOf(noOffsite)[0].note));

  const noSource = go(base.filter((f) => f.name !== "cfSourceOfData"));
  is("a fixed custom field that is missing is UNMAPPED too", st(noSource, "source"), "unmapped");

  const retyped = go(base.map((f) => (f.name === "cfPipelineStageBd" ? { ...f, type: "NUMBER" } : f)));
  is("a field an admin retyped is TYPE", st(retyped, "stage"), "type");
  ok("...and the note names both sides", /option/.test(problemsOf(retyped)[0].note) && /number/.test(problemsOf(retyped)[0].note), problemsOf(retyped)[0].note);

  const dateTime = go(base.map((f) => (f.name === "cfNextCallDate" ? { ...f, type: "DATETIME_PICKER" } : f)));
  is("next call is mapped whether the field is a date or a date-time", st(dateTime, "nextCall"), "mapped");
  const asText = go(base.map((f) => (f.name === "cfNextCallDate" ? { ...f, type: "TEXT_FIELD" } : f)));
  is("...but a text field is not picked at all, so it is UNMAPPED rather than mistyped", st(asText, "nextCall"), "unmapped");
  const single = go(base.map((f) => (f.name === "cfOffsiteTimelineBdNew" ? { ...f, type: "PICK_LIST" } : f)));
  is("offsite is mapped whether the picklist is single or multi", st(single, "offsite"), "mapped");

  const odd = go(base.map((f) => (f.name === "cfSourceOfData" ? { ...f, type: "HOLOGRAM" } : f)));
  is("a type this file does not read is UNKNOWN, not guessed", st(odd, "source"), "unknown");
}

console.log("\n6 · the end state: did Kylas keep it");
{
  ok("a picklist id comes back as {id, name}", holds(9103, { id: 9103, name: "Jul - Sep" }));
  ok("a multi-picklist is order-independent", holds([9104, 9103], [{ id: 9103 }, { id: 9104 }]));
  ok("a number that comes back as a string still matches", holds(74725, "74725"));
  ok("the same instant spelled two ways matches", holds("2026-10-20T04:30:00.000Z", "2026-10-20T04:30:00Z"));
  ok("a different instant does not", !holds("2026-10-20T04:30:00.000Z", "2026-10-20T05:30:00.000Z"));
  ok("a different option does not", !holds([9103], [9104]));
  is("kept: pushed and verified", verdict({ sent: [9103], got: [{ id: 9103 }] }), { status: "pushed", verified: true });
  is("answered OK but holds nothing: DROPPED", verdict({ sent: [9103], got: undefined }).status, "dropped");
  is("...an empty list is nothing too", verdict({ sent: [9103], got: [] }).status, "dropped");
  is("holds something else: MISMATCH", verdict({ sent: [9103], got: [9104] }).status, "mismatch");
  is("normalise sorts a list and stringifies it", normalise([{ id: 2 }, { id: 1 }]), ["1", "2"]);
  is("kindOfValue tells an array from an object", [kindOfValue([1]), kindOfValue({}), kindOfValue(null)], ["array", "object", null]);
}

console.log("\n7 · the log rows");
{
  const pushedOk = { key: "nextCall", label: "Next call (call-back)", kylasField: "cfNextCallDate", sent: "2026-10-20", got: "2026-10-20", status: "pushed" };
  const dropped = { key: "offsite", label: "Offsite quarter", kylasField: "cfOffsiteTimelineBdNew", sent: [9103], got: null, status: "dropped", why: "Kylas answered OK but the record holds nothing there" };
  const all = contactRow({ run: "push-1", at: "2026-10-17T21:15:00Z", kid: 1, name: "A", outcomes: [pushedOk] });
  is("every field read back: Pushed", all.Status, "Pushed");
  ok("...and Verified", all.Verified === true);
  const part = contactRow({ run: "push-1", at: "x", kid: 2, name: "B", outcomes: [pushedOk, dropped] });
  is("one landed, one did not: Partly pushed", part.Status, "Partly pushed");
  ok("...it names both sides", part.Pushed === "Next call (call-back)" && part["Not Pushed"] === "Offsite quarter", JSON.stringify([part.Pushed, part["Not Pushed"]]));
  ok("...with the reason", /holds nothing/.test(part.Reason), part.Reason);
  ok("...and is NOT verified", part.Verified === false);
  is("nothing landed: Not pushed", contactRow({ run: "p", at: "x", kid: 3, name: "C", outcomes: [dropped] }).Status, "Not pushed");
  is("nothing was even tried: Not pushed", contactRow({ run: "p", at: "x", kid: 4, name: "D", outcomes: [] }).Status, "Not pushed");
  is("the key is run + contact, so recording twice overwrites", all.Key, "push-1|1");
  ok("the detail is JSON a person can read back", JSON.parse(part.Detail)[1].s === "dropped");

  const run = runRow({ run: "push-1", at: "x", totals: { pushed: 1, notPushed: 1 },
                       mapProblems: [{ key: "source", label: "Source of Data", status: "unmapped", note: "cfSourceOfData is not in this account's field list" }] });
  is("the run row is marked (run)", run.Contact, "(run)");
  const partlyRun = runRow({ run: "p", at: "x", totals: { pushed: 1, partly: 1, notPushed: 0 }, mapProblems: [] });
  is("a night with a partly pushed contact is Partly pushed, not Pushed", [partlyRun.Status, partlyRun.Verified], ["Partly pushed", false]);
  is("a clean night is Pushed and Verified", [runRow({ run: "p", at: "x", totals: { pushed: 2 } }).Status, runRow({ run: "p", at: "x", totals: { pushed: 2 } }).Verified], ["Pushed", true]);
  const sum = summarisePush([all, part, run].map((r) => r));
  is("the summary counts contacts, not the run row", [sum.contacts, sum.pushed, sum.partly, sum.notPushed], [2, 1, 1, 0]);
  ok("...carries the map problem from the run row", sum.mapProblems.length === 1 && sum.mapProblems[0].key === "source");
  ok("...and lists what did not fully push, by name", sum.problems.length === 1 && /B/.test(sum.problems[0].what), JSON.stringify(sum.problems));
  is("no Push Log table is null, never zero", summarisePush(null), null);
}

console.log("\n8 · the morning mail says it");
{
  const push = summarisePush([
    contactRow({ run: "p", at: "x", kid: 2, name: "Bhavna", outcomes: [
      { key: "offsite", label: "Offsite quarter", status: "dropped", why: "Kylas answered OK but the record holds nothing there" }] }),
    runRow({ run: "p", at: "x", totals: {}, mapProblems: [{ key: "source", label: "Source of Data", status: "unmapped", note: "no such field" }] }),
  ]);
  const s = summarise([], { day: "2026-10-16", push });
  const text = renderText(s);
  ok("the mail has a push section", /Airtable → Kylas push/.test(text));
  ok("...it says NOT pushed, with a count", /1\s+NOT pushed/.test(text), text);
  ok("...it names the contact and the reason", /Bhavna/.test(text) && /holds nothing/.test(text));
  ok("...it names the unmapped field", /Source of Data: no such field/.test(text));
  ok("...the subject line is flagged", attention(s) === 2, String(attention(s)));
  ok("the HTML carries it too", /NOT pushed/.test(renderHtml(s)) || /Bhavna/.test(renderHtml(s)));

  const none = renderText(summarise([], { day: "d", push: null }));
  ok("no Push Log table is said, not shown as zero", /Not tracked yet/.test(none) && /repair-base/.test(none), none);
  ok("an older caller that did not look gets no push section", !/Airtable → Kylas push/.test(renderText(summarise([], { day: "d" }))));

  const saved = summarise([{ state: "done", result: { wrote: ["updated contact"], unmapped: ["next call"] } }], { day: "d" });
  ok("a save that left a value off is counted", saved.unmappedSaves === 1 && saved.unmappedWhat[0] === "next call");
  ok("...and the mail says so", /1 save\(s\) left a value off/.test(renderText(saved)));
}

console.log("\n9 · what a save will leave off");
{
  const whole = { nextCall: { name: "a" }, offsite: { name: "b" } };
  is("a whole account leaves nothing off", lackingOnSave(whole, { nextCallDate: "2026-10-20" }, ["JUL_SEP"]), []);
  is("no next-call field, and the card has a call-back", lackingOnSave({ ...whole, nextCall: null }, { nextCallDate: "2026-10-20" }, []), ["next call"]);
  is("...no call-back on the card means nothing was lost", lackingOnSave({ ...whole, nextCall: null }, { nextCallDate: "" }, []), []);
  is("no offsite field, and a quarter was derived", lackingOnSave({ ...whole, offsite: null }, {}, ["JUL_SEP"]), ["offsite quarter"]);
  is("...no quarter derived means nothing was lost", lackingOnSave({ ...whole, offsite: null }, {}, []), []);
  is("both missing, both named", lackingOnSave({ nextCall: null, offsite: null }, { nextCallDate: "2026-10-20" }, ["JUL_SEP"]), ["next call", "offsite quarter"]);
  is("a map that could not be read leaves them off too", lackingOnSave(null, { nextCallDate: "2026-10-20" }, ["JUL_SEP"]), ["next call", "offsite quarter"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
