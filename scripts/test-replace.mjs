/* PUT /v1/contacts/{id} REPLACES THE RECORD. IT DOES NOT MERGE.
 *
 * Learned on the live account on 2026-09-29, at the cost of one contact's
 * name, phone and email. A PUT carrying only {remarks, customFieldValues}
 * returned 200 and left a record with no firstName, no lastName, no
 * phoneNumbers and no emails. Kylas had stored exactly what it was sent.
 *
 * Every case here is something that would therefore have been DELETED by a
 * save, silently, with a 200 in the log and the associate told it worked:
 *
 *   an existing contact saved from a card with no phone   → its phone
 *   a contact whose designation was filled in the CRM      → the designation
 *   cfBatch, cfAccountHealthBd, anything the CRM owns      → all of it
 *
 * The rule this file enforces is one sentence: a field the card has no
 * opinion about is carried over from the record, never left out.
 *
 * Run: node scripts/test-replace.mjs
 */
import { toKylasContact } from "./kylas.mjs";
import { bodyFor } from "./push-kylas.mjs";
import { STAGE_ID } from "./stages.mjs";

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

/* A contact as Kylas hands it over: more on it than the console ever shows. */
const BASE = {
  id: 6258147, firstName: "Preeti", lastName: "Pagote",
  designation: "Employee Experience Manager", linkedin: "https://linkedin.com/in/preeti",
  emails: [{ type: "OFFICE", value: "preeti@draup.com", primary: true }],
  phoneNumbers: [{ type: "MOBILE", dialCode: "+91", value: "8722508204", primary: true }],
  company: { id: 1777335, name: "draup" }, ownerId: 74725,
  remarks: "spoke at the GPTW event",
  customFieldValues: {
    cfPipelineStageBd: 2862827, cfBatch: "B-11", cfAccountHealthBd: 3,
    cfSourceOfData: "Round-Robin", cfPreviousOffsiteLocation: "Goa",
  },
};

/* The card as the console has it mid-call: a stage change and nothing else.
   This is the ordinary case — 85% of calls need near-zero typing. */
const CARD = { kid: "6258147", pocName: "Preeti Pagote", stage: "MQL_MARKETING_QUALIFIED_LEAD",
               phones: [], emails: [], past: [], current: [] };

console.log("1. what a save of a barely-touched card must NOT delete");
const body = toKylasContact(CARD, { remarks: "new block", base: BASE });
is("the phone survives", body.phoneNumbers, BASE.phoneNumbers);
is("the email survives", body.emails, BASE.emails);
is("the designation survives", body.designation, BASE.designation);
is("the linkedin survives", body.linkedin, BASE.linkedin);
is("the company survives", body.company, 1777335);
is("the owner survives", body.ownerId, 74725);

console.log("\n2. ...and the custom fields the CRM owns, which this console does not");
is("cfBatch", body.customFieldValues.cfBatch, "B-11");
is("cfAccountHealthBd", body.customFieldValues.cfAccountHealthBd, 3);
is("cfPreviousOffsiteLocation", body.customFieldValues.cfPreviousOffsiteLocation, "Goa");
/* The one field the save is actually for still wins. */
is("while the stage is the new one",
  body.customFieldValues.cfPipelineStageBd, STAGE_ID.MQL_MARKETING_QUALIFIED_LEAD);
ok("...which is not the old one", body.customFieldValues.cfPipelineStageBd !== 2862827);

console.log("\n3. the card still wins wherever it has something to say");
const typed = toKylasContact({ ...CARD, designation: "Head of HR",
    phones: [{ type: "MOBILE", cc: "+91", value: "9800004321", primary: true }],
    emails: [{ type: "OFFICE", value: "NEW@draup.com", primary: true }] },
  { remarks: "x", base: BASE });
is("a new designation replaces the old", typed.designation, "Head of HR");
is("a new phone replaces the old", typed.phoneNumbers[0].value, "9800004321");
is("...and there is only one", typed.phoneNumbers.length, 1);
is("a new email replaces the old, lowercased", typed.emails[0].value, "new@draup.com");

console.log("\n4. a value that arrives as an object is written back as its id");
/* Kylas hands a picklist back as { id, name } on some endpoints and as a bare
   id on others. Writing { id, name } into a picklist is a 400. */
const objy = toKylasContact(CARD, { remarks: "x", base: { ...BASE,
  customFieldValues: { cfBatch: { id: 77, name: "B-11" }, cfAccountHealthBd: 3 } } });
is("the id, not the object", objy.customFieldValues.cfBatch, 77);
/* And a blank one is not carried: sending "" to a picklist is also a 400. */
const blanks = toKylasContact(CARD, { remarks: "x", base: { ...BASE,
  customFieldValues: { cfBatch: "", cfWebsite: null, cfAccountHealthBd: 3 } } });
ok("an empty value is left out entirely", !("cfBatch" in blanks.customFieldValues));
ok("...as is a null one", !("cfWebsite" in blanks.customFieldValues));
is("...while the real one stays", blanks.customFieldValues.cfAccountHealthBd, 3);

console.log("\n5. a new contact has no record to carry anything over from");
const made = toKylasContact({ ...CARD, kid: "",
  phones: [{ type: "MOBILE", cc: "+91", value: "9800004321", primary: true }] }, { remarks: "x" });
is("it is built from the card alone", made.phoneNumbers.length, 1);
ok("and nothing invents an email", Array.isArray(made.emails) && made.emails.length === 0);
is("the name is the card's", `${made.firstName} ${made.lastName}`, "Preeti Pagote");

console.log("\n6. the remarks block still merges rather than replaces");
/* Carried over only when the save has nothing to say about it. When it does,
   mergeRemarks has already kept the human's half — that is its own test. */
const noRemarks = toKylasContact(CARD, { base: BASE });
is("no new block, the old text stays", noRemarks.remarks, BASE.remarks);
is("a new block wins", toKylasContact(CARD, { remarks: "fresh", base: BASE }).remarks, "fresh");

console.log("\n7. the write-back fields still go out");
const withExtra = toKylasContact(CARD, { remarks: "x", base: BASE,
  extra: { cfNextCallDateCallLater: "2026-10-01T10:30:00.000Z", cfOffsiteTimeline: [2880426] } });
is("next call", withExtra.customFieldValues.cfNextCallDateCallLater, "2026-10-01T10:30:00.000Z");
is("offsite", withExtra.customFieldValues.cfOffsiteTimeline, [2880426]);
is("...beside everything carried over", withExtra.customFieldValues.cfBatch, "B-11");

/* ── the nightly push builds its own payload, and must not be the exception ──
   push-kylas.mjs does not go through toKylasContact: it is not saving a card,
   it is changing two fields on a record it just read. Same hazard, so the same
   rules, asserted separately — a fix applied to one and not the other is
   exactly how this comes back. */
console.log("\n8. the nightly push, which writes the record back too");
const pushed = bodyFor(BASE, { cfOffsiteTimeline: [2880426] });
is("the phone survives", pushed.phoneNumbers, BASE.phoneNumbers);
is("the email survives", pushed.emails, BASE.emails);
is("the name survives", `${pushed.firstName} ${pushed.lastName}`, "Preeti Pagote");
is("the remarks survive", pushed.remarks, BASE.remarks);
is("the company is its id", pushed.company, 1777335);
is("cfBatch survives", pushed.customFieldValues.cfBatch, "B-11");
/* THE STAGE IS NOT THE PUSH'S BUSINESS. It writes the two derived fields and
   carries everything else over — including a stage that has since moved in
   Kylas, which it must not roll back to whatever the copy remembers. */
is("...and the stage is whatever Kylas holds, untouched",
  pushed.customFieldValues.cfPipelineStageBd, 2862827);
is("the new value is there", pushed.customFieldValues.cfOffsiteTimeline, [2880426]);
const objPush = bodyFor({ ...BASE, customFieldValues: { cfBatch: { id: 77, name: "B-11" }, cfWebsite: "" } },
                        { cfOffsiteTimeline: [2880426] });
is("an object value goes back as its id", objPush.customFieldValues.cfBatch, 77);
ok("a blank one is left out", !("cfWebsite" in objPush.customFieldValues));
/* A record with nothing on it must not send empty arrays — that is the wipe. */
const bare = bodyFor({ firstName: "A", lastName: "B" }, { cfOffsiteTimeline: [2880426] });
ok("no empty phoneNumbers key", !("phoneNumbers" in bare));
ok("no empty emails key", !("emails" in bare));

/* ── a MULTI-picklist is an array, and an array has no .id ──────────────
   Found by running the push against the mock for the first time. Kylas hands
   a multi-select back as an array of values; the carry-over read it with the
   same helper that reads { id, name }, which returns undefined for an array.
   Undefined meant "no value", the field was left out, and the payload
   REPLACES the record — so a save on a contact whose Offsite Timeline had
   been set silently cleared it. The same shape that cost a phone number, one
   level deeper. It also made the nightly push rewrite the same value every
   night, for ever, because undefined never equals [2880426]. */
console.log("\n9. a multi-picklist survives, and does not look changed every night");
const MULTI = { ...BASE, customFieldValues: {
  cfPipelineStageBd: 2862827, cfOffsiteTimeline: [2880426, 2880427],
  cfBatch: { id: 77, name: "B-11" } } };
const saved = toKylasContact(CARD, { remarks: "x", base: MULTI });
is("the array is carried over whole", saved.customFieldValues.cfOffsiteTimeline, [2880426, 2880427]);
is("...beside the single-value fields", saved.customFieldValues.cfBatch, 77);
const pushedMulti = bodyFor(MULTI, { cfOffsiteTimeline: [2880426] });
is("the push carries it too", pushedMulti.customFieldValues.cfOffsiteTimeline, [2880426]);
/* An array of { id, name }, which is the other shape Kylas uses for these. */
const objArr = bodyFor({ ...BASE, customFieldValues: {
  cfOffsiteTimeline: [{ id: 2880426, name: "Jul - Sep" }, { id: 2880427, name: "Oct - Dec" }] } }, {});
is("...in either spelling", objArr.customFieldValues.cfOffsiteTimeline, [2880426, 2880427]);
/* And the comparison that decides whether to write at all. */
const idOf = (v) => (Array.isArray(v) ? v.map(idOf) : v && typeof v === "object" ? (v.id ?? v.value) : v);
is("a value already correct reads as unchanged",
  JSON.stringify(idOf([{ id: 2880426 }])), JSON.stringify([2880426]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
