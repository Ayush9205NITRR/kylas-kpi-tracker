#!/usr/bin/env node
/* THE CARD'S COMPANY PICKER: search by name, create one, never twice.
 *
 *   node scripts/test-company-create.mjs
 *
 * Starts its own mock Kylas, mock Airtable and proxy (test-idempotency's
 * shape) and asserts, against the real routes:
 *   - companyKey: "Acme Pvt. Ltd", "ACME", "The Acme Co" are one key
 *   - /company-search finds by prefix and contains, across owners
 *   - /company-create makes the company in Kylas, owned by the caller, and
 *     writes the Airtable Companies row at once
 *   - the same name again (any spelling of it) is refused with the existing
 *     account, and nothing new is created in Kylas
 */
import { spawn } from "node:child_process";
import { companyKey, rankCompanies } from "./fields.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ENV = { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK", PORT: "8787" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`); };

console.log("1. one key per company");
ok("Acme Pvt. Ltd = ACME", companyKey("Acme Pvt. Ltd") === companyKey("ACME"));
ok("The Acme Co = acme", companyKey("The Acme Co") === "acme");
ok("A & B Logistics = a and b logistics", companyKey("A & B Logistics") === companyKey("a and b logistics"));
ok("Limited alone is still a name", companyKey("Limited") === "limited");
const r = rankCompanies("acm", [{ name: "Bacme" }, { name: "Acme Co" }, { name: "Zeta" }]);
ok("prefix ranks above contains", r[0]?.name === "Acme Co" && r[1]?.name === "Bacme" && r.length === 2, JSON.stringify(r));

const procs = [];
const start = (file, env = {}) => procs.push(spawn("node", [file], { cwd: REPO, env: { ...process.env, ...ENV, ...env }, stdio: "ignore" }));
const wait = async (url) => { for (let i = 0; i < 60; i++) { try { await fetch(url); return; } catch { await sleep(300); } } throw new Error(`${url} never came up`); };
try {
  start("scripts/mock-kylas.mjs", { PORT: "9900" }); await wait("http://127.0.0.1:9900/__writes");
  start("scripts/mock-airtable.mjs", { PORT: "9901" }); await wait("http://127.0.0.1:9901/v0/appMOCK/Companies");
  start("scripts/proxy.mjs"); await wait("http://127.0.0.1:8787/health");
  const get = async (p) => (await fetch(`http://127.0.0.1:8787${p}`)).json();
  const post = async (p, body) => { const x = await fetch(`http://127.0.0.1:8787${p}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: x.status, j: await x.json() }; };

  console.log("\n2. search");
  const s1 = await get("/company-search?q=shore");
  ok("finds Shorehouse Retail by prefix", (s1.companies || []).some((c) => c.name === "Shorehouse Retail"), JSON.stringify(s1).slice(0, 200));
  const s2 = await get("/company-search?q=house");
  ok("...and by a word inside the name", (s2.companies || []).some((c) => c.name === "Shorehouse Retail"));
  ok("names the owner", (s1.companies || []).find((c) => c.name === "Shorehouse Retail")?.owner);
  const s3 = await get("/company-search?q=a");
  ok("one letter asks for nothing", Array.isArray(s3.companies) && s3.companies.length === 0);

  console.log("\n3. create");
  const c1 = await post("/company-create", { name: "Bluefin Labs Pvt Ltd" });
  ok("created", c1.status === 200 && c1.j.ok && c1.j.company?.id, JSON.stringify(c1));
  const made = await (await fetch("http://127.0.0.1:9900/__companies", { headers: { "api-key": "x" } })).json();
  ok("in Kylas, once", made.length === 1 && made[0].name === "Bluefin Labs Pvt Ltd", JSON.stringify(made));
  ok("owned by the caller (the key's user, 74725)", made[0]?.ownerId === 74725, String(made[0]?.ownerId));
  const at = await (await fetch("http://127.0.0.1:9901/v0/appMOCK/Companies", { headers: { Authorization: "Bearer pat_mock" } })).json();
  ok("the Airtable Companies row is there now", (at.records || []).some((x) => x.fields?.["Kylas Company ID"] === String(c1.j.company?.id) && x.fields?.Name === "Bluefin Labs Pvt Ltd"));
  const s4 = await get("/company-search?q=bluefin");
  ok("searchable straight away, before any crawl", (s4.companies || []).some((c) => String(c.id) === String(c1.j.company?.id)));

  console.log("\n4. never twice");
  for (const spelling of ["Bluefin Labs", "BLUEFIN LABS PRIVATE LIMITED", "bluefin-labs", "Shorehouse Retail Ltd"]) {
    const c = await post("/company-create", { name: spelling });
    ok(`"${spelling}" refused with the existing account`, c.status === 200 && c.j.ok === false && (c.j.exists || []).length >= 1, JSON.stringify(c.j).slice(0, 160));
  }
  const after = await (await fetch("http://127.0.0.1:9900/__companies", { headers: { "api-key": "x" } })).json();
  ok("...and Kylas still holds exactly one new company", after.length === 1, String(after.length));
  const c5 = await post("/company-create", { name: "x" });
  ok("a one-letter name is refused", c5.status === 400);
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
