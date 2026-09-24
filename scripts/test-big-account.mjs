#!/usr/bin/env node
/* An account the size of Ayush's, end to end through the handlers:
 *
 *   node scripts/test-big-account.mjs
 *
 * 17,926 companies behind Kylas' 10,000-row search window. The maintenance
 * run must reach all of them, keep them (in pieces, when the stored copy is
 * big — forced small here), and a fresh instance must serve every one from
 * that copy without asking Kylas again.
 */
import { spawn } from "node:child_process";
import { createHandlers } from "./handlers.mjs";
import { d1Store } from "./store.mjs";
import { fakeD1 } from "./d1-fake.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const kid = spawn("node", ["scripts/mock-kylas.mjs"], { cwd: REPO, stdio: "ignore",
  env: { ...process.env, PORT: "9951", MOCK_MANY: "17926", MOCK_SEARCH_CEILING: "10000", MOCK_NO_BOUND: "1" } });
for (let i = 0; i < 50; i++) {
  try { await fetch("http://127.0.0.1:9951/__writes", { headers: { "api-key": "x" } }); break; } catch { await sleep(150); }
}
let kylasCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, ...a) => { if (/:9951\//.test(String(u))) kylasCalls++; return realFetch(u, ...a); };

const db = fakeD1();
const env = { KYLAS_KEY: "x", KYLAS_BASE: "http://127.0.0.1:9951", KYLAS_GAP: "0", VERSION: "t",
              KEPT_PART_CHARS: "20000" };
const make = () => createHandlers({ env, store: d1Store(db), cache: d1Store(db), log: () => {}, db });
const u = new URL("http://x/companies?owner=all");

console.log("\n1. the first request, before any crawl");
const a = await make();
const first = await a.routes["/companies"](u, {});
check("says it is building, does not crawl inline", first.building === true);

console.log("\n2. the maintenance run");
const out = await a.maintain();
check("reads every company, past the 10,000 window", out.kylasCompanies?.companies >= 17926, JSON.stringify(out.kylasCompanies));
const keys = await d1Store(db).keys();
const parts = keys.filter((k) => k.startsWith("shared:kylas-companies#"));
check("and keeps the list in pieces when it is big", parts.length > 1, `${parts.length} pieces`);

console.log("\n3. a fresh instance");
const b = await make();
const c0 = kylasCalls;
const served = await b.routes["/companies"](u, {});
check("serves every company from the kept copy", served.companies.length >= 17926 && !served.building,
      `${served.companies.length} companies`);
check("without asking Kylas for the list again", kylasCalls - c0 <= 3, `${kylasCalls - c0} Kylas call(s)`);
check("and does not call the list short", !served.truncated && !served.hitTheirCeiling, `short=${served.short}`);

globalThis.fetch = realFetch;
kid.kill("SIGKILL");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
