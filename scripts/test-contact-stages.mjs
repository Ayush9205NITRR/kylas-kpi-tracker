#!/usr/bin/env node
/* THE ACCOUNT STAGE IS THE HIGHEST STAGE AMONG THE ACCOUNT'S CONTACTS.
 *
 *   node scripts/test-contact-stages.mjs
 *
 * Ayush, 2026-10-09: "har account ke contact mein aao aur usme joh higher
 * status hai usko pick karo... Not Interested vale CNC mein dale hue hai."
 *
 * Every expected value here is worked out from docs/stages.json by hand
 * first: CNC-1 is rung 6, CNC-3 rung 8, Not Interested 10, MQL 14,
 * SQL 26.
 */
import { emptyIndex, applyContacts, noteSaved, byCompany, higher } from "./contact-stages.mjs";
import { STAGE_RUNG } from "./stages.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${what}`); return; }
  fail++; console.log(`  FAIL  ${what}\n        got  ${g}\n        want ${w}`);
};

/* The Kylas shape, minimally: a company lookup and the contact picklist. */
const READ = {
  companyOf: (c) => c.company?.id ?? "",
  stageOf: (c) => c.customFieldValues?.cfPipelineStageBd ?? "",
  stampOf: (c) => Date.parse(c.updatedAt || 0) || 0,
};
const K = (id, co, stage, at = "2026-10-01T10:00:00Z") =>
  ({ id, company: { id: co }, customFieldValues: { cfPipelineStageBd: stage }, updatedAt: at });

console.log("the rungs this test leans on");
eq("CNC-3 is below Not Interested", STAGE_RUNG.CNC_COULD_NOT_CONNECT_3 < STAGE_RUNG.NOT_INTERESTED, true);
eq("Not Interested is below MQL", STAGE_RUNG.NOT_INTERESTED < STAGE_RUNG.MQL_MARKETING_QUALIFIED_LEAD, true);

console.log("\nthe highest contact decides");
{
  const ix = emptyIndex();
  applyContacts(ix, [
    /* THE REPORTED CASE: one contact Not Interested, one still at CNC-3.
       Under "highest wins" the account is Not Interested, not CNC. */
    K(1, "A", "NOT_INTERESTED"),
    K(2, "A", "CNC_COULD_NOT_CONNECT_3"),
    /* A live MQL beats a Not Interested colleague. */
    K(3, "B", "NOT_INTERESTED"),
    K(4, "B", "MQL_MARKETING_QUALIFIED_LEAD"),
    /* A single SQL contact puts the account at SQL — rung 26, not 0. */
    K(5, "C", "CNC_COULD_NOT_CONNECT"),
    K(6, "C", "SQL_SALES_QUALIFIED_LEAD"),
    /* A contact nobody has staged still counts as a contact. */
    K(7, "D", ""),
  ], READ);
  const m = byCompany(ix);
  eq("A — Not Interested beats CNC-3", m.get("A"), { stage: "NOT_INTERESTED", rung: 10, n: 2 });
  eq("B — MQL beats Not Interested", m.get("B"), { stage: "MQL_MARKETING_QUALIFIED_LEAD", rung: 14, n: 2 });
  eq("C — SQL is rung 26, not 0", m.get("C"), { stage: "SQL_SALES_QUALIFIED_LEAD", rung: 26, n: 2 });
  eq("D — has a contact, has no stage", m.get("D"), { stage: "", rung: 0, n: 1 });
  eq("an account with no contacts is simply absent", m.get("E"), undefined);
}

console.log("\na delta replaces, it does not add");
{
  const ix = emptyIndex();
  applyContacts(ix, [K(1, "A", "MQL_MARKETING_QUALIFIED_LEAD", "2026-10-01T10:00:00Z")], READ);
  /* The same contact, later, moved DOWN to Not Interested. The account is
     where its contacts are now — the index is not a high-water mark. */
  applyContacts(ix, [K(1, "A", "NOT_INTERESTED", "2026-10-02T10:00:00Z")], READ);
  eq("the account follows the contact down", byCompany(ix).get("A").stage, "NOT_INTERESTED");
  eq("...and it is still one contact, not two", byCompany(ix).get("A").n, 1);
  /* An OLDER copy arriving after a newer one — an overlapping delta — must
     not put the old stage back. */
  applyContacts(ix, [K(1, "A", "MQL_MARKETING_QUALIFIED_LEAD", "2026-10-01T10:00:00Z")], READ);
  eq("an older copy cannot undo a newer one", byCompany(ix).get("A").stage, "NOT_INTERESTED");
  eq("the watermark is the newest stamp seen", ix.watermark, "2026-10-02T10:00:00.000Z");
}
{
  /* A contact moving company leaves the old one. */
  const ix = emptyIndex();
  applyContacts(ix, [K(1, "A", "MQL_MARKETING_QUALIFIED_LEAD", "2026-10-01T10:00:00Z")], READ);
  applyContacts(ix, [K(1, "B", "MQL_MARKETING_QUALIFIED_LEAD", "2026-10-02T10:00:00Z")], READ);
  const m = byCompany(ix);
  eq("a contact that changed company leaves the old one", m.get("A"), undefined);
  eq("...and joins the new", m.get("B").n, 1);
}

console.log("\na console save moves the board at once");
{
  const ix = emptyIndex();
  applyContacts(ix, [K(1, "A", "CNC_COULD_NOT_CONNECT", "2026-10-01T10:00:00Z")], READ);
  noteSaved(ix, { id: "1", companyId: "A", stage: "DISCOVERY_CALL_BOOKED", at: Date.parse("2026-10-03T10:00:00Z") });
  eq("the saved stage is the account's", byCompany(ix).get("A").stage, "DISCOVERY_CALL_BOOKED");
  /* ...and the next delta, carrying Kylas' copy of that same save, agrees. */
  applyContacts(ix, [K(1, "A", "DISCOVERY_CALL_BOOKED", "2026-10-03T10:00:01Z")], READ);
  eq("the delta that follows agrees with it", byCompany(ix).get("A").stage, "DISCOVERY_CALL_BOOKED");
  eq("a save with no company is not noted", noteSaved(ix, { id: "9", companyId: "", stage: "X" }), false);
}

console.log("\nthe KPI base's floor and the index, higher wins");
eq("index higher", higher({ stage: "MQL_MARKETING_QUALIFIED_LEAD", rung: 14 }, { stage: "CNC_COULD_NOT_CONNECT", rung: 6 }),
   { stage: "MQL_MARKETING_QUALIFIED_LEAD", rung: 14 });
/* The 2026-09-29 rule: a POC who reached Discovery and was re-dialled to a
   no-answer has still been to Discovery. KPI Rank carries that floor, the
   index carries where the contact is now, and the floor wins. */
eq("KPI floor higher (Discovery reached, now CNC)",
   higher({ stage: "CNC_COULD_NOT_CONNECT", rung: 6 }, { stage: "DISCOVERY_CALL_BOOKED", rung: 19 }),
   { stage: "DISCOVERY_CALL_BOOKED", rung: 19 });
eq("only one side knows", higher(null, { stage: "ACTIVATION", rung: 13 }), { stage: "ACTIVATION", rung: 13 });
eq("neither side knows", higher(null, null), null);
eq("a stage with no rung given is looked up", higher({ stage: "SQL_SALES_QUALIFIED_LEAD" }, null),
   { stage: "SQL_SALES_QUALIFIED_LEAD", rung: 26 });

console.log("\nat this account's size");
{
  /* 35,850 contacts across 17,925 accounts, in one pass. The memo in
     handlers.mjs walks this once per index change, so it has to be cheap. */
  const ix = emptyIndex();
  const page = [];
  const codes = ["CNC_COULD_NOT_CONNECT", "NOT_INTERESTED", "MQL_MARKETING_QUALIFIED_LEAD"];
  for (let i = 0; i < 35_850; i++) page.push(K(i + 1, `co${i % 17_925}`, codes[i % 3]));
  const t = performance.now();
  applyContacts(ix, page, READ);
  const m = byCompany(ix);
  const ms = performance.now() - t;
  eq("every account is present", m.size, 17_925);
  eq("every contact is held", Object.keys(ix.contacts).length, 35_850);
  eq(`...in well under a second (${ms.toFixed(0)}ms)`, ms < 1000, true);
  const bytes = JSON.stringify(ix).length;
  console.log(`        index is ${(bytes / 1024 / 1024).toFixed(2)} MB as JSON, before gzip`);
  eq("small enough to keep in the shared store", bytes < 4 * 1024 * 1024, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
