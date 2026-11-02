#!/usr/bin/env node
/* THE RELEASE GATE FOR STORE=d1: the same suites, on both stores, side by side.
 *
 *   node scripts/test-parity.mjs            # ~15 minutes
 *   node scripts/test-parity.mjs --quick    # test-worker only
 *
 * Ayush, 2026-11-03: "the same system must run without any differences." This
 * is that sentence as a pass/fail. Each suite runs three ways:
 *
 *   airtable     the mock Airtable, as every suite always has
 *   d1 (REST)    MOCK_AIRTABLE_STORE=d1 — the same mock URL, but every KPI
 *                table answered by airtable-d1.mjs over real SQLite. Proves the
 *                engine speaks Airtable: shapes, formulas, errors, paging.
 *   d1 (binding) test-worker only — the Worker itself runs STORE=d1 with a
 *                KPI_DB binding, writing to D1 in-process exactly as on
 *                Cloudflare. Proves the switch, the stamps, the wiring.
 *
 * The gate: every suite passes on airtable and on d1 (REST), and the binding
 * run fails nothing outside the list below.
 *
 * EXPECTED IN THE BINDING RUN ONLY, each a property of the test harness and
 * not of the store — reviewed 2026-11-03, and kept here so a new failure is
 * never waved through as "one of those":
 */
const BINDING_EXPECTED = {
  "tables are copied one per run, not all at once":
    "checks the Airtable read-copy of the KPI tables; on D1 there is no copy (D1 is the store)",
  "a save stores the call-back on the contact and on the call":
    "reads the mock's write log; in-process D1 writes do not pass through the mock (the row is in D1)",
  "Company List is copied from the RESEARCH base, not the KPI one":
    "passes on Airtable only because the mock ignores the base id; the worker that refreshes the copy here has no RESEARCH_BASE, production always does",
  "Account Pipeline Stage reaches the accounts list": "follows from the Company List copy above",
  "...and so do the two links the columns render": "follows from the Company List copy above",
  "/enrich-status says where the enrichment came from and how much joined": "follows from the Company List copy above",
};
/* Suites whose subject exists only on Airtable — skipped on d1, with the reason. */
const AIRTABLE_ONLY = {
  "test-mirror": "the read-copy of Airtable; with STORE=d1 there is nothing to copy",
  "test-behind-base": "an Airtable base one repair behind the code; D1 tables are built from the code",
  "test-shadow": "pulls Airtable into D1 before the switch; off once D1 is the store",
};
const SUITES = ["test-worker", "test-dialler", "test-idempotency", "test-etag", "test-push-track",
  "test-migration", "test-ladder-migration", "test-bulk-tag"];

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const quick = process.argv.includes("--quick");
const run = (suite, env) => {
  const r = spawnSync("node", [`scripts/${suite}.mjs`], { cwd: REPO, env: { ...process.env, ...env },
    encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /(\d+) passed, (\d+) failed/.exec(out.split("\n").filter((l) => /passed, \d+ failed/.test(l)).pop() || "");
  const fails = out.split("\n").filter((l) => /^\s*!?\s*FAIL\b/.test(l))
    .map((l) => l.replace(/^\s*!?\s*FAIL\s+/, "").split("  — ")[0].trim());
  return { passed: m ? +m[1] : 0, failed: m ? +m[2] : (r.status ? 1 : 0), fails, code: r.status };
};

let bad = 0;
const rows = [];
for (const s of quick ? ["test-worker"] : SUITES) {
  const a = run(s, {});
  const d = AIRTABLE_ONLY[s] ? null : run(s, { MOCK_AIRTABLE_STORE: "d1" });
  let b = null;
  if (s === "test-worker") {
    const file = join(tmpdir(), `parity-kpi-${process.pid}.sqlite`);
    rmSync(file, { force: true });
    b = run(s, { MOCK_AIRTABLE_STORE: "d1", MOCK_AIRTABLE_D1_FILE: file, TEST_STORE: "d1-binding" });
    rmSync(file, { force: true });
    b.unexpected = b.fails.filter((f) => !BINDING_EXPECTED[f]);
  }
  const okRow = a.failed === 0 && (!d || d.failed === 0) && (!b || b.unexpected.length === 0);
  if (!okRow) bad++;
  rows.push([s, `${a.passed}/${a.passed + a.failed}`, d ? `${d.passed}/${d.passed + d.failed}` : "n/a",
    b ? `${b.passed}/${b.passed + b.failed} (${b.fails.length - b.unexpected.length} expected)` : "", okRow ? "ok" : "DIFFERS"]);
  console.log(rows.at(-1).join("  |  "));
  for (const f of [...(a.failed ? a.fails.map((x) => `airtable: ${x}`) : []),
                   ...(d?.failed ? d.fails.map((x) => `d1: ${x}`) : []),
                   ...(b?.unexpected || []).map((x) => `binding: ${x}`)]) console.log(`    ! ${f}`);
}
for (const [s, why] of Object.entries(AIRTABLE_ONLY)) console.log(`${s}  |  airtable only — ${why}`);
console.log(bad ? `\n${bad} suite(s) differ — STORE=d1 is not ready.` : `\nNo differences. STORE=d1 behaves as STORE=airtable.`);
process.exit(bad ? 1 : 0);
