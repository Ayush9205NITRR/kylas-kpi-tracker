#!/usr/bin/env node
/* The four rungs that are not stage moves, and the dates they are counted on.
 *
 *   node scripts/test-signals.mjs
 *
 * WHAT THIS EXISTS FOR
 * Ayush, 2026-09-21: "this account has 2 right POCs and 1 discovery call, but
 * these activities are not reflecting in the KPI dashboard."
 *
 * They were not. Is Right POC is an Airtable formula that goes true when an
 * event row carries budget, timeline or pax. Nothing moves in Kylas when
 * somebody writes down a budget, so there is no transition row and the report
 * takes it as a `signal` — and a signal with no date cannot be placed in a
 * period, so it was dropped. The only date available was KPI Rank At, stamped
 * when the numeric RANK rises. Fill in a budget without moving the stage and
 * the rank does not rise. Flag true, no date, rung zero.
 *
 * Exactly the shape of the FLOORS bug before it: not "zero because nothing
 * happened" but "zero because nothing could ever be counted".
 *
 * So the first case below is the regression test, and it fails on the old code.
 */
import { contactSignals, SIGNAL_READ_FIELDS } from "./airtable.mjs";
import { firstArrivals } from "./report.mjs";
import { TABLES, FOLLOWUPS } from "./schema.mjs";

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n         got: ${JSON.stringify(got)}`}`);
};

const row = (id, fields) => ({ id, fields });
const CO = ["recCompanyAAAAAAA"];

/* ── the reported bug ─────────────────────────────────────────────────── */
console.log("— a right POC who never moved stage —");
{
  /* Tiwari, from the screenshot: budget, timeline and pax all filled, stage
     still LinkedIn Outreach Initiated. So the formula is true, the rank never
     rose, and KPI Rank At is empty. */
  const rows = [row("recT", {
    Name: "Tiwari", Owner: "Enout Super Admin", Company: CO,
    "Is Right POC": 1, "Is Discovery": 1,
    "First Worked At": "2026-09-18T10:00:00.000Z",
    "First Picked At": "2026-09-18T10:00:00.000Z",
    "First Right POC At": "2026-09-20T11:30:00.000Z",
    "First Discovery At": "2026-09-20T11:30:00.000Z",
  })];
  const { signals, undated } = contactSignals(rows);
  check("right POC is counted", signals.filter((s) => s.metric === "right").length, 1);
  check("discovery is counted", signals.filter((s) => s.metric === "discovery").length, 1);
  check("dated from its own stamp, not from the rank",
        signals.find((s) => s.metric === "right").at, "2026-09-20T11:30:00.000Z");
  check("nothing is left undated", undated.length, 0);
}

console.log("\n— the same contact before the stamp existed —");
{
  /* The old rows. No First Right POC At, no KPI Rank At either, because the
     stage never moved. This is the case that was silently dropped. */
  const rows = [row("recT", {
    Name: "Tiwari", Owner: "Enout Super Admin", Company: CO,
    "Is Right POC": 1,
    "First Worked At": "2026-09-18T10:00:00.000Z",
    "First Picked At": "2026-09-18T10:00:00.000Z",
  })];
  const { signals, undated } = contactSignals(rows);
  check("it is still counted", signals.filter((s) => s.metric === "right").length, 1);
  check("dated from the first call, which is a floor not a guess",
        signals.find((s) => s.metric === "right").at, "2026-09-18T10:00:00.000Z");
  check("and it says the date is a fallback",
        signals.find((s) => s.metric === "right").dated, "fallback");
  check("nothing is dropped", undated.length, 0);
}

console.log("\n— KPI Rank At is preferred over the call, being tighter —");
{
  const rows = [row("recT", {
    Owner: "A", Company: CO, "Is Right POC": 1,
    "KPI Rank At": "2026-09-19T09:00:00.000Z",
    "First Worked At": "2026-09-10T10:00:00.000Z",
  })];
  const { signals } = contactSignals(rows);
  check("the rank date wins", signals.find((s) => s.metric === "right").at,
        "2026-09-19T09:00:00.000Z");
}

console.log("\n— a qualifier with no date anywhere —");
{
  const rows = [row("recGhost", { Name: "Ghost", Owner: "A", Company: CO, "Is Right POC": 1 })];
  const { signals, undated } = contactSignals(rows);
  check("no signal is invented", signals.length, 0);
  /* SAID OUT LOUD. The old code did this silently, which is why the bug
     survived a rewrite of the ladder: nothing anywhere reported a dropped row. */
  check("but it is reported rather than dropped", undated.length, 1);
  check("with enough to find the contact", undated[0].name, "Ghost");
}

/* ── the rungs still count COMPANIES, not contacts ────────────────────── */
console.log("\n— two right POCs at one company —");
{
  /* The screenshot again: adrenalinco has Tiwari and Uvaraj, both Right POC.
     The ladder counts COMPANIES, so that is one arrival, not two. */
  const rows = [
    row("recT", { Name: "Tiwari", Owner: "A", Company: CO, "Is Right POC": 1,
                  "First Right POC At": "2026-09-20T11:00:00.000Z" }),
    row("recU", { Name: "Uvaraj", Owner: "A", Company: CO, "Is Right POC": 1,
                  "First Right POC At": "2026-09-21T09:00:00.000Z" }),
  ];
  const { signals } = contactSignals(rows);
  check("both contacts emit a signal", signals.filter((s) => s.metric === "right").length, 2);
  const arrivals = firstArrivals({ signals });
  check("but the company arrives once",
        arrivals.filter((a) => a.metric === "right").length, 1);
  check("dated by the EARLIER of the two",
        arrivals.find((a) => a.metric === "right").at, "2026-09-20T11:00:00.000Z");
}

console.log("\n— a contact with no company link —");
{
  const rows = [row("recLoose", { Name: "Loose", Owner: "A", "Is Right POC": 1,
                                  "First Right POC At": "2026-09-20T11:00:00.000Z" })];
  const { signals } = contactSignals(rows);
  check("it is a company of one, not a dropped rung", signals[0].company, "recLoose");
}

/* ── the field list and the reader cannot drift apart ─────────────────── */
console.log("\n— what the proxy asks Airtable for —");
{
  /* THE ORIGINAL FAULT, in one check. First Right POC At can exist on the
     table, be written by the writer, and still never reach the report if the
     projection does not name it — Airtable returns only the fields asked for.
     So: every field contactSignals() reads must be in SIGNAL_READ_FIELDS, and
     every field in SIGNAL_READ_FIELDS must exist on Contacts. */
  const src = contactSignals.toString();
  const read = [...src.matchAll(/f\["([^"]+)"\]/g)].map((m) => m[1]);
  const missing = [...new Set(read)].filter((n) => !SIGNAL_READ_FIELDS.includes(n));
  check("every field it reads is one it asked for", missing, []);

  const onContacts = new Set([
    ...TABLES.find((t) => t.name === "Contacts").fields.map((f) => f.name),
    ...FOLLOWUPS.filter((s) => s.table === "Contacts").map((s) => s.field.name),
    ...FOLLOWUPS.filter((s) => s.field.options?.linkedTable === "Contacts" && s.reverse)
      .map((s) => s.reverse),
  ]);
  const absent = SIGNAL_READ_FIELDS.filter((f) => !onContacts.has(f));
  check("and every one of them is on the table", absent, []);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
