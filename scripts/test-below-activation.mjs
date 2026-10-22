#!/usr/bin/env node
/* below-activation.mjs — which accounts the daily mail lists, and what it says changed.
 *
 *   node scripts/test-below-activation.mjs
 */
import { stuckAccounts, changes, snapshotOf, subjectOf, renderText, renderHtml, ACTIVATION_RUNG } from "./below-activation.mjs";
import { sendReport } from "./digest.mjs";
import { accountProgress } from "./progress.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${String(d).slice(0, 300)}` : ""}`); };

const today = "2026-10-22";
const at = (d) => `${d}T06:00:00Z`;
const P = (rung, stage, calls, first, last) => ({ rung, stage, calls, firstCallAt: first && at(first), lastCallAt: last && at(last) });
const byCompany = new Map([
  ["1", P(6, "CNC_COULD_NOT_CONNECT", 3, "2026-10-12", "2026-10-20")],     /* CNC, 10 days */
  ["2", P(13, "ACTIVATION", 5, "2026-10-01", "2026-10-21")],               /* at Activation: out */
  ["3", P(10, "NOT_INTERESTED", 2, "2026-10-05", "2026-10-06")],           /* closed: out */
  ["4", P(12, "OFFSITE_DELAYED", 1, "2026-10-10", "2026-10-10")],          /* a talk was had: out */
  ["5", P(6, "CNC_COULD_NOT_CONNECT", 0, null, null)],                     /* never called: out */
  ["6", P(5, "DISQUALIFIED_WRONG_POC", 1, "2026-10-21", "2026-10-21")],    /* wrong POC, yesterday: in */
  ["7", P(0, "", 2, "2026-10-15", "2026-10-16")],                          /* called, no stage yet: in */
  ["8", P(15, "FOLLOWUP_CNC", 4, "2026-09-01", "2026-10-01")],             /* rung 15: above Activation */
  ["9", P(4, "INVALID_CONTACT", 1, "2026-10-02", "2026-10-02")],           /* closed: out */
]);
const companies = [
  { id: "1", name: "Acme <Labs>", owner: "Sejal Agrawal" }, { id: "2", name: "Beta", owner: "Mayra Singh" },
  { id: "6", name: "Gamma", owner: "Mayra Singh" }, { id: "7", name: "Delta", owner: "Sejal Agrawal" },
];
const labels = { CNC_COULD_NOT_CONNECT: "CNC (Could Not Connect) - 1", DISQUALIFIED_WRONG_POC: "Disqualified - Wrong POC", ACTIVATION: "Activation" };

console.log("\n1 · who is on the list");
const stuck = stuckAccounts({ byCompany, companies, today, labels });
const ids = stuck.map((s) => s.id);
ok("called and under Activation: CNC, Wrong POC, called-with-no-stage", ids.length === 3 && ["1", "6", "7"].every((i) => ids.includes(i)), JSON.stringify(ids));
ok("Activation itself is not below Activation", !ids.includes("2") && ACTIVATION_RUNG === 13);
ok("Not Interested and Invalid Contact are closed, not stuck", !ids.includes("3") && !ids.includes("9"));
ok("Offsite Delayed is left out (a conversation happened)", !ids.includes("4"));
ok("never called is not 'called'", !ids.includes("5"));
ok("longest stuck first", ids[0] === "1", JSON.stringify(stuck.map((s) => [s.id, s.days])));
const a = stuck.find((s) => s.id === "1");
ok("days since the first call, calls, days since the last", a.days === 10 && a.calls === 3 && a.sinceLast === 2, JSON.stringify(a));
ok("the stage is the name people read", a.stageLabel === "CNC (Could Not Connect) - 1");
ok("an account with no stage yet says so", stuck.find((s) => s.id === "7").stageLabel === "no stage yet");
ok("an account Kylas has no name for still appears, by id", stuckAccounts({ byCompany: new Map([["42", P(6, "CNC_COULD_NOT_CONNECT", 1, "2026-10-20", "2026-10-20")]]), companies: [], today })[0].name === "Company 42");

const viaDialler = stuckAccounts({ byCompany: new Map([["50", { rung: 7, stage: "CNC_COULD_NOT_CONNECT_2", calls: 0, dialCalls: 2,
  dialFirstAt: at("2026-10-18"), dialLastAt: at("2026-10-21") }]]), companies: [], today });
ok("a call from the Kylas dialler counts as called", viaDialler.length === 1 && viaDialler[0].calls === 2 && viaDialler[0].days === 4 && viaDialler[0].sinceLast === 1,
   JSON.stringify(viaDialler));

{
  /* The join itself: a dialler call names a Kylas CONTACT id, which reaches its
     company through the Contacts table. */
  const { byCompany: bc } = accountProgress({
    companies: [{ id: "recC", fields: { "Kylas Company ID": "77" } }],
    contacts: [{ id: "recP", fields: { Company: ["recC"], "Current Stage": "CNC_COULD_NOT_CONNECT", "KPI Rank": 6, "Kylas Contact ID": "555" } }],
    dialler: [{ fields: { "Called At": at("2026-10-19"), "Contact Kylas ID": "555" } },
              { fields: { "Called At": at("2026-10-20"), "Contact Kylas ID": "999" } }],
    today });
  const p = bc.get("77");
  ok("progress joins dialler calls to the company by Kylas contact id", p.dialCalls === 1 && p.dialFirstAt === at("2026-10-19") && p.calls === 0,
     JSON.stringify(p));
}

console.log("\n2 · what changed since yesterday");
const first = changes(null, stuck, byCompany);
ok("the first day says it is the first day", first.first === true);
const prev = snapshotOf(stuck);
prev["2"] = { rung: 6, stage: "CNC_COULD_NOT_CONNECT", name: "Beta", owner: "Mayra Singh" };      /* climbed since */
prev["3"] = { rung: 6, stage: "CNC_COULD_NOT_CONNECT", name: "Old", owner: "Sejal Agrawal" };      /* closed since */
delete prev["6"];                                                                                    /* new today */
prev["1"].rung = 1; prev["1"].stage = "YET_TO_BE_MINED";                                            /* moved, still below */
const ch = changes(prev, stuck, byCompany);
ok("climbed to Activation", ch.climbed.length === 1 && ch.climbed[0].id === "2" && ch.climbed[0].stage === "ACTIVATION", JSON.stringify(ch.climbed));
ok("closed since", ch.closed.length === 1 && ch.closed[0].id === "3");
ok("newly here", ch.added.length === 1 && ch.added[0].id === "6");
ok("moved but still below", ch.moved.length === 1 && ch.moved[0].id === "1" && ch.moved[0].wasStage === "YET_TO_BE_MINED");

console.log("\n3 · the mail");
const subj = subjectOf(today, stuck, ch);
ok("the subject carries the count and the change", /3 accounts/.test(subj) && /\+1 new, 1 climbed/.test(subj), subj);
const text = renderText(today, stuck, ch, { labels });
ok("text: per owner, longest first", /Sejal Agrawal — 2, longest first/.test(text) && /Mayra Singh — 1/.test(text), text);
ok("text: what climbed, from what to what", /↑ Beta \(Mayra Singh\): CNC \(Could Not Connect\) - 1 → Activation/.test(text), text);
const html = renderHtml(today, stuck, ch, { labels });
ok("html escapes names", /Acme &lt;Labs&gt;/.test(html) && !/<Labs>/.test(html));
const many = Array.from({ length: 30 }, (_, i) => ({ ...stuck[0], id: String(100 + i), owner: "Sejal Agrawal" }));
ok("a long list is cut per owner and says how many more", /…and 5 more/.test(renderText(today, many, first, { perOwner: 25 })));

console.log("\n4 · sending");
const logs = [];
const r = await sendReport({ MAIL_TO: "ayush@enout.in" }, { subject: subj, text, html, label: "below-activation mail" }, { log: (m) => logs.push(m) });
ok("nothing configured: not sent, and the body is logged instead", r.sent === false && r.why === "not configured" && logs.some((l) => /below-activation mail \(not sent/.test(l)));
const posted = [];
const r2 = await sendReport({ MAIL_URL: "https://mail.example/send", MAIL_FROM: "automations@enout.in", MAIL_TO: "a@enout.in" },
  { subject: subj, text, html, to: "lakshaya.sharma@enout.in,ayush@enout.in" },
  { fetchImpl: async (u, o) => { posted.push(JSON.parse(o.body)); return new Response("{}", { status: 200 }); } });
ok("`to` overrides MAIL_TO for this one report", r2.sent && JSON.stringify(posted[0].to) === JSON.stringify(["lakshaya.sharma@enout.in", "ayush@enout.in"]), JSON.stringify(posted[0]?.to));
ok("...from automations@enout.in", posted[0].from === "automations@enout.in");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
