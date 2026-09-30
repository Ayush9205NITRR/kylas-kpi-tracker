/* BULK RE-ASSIGNMENT — the write that can take a whole account with it.
 *
 *   node scripts/test-reassign.mjs
 *
 * Every assertion here is about a way this can destroy data rather than move
 * it. The company PUT had never been called from this tree before; test-replace
 * asserted it never was, with the note "the day it stops being true is the day
 * contacts start moving on their own". These are the rules that note wanted.
 */
import { plan, apply, companyBody, contactBody, MAX_ACCOUNTS } from "./reassign.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A company as Kylas actually serves one: lookups as objects, a multi-picklist
   as an array of them, and server-managed keys mixed in with real fields. */
const CO = {
  id: 903, name: "vincitlabs", ownerId: { id: 74725, name: "Mayra Singh" },
  website: "vincitlabs.com", phoneNumbers: [{ type: "MOBILE", value: "9000000000" }],
  emails: [{ type: "OFFICE", value: "hi@vincitlabs.com" }],
  customFieldValues: { cfPipelineStageBd: { id: 2862828, name: "MQL" },
                       cfOffsiteTimelineBdNew: [{ id: 2880424 }, { id: 2880425 }],
                       cfSourceOfData: "LinkedIn", cfEmpty: "" },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
  createdBy: { id: 1 }, updatedBy: { id: 1 }, recordActions: { read: true },
};
const PERSON = {
  id: 6258147, firstName: "Preeti", lastName: "Pagote", designation: "HR",
  ownerId: { id: 74725, name: "Mayra Singh" }, company: { id: 903, name: "vincitlabs" },
  phoneNumbers: [{ type: "MOBILE", value: "9111111111", primary: true }],
  emails: [{ type: "OFFICE", value: "preeti@vincitlabs.com" }],
  customFieldValues: { cfOffsiteTimeline: [{ id: 2880424 }], cfNextCallDateCallLater: "2026-10-02T10:00:00Z" },
  createdAt: "2026-01-01T00:00:00Z", updatedBy: { id: 1 }, recordActions: {},
};

/* ── the bodies ─────────────────────────────────────────────────────── */
console.log("\n1. the whole record, one field changed");
const cb = companyBody(CO, "74726");
is("the owner is the new one, as a number", cb.ownerId, 74726);
is("the name survives", cb.name, "vincitlabs");
is("the website survives", cb.website, "vincitlabs.com");
is("the phone survives", cb.phoneNumbers, CO.phoneNumbers);
is("the email survives", cb.emails, CO.emails);
/* THE ONE THAT COST A CONTACT ITS PHONE NUMBER. A lookup sent back as the
   object Kylas served drops the field, and a dropped field is a deleted one. */
is("a lookup custom field goes back as its id", cb.customFieldValues.cfPipelineStageBd, 2862828);
is("a MULTI-picklist goes back as ids, not objects",
   cb.customFieldValues.cfOffsiteTimelineBdNew, [2880424, 2880425]);
is("a plain custom field survives", cb.customFieldValues.cfSourceOfData, "LinkedIn");
ok("an empty custom field is not sent", !("cfEmpty" in cb.customFieldValues));
for (const k of ["id", "createdAt", "updatedAt", "createdBy", "updatedBy", "recordActions"])
  ok(`${k} — Kylas' own — is not sent back`, !(k in cb));

/* THE ONE THAT BROKE A LIVE ACCOUNT, 2026-09-30. metaData is Kylas' internal
   id -> display-name cache for the lookups on a record. It was NOT in
   SERVER_KEYS, so the company PUT carried it back — and lucidity (1777441)
   came out of that write with no owner at all, then refused every further
   write with 02803002 "generic.error". The mock merged it without complaint,
   which is exactly how it reached a real account. */
{
  const withMeta = companyBody({
    name: "x", ownerId: { id: 1, name: "A" },
    metaData: { idNameStore: { ownerId: { 1: "A" } } },
    lastActivityAt: "2026-09-30T00:00:00Z", score: 12, ownerName: "A",
  }, 2);
  for (const k of ["metaData", "lastActivityAt", "score", "ownerName"])
    ok(`${k} — computed by Kylas — is never sent back`, !(k in withMeta));
  is("...and the owner still moves", withMeta.ownerId, 2);
  is("...and the name still survives", withMeta.name, "x");
}

console.log("\n2. ...and the same for a contact");
const pb = contactBody(PERSON, 74726);
is("the owner moved", pb.ownerId, 74726);
is("the name survives", [pb.firstName, pb.lastName], ["Preeti", "Pagote"]);
is("the phone survives", pb.phoneNumbers, PERSON.phoneNumbers);
is("the email survives", pb.emails, PERSON.emails);
is("the company link goes back as an id", pb.company, 903);
is("the offsite quarter survives as ids", pb.customFieldValues.cfOffsiteTimeline, [2880424]);
is("the call-back survives", pb.customFieldValues.cfNextCallDateCallLater, "2026-10-02T10:00:00Z");
ok("a contact with no last name still gets one", contactBody({ id: 1 }, 5).lastName === "Unknown");

/* THE NEAR MISS. The first version of companyBody ran push-kylas' idOf over
   every top-level field, and idOf collapses anything with a `.value` — which
   a phone number has. {type:"MOBILE", value:"9…", primary:true} went back as
   "9…", so a re-assignment would have quietly stripped the type and the
   primary flag off every phone and email it touched. These pin the rule that
   replaced it: only an object that is JUST {id, name} is a lookup. */
console.log("\n2b. only a real lookup is collapsed to an id");
{
  const rich = companyBody({
    name: "x", ownerId: { id: 1, name: "A" },
    phoneNumbers: [{ type: "MOBILE", value: "9", primary: true }],
    /* has an id, but also other keys — a record, not a lookup */
    addresses: [{ id: 7, city: "Pune", line1: "1 Road" }],
    stage: { id: 4, name: "MQL" },
  }, 2);
  is("a {id,name} lookup becomes its id", rich.stage, 4);
  is("a phone keeps every key it arrived with",
     rich.phoneNumbers, [{ type: "MOBILE", value: "9", primary: true }]);
  is("an object with an id AND other keys is left alone",
     rich.addresses, [{ id: 7, city: "Pune", line1: "1 Road" }]);
  is("an array of pure lookups still becomes ids",
     companyBody({ name: "x", tags: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }, 3).tags, [1, 2]);
}

console.log("\n3. a company with no name is refused, not invented");
let threw = "";
try { companyBody({ id: 9, ownerId: 1 }, 2); } catch (e) { threw = e.message; }
ok("refused", /no name/.test(threw), threw);

/* ── a fake Kylas that records every write ──────────────────────────── */
const fake = ({ failCompany = null, failContact = null } = {}) => {
  const wrote = { companies: [], contacts: [] };
  const people = { 903: [{ id: 11 }, { id: 12 }], 904: [{ id: 21 }], 905: [] };
  const owners = { 903: 74725, 904: 74725, 905: 74726 };
  const cOwners = { 11: 74725, 12: 74726, 21: 74725 };
  return {
    wrote,
    company: async (id) => {
      if (String(id) === "666") throw Object.assign(new Error("not found"), { status: 404 });
      return { ...CO, id: Number(id), name: `co${id}`, ownerId: { id: owners[id] ?? 74725 } };
    },
    contactsForCompany: async (id) => people[id] || [],
    contact: async (id) => ({ ...PERSON, id: Number(id), ownerId: { id: cOwners[id] ?? 74725 } }),
    updateCompany: async (id, body) => {
      if (String(id) === failCompany) throw new Error("company write rejected");
      wrote.companies.push({ id: String(id), ownerId: body.ownerId, name: body.name });
    },
    updateContact: async (id, body) => {
      if (String(id) === failContact) throw new Error("contact write rejected");
      wrote.contacts.push({ id: String(id), ownerId: body.ownerId });
    },
  };
};

console.log("\n4. plan() counts and writes nothing");
{
  const k = fake();
  const p = await plan({ kylas: k, companies: ["903", "904", "905"], ownerId: "74726" });
  is("nothing was written", [k.wrote.companies.length, k.wrote.contacts.length], [0, 0]);
  is("two accounts would move", p.moving, 2);
  is("...and one is already theirs", p.already, 1);
  is("three contacts would follow", p.contacts, 3);
  ok("each account says who holds it now", p.accounts.every((a) => "from" in a));
}

console.log("\n5. an account that cannot be read is reported, not guessed at");
{
  const k = fake();
  const p = await plan({ kylas: k, companies: ["903", "666"], ownerId: "74726" });
  is("the good one still counted", p.moving, 1);
  is("the bad one is a problem, with its status", p.problems, [{ id: "666", why: "not found", status: 404 }]);
}

console.log("\n6. apply() moves the account AND the people on it");
{
  const k = fake();
  const r = await apply({ kylas: k, companies: ["903", "904"], ownerId: "74726" });
  is("both companies written", k.wrote.companies.map((c) => c.id), ["903", "904"]);
  is("...to the new owner", [...new Set(k.wrote.companies.map((c) => c.ownerId))], [74726]);
  /* 12 is already on the new owner, so it costs no write. */
  is("only the contacts that needed moving were written", k.wrote.contacts.map((c) => c.id), ["11", "21"]);
  is("the reply counts what moved", [r.moved, r.contacts], [2, 2]);
}

console.log("\n7. an account already on that owner costs no write at all");
{
  const k = fake();
  const r = await apply({ kylas: k, companies: ["905"], ownerId: "74726" });
  is("no company write", k.wrote.companies, []);
  is("no contact write", k.wrote.contacts, []);
  is("and it is reported as skipped", [r.moved, r.skipped], [0, 1]);
}

console.log("\n8. RULE 4 — a company that failed does not leak its contacts");
{
  const k = fake({ failCompany: "903" });
  const r = await apply({ kylas: k, companies: ["903", "904"], ownerId: "74726" });
  ok("903's contacts were NOT moved", !k.wrote.contacts.some((c) => ["11", "12"].includes(c.id)),
     JSON.stringify(k.wrote.contacts));
  is("904 still went through", k.wrote.companies.map((c) => c.id), ["904"]);
  is("903 is reported failed", r.failed.map((f) => f.id), ["903"]);
}

console.log("\n9. a contact that fails does not lose the rest of the account");
{
  const k = fake({ failContact: "11" });
  const r = await apply({ kylas: k, companies: ["903"], ownerId: "74726" });
  is("the company still moved", k.wrote.companies.map((c) => c.id), ["903"]);
  is("the account is reported, with the contact named", r.accounts[0].contactsFailed.map((c) => c.id), ["11"]);
}

console.log("\n10. RULE 3 — a batch over the cap is refused, never truncated");
{
  const k = fake();
  const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => String(1000 + i));
  let msg = "", status = 0;
  try { await apply({ kylas: k, companies: many, ownerId: "74726" }); }
  catch (e) { msg = e.message; status = e.status; }
  ok("refused", /more than one batch may move/.test(msg), msg);
  is("...as a bad request", status, 400);
  is("and nothing was written", k.wrote.companies, []);
}

console.log("\n11. the arguments that must never be assumed");
{
  const k = fake();
  for (const [what, args] of [
    ["no owner", { companies: ["903"], ownerId: "" }],
    ["no accounts", { companies: [], ownerId: "74726" }],
  ]) {
    let s = 0;
    try { await apply({ kylas: k, ...args }); } catch (e) { s = e.status; }
    ok(`${what} is a 400, not a silent no-op`, s === 400, `status ${s}`);
  }
  is("nothing was written", [k.wrote.companies.length, k.wrote.contacts.length], [0, 0]);
}

console.log("\n12. the same account twice is one move, not two");
{
  const k = fake();
  await apply({ kylas: k, companies: ["903", "903", "903"], ownerId: "74726" });
  is("written once", k.wrote.companies.map((c) => c.id), ["903"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
