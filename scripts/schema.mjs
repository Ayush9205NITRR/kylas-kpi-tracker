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
/* Reason codes are generated from docs/rca-reasons.json — see gen-rca.mjs. The
   RCA table's Reason column is a singleSelect built from them, so a reason the
   console offers and the base has never heard of is a rejected write. */
import { RCA_REASON_CODES, RCA_GATE_KEYS } from "./rca.mjs";

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
      /* Added 2026-09-19 for the nightly Kylas -> Airtable sync. It holds the
         record's updatedAt AS KYLAS REPORTED IT, which makes the watermark
         derivable from the base itself: the next run asks Kylas for everything
         changed since the newest value here. No local cursor file, so the cron
         can move between machines and a lost disk costs nothing. */
      { name: "Kylas Updated At", type: "dateTime", options: dateTime },
      /* Added 2026-09-19 so the dashboard's company list can be read from here
         rather than from a Kylas crawl that stops at a result window. These are
         Kylas' own company fields — the Companies view filters on source, batch
         and health, so a mirror without them is not a mirror.
         "Kylas Stage" and not "Stage": KPI Stage below is DERIVED from the
         ladder and means something else entirely. */
      { name: "Kylas Owner ID", type: "singleLineText" },
      { name: "Kylas Stage", type: "singleLineText" },
      { name: "Source of Data", type: "singleLineText" },
      { name: "Batch", type: "singleLineText" },
      { name: "Account Health", type: "singleLineText" },
      { name: "Website", type: "singleLineText" },
      { name: "Last Called At", type: "singleLineText" },
    ],
  },
  {
    name: "Contacts",
    description: "One row per Kylas contact. Where data is actually entered. KPI Rank is monotonic and written by the proxy, never by a formula.",
    fields: [
      { name: "Name", type: "singleLineText" },
      { name: "Kylas Contact ID", type: "singleLineText" },
      /* Added 2026-09-19 for the nightly Kylas -> Airtable sync. It holds the
         record's updatedAt AS KYLAS REPORTED IT, which makes the watermark
         derivable from the base itself: the next run asks Kylas for everything
         changed since the newest value here. No local cursor file, so the cron
         can move between machines and a lost disk costs nothing. */
      { name: "Kylas Updated At", type: "dateTime", options: dateTime },
      { name: "Designation", type: "singleLineText" },
      { name: "LinkedIn", type: "url" },
      /* Added 2026-09-19, so the console can be READ from here rather than from
         Kylas. Without a number there is nothing to dial and the whole idea
         fails on the first call of the day.

         Two columns per channel on purpose. The JSON one is what the console
         reads: a contact can carry several numbers with a type and a country
         code each, and flattening that to one string loses the ones that are
         not primary. The plain one is for a person looking at the base, which
         is most of why the base exists. Both are written from the same value
         on every sync, so they cannot drift apart. */
      { name: "Phone", type: "singleLineText" },
      { name: "Phones", type: "multilineText" },
      { name: "Email", type: "singleLineText" },
      { name: "Emails", type: "multilineText" },
      /* The NAME is what the reports group by, but the id is what the console
         filters companies on — carrying only one of them made a contact read
         from Airtable subtly different from the same contact read from Kylas,
         and "subtly different" is how a consumer grows a branch. */
      { name: "Kylas Owner ID", type: "singleLineText" },
      { name: "Salutation", type: "singleLineText" },
      { name: "Source of Data", type: "singleLineText" },
      { name: "Remarks", type: "multilineText" },
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
      /* WHEN THIS CONTACT WAS FIRST WORKED, AND FIRST PICKED UP.
         Written once by the proxy and never overwritten, which is the whole
         point: "First Call At" beside them is a rollup of the Call Log, and
         rollup-calls.mjs DELETES raw call rows once they are past the retention
         window — so that field silently moves forward as history is compacted,
         and a company's first touch drifts to whatever is left. These two are
         values, not derivations, so nothing can erase them.

         They are what makes the funnel count COMPANIES at every rung. Without
         them the first two rungs had to be counted from the call log, which
         counts CALLS — and a ladder whose bottom two rungs are a different unit
         from its top five cannot be monotonic. It showed 0 connected above 2
         right POC. */
      { name: "First Worked At", type: "dateTime", options: dateTime,
        description: "First call ever logged against this contact. Written once, never updated." },
      { name: "First Picked At", type: "dateTime", options: dateTime,
        description: "First time this contact reached a stage that is not a no-answer — the moment somebody actually spoke to them. Written once, never updated." },
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
      /* "Kylas sync" added 2026-09-19: a stage that moved in Kylas rather than
         in the console still has to reach the report, and it must be
         distinguishable from one an associate set on a call. */
      { name: "Source", type: "singleSelect",
        options: sel("Console", "Kylas webhook", "Backfill", "Kylas sync") },
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
    name: "Call Rollup",
    description: "One row per day per owner per outcome, replacing the raw Call Log rows for days past the retention window. Written by rollup-calls.mjs. The period report reads this for old days and the raw log for recent ones.",
    fields: [
      { name: "Key", type: "singleLineText",
        description: "day|owner|outcome. The upsert key, so re-running a day overwrites rather than adds." },
      /* TEXT, not a date field. An Airtable date carries a timezone and this is
         a calendar day that has already been decided — storing it as a date
         invites the day to shift by one under a different viewer's zone, which
         would move calls between weeks and quietly change a report that is
         supposed to be frozen. */
      { name: "Day", type: "singleLineText" },
      { name: "Owner", type: "singleLineText" },
      { name: "Outcome", type: "singleLineText" },
      { name: "Calls", type: "number", options: num },
      { name: "Talk Seconds", type: "number", options: num },
      { name: "Rolled At", type: "dateTime", options: dateTime },
    ],
  },
  /* WHY AN ACCOUNT STOPPED MOVING, in the associate's own words, at the moment
     it is still fresh enough to remember.

     The funnel already says WHERE accounts are lost — Right POC → Discovery is
     the step with the drop. It cannot say why, and a conversion rate nobody can
     explain is a number that gets reported and never acted on. This is the
     other half: when a contact has sat at one rung past the gate's patience, it
     is listed, and the associate picks a reason.

     One row per contact per gate, keyed so the same stall cannot be asked twice
     and an answer can be revised rather than duplicated. Append in spirit: a
     row is written when the question is asked and updated when it is answered,
     never deleted, because "we asked and nobody said" is itself a finding. */
  {
    name: "RCA",
    description: "One row per stalled contact per gate. Asked by the console when a contact has sat at a rung past the gate's patience; answered by the associate. Reason codes come from docs/rca-reasons.json — see gen-rca.mjs.",
    fields: [
      { name: "Key", type: "singleLineText",
        description: "<kylas contact id>|<gate key>. The upsert key: one open question per contact per gate, for ever." },
      { name: "Gate", type: "singleSelect", options: sel(...RCA_GATE_KEYS),
        description: "Which stall this is — see docs/rca-reasons.json." },
      { name: "Asked At", type: "dateTime", options: dateTime,
        description: "When the console first listed it. Not when it became stuck." },
      { name: "Stuck Since", type: "dateTime", options: dateTime,
        description: "The contact's KPI Rank At — when it arrived at the rung it is stuck on." },
      { name: "Stuck Days", type: "number", options: num,
        description: "Days between Stuck Since and the answer. Frozen at answer time, so a row read months later still says how long it had been when somebody looked." },
      { name: "Reason", type: "singleSelect", options: sel(...RCA_REASON_CODES),
        description: "Blank until answered. Codes, not labels — a label can be reworded without orphaning the history." },
      { name: "Note", type: "multilineText",
        description: "Free text. Optional, and the only place the specifics of one account can live." },
      { name: "Answered At", type: "dateTime", options: dateTime },
      { name: "Answered By", type: "singleLineText" },
      { name: "Owner", type: "singleLineText",
        description: "Whose account it was when the question was asked." },
    ],
  },
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
  link("RCA", "Contact", "Contacts", "RCA"),

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
  /* The company is worked the moment its FIRST contact is, and picked the
     moment its first contact picks up. MIN, so a company counts on the period
     it entered the rung rather than the period its latest POC did. */
  rollup("Companies", "First Worked At", "Contacts", "First Worked At", "MIN(values)"),
  rollup("Companies", "First Picked At", "Contacts", "First Picked At", "MIN(values)"),
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
