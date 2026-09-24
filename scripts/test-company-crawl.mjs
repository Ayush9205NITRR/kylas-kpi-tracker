#!/usr/bin/env node
/* Past Kylas' 10,000-row search window: does the company crawl reach every
 * company?
 *
 *   node scripts/test-company-crawl.mjs
 *
 * Ayush's account: Kylas reports 17,926 companies and the paged search serves
 * 10,000, then a short page. The updatedAt-window crawl added nothing there.
 * Each case below is the mock Kylas with that ceiling plus one way the window
 * crawl can fail, and the crawl must still come back complete (or say plainly
 * that it could not).
 */
import { spawn } from "node:child_process";
import { createClient } from "./kylas.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

async function crawl(env, port) {
  const kid = spawn("node", ["scripts/mock-kylas.mjs"], { cwd: REPO, stdio: "ignore",
    env: { ...process.env, PORT: String(port), MOCK_MANY: "17926", MOCK_SEARCH_CEILING: "10000", ...env } });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/__writes`, { headers: { "api-key": "x" } }); break; }
      catch { await sleep(150); }
    }
    const lines = [];
    const k = createClient("x", { base: `http://127.0.0.1:${port}`, gap: 0, log: (m) => lines.push(m) });
    const list = await k.companies();
    return { list, search: k.lastCompanySearch(), lines };
  } finally { kid.kill("SIGKILL"); }
}

const ids = (l) => new Set(l.map((c) => String(c.id)));

console.log("\n1. the search cannot filter on updatedAt (the window crawl is unusable)");
let r = await crawl({ MOCK_NO_BOUND: "1" }, 9931);
const total = r.search.reportedTotal;
check("every company is reached", r.list.length === total && ids(r.list).size === total,
      `${r.list.length} of ${total}`);
check("and it is not reported as short", r.search.short === 0 && !r.search.hitTheirCeiling,
      `short=${r.search.short}`);
check("by reading oldest-first", r.search.reversePages > 0 && r.lines.some((l) => /oldest-first added/.test(l)),
      r.lines.find((l) => /oldest-first added/.test(l)));

console.log("\n2. bulk-imported companies sharing one timestamp (the window crawl stalls)");
r = await crawl({ MOCK_SAME_STAMP: "1" }, 9932);
check("every company is reached", r.list.length === r.search.reportedTotal, `${r.list.length} of ${r.search.reportedTotal}`);
check("no duplicates", ids(r.list).size === r.list.length);

console.log("\n3. a search that ignores the sort direction");
r = await crawl({ MOCK_NO_BOUND: "1", MOCK_IGNORE_ASC: "1" }, 9933);
check("stops after one page instead of reading the same rows again", r.search.reversePages === 1, `${r.search.reversePages} page(s)`);
check("and says the list is still short, by how much", r.search.short > 0 && r.search.hitTheirCeiling,
      `short=${r.search.short}`);

console.log("\n4. an account inside the window pays nothing extra");
r = await crawl({ MOCK_MANY: "3000" }, 9934);
check("no oldest-first pages when nothing is missing", r.search.reversePages === 0 && r.search.short === 0,
      `${r.list.length} companies, ${r.search.reversePages} extra page(s)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
