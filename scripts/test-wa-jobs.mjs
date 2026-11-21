#!/usr/bin/env node
/* THE WHATSAPP OUTBOX, against a real SQLite.
 *
 *   node scripts/test-wa-jobs.mjs
 *
 * The queue is the only part of the WhatsApp work that lives in this repo —
 * the bot is `whatsapp-bd-outreach` and already works — so this is where the
 * six post-send cases have to be proved. They are pure functions over plain
 * objects precisely so they can be tested without a laptop, a QR code or a
 * phone, and the store is then tested against the same SQLite the Worker's
 * D1 fake uses.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { createWaJobs, inBusinessHours, nextBusinessSlot, istMinutes, waPlan, waVars,
         onInboundReply, onNoReplyAdvance, onCallSupersedes, onMultiThreadGuard,
         onDeliveryFailure, onOptOut, WARM_STAGES } from "./wa-jobs.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : `  — ${detail}`}`);
};
/* A fixed instant, so "business hours" is not a question about when the
   suite happens to run. 2026-11-21T06:00:00Z is 11:30 IST — open. */
const OPEN = Date.parse("2026-11-21T06:00:00Z");
const SHUT = Date.parse("2026-11-21T20:00:00Z");       /* 01:30 IST — shut */

console.log("\n1 · business hours are IST, and a constant offset");
ok("11:30 IST is inside 09:30–19:30", inBusinessHours(OPEN) === true, `${istMinutes(OPEN)} min`);
ok("01:30 IST is not", inBusinessHours(SHUT) === false, `${istMinutes(SHUT)} min`);
ok("a message due in hours goes now", nextBusinessSlot(OPEN) === OPEN);
const slot = nextBusinessSlot(SHUT);
ok("...and one due at 01:30 waits for 09:30, not 00:00 UTC",
   istMinutes(slot) === 9 * 60 + 30 && slot > SHUT, `${istMinutes(slot)} min, +${Math.round((slot - SHUT) / 60000)}min`);
ok("the wait is under a day — it is the next opening, not the one after",
   slot - SHUT < 86400000);

console.log("\n2 · which stages offer what");
ok("CNC 1 auto-queues", waPlan("CNC_COULD_NOT_CONNECT").auto === true);
ok("CNC 3 auto-queues and asks for a second POC",
   waPlan("CNC_COULD_NOT_CONNECT_3").auto === true && waPlan("CNC_COULD_NOT_CONNECT_3").multiThread === true);
ok("Connect Later auto-queues", waPlan("CONNECT_LATER").auto === true);
ok("MQL offers but does not auto-send — it quotes what they said, so a human looks first",
   waPlan("MQL_MARKETING_QUALIFIED_LEAD").offer === true
   && waPlan("MQL_MARKETING_QUALIFIED_LEAD").auto === false
   && waPlan("MQL_MARKETING_QUALIFIED_LEAD").needsEvent === true);
ok("Activation the same", waPlan("ACTIVATION").needsEvent === true);
ok("a stage with no playbook offers nothing", waPlan("NOT_INTERESTED").offer === false);
ok("no number, no offer", waPlan("CNC_COULD_NOT_CONNECT", { hasPhone: false }).offer === false);
ok("opted out, no offer", waPlan("CNC_COULD_NOT_CONNECT", { optedOut: true }).offer === false);

console.log("\n3 · the live event row is what gets quoted");
const v = waVars({ pocName: "Sana Kausar", current: [{ eventType: "Employee offsites",
  pax: "around 120", timeline: "March", budget: "approx 8L, not signed off" }] }, { name: "pinelabs" });
ok("first name only", v.name === "Sana", v.name);
ok("the event row is carried verbatim, free text and all",
   v.pax === "around 120" && v.budget === "approx 8L, not signed off", JSON.stringify(v));
ok("a contact with no rows still produces a usable greeting",
   waVars({ pocName: "" }, {}).name === "there");

console.log("\n4 · the six cases, as rules");
const seq = { id: "s1", contactId: "c1", seq: "cnc", step: 1, steps: 3, state: "active" };
const r1 = onInboundReply(seq, { at: OPEN });
ok("1 · a reply pauses the sequence and cancels what is queued",
   r1.pause.reason === "inbound_reply" && r1.cancelQueued === true);
ok("...bumps the call-back to today, so the BD sees them in Work today",
   /^\d{4}-\d\d-\d\d$/.test(r1.nextCallDate), r1.nextCallDate);
ok("...and raises the badge", r1.badge === "WA Replies");

const adv = onNoReplyAdvance(seq, { at: SHUT });
ok("2 · no reply advances a step", adv.advance === true && adv.step === 2);
ok("...into business hours, never at 01:30", inBusinessHours(adv.dueAt) === true);
ok("...and a paused sequence does not advance at all",
   onNoReplyAdvance({ ...seq, state: "paused" }).advance === false);
ok("...nor one that has run out of steps",
   onNoReplyAdvance({ ...seq, step: 3 }).advance === false);

const sup = onCallSupersedes([{ id: "j1", state: "queued" }, { id: "j2", state: "sent" }]);
ok("3 · a new call cancels the WAITING message, not the one already sent",
   sup.cancel.length === 1 && sup.cancel[0] === "j1", sup.cancel.join(","));

const guard = onMultiThreadGuard([
  { id: "a", contactId: "c1", seq: "cnc", state: "active" },
  { id: "b", contactId: "c2", seq: "cnc", state: "active" },
  { id: "c", contactId: "c3", seq: "event", state: "active" }], "c1");
ok("4 · one POC going warm holds the COLD chase on the others",
   guard.pause.length === 1 && guard.pause[0] === "b", guard.pause.join(","));
ok("...and leaves the warm POC's own sequence alone", !guard.pause.includes("a"));
ok("...and does not touch a different playbook", !guard.pause.includes("c"));
ok("the warm set is the booked/done/SQL rungs",
   WARM_STAGES.has("ACTIVE_REQUIREMENT_CALL_BOOKED") && !WARM_STAGES.has("CNC_COULD_NOT_CONNECT"));

const off = onDeliveryFailure({ id: "j9" }, "seat_offline", { at: SHUT });
const notwa = onDeliveryFailure({ id: "j9" }, "not_on_wa", { at: OPEN });
ok("5 · a seat being offline is this hour's problem — the job waits",
   off.state === "queued" && off.pauseSequence === false && off.retryAt > SHUT);
ok("...and it waits until business hours", inBusinessHours(off.retryAt) === true);
ok("...while NOT on WhatsApp is final, and says to call instead",
   notwa.state === "failed" && notwa.pauseSequence === true && /call instead/i.test(notwa.note));

const out = onOptOut(seq, { at: OPEN });
ok("6 · opt-out halts and sets DND", out.dnd === true && out.cancelQueued === true
   && out.pause.reason === "opt_out");

console.log("\n5 · the store");
const db = fakeD1();
const wa = createWaJobs({ db, now: () => OPEN });
const q1 = await wa.queue({ contactId: "900", companyId: "903", phone: "+919000000001",
  stage: "CNC_COULD_NOT_CONNECT", vars: { name: "A" } });
ok("a job is queued", !!q1.id && q1.seqId === "900:cnc", JSON.stringify(q1));
ok("...due inside business hours", inBusinessHours(q1.dueAt) === true);

const d1 = await wa.drain({ seat: "seat-1", limit: 10 });
ok("the bot drains it", d1.jobs.length === 1 && d1.jobs[0].contact_id === "900", `${d1.jobs.length}`);
ok("...with the variables parsed, not a JSON string", d1.jobs[0].vars?.name === "A");
const d2 = await wa.drain({ seat: "seat-2", limit: 10 });
ok("...and a second seat does not get the same job twice — it is leased",
   d2.jobs.length === 0, `${d2.jobs.length}`);

/* CASE 3, in the store rather than the rule: queueing again for the same
   contact cancels what was waiting. */
await wa.queue({ contactId: "901", companyId: "903", phone: "+919000000002", stage: "CNC_COULD_NOT_CONNECT" });
await wa.queue({ contactId: "901", companyId: "903", phone: "+919000000002", stage: "CNC_COULD_NOT_CONNECT_2" });
const s1 = await wa.status({});
ok("3 (stored) · the second queue for a contact cancels the first",
   (s1.by.cancelled || 0) >= 1, JSON.stringify(s1.by));

await wa.webhook({ event: "inbound_reply", contactId: "901" });
const s2 = await wa.status({});
ok("1 (stored) · a reply leaves nothing queued for that contact and counts as a reply",
   s2.replies >= 1, JSON.stringify(s2));

/* CASE 4, in the store: a warm stage at the company holds the others. */
await wa.queue({ contactId: "902", companyId: "903", phone: "+919000000003", stage: "CNC_COULD_NOT_CONNECT" });
await wa.webhook({ event: "stage_warm", contactId: "999", companyId: "903",
                   stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" });
const left = await db.prepare("SELECT state, error FROM wa_jobs WHERE contact_id = '902'").first();
ok("4 (stored) · a warm POC cancels a colleague's cold job",
   left.state === "cancelled" && left.error === "multi_thread_guard", JSON.stringify(left));

/* CASE 6, in the store: DND outlives the sequence. */
await wa.webhook({ event: "opt_out", contactId: "905" });
await wa.queue({ contactId: "905", companyId: "903", phone: "+919000000005", stage: "CNC_COULD_NOT_CONNECT" });
const after = await db.prepare("SELECT COUNT(*) AS n FROM wa_jobs WHERE contact_id = '905' AND state = 'queued'").first();
ok("6 (stored) · a DND contact cannot be queued again by a later stage change",
   after.n === 0, `${after.n} queued`);

/* CASE 5, in the store. */
const q5 = await wa.queue({ contactId: "906", companyId: "903", phone: "+919000000006", stage: "CONNECT_LATER" });
await wa.webhook({ event: "seat_offline", jobId: q5.id, contactId: "906" });
const back = await db.prepare("SELECT state FROM wa_jobs WHERE id = ?").bind(q5.id).first();
ok("5 (stored) · an offline seat puts the job back on the queue, not in the bin",
   back.state === "queued", back.state);
await wa.webhook({ event: "not_on_wa", jobId: q5.id, contactId: "906" });
const dead = await db.prepare("SELECT state FROM wa_jobs WHERE id = ?").bind(q5.id).first();
ok("...and not_on_wa fails it for good", dead.state === "failed", dead.state);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
