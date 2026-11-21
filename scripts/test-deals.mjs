#!/usr/bin/env node
/* DEALS, THE TWO CLOCKS, AND THE RADAR.
 *
 *   node scripts/test-deals.mjs
 *
 * The shapes that go to Kylas are asserted as plain objects, because they are
 * pure functions for exactly that reason — a deal body can be wrong in a way
 * that only a live tenant would tell you, and this is the next best thing.
 * The clocks and the radar are then tested against the real SQLite.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { createDeals, buildDeal, dealName, dealCustomFields, handoverNote, pushDue,
         completeItem, consolidate, radar, chipOf, parseBudget, PLAYBOOKS, DEAL_DEFAULTS, COURTS } from "./deals.mjs";

let pass = 0, fail = 0;
const ok = (w, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c || !d ? "" : `  — ${d}`}`); };
const T0 = Date.parse("2026-11-21T06:00:00Z");
const HOUR = 3600000;

const C = { kid: 72001, pocName: "Sana Kausar", designation: "Senior Manager – HR",
  companyId: 903, company: "pinelabs", ownerId: 74725, owner: "Gurnoor Kaur",
  phones: [{ cc: "+91", value: "8956397765" }], emails: [{ value: "sana@pinelabs.com" }],
  modeOfMeeting: "Virtual", vendorInfo: "Uses Thomas Cook", serviceOffering: true,
  remarks: "Finance review on the 20th",
  current: [{ eventType: "Employee offsites", pax: "120", timeline: "March", budget: "approx 8L, not signed off" }],
  past: [{ eventType: "Product launch", pax: "60", timeline: "last Sept", budget: "3L" }] };
const CO = { id: 903, name: "pinelabs" };
const EV = C.current[0];

console.log("\n1 · the deal body, against the live tenant values");
const b = buildDeal(C, CO, EV);
ok("the Demand Funnel pipeline", b.pipeline.id === 32572, JSON.stringify(b.pipeline));
ok("...opening at Discovery Call Scheduled", b.pipelineStage.id === 227155);
ok("...in INR", b.currencyId === 431);
ok("...with the source set", b.source.id === 183847);
ok("named {Company} || {Event} || {Pax} Pax",
   b.name === "pinelabs || Employee offsites || 120 Pax", b.name);
ok("...and a missing event type does not leave empty bars",
   dealName("pinelabs", {}) === "pinelabs", dealName("pinelabs", {}));
ok("the company and the contact are linked", b.company.id === 903 && b.contacts[0].id === 72001);
ok("the owner rides along", b.ownerId === 74725);

console.log("\n2 · custom fields, by their live names");
const cf = dealCustomFields(C, EV);
ok("pax", cf.cfPaxNumberOfParticipants === "120");
ok("execution date carries the TIMELINE AS TYPED, free text and all",
   cf.cfExecutionDate === "March", cf.cfExecutionDate);
ok("remarks are joined, not dropped", /Finance review/.test(cf.cfRemarks), cf.cfRemarks);
ok("a field with nothing to say is not sent at all",
   dealCustomFields({}, {}).cfLocation === undefined && Object.keys(dealCustomFields({}, {})).length === 0);
/* Budget is free text by design — "approx 8L, not signed off". Putting a
   number in Sales' forecast that nobody actually said is worse than no
   number at all. */
ok("no estimatedValue is invented from a free-text budget", b.estimatedValue === undefined);

console.log("\n2b · a rupee figure out of free text, for the radar only");
ok('"approx 8L, not signed off" is 8 lakh', parseBudget("approx 8L, not signed off") === 800000);
ok('"1.4 Cr" is 1.4 crore', parseBudget("1.4 Cr") === 14000000);
ok('"₹3,50,000" survives the commas', parseBudget("₹3,50,000") === 350000);
ok('"50k" is fifty thousand', parseBudget("50k") === 50000);
ok('a bare small number is NOT rupees — it is pax in the wrong field',
   parseBudget("120") === 0, String(parseBudget("120")));
ok('nothing parseable is 0, not a guess', parseBudget("no idea yet") === 0 && parseBudget("") === 0);
/* And it still never reaches Kylas. */
ok('...and it is still absent from the deal body', buildDeal(C, CO, EV).estimatedValue === undefined);

console.log("\n3 · the handover note");
const n = handoverNote(C, CO, EV, { salesPoc: "Rohit", slot: "Tue 3pm", research: "Series C, 1200 staff" });
for (const must of ["Sana Kausar", "Employee offsites", "approx 8L, not signed off", "Virtual",
                    "Uses Thomas Cook", "Rohit", "Tue 3pm", "Series C", "Finance review"])
  ok(`...carries ${must}`, n.includes(must));
ok("...and the OTHER event row, which is not this deal", n.includes("Product launch"));
ok("...without repeating the deal's own row in that list",
   (n.match(/Employee offsites/g) || []).length === 2, `${(n.match(/Employee offsites/g) || []).length}`);

console.log("\n4 · pushing a date costs a slip and needs a reason");
const item = { id: "i1", baseline_due_at: T0 + 24 * HOUR, current_due_at: T0 + 24 * HOUR, slip_count: 0 };
ok("a push with no reason chip is refused", pushDue(item, { to: T0 + 48 * HOUR }).ok === false);
ok("...and so is one with no date", pushDue(item, { chip: "dmm_pending" }).ok === false);
const p1 = pushDue(item, { to: T0 + 48 * HOUR, chip: "dmm_pending", at: T0, by: "Gurnoor" });
ok("a push with a reason moves the CURRENT date", p1.patch.current_due_at === T0 + 48 * HOUR);
ok("...leaves the baseline alone — that is the promise we made",
   item.baseline_due_at === T0 + 24 * HOUR);
ok("...counts the slip", p1.patch.slip_count === 1);
ok("...moves the ball to the Planning Team", p1.patch.court === "planning_team");
/* THE POINT OF THE WHOLE MECHANISM. */
ok("...and does NOT count against the BD", p1.penalisesBd === false);
ok("a BD's own chip does count against them",
   pushDue(item, { to: T0 + 48 * HOUR, chip: "bd_followup" }).penalisesBd === true);
ok("POC didn't pick triggers a WhatsApp nudge",
   pushDue(item, { to: T0 + 48 * HOUR, chip: "poc_no_pick" }).waNudge === true);
ok("...and is the chip that counts no-picks, for the second-POC prompt",
   chipOf("poc_no_pick").noPick === true);
ok("the slip history keeps who, when, and why",
   JSON.parse(p1.patch.slip_history)[0].chip === "dmm_pending"
   && JSON.parse(p1.patch.slip_history)[0].by === "Gurnoor");

console.log("\n5 · TAT is measured against the BASELINE");
const late = completeItem({ baseline_due_at: T0, current_due_at: T0 + 48 * HOUR }, { at: T0 + 12 * HOUR });
ok("done after the baseline is late, even though the pushed date was met",
   late.onTime === false && late.againstCurrent === true, JSON.stringify(late));
ok("...and says by how much", late.tatHours === 12, `${late.tatHours}`);
ok("done before the baseline is on time",
   completeItem({ baseline_due_at: T0 + HOUR }, { at: T0 }).onTime === true);

console.log("\n6 · one consolidated timeline per deal");
const its = [
  { state: "done", baseline_due_at: T0, current_due_at: T0, court: "bd" },
  { state: "open", baseline_due_at: T0 + 4 * HOUR, current_due_at: T0 + 30 * HOUR, slip_count: 2, court: "client_poc" },
  { state: "open", baseline_due_at: T0 + 48 * HOUR, current_due_at: T0 + 48 * HOUR, slip_count: 0, court: "bd" },
];
const t = consolidate(its);
ok("it counts what is open and what is done", t.open === 2 && t.done === 1);
ok("...sums the slips", t.slipCount === 2);
ok("...and the deal's court is the OLDEST open item's, not the newest",
   t.court === "client_poc", t.court);
ok("...and it knows it has slipped", t.slipped === true);
ok("a deal with nothing open has no due date", consolidate([{ state: "done" }]).currentDueAt === null);

console.log("\n7 · the radar counts deals AND rupees by court");
const deals = [{ id: "d1", value: 800000, court: "bd" }, { id: "d2", value: 600000, court: "bd" },
                { id: "d3", value: 250000, court: "bd" }, { id: "d4", value: 100000, sql: 1 }];
const byDeal = new Map([
  ["d1", [{ state: "open", baseline_due_at: T0 - HOUR, current_due_at: T0 - HOUR, court: "planning_team" }]],
  ["d2", [{ state: "open", baseline_due_at: T0 + HOUR, current_due_at: T0 + HOUR, court: "client_poc" }]],
  ["d3", [{ state: "open", baseline_due_at: T0 + HOUR, current_due_at: T0 + HOUR, court: "sales_poc" }]],
]);
const r = radar(deals, byDeal, { at: T0 });
ok("a deal already at SQL is out of the window", r.total === 3, `${r.total}`);
ok("...the rupees are summed", r.value === 1650000, `${r.value}`);
const court = (k) => r.all.find((x) => x.court === k);
ok("Planning Team is carrying one", court("planning_team").deals === 1);
ok("...and it is overdue", court("planning_team").overdue === 1);
ok("Client POC one, Sales POC one", court("client_poc").deals === 1 && court("sales_poc").deals === 1);
ok("...and the BD is carrying none of them", court("bd").deals === 0, `${court("bd").deals}`);
ok("every court is named for the strip", COURTS.every((c) => r.all.some((x) => x.court === c)));

console.log("\n8 · the store, and the playbooks");
const db = fakeD1();
let clock = T0;
const D = createDeals({ db, now: () => clock });
const made = await D.create({ kylasDealId: "55", companyId: "903", contactId: "72001",
  name: "pinelabs || Employee offsites || 120 Pax", owner: "Gurnoor Kaur", value: 800000,
  playbooks: ["pre_call", "post_call"] });
const seeded = await D.items(made.id);
ok("the playbooks seed their action items",
   seeded.length === PLAYBOOKS.pre_call.items.length + PLAYBOOKS.post_call.items.length, `${seeded.length}`);
ok("...each with both clocks set to the same thing at birth",
   seeded.every((i) => i.baseline_due_at === i.current_due_at && i.baseline_due_at > T0));
ok("...and a court of its own, not all BD",
   new Set(seeded.map((i) => i.court)).size > 1, [...new Set(seeded.map((i) => i.court))].join(","));

const inputs = seeded.find((i) => i.item_key === "inputs");
clock = T0 + HOUR;
const pushed = await D.push(inputs.id, { to: T0 + 72 * HOUR, chip: "poc_no_pick", by: "Gurnoor" });
ok("pushing moves the court to the client", pushed.patch.court === "client_poc");
const deal = await db.prepare("SELECT court FROM deals WHERE id = ?").bind(made.id).first();
ok("...and the DEAL follows, so the radar sees it", deal.court === "client_poc", deal.court);
await (async () => { try { await D.push(inputs.id, { to: T0 + 99 * HOUR }); ok("a reasonless push is refused by the store", false); }
  catch (e) { ok("a reasonless push is refused by the store", e.status === 400, e.message); } })();

clock = T0 + 100 * HOUR;
const done = await D.complete(inputs.id);
ok("completing records the TAT against the baseline", done.onTime === false && done.tatHours > 0, `${done.tatHours}h`);

/* Before the client's item was done, the deal was theirs. */
ok("...and the court was the client's while their item was open",
   pushed.patch.court === "client_poc");
const listed = await D.list({});
ok("the list carries one consolidated timeline per deal", listed.deals[0].timeline.open > 0);
ok("...and a radar beside it", listed.radar.all.length === COURTS.length);
/* ONCE THE CLIENT'S ITEM IS DONE THE COURT MOVES ON, and it should: the
   thing now holding the deal up is the BD's own research item, which is the
   oldest still open. A court that stuck to whoever was blamed last would
   keep reporting the client after they had answered. */
ok("...and once the client's item is done the court moves to whoever is now blocking",
   listed.radar.all.find((x) => x.court === "bd").deals === 1, JSON.stringify(listed.radar.by));
ok("...which is not the client any more",
   listed.radar.all.find((x) => x.court === "client_poc").deals === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
