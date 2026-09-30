/* BULK RE-ASSIGNMENT — moving the people on an account to another BD.
 *
 *   node scripts/test-reassign.mjs
 *
 * Every assertion here is about a way this can destroy data rather than move
 * it. The company write that used to be in this file is GONE: Kylas accepts a
 * company PUT carrying ownerId and silently drops it, which on a replacing PUT
 * means the owner is ERASED — that is how lucidity (1777441) lost its owner on
 * the first live run. See the header of reassign.mjs. Contacts are what move.
 */
import { plan, apply, contactBody, MAX_ACCOUNTS } from "./reassign.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A contact as Kylas actually serves one: lookups as objects, a multi-picklist
   as an array of them, and server-managed keys mixed in with real fields. */
const PERSON = {
  id: 6258147, firstName: "Preeti", lastName: "Pagote", designation: "HR",
  ownerId: { id: 74725, name: "Mayra Singh" }, company: { id: 903, name: "vincitlabs" },
  phoneNumbers: [{ type: "MOBILE", value: "9111111111", primary: true }],
  emails: [{ type: "OFFICE", value: "preeti@vincitlabs.com" }],
  customFieldValues: { cfOffsiteTimeline: [{ id: 2880424 }, { id: 2880425 }],
                       cfNextCallDateCallLater: "2026-10-02T10:00:00Z",
                       cfSourceOfData: "LinkedIn", cfEmpty: "" },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
  createdBy: { id: 1 }, updatedBy: { id: 1 }, recordActions: { read: true },
  metaData: { idNameStore: { ownerId: { 74725: "Mayra Singh" } } },
};

/* ── the body ───────────────────────────────────────────────────────── */
console.log("\n1. the whole record, one field changed");
const pb = contactBody(PERSON, "74726");
is("the owner is the new one, as a number", pb.ownerId, 74726);
is("the name survives", [pb.firstName, pb.lastName], ["Preeti", "Pagote"]);
is("the designation survives", pb.designation, "HR");
/* THE ONE THAT COST A CONTACT ITS PHONE NUMBER. */
is("the phone survives, whole", pb.phoneNumbers, PERSON.phoneNumbers);
is("the email survives, whole", pb.emails, PERSON.emails);
is("the company link goes back as an id", pb.company, 903);
is("a MULTI-picklist goes back as ids, not objects",
   pb.customFieldValues.cfOffsiteTimeline, [2880424, 2880425]);
is("the call-back survives", pb.customFieldValues.cfNextCallDateCallLater, "2026-10-02T10:00:00Z");
is("a plain custom field survives", pb.customFieldValues.cfSourceOfData, "LinkedIn");
ok("an empty custom field is not sent", !("cfEmpty" in pb.customFieldValues));
ok("a contact with no last name still gets one", contactBody({ id: 1 }, 5).lastName === "Unknown");

console.log("\n1b. nothing Kylas computes for us is sent back");
for (const k of ["id", "createdAt", "updatedAt", "createdBy", "updatedBy", "recordActions", "metaData"])
  ok(`${k} is not sent back`, !(k in pb));
/* metaData was the one missing from SERVER_KEYS on the first live run. On the
   company PUT it contributed to a 400 that named neither field nor rule. */
{
  const rich = contactBody({ lastName: "x", metaData: { idNameStore: {} },
    lastActivityAt: "2026-09-30T00:00:00Z", score: 12, ownerName: "A" }, 2);
  for (const k of ["metaData", "lastActivityAt", "score", "ownerName"])
    ok(`${k} — computed by Kylas — is never sent back`, !(k in rich));
  is("...and the owner still moves", rich.ownerId, 2);
}

console.log("\n1c. only a real lookup is collapsed to an id");
{
  const rich = contactBody({
    lastName: "x", ownerId: { id: 1, name: "A" }, stage: { id: 4, name: "MQL" },
    phoneNumbers: [{ type: "MOBILE", value: "9", primary: true }],
    addresses: [{ id: 7, city: "Pune", line1: "1 Road" }],
    tags: [{ id: 1, name: "a" }, { id: 2, name: "b" }],
  }, 2);
  is("a {id,name} lookup becomes its id", rich.stage, 4);
  is("a phone keeps every key it arrived with",
     rich.phoneNumbers, [{ type: "MOBILE", value: "9", primary: true }]);
  is("an object with an id AND other keys is left alone",
     rich.addresses, [{ id: 7, city: "Pune", line1: "1 Road" }]);
  is("an array of pure lookups becomes ids", rich.tags, [1, 2]);
}

/* ── THE FENCE. Nothing here may write a company. ───────────────────── */
console.log("\n2. the company owner is never written");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("scripts/reassign.mjs", "utf8");
  ok("reassign.mjs does not call updateCompany",
     !/kylas\.updateCompany\s*\(/.test(src));
  ok("...and exports no companyBody for anything else to call",
     !/export function companyBody/.test(src));
  /* Kylas ACCEPTS a company PUT carrying ownerId and drops the field. On a
     replacing PUT that erases the owner, and nothing in the API could set it
     back. Documented in the file header; asserted here so it cannot creep in
     again on a quiet afternoon. */
  ok("the file says why, so the next person does not retry it",
     /silently DROPPED|ACCEPTED/.test(src) && /lucidity/.test(src));
}

/* ── a fake Kylas that records every write ──────────────────────────── */
const fake = ({ failContact = null, failCompany = null } = {}) => {
  const wrote = { companies: [], contacts: [] };
  const people = { 903: [{ id: 11 }, { id: 12 }], 904: [{ id: 21 }], 905: [] };
  const cOwners = { 11: 74725, 12: 74726, 21: 74725 };
  return {
    wrote,
    company: async (id) => {
      if (String(id) === String(failCompany)) throw Object.assign(new Error("not found"), { status: 404 });
      return { id: Number(id), name: `co${id}`, ownerId: { id: 74725 } };
    },
    contactsForCompany: async (id) => (people[id] || []).map((p) => ({ ...p, ownerId: { id: cOwners[p.id] } })),
    contact: async (id) => ({ ...PERSON, id: Number(id), ownerId: { id: cOwners[id] ?? 74725 } }),
    updateCompany: async () => { throw new Error("nothing may write a company"); },
    updateContact: async (id, body) => {
      if (String(id) === String(failContact)) throw new Error("contact write rejected");
      wrote.contacts.push({ id: String(id), ownerId: body.ownerId });
    },
  };
};

console.log("\n3. plan() counts and writes nothing");
{
  const k = fake();
  const p = await plan({ kylas: k, companies: ["903", "904", "905"], ownerId: "74726" });
  is("nothing was written", [k.wrote.companies.length, k.wrote.contacts.length], [0, 0]);
  /* 11 and 21 need moving; 12 is already there; 905 has nobody. */
  is("two contacts would move", p.contacts, 2);
  is("...across two accounts", p.moving, 2);
  is("...and one is already there", p.already, 1);
  is("it says plainly that the account owner does not move", p.accountOwnerMoves, false);
  ok("each account reports who owns it, for display only",
     p.accounts.every((a) => "accountOwner" in a));
}

console.log("\n4. an account that cannot be read is reported, not guessed at");
{
  const k = fake({ failCompany: "666" });
  const p = await plan({ kylas: k, companies: ["903", "666"], ownerId: "74726" });
  is("the good one still counted", p.contacts, 1);
  is("the bad one is a problem, with its status", p.problems, [{ id: "666", why: "not found", status: 404 }]);
}

console.log("\n5. apply() moves the people, and only the ones that need it");
{
  const k = fake();
  const r = await apply({ kylas: k, companies: ["903", "904"], ownerId: "74726" });
  is("no company was written", k.wrote.companies, []);
  is("only the contacts that needed moving were written", k.wrote.contacts.map((c) => c.id), ["11", "21"]);
  is("...to the new owner", [...new Set(k.wrote.contacts.map((c) => c.ownerId))], [74726]);
  is("the reply counts contacts, and the accounts they sat on", [r.contacts, r.moved], [2, 2]);
  is("...and repeats that the account owner did not move", r.accountOwnerMoves, false);
}

console.log("\n6. an account whose people are all already there costs no write");
{
  const k = fake();
  const r = await apply({ kylas: k, companies: ["905"], ownerId: "74726" });
  is("nothing written", k.wrote.contacts, []);
  is("and it is reported as moving nobody", r.contacts, 0);
}

console.log("\n7. a contact that fails does not lose the rest of the account");
{
  const k = fake({ failContact: "11" });
  const r = await apply({ kylas: k, companies: ["903"], ownerId: "74726" });
  is("the account is reported, with the contact named", r.accounts[0].contactsFailed.map((c) => c.id), ["11"]);
  is("...and nothing else was written for it", r.contacts, 0);
}

console.log("\n8. an account that cannot be read does not abort the rest");
{
  const k = fake({ failCompany: "666" });
  const r = await apply({ kylas: k, companies: ["666", "904"], ownerId: "74726" });
  is("904 still went through", k.wrote.contacts.map((c) => c.id), ["21"]);
  is("666 is reported failed", r.failed.map((f) => f.id), ["666"]);
}

console.log("\n9. RULE 3 — a batch over the cap is refused, never truncated");
{
  const k = fake();
  const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => String(1000 + i));
  let msg = "", status = 0;
  try { await apply({ kylas: k, companies: many, ownerId: "74726" }); }
  catch (e) { msg = e.message; status = e.status; }
  ok("refused", /more than one batch may move/.test(msg), msg);
  is("...as a bad request", status, 400);
  is("and nothing was written", k.wrote.contacts, []);
}

console.log("\n10. the arguments that must never be assumed");
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
  is("nothing was written", k.wrote.contacts, []);
}

console.log("\n11. the same account twice is one pass, not two");
{
  const k = fake();
  await apply({ kylas: k, companies: ["903", "903", "903"], ownerId: "74726" });
  is("written once", k.wrote.contacts.map((c) => c.id), ["11"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
