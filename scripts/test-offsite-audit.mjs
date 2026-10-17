#!/usr/bin/env node
/* THE OFFSITE AUDIT: THE VERDICTS, THE RATES AND THEIR DENOMINATORS.
 *
 *   node scripts/test-offsite-audit.mjs
 *
 * A rate is only worth reading if its denominator is the one the name promises,
 * so most of this pins the arithmetic on cases small enough to count by hand.
 */
import { auditOffsite, auditLines } from "./offsite-audit.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${d}` : ""}`); };
const is = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const m = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

console.log("\n1 · the five verdicts");
{
  const a = auditOffsite({
    airtable: m({ 1: ["JUL_SEP"], 2: ["JUL_SEP", "OCT_DEC"], 3: ["JAN_MAR"], 4: ["APR_JUN"] }),
    kylas:    m({ 1: ["JUL_SEP"], 2: ["JUL_SEP"],            3: ["OCT_DEC"], 5: ["JAN_MAR"] }),
  });
  is("the counts", a.counts, { agree: 1, partial: 1, conflict: 1, onlyAirtable: 1, onlyKylas: 1 });
  is("1 agrees (same set)", a.counts.agree, 1);
  ok("2 is partial: they share Jul-Sep but not Oct-Dec", a.examples.partial[0]?.id === "2");
  ok("3 is a conflict: nothing in common", a.examples.conflict[0]?.id === "3");
  ok("4 is only in Airtable: the company field is empty", a.examples.onlyAirtable[0]?.id === "4");
  is("5 is only in Kylas, so is not an Airtable gap", a.counts.onlyKylas, 1);
}

console.log("\n2 · the rates, each over its own denominator");
{
  /* Airtable has a quarter for 4 companies (1,2,3,4); both have one for 3 (1,2,3). */
  const a = auditOffsite({
    airtable: m({ 1: ["JUL_SEP"], 2: ["JUL_SEP", "OCT_DEC"], 3: ["JAN_MAR"], 4: ["APR_JUN"] }),
    kylas:    m({ 1: ["JUL_SEP"], 2: ["JUL_SEP"],            3: ["OCT_DEC"], 5: ["JAN_MAR"] }),
  });
  is("companies Airtable has a quarter for", a.companies.airtableHas, 4);
  is("companies both have one for", a.companies.both, 3);
  is("mapped = agree / Airtable has = 1 of 4", a.rates.mapped, 25);
  is("error = (partial + conflict) / both = 2 of 3", a.rates.error, 66.7);
  is("notWritten = onlyAirtable / Airtable has = 1 of 4", a.rates.notWritten, 25);
}

console.log("\n3 · no denominator is not a good result");
{
  const none = auditOffsite({ airtable: m({ 1: ["JUL_SEP"] }), kylas: new Map() });
  is("when no company has both, the error rate is null, not 0%", none.rates.error, null);
  is("...and everything Airtable has is unwritten", none.rates.notWritten, 100);
  const empty = auditOffsite({});
  is("an empty world has null rates, not zeros", [empty.rates.mapped, empty.rates.error, empty.rates.notWritten], [null, null, null]);
  is("...and no companies", empty.companies, { total: 0, airtableHas: 0, kylasHas: 0, both: 0 });
}

console.log("\n4 · the quarters are compared as a set, in any order");
{
  const a = auditOffsite({ airtable: m({ 1: ["OCT_DEC", "JUL_SEP"] }), kylas: m({ 1: ["JUL_SEP", "OCT_DEC"] }) });
  is("the same two quarters in another order agree", a.counts.agree, 1);
  const junk = auditOffsite({ airtable: m({ 1: ["NOT_A_QUARTER"] }), kylas: m({ 1: ["JUL_SEP"] }) });
  is("a value that is not a quarter is not one, so the company is Kylas-only", [junk.counts.onlyKylas, junk.counts.conflict], [1, 0]);
}

console.log("\n5 · the Company List copy, counted on its own");
{
  const a = auditOffsite({ airtable: m({}), kylas: m({ 1: ["JUL_SEP"], 2: ["JAN_MAR"], 3: ["APR_JUN"] }),
                           list: m({ 1: ["JUL_SEP"], 2: ["OCT_DEC"] }) });
  is("two have both; one of them differs", [a.companyList.both, a.companyList.same, a.companyList.stale], [2, 1, 50]);
}

console.log("\n6 · names and examples");
{
  const a = auditOffsite({ airtable: m({ 7: ["JUL_SEP"] }), kylas: m({ 7: ["JAN_MAR"] }) }, { names: new Map([["7", "Acme Events"]]) });
  is("a company is named, not just numbered", a.examples.conflict[0].name, "Acme Events");
  ok("one with no name falls back to its id", auditOffsite({ airtable: m({ 9: ["JUL_SEP"] }) }).examples.onlyAirtable[0].name === "Company 9");
  const many = auditOffsite({ airtable: m(Object.fromEntries([...Array(30)].map((_, i) => [i + 1, ["JUL_SEP"]]))) }, { examples: 5 });
  is("examples are capped", many.examples.onlyAirtable.length, 5);
}

console.log("\n7 · the words for the mail");
{
  const a = auditOffsite({ airtable: m({ 1: ["JUL_SEP"], 2: ["JAN_MAR"] }), kylas: m({ 1: ["JUL_SEP"] }) });
  const t = auditLines(a).join("\n");
  ok("it states the mapped share", /2 companies have a quarter.*1 carry the same one.*50%/.test(t), t);
  ok("...the unwritten share and why", /1 have none on the company \(50%\).*nothing writes/.test(t), t);
  ok("...and the error rate over the companies where both speak", /Where both have one \(1\): 0 differ, an error rate of 0%/.test(t), t);
  ok("an empty audit says so", /No company has an offsite quarter/.test(auditLines(auditOffsite({})).join()));
  is("nothing to say about nothing", auditLines(null), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
