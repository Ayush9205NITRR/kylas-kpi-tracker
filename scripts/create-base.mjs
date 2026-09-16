#!/usr/bin/env node
/**
 * Creates the BD KPI base in Airtable from docs/kpi-spec.md.
 *
 *   AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE=wsp... node scripts/create-base.mjs
 *
 * PAT needs scopes: schema.bases:write, schema.bases:read.
 * Idempotent only in the sense that it fails loudly — it does not patch an
 * existing base. Delete and re-run if you need to start over.
 */

const PAT = process.env.AIRTABLE_PAT;
const WORKSPACE = process.env.AIRTABLE_WORKSPACE;
const BASE_NAME = process.env.AIRTABLE_BASE_NAME || "Enout BD KPI";

if (!PAT || !WORKSPACE) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_WORKSPACE (wsp...).");
  process.exit(1);
}

const API = "https://api.airtable.com/v0/meta";
const EPOCH = "DATETIME_PARSE('1970-01-01', 'YYYY-MM-DD')";

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  return JSON.parse(text);
}

const field = (baseId, tableId, f) => call("POST", `/bases/${baseId}/tables/${tableId}/fields`, f);

const dateTime = {
  dateFormat: { name: "iso" },
  timeFormat: { name: "24hour" },
  timeZone: "Asia/Kolkata",
};
const sel = (...names) => ({ choices: names.map((name) => ({ name })) });

// Stage lists are placeholders until the real Kylas picklist is pulled from
// GET /v1/entities/contact/fields?custom-only=false — see docs/kpi-spec.md §7.
const STAGES = [
  "LinkedIn Outreach Initiated", "Cold Call Initiated", "Could Not Connect",
  "Contacted", "Wrong POC", "Qualifying", "Discovery Call Booked",
  "Discovery Call Done", "SQL — Active", "Holding Pad", "Lost",
];

const LADDER = [
  [0, "0 · Not reached"],
  [1, "1 · Reached"],
  [2, "2 · Phone Picked"],
  [3, "3 · Right POC"],
  [4, "4 · Successful Discovery"],
  [5, "5 · Active Requirement"],
  [6, "6 · SQL Call Booked"],
  [7, "7 · SQL Call Held"],
  [8, "8 · SQL Accepted"],
];

/** Nested IF mapping a numeric rank field to its ladder label. */
const ladderFormula = (rankField) =>
  LADDER.slice(1).reduceRight(
    (acc, [n, label]) => `IF({${rankField}} = ${n}, "${label}", ${acc})`,
    `"${LADDER[0][1]}"`,
  );

async function main() {
  console.log(`Creating base "${BASE_NAME}" in ${WORKSPACE}…`);

  // ── 1. base + tables, scalar fields only ──────────────────────────────
  const base = await call("POST", "/bases", {
    workspaceId: WORKSPACE,
    name: BASE_NAME,
    tables: [
      {
        name: "Companies",
        description: "One row per Kylas company. All KPI fields here are derived from Contacts.",
        fields: [
          { name: "Name", type: "singleLineText" },
          { name: "Kylas Company ID", type: "singleLineText" },
        ],
      },
      {
        name: "Contacts",
        description: "One row per Kylas contact. KPI Rank is monotonic and written by the proxy — never by a formula.",
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
          { name: "Service Offering", type: "checkbox", options: { icon: "check", color: "greenBright" } },
          { name: "Ever Picked", type: "checkbox", options: { icon: "check", color: "greenBright" },
            description: "Set true by the proxy the first time a non-CNC stage is seen. Never unset — this is what makes Phone Picked monotonic." },
          { name: "KPI Rank", type: "number", options: { precision: 0 },
            description: "Highest rung ever reached. Written by the proxy as MAX(existing, computed). Never decreases." },
          { name: "KPI Rank At", type: "dateTime", options: dateTime,
            description: "When KPI Rank last increased — the 'last qualitative update'." },
          { name: "Flagged", type: "checkbox", options: { icon: "flag", color: "orangeBright" } },
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
        name: "Stage Transitions",
        description: "Append-only. Never update or delete a row here.",
        fields: [
          { name: "Key", type: "autoNumber" },
          { name: "From Stage", type: "singleSelect", options: sel(...STAGES) },
          { name: "To Stage", type: "singleSelect", options: sel(...STAGES) },
          { name: "Changed At", type: "dateTime", options: dateTime },
          { name: "Owner", type: "singleLineText" },
          { name: "Source", type: "singleSelect", options: sel("Console", "Kylas webhook", "Backfill") },
        ],
      },
      {
        name: "Daily Snapshot",
        description: "One frozen row per day per owner. Written once after the day ends, never updated. This is what day/week/month reporting reads — not a live recount.",
        fields: [
          { name: "Key", type: "singleLineText", description: "date + owner, e.g. 2026-09-16 · Ayush Tiwari. Prevents a day being frozen twice." },
          { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
          { name: "Owner", type: "singleLineText" },

          // ── activity: these ADD UP across a week or month ──
          { name: "Dials", type: "number", options: { precision: 0 } },
          { name: "Connects", type: "number", options: { precision: 0 } },
          { name: "New Right POC", type: "number", options: { precision: 0 },
            description: "Contacts that reached this rung ON this day. A movement, not a total." },
          { name: "New Discovery", type: "number", options: { precision: 0 } },
          { name: "New SQL Booked", type: "number", options: { precision: 0 } },
          { name: "New SQL Accepted", type: "number", options: { precision: 0 } },
          { name: "Companies Touched", type: "number", options: { precision: 0 } },
          { name: "Contacts Added", type: "number", options: { precision: 0 } },
          { name: "Talk Seconds", type: "number", options: { precision: 0 },
            description: "Measured dials only. Estimated durations are excluded so this stays a real number." },

          // ── standing totals: these DO NOT add up; take the latest day ──
          { name: "Companies At Right POC", type: "number", options: { precision: 0 },
            description: "Where things STOOD at end of day. Summing these across a week double-counts — take the last day's value." },
          { name: "Companies At Discovery", type: "number", options: { precision: 0 } },
          { name: "Companies At SQL Booked", type: "number", options: { precision: 0 } },
          { name: "Companies At SQL Accepted", type: "number", options: { precision: 0 } },
          { name: "Companies Reached To Date", type: "number", options: { precision: 0 } },

          { name: "Connect Rate", type: "percent", options: { precision: 0 } },
          { name: "Frozen At", type: "dateTime", options: dateTime },
        ],
      },
      {
        name: "Call Log",
        description: "Append-only. One row per save in the console, whether or not the stage moved.",
        fields: [
          { name: "Key", type: "autoNumber" },
          { name: "Called At", type: "dateTime", options: dateTime },
          { name: "Outcome", type: "singleSelect", options: sel("No answer", "Wrong POC", "Right POC", "Discovery") },
          { name: "Duration", type: "number", options: { precision: 0 }, description: "Seconds." },
          { name: "Owner", type: "singleLineText" },
          { name: "Stage Set", type: "singleSelect", options: sel(...STAGES) },
        ],
      },
    ],
  });

  const id = Object.fromEntries(base.tables.map((t) => [t.name, t.id]));
  console.log(`  base ${base.id}`);

  // ── 2. links ──────────────────────────────────────────────────────────
  const link = (from, name, to) =>
    field(base.id, id[from], { name, type: "multipleRecordLinks", options: { linkedTableId: id[to] } });

  await link("Contacts", "Company", "Companies");
  await link("Event Rows", "Contact", "Contacts");
  await link("Stage Transitions", "Contact", "Contacts");
  await link("Call Log", "Contact", "Contacts");
  console.log("  links done");

  // ── 3. Event Rows formulas ────────────────────────────────────────────
  // Remarks is deliberately excluded from both — see kpi-spec.md §5.
  const SIGNALS = ["Event Type", "Budget", "Timeline", "Pax"];
  await field(base.id, id["Event Rows"], {
    name: "Has Any Signal", type: "formula",
    description: "Any qualification field filled → the contact is a Right POC.",
    options: { formula: `IF(OR(${SIGNALS.map((f) => `{${f}} != ""`).join(", ")}), 1, 0)` },
  });
  await field(base.id, id["Event Rows"], {
    name: "Is Complete", type: "formula",
    description: "All qualification fields filled → a successful discovery call.",
    options: { formula: `IF(AND(${SIGNALS.map((f) => `{${f}} != ""`).join(", ")}), 1, 0)` },
  });

  // ── 4. Contacts rollups ───────────────────────────────────────────────
  const rollup = (table, name, linkField, target, formula, description) =>
    field(base.id, id[table], {
      name, type: "rollup", description,
      options: { recordLinkFieldId: linkField, fieldIdInLinkedTable: target, formula },
    });

  await rollup("Contacts", "Has Signal", "Event Rows", "Has Any Signal", "MAX(values)");
  await rollup("Contacts", "Has Complete Row", "Event Rows", "Is Complete", "MAX(values)");
  await rollup("Contacts", "Last Call At", "Call Log", "Called At", "MAX(values)",
    "Every call, not just stage changes — see kpi-spec.md §2.");
  await rollup("Contacts", "First Call At", "Call Log", "Called At", "MIN(values)");
  await rollup("Contacts", "Call Count", "Call Log", "Called At", "COUNTA(values)");
  await rollup("Contacts", "Last Stage Change At", "Stage Transitions", "Changed At", "MAX(values)");
  await rollup("Contacts", "First Stage Change At", "Stage Transitions", "Changed At", "MIN(values)");
  console.log("  contact rollups done");

  // ── 5. Contacts formulas ──────────────────────────────────────────────
  await field(base.id, id["Contacts"], {
    name: "Is Right POC", type: "formula",
    options: { formula: `IF({Has Signal} = 1, 1, 0)` },
  });
  await field(base.id, id["Contacts"], {
    name: "Right POC Name", type: "formula",
    description: "Name if this contact qualifies, blank otherwise. Rolled up into Companies.",
    options: { formula: `IF({Has Signal} = 1, {Name}, "")` },
  });
  await field(base.id, id["Contacts"], {
    name: "KPI Stage", type: "formula",
    options: { formula: ladderFormula("KPI Rank") },
  });
  // rank and timestamp packed into one sortable number so a MAX rollup picks
  // the highest rung and, among ties, the most recent one.
  await field(base.id, id["Contacts"], {
    name: "KPI Score", type: "formula",
    description: "KPI Rank * 1e10 + unix(KPI Rank At). Companies take MAX of this.",
    options: { formula: `IF({KPI Rank At}, {KPI Rank} * 10000000000 + DATETIME_DIFF({KPI Rank At}, ${EPOCH}, 'seconds'), {KPI Rank} * 10000000000)` },
  });

  // ── 6. Companies ──────────────────────────────────────────────────────
  await rollup("Companies", "Last Call At", "Contacts", "Last Call At", "MAX(values)",
    "Companies Reached is the count of rows where this is not blank.");
  await rollup("Companies", "First Call At", "Contacts", "First Call At", "MIN(values)");
  await rollup("Companies", "Ever Picked", "Contacts", "Ever Picked", "MAX(values)");
  await rollup("Companies", "KPI Score", "Contacts", "KPI Score", "MAX(values)");
  await rollup("Companies", "Right POC Contacts", "Contacts", "Right POC Name",
    "ARRAYJOIN(ARRAYCOMPACT(values), ', ')");
  await rollup("Companies", "Contact Count", "Contacts", "Name", "COUNTA(values)");

  await field(base.id, id["Companies"], {
    name: "Reached", type: "formula",
    options: { formula: `IF({Last Call At}, 1, 0)` },
  });
  await field(base.id, id["Companies"], {
    name: "Phone Picked", type: "formula",
    options: { formula: `IF({Ever Picked} = 1, 1, 0)` },
  });
  await field(base.id, id["Companies"], {
    name: "KPI Rank", type: "formula",
    options: { formula: `IF({KPI Score}, FLOOR({KPI Score} / 10000000000), 0)` },
  });
  await field(base.id, id["Companies"], {
    name: "KPI Stage", type: "formula",
    options: { formula: ladderFormula("KPI Rank") },
  });
  await field(base.id, id["Companies"], {
    name: "KPI Stage At", type: "formula",
    description: "When the company last moved up a rung — the last qualitative update.",
    options: { formula: `IF({KPI Score}, DATEADD(${EPOCH}, MOD({KPI Score}, 10000000000), 'seconds'))` },
  });

  console.log(`\nDone. https://airtable.com/${base.id}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
