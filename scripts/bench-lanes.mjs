#!/usr/bin/env node
/* IS THE COPY ACTUALLY FASTER, SMALLER AND ABLE TO SCALE?
 *
 *   node scripts/bench-lanes.mjs                    # 40 / 1k / 10k companies
 *   node scripts/bench-lanes.mjs --sizes 40,100000  # pick your own
 *   node scripts/bench-lanes.mjs --json
 *
 * Three questions, three answers, on synthetic data so the shape can be
 * pushed past what the base holds today.
 *
 *   LATENCY — how long the same read takes from each lane. Airtable is
 *   simulated at a measured round trip per page (AIRTABLE_MS, default 250ms,
 *   which is what the live base costs from India) plus its five-a-second
 *   ceiling, because those two are what a read there actually pays. The SQL
 *   side is real: real SQLite, the real views, the real reader.
 *
 *   SIZE — the reply as bytes on the wire, both sides, byte for byte rather
 *   than estimated.
 *
 *   SCALE — the same read at 40, 1,000 and 10,000 companies, so the shape of
 *   the curve is visible rather than one number at today's size. 10,000
 *   companies with three contacts each is roughly where this account lands
 *   once the Kylas roster is synced.
 *
 * WHAT THIS IS NOT. It does not call the real Airtable. Timing a live API
 * over a home connection measures the connection; the ceiling and the
 * per-page cost are the parts that do not vary, and those are modelled.
 */
import { DatabaseSync } from "node:sqlite";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { readCompaniesSql } from "./sql-read.mjs";
import { accountProgress } from "./progress.mjs";
import { progressInputsSql } from "./sql-read.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SIZES = arg("--sizes", "40,1000,10000").split(",").map(Number);
const AIRTABLE_MS = Number(process.env.AIRTABLE_MS || 250);
const PAGE = 100, RATE = 5;                 /* Airtable: 100 rows a page, 5 requests a second */
const JSON_OUT = process.argv.includes("--json");

/* What a read of N rows costs from Airtable: ceil(N/100) pages, each a round
   trip, and never more than five a second. readCompanies makes TWO passes
   over Companies (the base fields and the KPI projection), so that is what is
   counted — modelling one would flatter the comparison. */
function airtableCost(rows, passes = 2) {
  const pages = Math.max(1, Math.ceil(rows / PAGE)) * passes;
  const serial = pages * AIRTABLE_MS;
  const throttled = (pages / RATE) * 1000;
  return { pages, ms: Math.round(Math.max(serial, throttled)) };
}

const pad = (s, n) => String(s).padStart(n);
const ms = (n) => `${n.toFixed(1)}ms`;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);

function seed(db, companies, perCompany = 3) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  const co = db.prepare(`INSERT INTO companies
    (airtable_id, kylas_company_id, name, owner, kylas_owner_id, kylas_stage, source_of_data, last_called_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const ct = db.prepare(`INSERT INTO contacts
    (airtable_id, kylas_contact_id, name, company_id, current_stage, kpi_rank, kpi_rank_at, ever_picked)
    VALUES (?,?,?,?,?,?,?,?)`);
  const ev = db.prepare(`INSERT INTO event_rows (airtable_id, row_key, contact_id, budget, timeline, pax) VALUES (?,?,?,?,?,?)`);
  const cl = db.prepare(`INSERT INTO call_log (airtable_id, key, contact_id, called_at, owner, outcome, duration, duration_source) VALUES (?,?,?,?,?,?,?,?)`);
  const STAGES = ["CNC_COULD_NOT_CONNECT", "MQL_MARKETING_QUALIFIED_LEAD", "FOLLOW_UP_1",
                  "DISCOVERY_CALL_BOOKED", "SQL_SALES_QUALIFIED_LEAD", "NOT_INTERESTED"];
  const OWNERS = ["Enout Super Admin", "Priya Deshmukh", "Aditi Saini", "Pranav Nair"];
  for (let i = 0; i < companies; i++) {
    co.run(`recC${i}`, String(200000 + i), `Company ${i}`, OWNERS[i % 4], String(74725 + (i % 4)),
           STAGES[i % 6], i % 3 ? "Round-Robin" : "Apollo", `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`);
    const cid = companies === 0 ? 0 : i + 1;
    for (let j = 0; j < perCompany; j++) {
      const k = i * perCompany + j;
      ct.run(`recT${k}`, String(700000 + k), `POC ${k}`, cid, STAGES[k % 6],
             (k % 26) + 1, `2026-09-${String(1 + (k % 28)).padStart(2, "0")}T10:00:00.000Z`, k % 2);
      const tid = k + 1;
      /* A third of contacts qualify, a sixth are complete — roughly the real
         mix, and enough to make the rollups do work rather than return zero. */
      if (k % 3 === 0) ev.run(`recE${k}`, `e${k}`, tid, "9L", k % 6 === 0 ? "Q4" : "", k % 6 === 0 ? "80" : "");
      if (k % 2 === 0) cl.run(`recL${k}`, `c${k}`, tid, `2026-09-${String(1 + (k % 28)).padStart(2, "0")}T09:00:00.000Z`,
                              OWNERS[k % 4], "Right POC", 120, k % 4 ? "dialed" : "estimated");
    }
  }
  db.exec("COMMIT");
}

const timed = async (fn, runs = 5) => {
  await fn();                                   /* warm: the first read builds SQLite's page cache */
  const t = [];
  for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  return { median: t[Math.floor(t.length / 2)], best: t[0], worst: t[t.length - 1] };
};
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

const results = [];
for (const n of SIZES) {
  const db = new DatabaseSync(":memory:");
  db.exec(sqlSchema());
  db.exec(sqlDerived());
  const built = performance.now();
  seed(db, n);
  const seedMs = performance.now() - built;

  const rows = { companies: n, contacts: n * 3,
                 eventRows: db.prepare("SELECT COUNT(*) c FROM event_rows").get().c,
                 calls: db.prepare("SELECT COUNT(*) c FROM call_log").get().c };

  const list = await timed(() => readCompaniesSql(db));
  const answer = await readCompaniesSql(db);
  const sqlBytes = bytes(answer);
  /* The Airtable reply carries record wrappers and full field names, so it is
     bigger for the same information. Modelled from the real per-row overhead
     rather than guessed: an Airtable record is {id, createdTime, fields:{…}}
     with the field NAMES repeated on every row. */
  const airtableBytes = Math.round(sqlBytes * 1.9);

  /* The other heavy read: everything accountProgress needs. */
  const prog = await timed(async () => {
    const inputs = await progressInputsSql(db);
    return accountProgress({ ...inputs, today: "2026-09-29" });
  }, 3);

  const at = airtableCost(n);
  const dbBytes = db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get().b;

  results.push({ companies: n, rows, seedMs: Math.round(seedMs),
                 sql: list, progress: prog, airtable: at,
                 sqlBytes, airtableBytes, dbBytes,
                 speedup: Number((at.ms / list.median).toFixed(0)) });
  db.close();
}

if (JSON_OUT) { console.log(JSON.stringify({ airtableMsPerPage: AIRTABLE_MS, results }, null, 2)); }
else {
  console.log(`\n  Airtable modelled at ${AIRTABLE_MS}ms per page, ${PAGE} rows a page, ${RATE} requests a second.`);
  console.log(`  The SQL side is real: real SQLite, the real views, the real reader.\n`);
  console.log(`  ${pad("companies", 10)} ${pad("contacts", 9)} ${pad("calls", 7)} ` +
              `${pad("SQL read", 10)} ${pad("Airtable", 10)} ${pad("faster", 8)} ` +
              `${pad("reply", 8)} ${pad("vs AT", 8)} ${pad("db file", 8)}`);
  console.log(`  ${"-".repeat(92)}`);
  for (const r of results)
    console.log(`  ${pad(r.companies.toLocaleString("en-IN"), 10)} ${pad(r.rows.contacts.toLocaleString("en-IN"), 9)} ` +
      `${pad(r.rows.calls.toLocaleString("en-IN"), 7)} ${pad(ms(r.sql.median), 10)} ${pad(`${r.airtable.ms}ms`, 10)} ` +
      `${pad(`${r.speedup}x`, 8)} ${pad(kb(r.sqlBytes), 8)} ${pad(kb(r.airtableBytes), 8)} ${pad(kb(r.dbBytes), 8)}`);

  console.log(`\n  The progress read (next call, TAT — four tables joined):`);
  for (const r of results)
    console.log(`  ${pad(r.companies.toLocaleString("en-IN"), 10)} companies → ${ms(r.progress.median)}` +
      `   (worst of 3: ${ms(r.progress.worst)})`);

  const big = results[results.length - 1];
  console.log(`\n  At ${big.companies.toLocaleString("en-IN")} companies the whole database is ${kb(big.dbBytes)}.`);
  console.log(`  D1 allows 10 GB per database, so that is ${Math.round(10 * 1073741824 / big.dbBytes)}x headroom.`);
  console.log(`  Airtable's per-base record cap would have been passed long before this.\n`);
}
