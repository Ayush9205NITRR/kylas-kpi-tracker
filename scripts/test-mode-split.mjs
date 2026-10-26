#!/usr/bin/env node
/* Stage × mode of meeting, and who may answer a stalled contact.
 *
 *   node scripts/test-mode-split.mjs
 */
import { stageModeSplit, MODES } from "./mode-split.mjs";
import { mayAnswerRca, sameName } from "./rca-owner.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${String(d).slice(0, 300)}` : ""}`); };
const C = (stage, mode, owner = "Sejal Agrawal") => ({ fields: { "Current Stage": stage, "Mode of Meeting": mode, Owner: owner } });

console.log("\n1 · the split");
const rows = [
  C("DISCOVERY_CALL_BOOKED", "Virtual"), C("DISCOVERY_CALL_BOOKED", "Virtual", "Mayra Singh"), C("DISCOVERY_CALL_BOOKED", "In Person"),
  C("DISCOVERY_CALL_BOOKED", ""), C("DISCOVERY_CALL_BOOKED", ""),
  C("SQL_SALES_QUALIFIED_LEAD", "Calls"), C("SQL_SALES_QUALIFIED_LEAD", { name: "Text" }),
  C("CNC_COULD_NOT_CONNECT", ""), C("CNC_COULD_NOT_CONNECT", ""),       /* no mode anywhere: not listed */
  C("DISCOVERY_CALL_BOOKED", "Hybrid"),                                  /* a mode the base does not offer */
];
const r = stageModeSplit(rows);
ok("the four modes, in the order the base has them", r.modes.join() === "In Person,Virtual,Calls,Text" && MODES.length === 4);
ok("only stages where somebody has a mode are listed", r.rows.length === 2 && !r.rows.some((x) => x.code === "CNC_COULD_NOT_CONNECT"), r.rows.map((x) => x.code).join());
const d = r.rows.find((x) => x.code === "DISCOVERY_CALL_BOOKED");
ok("per stage: each mode counted", d.counts.Virtual === 2 && d.counts["In Person"] === 1 && d.counts.Calls === 0, JSON.stringify(d.counts));
ok("...with a mode / all at the stage, so the gap is visible", d.withMode === 4 && d.all === 6, JSON.stringify([d.withMode, d.all]));
ok("...and a mode the base does not offer is kept apart, not dropped", d.other === 1);
ok("a select that arrives as { name } counts", r.rows.find((x) => x.code === "SQL_SALES_QUALIFIED_LEAD").counts.Text === 1);
ok("furthest stage first", r.rows[0].code === "SQL_SALES_QUALIFIED_LEAD");
ok("a stage code reads as its label", /Discovery|Booked/i.test(d.label), d.label);
ok("totals add up", r.totals.Virtual === 2 && r.totals.withMode === 6 && r.totals.contacts === 10, JSON.stringify(r.totals));
const m = stageModeSplit(rows, { owner: "mayra singh" });
ok("narrowed to one owner (case aside)", m.totals.contacts === 1 && m.rows.length === 1 && m.rows[0].counts.Virtual === 1, JSON.stringify(m.totals));
ok("nothing in, an empty table not a crash", stageModeSplit([]).rows.length === 0 && stageModeSplit().totals.contacts === 0);

console.log("\n2 · who may give a reason");
ok("the owner may", mayAnswerRca({ role: "associate", user: "Sejal Agrawal", owner: "sejal  agrawal" }));
ok("somebody else may not", !mayAnswerRca({ role: "associate", user: "Mayra Singh", owner: "Sejal Agrawal" }));
ok("an unknown user may not", !mayAnswerRca({ role: "associate", user: "", owner: "Sejal Agrawal" }));
ok("a contact with no owner is nobody's to answer, for an associate", !mayAnswerRca({ role: "associate", user: "Sejal Agrawal", owner: "" }));
ok("an admin may (a contact whose owner has left is not stranded)", mayAnswerRca({ role: "admin", user: "Ayush Tiwari", owner: "Tanay Kumar" }));
ok("sameName ignores case and spacing only", sameName(" Sejal Agrawal ", "sejal agrawal") && !sameName("Sejal", "Sejal Agrawal"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
