#!/usr/bin/env node
/* TAT out of a spreadsheet, so the numbers can be checked before anything is
 * built.
 *
 *   node scripts/tat-from-csv.mjs docs/tat-sample.csv
 *   node scripts/tat-from-csv.mjs export.csv --today 2026-09-28 --working
 *   node scripts/tat-from-csv.mjs export.csv --cohort rightToDiscovery
 *
 * Ayush, 2026-09-27: "sample data how would it look, what formula to use and
 * how can I calculate it."
 *
 * This is the answer key. Export the five date columns from Airtable, run it,
 * and compare against what your sheet says — if the two disagree, one of the
 * formulas in docs/tat-by-hand.md has been typed wrong, and it is much
 * cheaper to find that out now than after a number with somebody's name on it
 * has been shown in a meeting.
 *
 * It uses the same tat.mjs the product will use, deliberately. A second
 * implementation for the spreadsheet stage would be a second set of answers,
 * and then the day the dashboard ships nobody knows which one was right.
 *
 * COLUMNS, matched case-insensitively and by several spellings each, because
 * an Airtable export is named however the base is named:
 *   Company · BD/Owner · Created At · First Call · Right POC · Discovery · SQL
 * Blank means "has not happened yet" — which is a row the arithmetic MUST
 * keep, not skip. Those are the accounts still waiting, and they are the
 * whole reason a median on its own lies.
 */
import { readFileSync } from "node:fs";
import { TAT_PAIRS, tatMatrix, tatCohort, tatWorkList } from "./tat.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] || true) : fallback;
};
const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--today"
                              && argv[argv.indexOf(a) - 1] !== "--cohort");
if (!file) {
  console.error("usage: node scripts/tat-from-csv.mjs <file.csv> [--today YYYY-MM-DD] [--working] [--cohort <pair>]");
  process.exit(2);
}

/* A real CSV parser, not a split on commas: company names have commas in them
   ("Nirvana Hotels, Pune") and a split would silently shift every date one
   column to the left — which does not error, it just returns wrong numbers. */
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const ALIASES = {
  company: ["company", "company name", "name", "account"],
  bd: ["bd", "owner", "associate", "bda", "assigned to"],
  created: ["created at", "created", "kylas created at", "create date"],
  worked: ["first call", "first reachout", "first worked at", "worked", "first touch"],
  right: ["right poc", "first right poc at", "right poc at", "right"],
  discovery: ["discovery", "discovery call", "first discovery at", "discovery at"],
  sql: ["sql", "sql at", "qualified", "sql date"],
};

const table = parseCSV(readFileSync(file, "utf8"));
const header = table[0].map((h) => h.trim().toLowerCase());
const colOf = (key) => {
  for (const a of ALIASES[key]) { const i = header.indexOf(a); if (i > -1) return i; }
  return -1;
};
const cols = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, colOf(k)]));
for (const need of ["company", "bd", "right"])
  if (cols[need] < 0) {
    console.error(`! no column for ${need}. Looked for: ${ALIASES[need].join(", ")}`);
    console.error(`  the file has: ${header.join(" | ")}`);
    process.exit(2);
  }

/* A bare date means midday, not midnight. Midnight sits on the boundary
   between two days in any timezone but UTC, so a sheet exported in IST would
   otherwise shift half the rows back a day and quietly change every gap. */
const at = (s) => {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T12:00:00Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};

const arrivals = [], created = {}, owners = {};
let skipped = 0;
for (const r of table.slice(1)) {
  const company = (r[cols.company] || "").trim();
  const bd = (r[cols.bd] || "").trim();
  if (!company) { skipped++; continue; }
  owners[company] = bd;
  const c = at(r[cols.created]);
  if (c) created[company] = c;
  for (const [metric, key] of [["worked", "worked"], ["right", "right"],
                               ["discovery", "discovery"], ["sql", "sql"]]) {
    const v = cols[key] > -1 ? at(r[cols[key]]) : "";
    if (v) arrivals.push({ metric, company, owner: bd, at: v });
  }
}

const today = flag("today");
const now = today && today !== true ? Date.parse(`${today}T12:00:00Z`) : Date.now();
const useWorkingDays = !!flag("working", false);

const nCo = Object.keys(owners).length;
console.log(`${file} — ${nCo} ${nCo === 1 ? "company" : "companies"}, ${arrivals.length} dated rungs` +
            (skipped ? `, ${skipped} row(s) with no company skipped` : ""));
console.log(`as at ${new Date(now).toISOString().slice(0, 10)}, in ${useWorkingDays ? "WORKING" : "calendar"} days\n`);

const m = tatMatrix({ arrivals, created, owners, now, useWorkingDays });

/* One table per step rather than one wide grid: six pairs times seven numbers
   does not fit a terminal, and a grid that wraps is a grid nobody reads. */
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const show = (v) => (v === null || v === undefined ? "–" : String(v));

for (const p of TAT_PAIRS) {
  const t = m.team[p.key];
  if (!t.n && !t.waiting) continue;
  const tag = p.composite ? "  (composite — do not judge one person on it)"
            : p.planning ? "  (planning number, not a coaching one)" : "";
  console.log(`${p.label}   gate ${p.gate}d${tag}`);
  console.log(`  ${pad("BD", 10)}${lpad("n", 4)}${lpad("median", 8)}${lpad("p75", 6)}` +
              `${lpad("vs team", 9)}${lpad("waiting", 9)}${lpad("oldest", 8)}${lpad("overdue", 9)}`);
  /* The team row has nothing to compare itself against, so it never prints a
     delta — least of all "thin", which would read as a caveat on the one row
     that carries every account. */
  const line = (name, c, isTeam = false) =>
    console.log(`  ${pad(name, 10)}${lpad(c.n, 4)}${lpad(show(c.median), 8)}${lpad(show(c.p75), 6)}` +
                `${lpad(isTeam ? "–" : c.vsTeam === null ? (c.thin ? "thin" : "–")
                                  : c.vsTeam > 0 ? `+${c.vsTeam}` : c.vsTeam, 9)}` +
                `${lpad(c.waiting, 9)}${lpad(show(c.waitingOldest), 8)}${lpad(c.overdue, 9)}`);
  for (const bd of m.bds) line(bd, m.byBd[bd][p.key]);
  line("TEAM", t, true);
  console.log();
}

if (m.anomalies.negative || m.anomalies.orphan) {
  console.log("data faults — excluded from the arithmetic, never clamped to zero:");
  for (const n of m.anomalies.detail.negative)
    console.log(`  ! ${n.company}: ${n.pair} ends ${-n.days} day(s) BEFORE it starts`);
  for (const o of m.anomalies.detail.orphan)
    console.log(`  ! ${o.company}: reached the end of ${o.pair} with no start date`);
  console.log();
}

const pair = flag("cohort");
if (pair && pair !== true) {
  console.log(`cohort — of the accounts that reached the start of ${pair} in each month,\n` +
              `         how many finished inside the gate:\n`);
  console.log(`  ${pad("month", 9)}${lpad("arrived", 9)}${lpad("in gate", 9)}${lpad("%", 7)}` +
              `${lpad("still open", 12)}   settled`);
  for (const c of tatCohort({ arrivals, created, owners, pair, now }))
    console.log(`  ${pad(c.key, 9)}${lpad(c.arrived, 9)}${lpad(c.hit, 9)}${lpad(`${c.pct}%`, 7)}` +
                `${lpad(c.stillOpen, 12)}   ${c.settled ? "yes" : "no — still inside the gate"}`);
  console.log();
}

const work = tatWorkList({ arrivals, created, owners, now, limit: 15 });
if (work.length) {
  console.log(`work list — open and past the gate, longest first:\n`);
  for (const w of work)
    console.log(`  ${pad(w.company, 20)}${pad(w.owner, 10)}${pad(w.label, 28)}` +
                `${lpad(`${w.days}d`, 6)}  (gate ${w.gate}d)`);
}
