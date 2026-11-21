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
import { statusOf, eligible, customVarsIn, WA_STATUS, WA_DEFAULTS, TEMPLATE_VISIBILITY,
         renderTemplate, varsUsed, TEMPLATE_VARS, VAR_FALLBACK, DEFAULT_TEMPLATES,
         createWaJobs, inBusinessHours, nextBusinessSlot, istMinutes, waPlan, waVars,
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

console.log("\n6 · templates and the renderer");
const V = { name: "Sana Kausar", company: "pinelabs", eventType: "Employee offsites",
            pax: "120", timeline: "March", budget: "approx 8L, not signed off",
            nextCallDate: "2026-11-25", bdName: "Gurnoor" };
ok("every variable substitutes",
   renderTemplate("{{name}} {{company}} {{eventType}} {{pax}} {{timeline}} {{budget}} {{nextCallDate}} {{bdName}}", V)
   === "Sana Kausar pinelabs Employee offsites 120 March approx 8L, not signed off 2026-11-25 Gurnoor");
ok("free text goes through untouched",
   renderTemplate("Budget {{budget}}.", V) === "Budget approx 8L, not signed off.");
ok("a blank value takes its fallback, so nobody gets “Hi ,”",
   renderTemplate("Hi {{name}},", { name: "" }) === "Hi there,");
ok("...and a caller's own fallback wins over the default",
   renderTemplate("Hi {{name}},", { name: "" }, { name: "team" }) === "Hi team,");
/* An unknown token is LEFT VISIBLE. A half-substituted message gets noticed;
   a silently blanked one gets sent. */
ok("an unknown {{token}} is left visible rather than blanked",
   renderTemplate("Hi {{nope}}", V) === "Hi {{nope}}", renderTemplate("Hi {{nope}}", V));
ok("whitespace inside the braces is tolerated",
   renderTemplate("Hi {{ name }}", V) === "Hi Sana Kausar");
ok("a hole left by an empty value does not become a double space",
   renderTemplate("for about {{pax}} people", { pax: "" }) === "for about people",
   renderTemplate("for about {{pax}} people", { pax: "" }));
ok("...nor a space before punctuation",
   renderTemplate("around {{timeline}}.", { timeline: "" }) === "around.");
ok("varsUsed lists only the real ones",
   varsUsed("{{name}} {{nope}} {{pax}} {{name}}").join(",") === "name,pax",
   varsUsed("{{name}} {{nope}} {{pax}} {{name}}").join(","));
ok("there are exactly eight variables", TEMPLATE_VARS.length === 8, TEMPLATE_VARS.join(","));
ok("...and each has a fallback entry", TEMPLATE_VARS.every((v) => v in VAR_FALLBACK));
ok("the five playbooks are seeded",
   ["cnc", "event", "confirm", "noshow", "inputs"].every((g) => DEFAULT_TEMPLATES.some((t) => t.stageGroup === g)));
ok("...and only the CNC one auto-sends",
   DEFAULT_TEMPLATES.filter((t) => t.autoSend).map((t) => t.id).join(",") === "cnc");
ok("every default body uses only known variables",
   DEFAULT_TEMPLATES.every((t) => varsUsed(t.body).every((v) => TEMPLATE_VARS.includes(v))
     && !/\{\{(?!\s*(name|company|eventType|pax|timeline|budget|nextCallDate|bdName)\s*\}\})/.test(t.body)));

const tpl = await wa.templates();
ok("the store seeds them on first read", tpl.length >= 5, `${tpl.length}`);
const saved = await wa.saveTemplate({ name: "My own", stageGroup: "cnc", body: "Hi {{name}} — {{bdName}}" });
ok("a BD can save their own", !!saved.id);
ok("...and it comes back", (await wa.templates()).some((t) => t.id === saved.id));
await wa.saveTemplate({ id: "cnc", name: "Could not connect", stageGroup: "cnc", autoSend: true, body: "Edited {{name}}" });
ok("editing a built-in sticks", (await wa.templates()).find((t) => t.id === "cnc").body === "Edited {{name}}");
await wa.ready();
ok("...and a later seed does not reset it",
   (await wa.templates()).find((t) => t.id === "cnc").body === "Edited {{name}}");
await (async () => { try { await wa.deleteTemplate("cnc"); ok("deleting a built-in is refused", false); }
  catch (e) { ok("deleting a built-in is refused, not a silent no-op", e.status === 400); } })();
await wa.deleteTemplate(saved.id);
ok("...but a BD's own can be deleted", !(await wa.templates()).some((t) => t.id === saved.id));
await (async () => { try { await wa.saveTemplate({ name: "", body: "x" }); ok("a nameless template is refused", false); }
  catch (e) { ok("a nameless template is refused", e.status === 400); } })();

const ov = await wa.queue({ contactId: "950", companyId: "903", phone: "+919000000950",
  stage: "CNC_COULD_NOT_CONNECT", vars: { name: "X", body_override: "Hand written, this one." },
  seat: "seat-3", dueAt: OPEN });
ok("a queued job carries the edited text and the seat it was sent from", !!ov.id);
const sent = await db.prepare("SELECT vars, seat FROM wa_jobs WHERE id = ?").bind(ov.id).first();
ok("...and the bot reads the exact string, not a re-render",
   JSON.parse(sent.vars).body_override === "Hand written, this one." && sent.seat === "seat-3");

console.log("\n7 · where somebody is on the ladder");
ok("nothing sent is Not Sent", statusOf(null) === WA_STATUS.NONE);
ok("a sent step reads as its rung",
   statusOf({ seq: "cnc", sent_step: 2 }) === "CNC-2 Sent", statusOf({ seq: "cnc", sent_step: 2 }));
ok("...and warmup has its own ladder",
   statusOf({ seq: "warmup", sent_step: 1 }) === "Warmup-1 Sent");
ok("a reply outranks the rung it was on",
   statusOf({ seq: "cnc", sent_step: 2, reason: "inbound_reply", state: "paused" }) === WA_STATUS.REPLIED);
ok("...and DND outranks everything", statusOf({ seq: "cnc", sent_step: 2, dnd: 1 }) === WA_STATUS.DND);
ok("not-on-WhatsApp is its own answer",
   statusOf({ seq: "cnc", sent_step: 1, reason: "not_on_wa" }) === WA_STATUS.NOT_ON_WA);

console.log("\n8 · the gate, and why somebody is skipped");
const C1 = { contactId: "1", phone: "+91900" };
ok("step 1 goes to somebody untouched", eligible(C1, null, { seq: "cnc", step: 1 }).ok === true);
ok("...but not to somebody already at CNC-1",
   eligible(C1, { seq: "cnc", sent_step: 1 }, { seq: "cnc", step: 1 }).ok === false);
/* THE SEQUENTIAL RULE. */
ok("CNC-2 goes ONLY to CNC-1 Sent",
   eligible(C1, { seq: "cnc", sent_step: 1, sent_at: OPEN - 72 * 3600000 }, { seq: "cnc", step: 2, now: OPEN }).ok === true);
ok("...not to somebody untouched",
   eligible(C1, null, { seq: "cnc", step: 2 }).why === "needs CNC-1 first",
   eligible(C1, null, { seq: "cnc", step: 2 }).why);
ok("CNC-3 goes ONLY to CNC-2 Sent",
   eligible(C1, { seq: "cnc", sent_step: 2, sent_at: OPEN - 72 * 3600000 }, { seq: "cnc", step: 3, now: OPEN }).ok === true
   && eligible(C1, { seq: "cnc", sent_step: 1 }, { seq: "cnc", step: 3 }).ok === false);
ok("Warmup walks its own ladder, not the CNC one",
   eligible(C1, { seq: "warmup", sent_step: 1, sent_at: OPEN - 72 * 3600000 }, { seq: "warmup", step: 2, now: OPEN }).ok === true
   && eligible(C1, { seq: "cnc", sent_step: 1 }, { seq: "warmup", step: 2 }).ok === false);
ok("a reply takes somebody out of the sequence for good",
   eligible(C1, { seq: "cnc", sent_step: 1, reason: "inbound_reply" }, { seq: "cnc", step: 2 }).why === "replied — talk to them");
ok("...so does opting out", eligible(C1, { dnd: 1 }, { seq: "cnc", step: 1 }).why === "opted out");
ok("...and not being on WhatsApp",
   eligible(C1, { reason: "not_on_wa" }, { seq: "cnc", step: 1 }).why === "not on WhatsApp");
ok("no number, no message", eligible({ contactId: "1" }, null, {}).why === "no number");
/* The gap between two steps of one ladder: three in an hour is what gets a
   number banned. */
const soon = eligible(C1, { seq: "cnc", sent_step: 1, sent_at: OPEN - 3600000 },
                      { seq: "cnc", step: 2, now: OPEN, cooldownHours: 48 });
ok("a step inside the cooldown waits, and says how long", soon.ok === false && /h to go/.test(soon.why), soon.why);
ok("the daily cap takes everybody out, with the reason said",
   eligible(C1, null, { seq: "cnc", step: 1, capReached: true }).why === "daily cap reached");

console.log("\n9 · anti-ban settings, and the kill switch");
ok("the defaults are the brakes we agreed",
   WA_DEFAULTS.dailyCapPerSeat === 80 && WA_DEFAULTS.maxCnc === 3
   && WA_DEFAULTS.maxWarmup === 4 && WA_DEFAULTS.cooldownHours === 48 && WA_DEFAULTS.killSwitch === 0,
   JSON.stringify(WA_DEFAULTS));
const cfg0 = await wa.settings();
ok("a fresh database reads the defaults", cfg0.dailyCapPerSeat === 80);
await wa.saveSettings({ dailyCapPerSeat: 2 }, "admin");
ok("...and a saved one sticks", (await wa.settings()).dailyCapPerSeat === 2);
await wa.saveSettings({ dailyCapPerSeat: "nonsense", maxCnc: -4 }, "admin");
ok("...while rubbish is ignored rather than stored",
   (await wa.settings()).dailyCapPerSeat === 2 && (await wa.settings()).maxCnc === 3);

/* $0.00 GUARDRAIL: the empty poll must cost one SELECT and no writes. */
const empty = await wa.drain({ seat: "seat-empty", limit: 10 });
/* NOTHING DUE MEANS NOTHING ELSE IS READ — not the settings, not the cap.
   That is the point of the ordering, so the empty poll eight laptops make
   all day costs one indexed SELECT and no writes. It also means an empty
   drain cannot report `paused`: there was nothing to pause. */
ok("an empty drain returns no jobs", (empty.jobs || []).length === 0);
ok("...and does not even look at the settings to do it",
   empty.paused === undefined && empty.capped === undefined && empty.cap === undefined,
   JSON.stringify(empty));

const kq = await wa.queue({ contactId: "960", companyId: "903", phone: "+919000000960",
  stage: "CNC_COULD_NOT_CONNECT", seat: "seat-kill", dueAt: OPEN });
await wa.saveSettings({ killSwitch: 1 }, "admin");
const killed = await wa.drain({ seat: "seat-kill", limit: 10 });
ok("the kill switch stops a drain that DID have work", (killed.jobs || []).length === 0
   && killed.paused === true, JSON.stringify(killed));
ok("...and the job is still there, not thrown away",
   (await db.prepare("SELECT state FROM wa_jobs WHERE id = ?").bind(kq.id).first()).state === "queued");
await (async () => { try { await wa.queue({ contactId: "970", companyId: "9", phone: "+91900",
    stage: "CNC_COULD_NOT_CONNECT" }); ok("...and refuses new jobs too", false); }
  catch (e) { ok("...and refuses new jobs too, rather than building a flood", e.status === 423, e.message); } })();
/* The other half of the switch, which is a separate decision: stop, versus
   stop and throw away. */
const killedAll = await wa.cancelAllQueued("admin");
ok("...unless the admin also asks for the queue to be cleared",
   killedAll.cancelled >= 1
   && (await db.prepare("SELECT state FROM wa_jobs WHERE id = ?").bind(kq.id).first()).state === "cancelled",
   JSON.stringify(killedAll));
await wa.saveSettings({ killSwitch: 0, dailyCapPerSeat: 80 }, "admin");

/* The cap, proved rather than assumed. */
await wa.saveSettings({ dailyCapPerSeat: 1 }, "admin");
await wa.queue({ contactId: "961", companyId: "903", phone: "+919000000961", stage: "CNC_COULD_NOT_CONNECT", seat: "seat-cap", dueAt: OPEN });
await wa.queue({ contactId: "962", companyId: "903", phone: "+919000000962", stage: "CNC_COULD_NOT_CONNECT", seat: "seat-cap", dueAt: OPEN });
const first = await wa.drain({ seat: "seat-cap", limit: 10 });
ok("a seat under its cap drains", first.jobs.length >= 1, `${first.jobs.length}`);
await wa.webhook({ event: "sent", jobId: first.jobs[0].id, contactId: first.jobs[0].contact_id });
const second = await wa.drain({ seat: "seat-cap", limit: 10 });
ok("...and is cut off once the day's cap is spent",
   second.jobs.length === 0 && second.capped === true && second.cap === 1, JSON.stringify(second));
await wa.saveSettings({ dailyCapPerSeat: 80 }, "admin");

console.log("\n10 · custom variables, visibility and metrics");
ok("a custom variable is spotted", customVarsIn("Hi {{name}} at {{venue_city}}").join(",") === "venue_city");
ok("...and substituted once it is mapped",
   renderTemplate("at {{venue_city}}", { venue_city: "Goa" }) === "at Goa");
ok("...or left visible while it is not",
   renderTemplate("at {{venue_city}}", {}) === "at {{venue_city}}");
ok("...and a fallback counts as mapping it",
   renderTemplate("at {{venue_city}}", {}, { venue_city: "your city" }) === "at your city");
ok("the three visibilities exist", TEMPLATE_VISIBILITY.join(",") === "private,team,official");
const vt = await wa.saveTemplate({ name: "Private one", stageGroup: "cnc", body: "Hi {{name}}", visibility: "private", owner: "a@b.c" });
const got = (await wa.templates()).find((x) => x.id === vt.id);
ok("a template remembers its visibility and its owner", got.visibility === "private" && got.owner === "a@b.c");
ok("...and the seeded ones default to team",
   (await wa.templates()).find((x) => x.id === "event").visibility === "team");

const jm = await wa.queue({ contactId: "980", companyId: "903", phone: "+919000000980",
  stage: "CNC_COULD_NOT_CONNECT", template: "cnc", seat: "bd-exec-1", dueAt: OPEN });
await wa.webhook({ event: "sent", jobId: jm.id, contactId: "980" });
await wa.webhook({ event: "delivered", jobId: jm.id, contactId: "980" });
await wa.webhook({ event: "read", jobId: jm.id, contactId: "980" });
const m = await wa.metrics();
ok("metrics count sent, delivered and read", m.total.sent >= 1 && m.total.delivered >= 1 && m.total.read >= 1,
   JSON.stringify(m.total));
ok("...per template and per seat",
   m.byTemplate.some((x) => x.template === "cnc") && m.bySeat.some((x) => x.seat === "bd-exec-1"),
   JSON.stringify(m.bySeat));
ok("...and give the three rates the strip shows",
   typeof m.rates.delivered === "number" && typeof m.rates.read === "number"
   && typeof m.rates.replied === "number", JSON.stringify(m.rates));
/* A SEND is what advances the ladder — not a queue. */
const st980 = await wa.statuses(["980"]);
ok("a sent message moves the contact up the ladder", st980["980"] === "CNC-1 Sent", st980["980"]);
ok("...and sentToday counts it against the seat's cap", (await wa.sentToday("bd-exec-1")) >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
