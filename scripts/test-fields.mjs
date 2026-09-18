#!/usr/bin/env node
/* Cases the validator has to get right, every one of them taken from something
   that actually went wrong or from data on this account.
 *
 *   node scripts/test-fields.mjs
 */
import { splitPhone, checkPhone, e164, prettyPhone, checkEmail, checkName,
         checkUrl, splitName, checkContact } from "./fields.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${g}\n       want ${w}`);
};

console.log("phones");
/* THE BUG. Kylas' own UI shows this contact's number as +918319585041, so the
   country code is inside the value. Writing it back as { +91, +918319585041 }
   is what earned the 400. */
eq("+918319585041 pasted whole", splitPhone("+918319585041"), { cc: "+91", value: "8319585041" });
eq("918319585041, no plus",      splitPhone("918319585041"),  { cc: "+91", value: "8319585041" });
eq("0091 prefix",                splitPhone("00918319585041"), { cc: "+91", value: "8319585041" });
eq("bare national",             splitPhone("8319585041"),     { cc: "+91", value: "8319585041" });
eq("trunk zero",                splitPhone("08319585041"),    { cc: "+91", value: "8319585041" });
eq("spaces and dashes",         splitPhone("+91 83195-85041"), { cc: "+91", value: "8319585041" });
eq("brackets",                  splitPhone("(+91) 8319585041"), { cc: "+91", value: "8319585041" });
eq("the one in the call bar",   splitPhone("+917259898838"),   { cc: "+91", value: "7259898838" });
/* A genuine 10-digit number that happens to begin 91 must survive. */
eq("9188... is a real number",  splitPhone("9188885041"),      { cc: "+91", value: "9188885041" });
eq("US number",                 splitPhone("+1 415 555 0134"), { cc: "+1", value: "4155550134" });
eq("UAE number",                splitPhone("+971501234567"),   { cc: "+971", value: "501234567" });
eq("idempotent",                splitPhone(splitPhone("+918319585041").value), { cc: "+91", value: "8319585041" });

eq("valid",        checkPhone("+918319585041").ok, true);
eq("9 digits",     checkPhone("831958504").ok, false);
eq("11 digits",    checkPhone("83195850411").ok, false);
eq("starts 5",     checkPhone("5319585041").ok, false);
eq("landline, typed as WORK", checkPhone("02212345678", { type: "WORK" }).ok, true);
eq("landline typed as a mobile is still wrong",
   checkPhone("02212345678", { type: "MOBILE" }).ok, false);
eq("letters only", checkPhone("call me").ok, false);
eq("empty",        checkPhone("").ok, false);
eq("why is readable", checkPhone("831958504").why, "9 digits after +91, needs 10 digits");

eq("e164",   e164("+91 83195 85041"), "+918319585041");
eq("pretty", prettyPhone({ cc: "+91", value: "8319585041" }), "+91 83195 85041");

console.log("emails");
eq("the one on screen", checkEmail("nandini.shenoy@jsw.in").ok, true);
eq("uppercased",        checkEmail("Nandini.Shenoy@JSW.in").value, "nandini.shenoy@jsw.in");
eq("space",             checkEmail("nandini shenoy@jsw.in").ok, false);
eq("two at",            checkEmail("a@b@jsw.in").ok, false);
eq("no domain dot",     checkEmail("nandini@jsw").ok, false);
eq("trailing dot",      checkEmail("nandini.@jsw.in").ok, false);
eq("plus tag",          checkEmail("nandini+bd@jsw.in").ok, true);
eq("blank",             checkEmail("").ok, false);

console.log("names");
eq("two words",  splitName("Nandini Shenoy"), { firstName: "Nandini", lastName: "Shenoy" });
eq("one word",   splitName("Shenoy"), { firstName: "", lastName: "Shenoy" });
eq("three",      splitName("Ram Prasad Iyer"), { firstName: "Ram Prasad", lastName: "Iyer" });
eq("phone in the name box", checkName("8319585041").ok, false);
eq("Temp is a placeholder", checkName("Temp").ok, false);
eq("real name ok", checkName("  Nandini   Shenoy ").value, "Nandini Shenoy");

console.log("urls");
eq("bare host gets https", checkUrl("linkedin.com/in/x", { host: "linkedin.com" }).value,
   "https://linkedin.com/in/x");
eq("http upgraded", checkUrl("http://www.linkedin.com/in/x", { host: "linkedin.com" }).value,
   "https://www.linkedin.com/in/x");
eq("wrong host", checkUrl("https://example.com/x", { host: "linkedin.com" }).ok, false);
eq("empty is fine", checkUrl("").ok, true);

console.log("whole contact");
const bad = checkContact({ pocName: "Temp", phones: [{ value: "+918319585041" }],
                           emails: [{ value: "not an email" }] });
eq("blocked", bad.ok, false);
eq("names the fields", bad.problems.map((p) => p.field).sort(), ["emails.0", "pocName"]);
eq("phone was still normalised", bad.contact.phones, [{ type: "MOBILE", cc: "+91", value: "8319585041", primary: true }]);

const good = checkContact({ pocName: "Nandini Shenoy", designation: "Hr Business Partner",
                            phones: [{ value: "+91 72598 98838" }],
                            emails: [{ value: "Nandini.Shenoy@jsw.in" }] });
eq("passes", good.ok, true);
eq("split name", [good.contact.firstName, good.contact.lastName], ["Nandini", "Shenoy"]);
eq("phone normalised", good.contact.phones[0].value, "7259898838");
eq("email lowered", good.contact.emails[0].value, "nandini.shenoy@jsw.in");
eq("primary forced", good.contact.phones[0].primary, true);

const nophone = checkContact({ pocName: "Nandini Shenoy", phones: [] });
eq("no phone blocks a create", nophone.ok, false);
eq("unless the caller says otherwise",
   checkContact({ pocName: "Nandini Shenoy", phones: [] }, { allowNoPhone: true }).ok, true);

/* A stale picklist reports but never blocks, and never drops the value. */
const stale = checkContact({ pocName: "Nandini Shenoy", phones: [{ value: "9876543210" }],
                             source: "Round-Robin" }, { sources: ["Referral"] });
eq("stale picklist does not block", stale.ok, true);
eq("stale picklist is reported", stale.problems.length, 1);
eq("stale picklist keeps the value", stale.contact.source, "Round-Robin");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
