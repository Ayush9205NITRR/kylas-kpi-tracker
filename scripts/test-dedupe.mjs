#!/usr/bin/env node
/* THE DUPLICATE CHECK'S RULES, WITHOUT A SERVER.
 *
 *   node scripts/test-dedupe.mjs
 *
 * demo-dedupe.mjs runs the whole thing through the Worker and prints it for a
 * person; this pins the decisions underneath it, one rule at a time, so a change
 * to a rule fails here by name. The cases that matter most are the ones where
 * being wrong is expensive: refusing a legitimate contact, and quietly creating
 * a second record.
 */
import { normPhone, normEmail, keysOf, samePerson, classify, candidateFromAirtable, candidateFromKylas, findCandidates } from "./dedupe.mjs";
import { renderVerdict } from "./dedupe-report.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${d}` : ""}`); };
const is = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const LK = { airtable: { status: "ok" }, kylas: { status: "ok" } };
const cand = (o) => ({ kid: "1", name: "Hema Bharathi", companyId: "10", company: "", owner: "", ownerId: "5", phones: [], emails: [], sources: ["airtable"], ...o });
const card = (o) => ({ pocName: "Hema Bharathi", companyId: "10", ownerId: "5", phones: [], emails: [], ...o });

console.log("\n1 · normalising");
is("+91 and spaces and dashes are one number", normPhone("+91 98765-01234"), "9876501234");
is("a leading zero is one too", normPhone("098765 01234"), "9876501234");
is("a bare extension is not compared", normPhone("4321"), "");
is("nothing is nothing", normPhone(undefined), "");
is("an email is compared in lower case", normEmail("  HEMA@Seats.AERO "), "hema@seats.aero");
is("something that is not an email is not one", normEmail("hema at seats"), "");
is("keysOf reads value objects and bare strings", keysOf({ phones: [{ value: "9876501234" }, "9811122233"], emails: [{ value: "A@b.co" }] }),
   { phones: ["9876501234", "9811122233"], emails: ["a@b.co"] });

console.log("\n2 · both sources, read into one shape");
{
  const a = candidateFromAirtable({ id: "rec1", fields: { "Kylas Contact ID": 7, Name: "Asha Rao", Phone: "98765 01234",
    Phones: JSON.stringify([{ value: "9811122233" }]), Email: "ASHA@x.com", Emails: "[]", Owner: "Vaibhav", "Kylas Owner ID": "9", "Company Kylas ID": ["33"] } });
  is("Airtable: both the plain and the JSON phone are read", a.phones, ["9876501234", "9811122233"]);
  is("...email lower-cased", a.emails, ["asha@x.com"]);
  is("...a rollup array gives the company id", a.companyId, "33");
  const broken = candidateFromAirtable({ id: "r", fields: { Phones: "not json", Name: "X" } });
  is("a hand-edited row with broken JSON does not throw", broken.phones, []);
  const k = candidateFromKylas({ id: 8, firstName: "Asha", lastName: "Rao", ownerId: 9, company: { id: 33, name: "Acme" },
    phoneNumbers: [{ value: "9876501234", dialCode: "+91" }], emails: [{ value: "Asha@X.com" }] });
  is("Kylas: name, company and owner", [k.name, k.company, k.companyId, k.ownerId], ["Asha Rao", "Acme", "33", "9"]);
  is("...phone and email normalised", [k.phones, k.emails], [["9876501234"], ["asha@x.com"]]);
  is("a bare company id has no name", candidateFromKylas({ id: 1, company: 55 }).companyId, "55");
}

console.log("\n3 · is it the same person");
ok("identical", samePerson("Hema Bharathi", "Hema Bharathi"));
ok("case and spacing do not matter", samePerson("hema   bharathi", "HEMA BHARATHI"));
ok("a middle name does not matter", samePerson("Hema S Bharathi", "Hema Bharathi"));
ok("an initial for a last name is the same person", samePerson("Hema B", "Hema Bharathi"));
ok("a first name alone is the same person (they share a phone already)", samePerson("Hema", "Hema Bharathi"));
ok("a different first name is not", !samePerson("Rohit Bharathi", "Hema Bharathi"));
ok("the same first name and a different last name is not", !samePerson("Hema Rao", "Hema Bharathi"));
ok("an empty name is not anybody", !samePerson("", "Hema"));

console.log("\n4 · the verdict");
{
  const v = (c, cands, lk = LK) => classify(c, cands, lk);
  const hit = cand({ phones: ["9876501234"] });

  is("nobody holds it: clear", v(card({ phones: [{ value: "9000000000" }] }), [hit]).verdict, "clear");
  const ex = v(card({ phones: [{ value: "9876501234" }] }), [hit]);
  is("the same person, same company: existing", [ex.verdict, ex.action], ["existing", "open"]);
  ok("...with the existing contact named", ex.existing?.kid === "1" && /Hema/.test(ex.summary), ex.summary);
  is("the same person and NO company on either side: still existing", v(card({ companyId: "", phones: [{ value: "9876501234" }] }), [cand({ companyId: "", phones: ["9876501234"] })]).verdict, "existing");
  is("the same person, their company unknown: existing", v(card({ phones: [{ value: "9876501234" }] }), [cand({ companyId: "", phones: ["9876501234"] })]).verdict, "existing");

  const other = v(card({ companyId: "99", phones: [{ value: "9876501234" }] }), [hit]);
  is("the same person at ANOTHER company: flag, not existing", [other.verdict, other.action], ["flag", "create-and-flag"]);
  is("...kind other-company", other.flags.map((f) => f.kind), ["other-company"]);

  const ph = v(card({ pocName: "Karan Mehta", phones: [{ value: "9876501234" }] }), [hit]);
  is("somebody else's phone: flag phone-conflict", [ph.verdict, ph.flags.map((f) => f.kind)], ["flag", ["phone-conflict"]]);
  const em = v(card({ pocName: "Karan Mehta", emails: [{ value: "HEMA@x.com" }] }), [cand({ emails: ["hema@x.com"] })]);
  is("somebody else's email: flag email-conflict", em.flags.map((f) => f.kind), ["email-conflict"]);
  const both = v(card({ pocName: "Karan Mehta", phones: [{ value: "9876501234" }], emails: [{ value: "h@x.com" }] }), [cand({ phones: ["9876501234"], emails: ["h@x.com"] })]);
  is("both phone and email on somebody else: two flags", both.flags.map((f) => f.kind), ["phone-conflict", "email-conflict"]);

  const bd = v(card({ pocName: "Karan Mehta", ownerId: "6", phones: [{ value: "9876501234" }] }), [hit]);
  is("the match sits with another BD: that is flagged too", bd.flags.map((f) => f.kind), ["phone-conflict", "other-bd"]);
  const sameBd = v(card({ pocName: "Karan Mehta", ownerId: "5", phones: [{ value: "9876501234" }] }), [hit]);
  is("...and not when it is the same BD", sameBd.flags.map((f) => f.kind), ["phone-conflict"]);

  const own = v(card({ kid: "1", phones: [{ value: "9876501234" }] }), [hit]);
  is("editing a contact is not duplicating it", own.verdict, "clear");

  const two = v(card({ phones: [{ value: "9876501234" }] }), [cand({ kid: "2", name: "Rohit Rao", phones: ["9876501234"] }), hit]);
  is("one real duplicate and one phone clash: existing wins, the clash is still named", [two.verdict, two.flags.map((f) => f.kind)], ["existing", ["phone-conflict"]]);

  const none = v(card({ phones: [], emails: [] }), []);
  is("nothing to check with: unverified", [none.verdict, none.flags[0].kind], ["unverified", "unverified"]);
  const dead = v(card({ phones: [{ value: "9000000000" }] }), [], { airtable: { status: "failed" }, kylas: { status: "failed" } });
  is("no source answered: unverified, never clear", [dead.verdict, dead.coverage], ["unverified", "none"]);
  const half = v(card({ phones: [{ value: "9000000000" }] }), [], { airtable: { status: "failed" }, kylas: { status: "ok" } });
  is("one source answered: clear, and says it was partial", [half.verdict, half.coverage], ["clear", "partial"]);
  ok("...and the sentence names the source that did", /Kylas search/.test(half.summary), half.summary);
  const skipped = v(card({ phones: [{ value: "9000000000" }] }), [], { airtable: { status: "skipped" }, kylas: { status: "ok" } });
  is("a source that was skipped counts as not having answered", skipped.coverage, "partial");
  const src = v(card({ phones: [{ value: "9876501234" }] }), [cand({ phones: ["9876501234"] })]);
  ok("a match found only in the Airtable copy says so, and does not claim Kylas", /Airtable copy/.test(src.summary) && !/^Already in Kylas/.test(src.summary), src.summary);
}

console.log("\n5 · looking: a source that fails must not take the other down");
{
  const c = card({ phones: [{ value: "9876501234" }] });
  const airtable = { listAll: async () => [{ id: "r1", fields: { "Kylas Contact ID": "1", Name: "Hema Bharathi", Phone: "9876501234", "Company Kylas ID": "10" } }] };
  const kylasDown = { contactsMatching: async () => { throw new Error("503"); } };
  const a = await findCandidates({ card: c, airtable, kylas: kylasDown });
  is("Kylas down: the copy still answers", [a.lookup.airtable.status, a.lookup.kylas.status, a.candidates.length], ["ok", "failed", 1]);
  const kylasOk = { contactsMatching: async () => [{ id: 1, firstName: "Hema", lastName: "Bharathi", company: 10, ownerId: 5, phoneNumbers: [{ value: "9876501234" }] }] };
  const b = await findCandidates({ card: c, airtable, kylas: kylasOk });
  is("both find the same contact: one candidate, two sources", [b.candidates.length, b.candidates[0].sources.sort()], [1, ["airtable", "kylas"]]);
  const notBuilt = { listAll: async () => { throw new Error("listAll: more than maxPages"); } };
  const d = await findCandidates({ card: c, airtable: notBuilt, kylas: kylasOk });
  is("a table too big to read directly is skipped, not failed", d.lookup.airtable.status, "skipped");
  const fuzzy = { contactsMatching: async () => [{ id: 9, firstName: "Somebody", lastName: "Else", phoneNumbers: [{ value: "9999999999" }] }] };
  const e = await findCandidates({ card: c, airtable: null, kylas: fuzzy });
  is("a fuzzy Kylas hit that is not an exact match is not a candidate", [e.candidates.length, e.lookup.kylas.hits], [0, 0]);
  const empty = await findCandidates({ card: card({}), airtable, kylas: kylasOk });
  is("nothing to search with searches nothing", [empty.candidates.length, empty.lookup.airtable.status], [0, "skipped"]);
  const noClient = await findCandidates({ card: c, airtable: null, kylas: null });
  is("no clients at all is two skips, not a throw", [noClient.lookup.airtable.status, noClient.lookup.kylas.status], ["skipped", "skipped"]);
}

console.log("\n6 · the words");
{
  const v = classify(card({ pocName: "Karan Mehta", ownerId: "6", phones: [{ value: "9876501234" }] }), [cand({ phones: ["9876501234"] })], LK);
  const t = renderVerdict(card({ pocName: "Karan Mehta", phones: [{ value: "9876501234" }] }), v);
  ok("the report says what was checked, the sources, the verdict, the matches, the flags and the action",
     ["CHECKING", "SOURCES", "VERDICT", "MATCHES", "FLAGS", "ACTION"].every((w) => t.includes(w)), t);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
