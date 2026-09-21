#!/usr/bin/env node
/* Reading somebody else's research table without having seen it.
 *
 *   node scripts/test-source-research.mjs
 *
 * Ayush, 2026-09-21, with a link to app55PsyRKqkf2CAQ / tbl2Jje9EBC4Cqydw:
 * "the research section should be taken from airtable (every company id has a
 * research section)", and a list of ten columns.
 *
 * I have no access to that base. The list in the message is how somebody
 * writes column names in a chat, not necessarily how Airtable spells them —
 * "linkedin - Appollo" has a typo in it and "No. of Employees (kylas)" has
 * punctuation no normaliser would keep. So the reader matches loosely and
 * detects the key column rather than assuming one, and this file is where that
 * is proved, because the alternative is finding out on their machine.
 *
 * Every fixture below is a plausible spelling of the same table. If the real
 * one is spelled differently again, RESEARCH_KEY_FIELD and the status line in
 * the panel are what make that a two-minute fix instead of a mystery.
 */
import { readSourceResearch, detectKeyField, SOURCE_RESEARCH_FIELDS } from "./airtable.mjs";

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n         got: ${JSON.stringify(got)}`}`);
};

/* A stand-in for the client: listAll is the only thing readSourceResearch uses. */
const fake = (rows) => ({ listAll: async () => rows, log: () => {} });
const rec = (fields) => ({ id: "rec" + Math.random().toString(36).slice(2, 10), fields });

/* The columns exactly as Ayush listed them. */
const THEIRS = (id, over = {}) => rec({
  "Kylas Company ID": id,
  "linkedin - Appollo": "https://www.linkedin.com/in/someone",
  "Boolean Post link": "https://google.com/search?q=...",
  "Total Funding": "$48M",
  "Latest Funding Amount": "$40M",
  "Latest Funding Type": "Series C",
  "Source - Concatenate": "Apollo · LinkedIn",
  "Account Pipeline Stage": "SQL",
  "Annual Revenue": "₹320 Cr",
  "No. of Employees (kylas)": 760,
  at_rev_per_employee: 4210526,
  ...over,
});

console.log("— the ten columns, spelled the way they were given —");
{
  const { rows, status } = await readSourceResearch(fake([THEIRS("903"), THEIRS("1772963")]), "t");
  check("the key column is found by name", status.keyField, "Kylas Company ID");
  check("both accounts are keyed", Object.keys(rows).sort(), ["1772963", "903"]);
  check("all ten map", status.unmapped, []);
  check("the Apollo link", rows["903"].apollo, "https://www.linkedin.com/in/someone");
  check("the boolean post link", rows["903"].boolean, "https://google.com/search?q=...");
  check("total funding", rows["903"].fundTotal, "$48M");
  check("latest amount is not taken by total",
        rows["903"].fundLast, "$40M");
  check("latest type", rows["903"].fundType, "Series C");
  check("the concatenated source", rows["903"].srcConcat, "Apollo · LinkedIn");
  check("pipeline stage", rows["903"].pipeline, "SQL");
  check("annual revenue", rows["903"].revenue, "₹320 Cr");
  /* A NUMBER IS NOT A STRING. Airtable returns 760, and `esc(760)` on a
     number is fine but `760.trim()` is a TypeError — which would take the
     whole panel down, not just the field. */
  check("a numeric employee count survives", rows["903"].employees, "760");
  check("and so does the ratio", rows["903"].revPerEmp, "4210526");
}

console.log("\n— spelled differently, as a real base often is —");
{
  const row = rec({
    "Company ID": "903",
    LinkedIn: "https://in.linkedin.com/company/x",
    "Boolean post": "https://example.com/b",
    "TOTAL FUNDING": "$48M",
    "latest_funding_amount": "$40M",
    "Latest funding type": "Series C",
    Source: "Apollo",
    "Pipeline Stage": "MQL",
    "annual revenue": "₹320 Cr",
    "Number of employees": 760,
    "Revenue per employee": "42L",
  });
  const { rows, status } = await readSourceResearch(fake([row]), "t");
  check("the key column is still found", status.keyField, "Company ID");
  check("case, spacing and underscores all normalise away", status.unmapped, []);
  check("and the values land on the right keys",
        [rows["903"].fundLast, rows["903"].pipeline, rows["903"].employees],
        ["$40M", "MQL", "760"]);
}

console.log("\n— a key column no heuristic would guess —");
{
  /* Detection by VALUE. The only thing that survives somebody calling it
     "Account Ref", and the reason knownIds is threaded through from the rows
     we already hold. */
  const rows = [rec({ "Account Ref": "903", "Total Funding": "$1M" }),
                rec({ "Account Ref": "1772963", "Total Funding": "$2M" }),
                rec({ "Account Ref": "1776620", "Total Funding": "$3M" })];
  const byName = detectKeyField(rows, []);
  check("with nothing to match against, it says so", byName.field, "");
  const byValue = detectKeyField(rows, ["903", "1772963", "1776620"]);
  check("with ids to match against, it finds the column", byValue.field, "Account Ref");
  check("and says how it found it", byValue.how, (h) => /values/.test(h));
}

console.log("\n— a column that merely looks like ids —");
{
  /* ONE COINCIDENCE IS NOT EVIDENCE. A "Notes" column containing the string
     "903" once must not become the key, because keying on it would scatter
     every account under the wrong id and the panel would show one company's
     funding against another's name. */
  const rows = [rec({ Notes: "903", Other: "x" }), rec({ Notes: "n/a", Other: "y" })];
  check("it is refused", detectKeyField(rows, ["903", "111", "222", "333"]).field, "");
}

console.log("\n— when the table cannot be read at all —");
{
  const boom = { listAll: async () => { throw new Error("NOT_AUTHORIZED"); }, log: () => {} };
  const { rows, status } = await readSourceResearch(boom, "tbl2Jje9EBC4Cqydw");
  check("no rows", Object.keys(rows), []);
  /* THE WHOLE POINT OF THE STATUS. A PAT that is not scoped to that base and
     an account nobody has researched look identical on screen — an empty
     panel — and are completely different problems. */
  check("but the reason travels", status.ok, false);
  check("and it names the fault", status.error, (e) => /NOT_AUTHORIZED/.test(e));
  check("and the table it was reading", status.table, "tbl2Jje9EBC4Cqydw");
}

console.log("\n— an empty table —");
{
  const { status } = await readSourceResearch(fake([]), "t");
  check("is not an error", status.ok, true);
  check("it just says it is empty", status.note, (n) => /empty/.test(n || ""));
}

console.log("\n— arrays and attachments, which Airtable also returns —");
{
  const row = rec({
    "Kylas Company ID": "903",
    "Latest Funding Type": ["Series C", "Debt"],
    "Account Pipeline Stage": { name: "SQL" },
  });
  const { rows } = await readSourceResearch(fake([row]), "t");
  check("a multi-select reads as a list", rows["903"].fundType, "Series C, Debt");
  check("an object reads as its name", rows["903"].pipeline, "SQL");
}

console.log("\n— what the panel is handed —");
{
  check("every field has a key and a label",
        SOURCE_RESEARCH_FIELDS.every((f) => f.k && f.l), true);
  check("the keys are unique",
        new Set(SOURCE_RESEARCH_FIELDS.map((f) => f.k)).size, SOURCE_RESEARCH_FIELDS.length);
  check("all ten Ayush asked for are there", SOURCE_RESEARCH_FIELDS.length, 10);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
