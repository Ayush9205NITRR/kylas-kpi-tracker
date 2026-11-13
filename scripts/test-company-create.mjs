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
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH", PORT: "8787" };
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
  const FORM = { ownerId: "74725", source: "COLD_CALLING", linkedin: "https://www.linkedin.com/company/bluefin-labs", empBand: "201-500" };
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
  const c1 = await post("/company-create", { ...FORM, name: "Bluefin Labs Pvt Ltd", revenue: "25,000,000", fundingType: "Series A", totalFunding: 12000000, industry: "IT & Software", subIndustry: "SaaS & Software", city: "bangalore" });
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
    const c = await post("/company-create", { ...FORM, name: spelling });
    ok(`"${spelling}" refused with the existing account`, c.status === 200 && c.j.ok === false && (c.j.exists || []).length >= 1, JSON.stringify(c.j).slice(0, 160));
  }
  const after = await (await fetch("http://127.0.0.1:9900/__companies", { headers: { "api-key": "x" } })).json();
  ok("...and Kylas still holds exactly one new company", after.length === 1, String(after.length));
  const c5 = await post("/company-create", { ...FORM, name: "x" });
  ok("a one-letter name is refused", c5.status === 400);

  console.log("\n5. the form's required fields");
  for (const [k, label] of [["source", "Source of Data"], ["linkedin", "LinkedIn"], ["empBand", "employee size"]]) {
    const c = await post("/company-create", { ...FORM, name: `Missing ${k} Co`, [k]: "" });
    ok(`no ${label} -> 400`, c.status === 400, JSON.stringify(c.j).slice(0, 100));
  }
  const bad = await post("/company-create", { ...FORM, name: "Bad Link Co", linkedin: "https://example.com/acme" });
  ok("a LinkedIn URL that is not a company page -> 400", bad.status === 400, JSON.stringify(bad.j).slice(0, 100));
  const badSrc = await post("/company-create", { ...FORM, name: "Bad Source Co", source: "NOT_A_SOURCE" });
  ok("an unknown Source of Data -> 400", badSrc.status === 400);
  const badOwner = await post("/company-create", { ...FORM, name: "Bad Owner Co", ownerId: "99999" });
  ok("an owner who is not an active user -> 400", badOwner.status === 400);
  const noType = await post("/company-create", { ...FORM, name: "Funding No Type Co", totalFunding: 5 });
  ok("funding numbers without a funding type -> 400", noType.status === 400);

  console.log("\n6. what the full create wrote");
  const w = await (await fetch("http://127.0.0.1:9900/__companies", { headers: { "api-key": "x" } })).json();
  const blue = w.find((c) => c.name === "Bluefin Labs Pvt Ltd");
  ok("Kylas got Source of Data as its option id", blue?.customFieldValues?.cfSourceOfData === 9201, JSON.stringify(blue?.customFieldValues));
  ok("Kylas got ONLY name, owner and Source of Data", blue && Object.keys(blue.customFieldValues || {}).join() === "cfSourceOfData"
     && !("city" in blue) && !("linkedin" in blue) && !("numberOfEmployees" in blue), JSON.stringify(blue).slice(0, 200));
  const cl = await (await fetch("http://127.0.0.1:9901/v0/appRESEARCH/Company%20List", { headers: { Authorization: "Bearer pat_mock" } })).json();
  const r = (cl.records || []).find((x) => x.fields?.["Kylas Company Id"] === String(blue?.id))?.fields || {};
  ok("Company List: employees = band midpoint (350)", r["Employees (Manual)"] === 350, JSON.stringify(r).slice(0, 200));
  ok("Company List: revenue, funding type and total as entered", r["Revenue (Manual)"] === 25000000 && r["Funding Type (Manual)"] === "Series A" && r["Total Funding (Manual)"] === 12000000);
  ok("Company List: industry, sub-industry, city", r["Industry Group"] === "IT & Software" && r["Sub-industry"] === "SaaS & Software" && r["HQ City"] === "Bengaluru");
  ok("Company List: who and when", !!r["Manual By"] && /^\d{4}-\d{2}-\d{2}$/.test(r["Manual At"] || ""));
  const form = await get("/company-form");
  ok("/company-form lists sources, bands, industries, cities", form.sources?.length === 3 && form.bands?.length === 8 && Object.keys(form.industries || {}).length >= 15 && form.cities?.includes("Bengaluru"));

  console.log("\n7. move a contact to another company, immediately");
  const K = async (path) => { for (let i = 0; i < 8; i++) { const r = await fetch(`http://127.0.0.1:9900${path}`, { headers: { "api-key": "x" } });
    if (r.status !== 429) return r.json(); await sleep(1200); } throw new Error("mock kept rate limiting"); };
  const cBefore = await K("/v1/contacts/112936");
  /* The name is the one other thing a write changes on purpose: the whole
     name goes into lastName (POC Name), firstName empty. */
  const strip = (c) => { const { company, updatedAt, updatedBy, metaData, firstName, lastName, ...rest } = c || {}; return JSON.stringify(rest); };
  const mv = await post("/contact-move", { kid: "112936", companyId: "903", companyName: "Shorehouse Retail" });
  const cAfter = await K("/v1/contacts/112936");
  const coOf = (c) => String(c?.company?.id ?? c?.company ?? "");
  ok("the move answers ok, from -> to", mv.status === 200 && mv.j.ok && mv.j.from === "1776620" && mv.j.to === "903", JSON.stringify(mv.j));
  ok("Kylas: the contact now belongs to the new company", coOf(cAfter) === "903", coOf(cAfter));
  ok("Kylas: nothing else on the contact changed", strip(cBefore) === strip(cAfter), `${strip(cBefore).slice(0, 120)} vs ${strip(cAfter).slice(0, 120)}`);
  const ct = await (await fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts", { headers: { Authorization: "Bearer pat_mock" } })).json();
  const cos = await (await fetch("http://127.0.0.1:9901/v0/appMOCK/Companies", { headers: { Authorization: "Bearer pat_mock" } })).json();
  const row = (ct.records || []).find((x) => x.fields?.["Kylas Contact ID"] === "112936");
  const shore = (cos.records || []).find((x) => x.fields?.["Kylas Company ID"] === "903");
  ok("Airtable: the contact is linked to the new company", !!row && !!shore && (row.fields.Company || []).includes(shore.id), JSON.stringify(row?.fields?.Company));
  const undo = await post("/contact-move", { kid: "112936", companyId: "1776620" });
  ok("undo moves it back", undo.j.ok && coOf(await K("/v1/contacts/112936")) === "1776620");
  const same = await post("/contact-move", { kid: "112936", companyId: "1776620" });
  ok("moving to the company it is already in changes nothing", same.j.unchanged === true);
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
