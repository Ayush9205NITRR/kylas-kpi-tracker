#!/usr/bin/env node
/* bd-mail.mjs — one morning mail per BD, to their own Kylas e-mail.
 *
 *   node scripts/test-bd-mail.mjs
 */
import { stuckAccounts, changes } from "./below-activation.mjs";
import { forOwner, recipients, renderBd, planBdMails } from "./bd-mail.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${String(d).slice(0, 300)}` : ""}`); };

const today = "2026-10-26";
const at = (d) => `${d}T06:00:00Z`;
const P = (rung, stage, calls, first, last) => ({ rung, stage, calls, firstCallAt: first && at(first), lastCallAt: last && at(last) });
const byCompany = new Map([
  ["1", P(6, "CNC_COULD_NOT_CONNECT", 3, "2026-10-12", "2026-10-20")],
  ["2", P(6, "CNC_COULD_NOT_CONNECT", 2, "2026-10-20", "2026-10-24")],
  ["3", P(5, "DISQUALIFIED_WRONG_POC", 1, "2026-10-21", "2026-10-21")],
  ["4", P(6, "CNC_COULD_NOT_CONNECT", 1, "2026-10-22", "2026-10-22")],
  ["5", P(6, "CNC_COULD_NOT_CONNECT", 1, "2026-10-22", "2026-10-22")],
]);
const companies = [
  { id: "1", name: "Acme <Labs>", owner: "Sejal One" }, { id: "2", name: "Beta", owner: "Sejal One" },
  { id: "3", name: "Gamma", owner: "Mayra Five" }, { id: "4", name: "Delta", owner: "Gone Person" },
  { id: "5", name: "Epsilon", owner: "Enout Super Admin" },
];
const users = [
  { id: "1", name: "Sejal One", email: "sejal@enout.in", active: true },
  { id: "2", name: "Mayra Five", email: "mayra@enout.in", active: true },
  { id: "3", name: "Gone Person", email: "gone@enout.in", active: false },
  { id: "74725", name: "Enout Super Admin", email: "crmadmin@enout.in", active: true },
  { id: "9", name: "Twin Name", email: "t1@enout.in", active: true }, { id: "10", name: "Twin Name", email: "t2@enout.in", active: true },
  { id: "11", name: "Outsider", email: "o@gmail.com", active: true }, { id: "12", name: "No Mail", email: "", active: true },
];
const labels = { CNC_COULD_NOT_CONNECT: "CNC (Could Not Connect) - 1", DISQUALIFIED_WRONG_POC: "Disqualified - Wrong POC" };
const stuck = stuckAccounts({ byCompany, companies, today, labels });
const prev = { 1: { rung: 6, stage: "CNC_COULD_NOT_CONNECT", name: "Acme <Labs>", owner: "Sejal One" },
               9: { rung: 6, stage: "CNC_COULD_NOT_CONNECT", name: "Old", owner: "Sejal One" } };
const ch = changes(prev, stuck, new Map([["9", P(14, "ACTIVATION", 4, "2026-10-01", "2026-10-20")]]));
const due = [{ name: "Pragyaa Prasad", owner: "Sejal One", gate: "discoveryNoBooking", days: 26 },
             { name: "Rohit Menon", owner: "sejal  one", gate: "rightNoDiscovery", days: 45 },
             { name: "Somebody", owner: "Mayra Five", gate: "rightNoDiscovery", days: 20 }];

console.log("\n1 · a BD's slice");
const s1 = forOwner("Sejal One", stuck, ch);
ok("only their accounts", s1.stuck.length === 2 && s1.stuck.every((x) => x.owner === "Sejal One"), JSON.stringify(s1.stuck.map((x) => x.name)));
ok("only their changes (the climb of their old account)", s1.ch.climbed.length === 0 || s1.ch.climbed.every((x) => x.owner === "Sejal One"));
ok("and the first-day flag survives", forOwner("Sejal One", stuck, { first: true, added: [], climbed: [], closed: [], moved: [] }).ch.first === true);

console.log("\n2 · who gets a mail");
const rc = recipients(["Sejal One", "Mayra Five", "Gone Person", "Enout Super Admin", "Twin Name", "Outsider", "No Mail", "Nobody Known", "sejal one", "—"],
  users, { domain: "enout.in", apiUser: "74725" });
ok("an active BD with an enout.in address, matched on the name", rc.to.map((t) => t.email).join() === "sejal@enout.in,mayra@enout.in", JSON.stringify(rc.to));
const why = Object.fromEntries(rc.skipped.map((x) => [x.owner, x.why]));
ok("deactivated is skipped", why["Gone Person"] === "deactivated", JSON.stringify(why));
ok("the API user is skipped", why["Enout Super Admin"] === "api user");
ok("a name shared by two users is skipped, not guessed", /share the name/.test(why["Twin Name"] || ""));
ok("an address outside the domain is skipped", /outside/.test(why["Outsider"] || ""));
ok("no e-mail, and no such user, are skipped", /no e-mail/.test(why["No Mail"] || "") && /no Kylas user/.test(why["Nobody Known"] || ""));
ok("the same name twice (case aside) is one mail", rc.to.filter((t) => t.email === "sejal@enout.in").length === 1);

console.log("\n3 · what the mail says");
const m = renderBd({ owner: "Sejal One", day: today, ...s1, due: due.filter((d) => /sejal/i.test(d.owner)), labels });
ok("greets by first name", /^Hi Sejal,/.test(m.text));
ok("says how many reasons are owed, longest first, with the gate", /2 of your contacts have stalled/.test(m.text) &&
   m.text.indexOf("Rohit Menon") < m.text.indexOf("Pragyaa Prasad") && /Right POC, no discovery call/.test(m.text), m.text.slice(0, 400));
ok("tells them where to act", /tap Reasons at the top/.test(m.text));
ok("subject carries the count of accounts and of reasons", /2 accounts/.test(m.subject) && /2 reasons due/.test(m.subject), m.subject);
ok("lists their accounts, not anybody else's", /Acme <Labs>/.test(m.text) && !/Gamma|Delta|Epsilon/.test(m.text));
ok("the HTML escapes names", m.html.includes("Acme &lt;Labs&gt;") && !m.html.includes("Acme <Labs>"));
const none = renderBd({ owner: "Mayra Five", day: today, stuck: [], ch: { first: false, added: [], climbed: [], closed: [], moved: [] }, due: [due[2]] });
ok("owing a reason alone is enough for a mail, and says so", /1 of your contact has stalled/.test(none.text) && /1 reason due/.test(none.subject), none.subject);

console.log("\n4 · the plan");
const plan = planBdMails({ stuck, ch, due, users, domain: "enout.in", apiUser: "74725", labels, day: today });
ok("one mail each to Sejal and Mayra, nobody else", plan.mails.map((x) => x.email).sort().join() === "mayra@enout.in,sejal@enout.in", JSON.stringify(plan.mails.map((x) => x.email)));
ok("Mayra's carries her own account and her own reason, not Sejal's",
   plan.mails.find((x) => x.owner === "Mayra Five").text.includes("Gamma") && !plan.mails.find((x) => x.owner === "Mayra Five").text.includes("Acme"));
const quiet = planBdMails({ stuck: [], ch: { first: false, added: [], climbed: [], closed: [], moved: [] }, due: [], users, domain: "enout.in", labels, day: today });
ok("a day with nothing to say sends nothing", quiet.mails.length === 0);

console.log("\n--- a sample, as Sejal reads it ---\n" + m.text);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
