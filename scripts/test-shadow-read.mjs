/* GATE 3: the harness, and the rules that decide what counts as a difference.
 *
 * Most of this file is about what must NOT be reported. A comparison that
 * fires on list order, on 120 versus 120.0, or on "" versus null would report
 * drift on every row of a perfectly correct copy — and then be switched off,
 * which is worse than never having built it.
 *
 * Run: node scripts/test-shadow-read.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { fakeD1 } from "./d1-fake.mjs";
import { sameValue, diff, diffLists } from "./compare.mjs";
import { createShadowReads } from "./shadow-read.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { readCompaniesSql } from "./sql-read.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) => ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("1. what is NOT a difference");
ok("120 and 120.0", sameValue(120, 120.0));
ok("'5' and 5", sameValue("5", 5));
ok("'' and null", sameValue("", null));
ok("null and 0", sameValue(null, 0));
ok("'' and 0", sameValue("", 0));
ok("[] and null", sameValue([], null));
ok("names in another order", sameValue(["Hema", "Shipra"], ["Shipra", "Hema"]));
ok("the same instant, written two ways",
  sameValue("2026-09-28T11:20:34.648Z", "2026-09-28T11:20:34+00:00"));
ok("a nested object that agrees",
  sameValue({ rank: 14, names: ["a", "b"] }, { rank: 14.0, names: ["b", "a"] }));

console.log("\n2. what IS a difference");
ok("a different number", !sameValue(14, 19));
ok("a different name", !sameValue("Hema", "Shipra"));
ok("a name missing from one list", !sameValue(["Hema", "Shipra"], ["Hema"]));
ok("a different name in the same-length list", !sameValue(["Hema"], ["Raj"]));
ok("a value on one side only", !sameValue("Hema", null));
ok("instants a minute apart",
  !sameValue("2026-09-28T11:20:34Z", "2026-09-28T11:21:34Z"));

console.log("\n3. the field-level report");
const d = diff({ id: "1", kpi: { rank: 14, sql: 0 } }, { id: "1", kpi: { rank: 19, sql: 0 } });
is("one field named", d.length, 1);
is("with its path", d[0].field, "kpi.rank");
is("and both values", `${d[0].airtable}/${d[0].sql}`, "14/19");

console.log("\n4. two lists, matched by key not position");
const A = [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }];
const B = [{ id: "c", n: 3 }, { id: "a", n: 1 }, { id: "b", n: 2 }];
ok("the same rows in another order agree", diffLists(A, B).clean);
const r1 = diffLists(A, [{ id: "a", n: 1 }, { id: "b", n: 99 }]);
is("a row only Airtable has", r1.onlyAirtable, 1);
is("...named", r1.sampleOnlyAirtable[0], "c");
is("a row that disagrees", r1.differing, 1);
is("...and which field", Object.keys(r1.fieldCounts)[0], "n");
const r2 = diffLists([{ id: "a" }], [{ id: "a" }, { id: "z" }]);
is("a row only SQL has", r2.onlySql, 1);
ok("...which is not clean", !r2.clean);

console.log("\n5. the harness records what happened");
const db = fakeD1();
const sr = createShadowReads({ db, log: () => {} });
ok("it exists with a database", !!sr);
is("and not without one", createShadowReads({ db: null }), null);

await sr.record("/companies", { airtable: A, sql: B, airtableMs: 400, sqlMs: 8, keyOf: (x) => x.id });
let st = await sr.status();
is("one route recorded", st.length, 1);
is("one run", st[0].runs, 1);
is("which agreed", st[0].agreed, 1);
is("both timings kept", `${st[0].airtableAvgMs}/${st[0].sqlAvgMs}`, "400/8");
is("and the ratio computed", st[0].speedup, 50);
ok("both payload sizes measured", st[0].airtableBytes > 0 && st[0].sqlBytes > 0);

await sr.record("/companies", { airtable: A, sql: [{ id: "a", n: 1 }], airtableMs: 300, sqlMs: 12, keyOf: (x) => x.id });
st = await sr.status();
is("two runs now", st[0].runs, 2);
is("one of them disagreed", st[0].disagreed, 1);
is("averages are over both", st[0].airtableAvgMs, 350);
ok("an example is kept", !!st[0].lastExample, JSON.stringify(st[0].lastExample));
is("naming the missing rows", st[0].lastExample.onlyAirtable.length, 2);

console.log("\n6. field counts accumulate across runs");
await sr.reset();
for (let i = 0; i < 3; i++)
  await sr.record("/x", { airtable: [{ id: "a", n: 1, m: 2 }], sql: [{ id: "a", n: 9, m: 2 }],
                          airtableMs: 1, sqlMs: 1, keyOf: (x) => x.id });
st = await sr.status();
is("the same field three times", (await sr.status())[0].fieldCounts.n, 3);
ok("and not the field that agreed", !("m" in st[0].fieldCounts));

console.log("\n7. the harness cannot break a request");
const brokenDb = { prepare: () => { throw new Error("D1 is down"); } };
const broken = createShadowReads({ db: brokenDb, log: () => {} });
let threw = false;
try { await broken.record("/companies", { airtable: A, sql: B, airtableMs: 1, sqlMs: 1, keyOf: (x) => x.id }); }
catch { threw = true; }
ok("a database that throws is swallowed", !threw);

console.log("\n8. the SQL reader answers in the Airtable shape");
const sq = new DatabaseSync(":memory:");
sq.exec(sqlSchema()); sq.exec(sqlDerived());
sq.exec(`INSERT INTO companies (airtable_id,kylas_company_id,name,owner,kylas_owner_id,kylas_stage,source_of_data)
         VALUES ('recA','900','Acme','Enout Super Admin','74725','MQL_MARKETING_QUALIFIED_LEAD','Apollo')`);
sq.exec(`INSERT INTO contacts (airtable_id,kylas_contact_id,name,company_id,kpi_rank,kpi_rank_at,ever_picked)
         VALUES ('recB','700','Hema',1,19,'2026-09-20T10:00:00.000Z',1)`);
sq.exec(`INSERT INTO event_rows (row_key,contact_id,budget,timeline,pax) VALUES ('e1',1,'9L','Q4','80')`);
sq.exec(`INSERT INTO call_log (key,contact_id,called_at,duration,duration_source)
         VALUES ('c1',1,'2026-09-20T09:00:00.000Z',120,'dialed')`);
const [co] = await readCompaniesSql(sq);
is("keyed by the Kylas id", co.id, "900");
is("carrying the record id too", co.recordId, "recA");
is("the company's own stage, not the KPI one", co.stage, "MQL_MARKETING_QUALIFIED_LEAD");
is("owner id as a string", co.ownerId, "74725");
is("a KPI block", typeof co.kpi, "object");
is("with the contact's rank", co.kpi.rank, 19);
is("the funnel flags as 0/1", `${co.kpi.right}${co.kpi.discovery}${co.kpi.sql}`, "110");
is("names split back into a list", co.kpi.rightNames.join("|"), "Hema");
is("last call trimmed to a date", co.kpi.lastCalledAt, "2026-09-20");
is("talk seconds summed", co.kpi.talkSeconds, 120);

/* A company with no Kylas id is skipped by readCompanyKpis, so it must have
   no KPI block here either — otherwise the two sides differ on a row that
   nothing can use anyway, and the report fills with noise. */
sq.exec(`INSERT INTO companies (airtable_id,name) VALUES ('recZ','Hand-made row')`);
const all = await readCompaniesSql(sq);
const orphan = all.find((c) => c.recordId === "recZ");
is("a company with no Kylas id has no KPI block", orphan.kpi, null);
sq.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
