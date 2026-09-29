/* THE DAILY WRITE-BACK EMAIL, counted from the job rows.
 *
 * The cases that matter are the dishonest ones: a save that failed counted as
 * a success, a save whose Kylas half landed and whose Airtable half did not
 * counted as either, and "accounts created" showing a number when the console
 * has never created a company in its life.
 *
 * Run: node scripts/test-digest.mjs
 */
import { summarise, renderText, renderHtml, sendDigest, windowFor } from "./digest.mjs";

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

const job = (o) => ({ id: o.id || "j", state: o.state || "done", tries: o.tries || 1,
  at: o.at || 0, result: o.result || null, error: o.error || null });

const DAY = "2026-09-29";
const rows = [
  job({ result: { kid: "1", created: true, wrote: ["created contact", "logged call"] } }),
  job({ result: { kid: "2", created: false, wrote: ["updated contact", "logged call"] } }),
  job({ result: { kid: "3", created: false, wrote: ["updated contact"] } }),
  job({ result: { kid: "4", created: false, wrote: ["updated contact", "logged call"],
                  airtableError: "Airtable 422: unknown field \"Offsite Timeline\"" } }),
  job({ state: "failed", tries: 6, result: { kid: "5" }, error: { message: "Kylas 400 002008 Invalid Mobile Number" } }),
];

console.log("1. what reached Kylas");
const s = summarise(rows, { day: DAY });
is("contacts updated", s.contactsUpdated, 3);
is("contacts created", s.contactsCreated, 1);
is("calls logged", s.callsLogged, 3);
/* A create is not also an update. Counting it in both is how a digest reads
   like twice the work was done. */
ok("a created contact is not counted as updated too", s.contactsUpdated + s.contactsCreated === 4);

console.log("\n2. the ones a friendly number would hide");
is("failures", s.failed, 1);
/* Kylas took it, Airtable did not. Not a failed save — the associate was told
   it was safe — and not a clean one either: that row's KPIs are missing. */
is("half-landed saves", s.partial, 1);
is("both are named", s.failures.length, 2);
ok("with the reason Kylas gave", /002008/.test(s.failures.find((f) => /contact 5/.test(f.what))?.why || ""));
ok("and the one Airtable gave", /Offsite Timeline/.test(s.failures.find((f) => /part of the save/.test(f.what))?.why || ""));

console.log("\n3. accounts created is zero, and says why");
is("in Kylas", s.accountsCreatedInKylas, 0);
ok("the text says the console does not create companies",
  /never creates companies/.test(renderText(s)), renderText(s));
/* What Ayush actually wants under that heading: accounts saved here for the
   first time. It has its own line and its own name. */
const first = summarise(rows, { day: DAY, newCompanies: 7 });
is("accounts saved here for the first time", first.accountsFirstSaved, 7);
ok("...and it is in the email", /7  Accounts saved here for the first time/.test(renderText(first)));

console.log("\n4. a quiet day");
const quiet = summarise([], { day: DAY });
is("nothing counted", quiet.contactsUpdated + quiet.contactsCreated + quiet.callsLogged, 0);
ok("and it says so rather than printing an empty table",
  /Nothing was saved yesterday/.test(renderText(quiet)));
ok("a clean day says nothing failed",
  /Nothing failed/.test(renderText(summarise(rows.slice(0, 3), { day: DAY }))));

console.log("\n5. the html is html, and escapes what Kylas said");
const html = renderHtml(summarise([job({ state: "failed", result: { kid: "9" },
  error: { message: '<script>alert(1)</script> & "quoted"' } })], { day: DAY }));
ok("no raw tag survives", !/<script>/.test(html), html.slice(0, 200));
ok("it is still html", /^<div/.test(html));

console.log("\n6. nothing emails anybody by accident");
let called = 0;
const noSend = await sendDigest({}, s, { log: () => {}, fetchImpl: async () => { called++; return { ok: true, text: async () => "" }; } });
is("no provider, no request", called, 0);
is("...and it says why", noSend.why, "not configured");
ok("...while still handing back the text", noSend.text.includes("BD console"));

const env = { MAIL_URL: "https://api.example/send", MAIL_KEY: "k", MAIL_FROM: "a@b.c", MAIL_TO: "ayush@enout.in" };
let sentBody = null;
const sent = await sendDigest(env, s, { log: () => {},
  fetchImpl: async (u, o) => { sentBody = JSON.parse(o.body); return { ok: true, text: async () => "{}" }; } });
ok("configured, it posts once", sent.sent === true);
is("to the address given", sentBody.to, ["ayush@enout.in"]);
ok("with the counts in the subject", /3 updated, 1 created/.test(sentBody.subject), sentBody.subject);
ok("and both bodies", !!sentBody.text && !!sentBody.html);

const failed = await sendDigest(env, s, { log: () => {},
  fetchImpl: async () => ({ ok: false, status: 403, text: async () => "no" }) });
ok("a provider that refuses is not a crash", failed.sent === false && failed.why === "403");

console.log("\n7. the day is midnight to midnight in IST");
const w = windowFor("2026-09-29", 330);
is("starts at 18:30Z the day before", new Date(w.from).toISOString(), "2026-09-28T18:30:00.000Z");
is("and runs 24 hours", w.to - w.from, 86400000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
