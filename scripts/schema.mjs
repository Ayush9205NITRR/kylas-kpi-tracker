/* The BD KPI base, as data rather than as a sequence of API calls.
   create-base.mjs executes this; validate-schema.mjs checks it without a
   network call. Keeping it declarative is what makes it testable. */

export const EPOCH = "DATETIME_PARSE('1970-01-01', 'YYYY-MM-DD')";

export const dateTime = {
  dateFormat: { name: "iso" },
  timeFormat: { name: "24hour" },
  timeZone: "Asia/Kolkata",
};
export const sel = (...names) => ({ choices: names.map((name) => ({ name })) });
export const num = { precision: 0 };
export const check = { icon: "check", color: "greenBright" };

/* Stage tables are generated from docs/stages.json — see gen-stages.mjs. */
export { STAGES, STAGE_ID, STAGE_RUNG, LADDER, EXIT_STAGES } from "./stages.mjs";
import { STAGES, LADDER, EXIT_STAGES, MILESTONE } from "./stages.mjs";

export const ladderFormula = (rankField) =>
  LADDER.slice(1).reduceRight(
    (acc, [n, label]) => `IF({${rankField}} = ${n}, "${label}", ${acc})`,
    `"${LADDER[0][1]}"`,
  );

/* Event type is not qualification signal — see docs/kpi-spec.md §5. */
const SIGNALS = ["Budget", "Timeline", "Pax"];
const anyFilled = SIGNALS.map((f) => `{${f}} != ""`).join(", ");

/* ── tables, created first with their own columns only ─────────────── */
export const TABLES = [
  {
    name: "Companies",
    description: "One row per Kylas company. Every KPI field here is derived from its Contacts — nothing is entered at this level.",
    fields: [
      { name: "Name", type: "singleLineText" },
      { name: "Kylas Company ID", type: "singleLineText" },
      /* Added 2026-09-18. Without it the KPI store cannot say WHOSE company a
         row is, so the dashboard had to join every Airtable row back to a
         10,000-row Kylas crawl just to attribute it — and when that join missed,
         every company-level number read zero with nothing saying why. With the
         owner here, Airtable can answer the dashboard on its own. */
      { name: "Owner", type: "singleLineText",
        description: "The Kylas owner's name, copied on every save so this table can attribute a company without calling Kylas." },
    ],
  },
  {
    name: "Contacts",
    description: "One row per Kylas contact. Where data is actually entered. KPI Rank is monotonic and written by the proxy, never by a formula.",
    fields: [
      { name: "Name", type: "singleLineText" },
      { name: "Kylas Contact ID", type: "singleLineText" },
      { name: "Designation", type: "singleLineText" },
      { name: "LinkedIn", type: "url" },
      { name: "Owner", type: "singleLineText" },
      { name: "Current Stage", type: "singleSelect", options: sel(...STAGES) },
      { name: "Previous Stage", type: "singleSelect", options: sel(...STAGES) },
      { name: "Vendor Info", type: "singleSelect", options: sel("Internal", "Vendor Exists", "First Event", "No Info") },
      { name: "Mode of Meeting", type: "singleSelect", options: sel("In Person", "Virtual", "Calls", "Text") },
      { name: "Service Offering", type: "checkbox", options: check },
      { name: "Ever Picked", type: "checkbox", options: check,
        description: "Set true the first time a non-CNC stage is seen, never unset. This is what makes Phone Picked monotonic." },
      { name: "KPI Rank", type: "number", options: num,
        description: "Highest rung ever reached. Written as MAX(existing, computed). Never decreases." },
      { name: "KPI Rank At", type: "dateTime", options: dateTime,
        description: "When KPI Rank last increased — the last qualitative update." },
      { name: "Pending Create", type: "checkbox", options: check,
        description: "Captured in the console but not yet in Kylas. Tells the writer POST rather than PUT." },
      { name: "Exit Reason", type: "singleSelect", options: sel(...EXIT_STAGES),
        description: "Set when the contact lands on a dead-end stage. Kept apart from KPI Rank so an exit cannot pull the funnel backwards." },
      { name: "Flagged", type: "checkbox", options: check },
    ],
  },
  {
    name: "Event Rows",
    description: "Past and current event rows. Hangs off the contact, not the company.",
    fields: [
      { name: "Row Key", type: "singleLineText", description: "UUID assigned by the overlay. Upsert key." },
      { name: "Period", type: "singleSelect", options: sel("Past", "Current") },
      { name: "Event Type", type: "singleLineText" },
      { name: "Budget", type: "multilineText" },
      { name: "Timeline", type: "multilineText" },
      { name: "Pax", type: "multilineText" },
      { name: "Remarks", type: "multilineText" },
    ],
  },
  {
    name: "Call Log",
    description: "One row per save in the console, whether or not the stage moved. Append-only — never update or delete a row here.",
    fields: [
      { name: "Key", type: "singleLineText", description: "Idempotency key from the overlay, so a retried save does not double-count." },
      { name: "Called At", type: "dateTime", options: dateTime },
      { name: "Outcome", type: "singleSelect", options: sel("No answer", "Wrong POC", "Right POC", "Discovery") },
      { name: "Duration", type: "number", options: num, description: "Seconds." },
      { name: "Duration Source", type: "singleSelect", options: sel("dialed", "estimated", "none"),
        description: "dialed is measured; estimated is inferred from the outcome keypress; none means no outcome was set." },
      { name: "Owner", type: "singleLineText" },
      { name: "Stage Set", type: "singleSelect", options: sel(...STAGES) },
      { name: "Created Here", type: "checkbox", options: check },
    ],
  },
  {
    name: "Stage Transitions",
    description: "One row per stage change. Append-only — never update or delete a row here.",
    fields: [
      { name: "Key", type: "singleLineText" },
      { name: "From Stage", type: "singleSelect", options: sel(...STAGES) },
      { name: "To Stage", type: "singleSelect", options: sel(...STAGES) },
      { name: "Changed At", type: "dateTime", options: dateTime },
      { name: "Owner", type: "singleLineText" },
      { name: "Source", type: "singleSelect", options: sel("Console", "Kylas webhook", "Backfill") },
    ],
  },
  {
    name: "Daily Snapshot",
    description: "One frozen row per day per owner. Written once after the day ends, never updated. Day/week/month reporting reads this, not a live recount.",
    fields: [
      { name: "Key", type: "singleLineText", description: "date · owner. Stops a day being frozen twice." },
      { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
      { name: "Owner", type: "singleLineText" },

      /* activity — these ADD UP across a week or month */
      { name: "Dials", type: "number", options: num },
      { name: "Connects", type: "number", options: num },
      { name: "New Right POC", type: "number", options: num, description: "Reached this rung ON this day. A movement, not a total." },
      { name: "New Discovery", type: "number", options: num },
      { name: "New SQL Booked", type: "number", options: num },
      { name: "New SQL Accepted", type: "number", options: num },
      { name: "Companies Touched", type: "number", options: num },
      { name: "Contacts Added", type: "number", options: num },
      { name: "Talk Seconds", type: "number", options: num, description: "Measured dials only, so this stays a real number." },

      /* standing totals — these DO NOT add up; read the latest day */
      { name: "Companies At Right POC", type: "number", options: num, description: "Where things STOOD at end of day. Summing across a week double-counts." },
      { name: "Companies At Discovery", type: "number", options: num },
      { name: "Companies At SQL Booked", type: "number", options: num },
      /* Added 2026-09-18: the milestone ladder gained SQL Meeting Done (rung
         21) after this table was written, so the trend chart had a gap exactly
         where one of the five benchmark conversions is measured. */
      { name: "Companies At SQL Meeting Done", type: "number", options: num },
      { name: "Companies At SQL Accepted", type: "number", options: num },
      { name: "Companies Reached To Date", type: "number", options: num },

      { name: "Connect Rate", type: "percent", options: num },
      { name: "Frozen At", type: "dateTime", options: dateTime },
    ],
  },

  /* ── a record of what has already been done to this base ─────────── */
  /* A data migration is not idempotent and cannot be made so by inspection.
     The ladder remap turns a stored rank of 22 into 21; run it twice and that
     22 becomes 20, and nothing about the number says which it is. A local
     marker file would not do either — the base is shared, and the next
     machine would happily run it again.

     So the base records its own migrations, and migrate-ladder.mjs refuses to
     repeat one. Three fields; it earns them. */
  {
    name: "Schema Migrations",
    description: "One row per migration applied to this base. Written by the migration scripts, read by them to refuse a second run. Do not delete a row unless you intend the migration to run again.",
    fields: [
      { name: "Key", type: "singleLineText",
        description: "Stable id of the migration, e.g. ladder-2026-09-17-retire-reschedule-pending." },
      { name: "Applied At", type: "dateTime", options: dateTime },
      { name: "Note", type: "multilineText",
        description: "What it changed, and how many rows." },
    ],
  },
];

/* ── fields added afterwards, in dependency order ──────────────────── */
/* Airtable creates the reverse link automatically, on the other table, with a
   name it picks itself. Everything downstream rolls up THROUGH that reverse
   field, so it is declared here and create-base.mjs renames the generated field
   to match. Leaving it to chance is how the rollups silently target nothing. */
const link = (table, name, to, reverse, description) =>
  ({ table, reverse, field: { name, type: "multipleRecordLinks", options: { linkedTable: to }, description } });

const rollup = (table, name, via, target, formula, description) =>
  ({ table, field: { name, type: "rollup", description,
      options: { recordLinkFieldId: via, fieldIdInLinkedTable: target, formula } } });

const formula = (table, name, f, description) =>
  ({ table, field: { name, type: "formula", options: { formula: f }, description } });

export const FOLLOWUPS = [
  link("Contacts", "Company", "Companies", "Contacts"),
  link("Event Rows", "Contact", "Contacts", "Event Rows"),
  link("Call Log", "Contact", "Contacts", "Call Log"),
  link("Stage Transitions", "Contact", "Contacts", "Stage Transitions"),

  /* Remarks is excluded from both on purpose — see kpi-spec.md §5. */
  formula("Event Rows", "Has Any Signal", `IF(OR(${anyFilled}), 1, 0)`,
    "Any qualification field filled → the contact counts as a Right POC."),
  formula("Event Rows", "Is Complete", `IF(AND(${anyFilled}), 1, 0)`,
    "All qualification fields filled → a successful discovery call."),

  /* A rollup cannot filter on a sibling field, so zero out the estimates first
     and then sum. Otherwise inferred seconds inflate real talk time. */
  formula("Call Log", "Measured Seconds", `IF({Duration Source} = "dialed", {Duration}, 0)`,
    "Duration when it was actually measured, 0 otherwise."),

  rollup("Contacts", "Has Signal", "Event Rows", "Has Any Signal", "MAX(values)"),
  rollup("Contacts", "Has Complete Row", "Event Rows", "Is Complete", "MAX(values)"),

  /* per-contact call history */
  rollup("Contacts", "Call Count", "Call Log", "Called At", "COUNTA(values)"),
  rollup("Contacts", "Last Call At", "Call Log", "Called At", "MAX(values)",
    "Every call, not just stage changes — see kpi-spec.md §2."),
  rollup("Contacts", "First Call At", "Call Log", "Called At", "MIN(values)"),
  rollup("Contacts", "Talk Seconds", "Call Log", "Measured Seconds", "SUM(values)"),
  rollup("Contacts", "Measured Calls", "Call Log", "Measured Seconds", "COUNTALL(values)"),
  formula("Contacts", "Avg Call Seconds",
    `IF({Call Count} > 0, ROUND({Talk Seconds} / {Call Count}, 0), 0)`,
    "Across all calls. Estimated durations count as 0, so read it with Talk Seconds."),

  rollup("Contacts", "Last Stage Change At", "Stage Transitions", "Changed At", "MAX(values)"),
  rollup("Contacts", "First Stage Change At", "Stage Transitions", "Changed At", "MIN(values)"),

  formula("Contacts", "Is Right POC", `IF({Has Signal} = 1, 1, 0)`),
  formula("Contacts", "Right POC Name", `IF({Has Signal} = 1, {Name}, "")`,
    "Name when this contact qualifies, blank otherwise. Rolled up into Companies."),
  formula("Contacts", "Is Discovery", `IF({Has Complete Row} = 1, 1, 0)`),
  formula("Contacts", "Discovery Name", `IF({Has Complete Row} = 1, {Name}, "")`,
    "Name when one event row has budget AND timeline AND pax. Rolled up into Companies, exactly as Right POC Name is."),
  formula("Contacts", "KPI Stage", ladderFormula("KPI Rank")),
  formula("Contacts", "KPI Score",
    `IF({KPI Rank At}, {KPI Rank} * 10000000000 + DATETIME_DIFF({KPI Rank At}, ${EPOCH}, 'seconds'), {KPI Rank} * 10000000000)`,
    "Rank in the high digits, timestamp in the low. A single MAX rollup then gives Companies the best rung and, among ties, the most recent."),

  rollup("Companies", "Last Call At", "Contacts", "Last Call At", "MAX(values)",
    "Companies Reached is the count of rows where this is not blank."),
  rollup("Companies", "First Call At", "Contacts", "First Call At", "MIN(values)"),
  rollup("Companies", "Call Count", "Contacts", "Call Count", "SUM(values)"),
  rollup("Companies", "Talk Seconds", "Contacts", "Talk Seconds", "SUM(values)"),
  rollup("Companies", "Ever Picked", "Contacts", "Ever Picked", "MAX(values)"),
  rollup("Companies", "KPI Score", "Contacts", "KPI Score", "MAX(values)"),
  rollup("Companies", "Right POC Contacts", "Contacts", "Right POC Name", "ARRAYJOIN(ARRAYCOMPACT(values), ', ')"),
  rollup("Companies", "Discovery Contacts", "Contacts", "Discovery Name", "ARRAYJOIN(ARRAYCOMPACT(values), ', ')",
    "Which POCs gave a complete row. Successful Discovery is the count of companies where this is not blank."),
  rollup("Companies", "Contact Count", "Contacts", "Name", "COUNTA(values)"),

  formula("Companies", "Reached", `IF({Last Call At}, 1, 0)`),
  formula("Companies", "Phone Picked", `IF({Ever Picked} = 1, 1, 0)`),
  formula("Companies", "Right POC", `IF({Right POC Contacts}, 1, 0)`,
    "Any of budget | timeline | pax on any row, Past or Current, on any contact."),
  /* Cumulative by construction: a complete row has all three filled, so it also
     has any one of them. Discovery is always a subset of Right POC — no OR
     needed to keep the funnel reading straight down. */
  formula("Companies", "Successful Discovery", `IF({Discovery Contacts}, 1, 0)`,
    "One row with budget AND timeline AND pax. Implies Right POC."),
  formula("Companies", "KPI Rank", `IF({KPI Score}, FLOOR({KPI Score} / 10000000000), 0)`),

  /* The three stage-driven milestones. Each is a floor on the ladder, and
     because KPI Rank only ever rises, "ever reached it" needs no history — the
     rank IS the high-water mark. So Booked counts a company whose call was
     booked and then no-showed, which is what "regardless of outcome" means.
     Stage-driven, unlike Right POC and Successful Discovery above, which come
     from the event data. A company can sit at SQL with no complete row. */
  formula("Companies", "SQL Meeting Booked", `IF({KPI Rank} >= ${MILESTONE.sqlMeetingBooked.floor}, 1, 0)`,
    `Rank >= ${MILESTONE.sqlMeetingBooked.floor} (${MILESTONE.sqlMeetingBooked.stage} and above). Includes no-shows and reschedules.`),
  formula("Companies", "SQL Meeting Done", `IF({KPI Rank} >= ${MILESTONE.sqlMeetingDone.floor}, 1, 0)`,
    `Rank >= ${MILESTONE.sqlMeetingDone.floor} (${MILESTONE.sqlMeetingDone.stage} and above). The call was actually held.`),
  formula("Companies", "SQL", `IF({KPI Rank} >= ${MILESTONE.sql.floor}, 1, 0)`,
    `Rank >= ${MILESTONE.sql.floor}. Qualified.`),
  formula("Companies", "KPI Stage", ladderFormula("KPI Rank")),
  formula("Companies", "KPI Stage At",
    `IF({KPI Score}, DATEADD(${EPOCH}, MOD({KPI Score}, 10000000000), 'seconds'))`,
    "When the company last moved up a rung."),
];
