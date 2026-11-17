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
  /* MOCK_USER_LIST=1: /allot-people needs a user list, and §9 asks it for one. */
  start("scripts/mock-kylas.mjs", { PORT: "9900", MOCK_USER_LIST: "1" }); await wait("http://127.0.0.1:9900/__writes");
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

  console.log("\n8. re-assign a contact to another BD, immediately");
  /* The owner is the ONE field this is allowed to change. Everything else —
     the name included, which /contact-move is allowed to normalise — must come
     back byte for byte, because the PUT replaces the record. */
  const oBefore = await K("/v1/contacts/112936");
  const ownerOf = (c) => String(c?.ownerId?.id ?? c?.ownerId ?? "");
  const stripO = (c) => { const { updatedAt, updatedBy, metaData, ownerId, ...rest } = c || {}; return JSON.stringify(rest); };
  const noKid = await post("/contact-owner", { ownerId: "74726" });
  ok("no kid -> 400", noKid.status === 400);
  const noOwner = await post("/contact-owner", { kid: "112936" });
  ok("no ownerId -> 400", noOwner.status === 400);
  const ghost = await post("/contact-owner", { kid: "99999999", ownerId: "74726" });
  ok("a contact Kylas has never seen -> 404, and says to save it first",
     ghost.status === 404 && /save it once/i.test(JSON.stringify(ghost.j)), JSON.stringify(ghost.j).slice(0, 140));
  const stranger = await post("/contact-owner", { kid: "112936", ownerId: "99999" });
  ok("an owner who is not a Kylas user -> 400", stranger.status === 400, JSON.stringify(stranger.j).slice(0, 120));
  const ro = await post("/contact-owner", { kid: "112936", ownerId: "74726" });
  const oAfter = await K("/v1/contacts/112936");
  ok("the re-assign answers ok, from -> to", ro.status === 200 && ro.j.ok && ro.j.to === "74726", JSON.stringify(ro.j));
  ok("Kylas: the contact now belongs to the new owner", ownerOf(oAfter) === "74726", ownerOf(oAfter));
  ok("Kylas: NOTHING else on the contact changed", stripO(oBefore) === stripO(oAfter),
     `${stripO(oBefore).slice(0, 120)} vs ${stripO(oAfter).slice(0, 120)}`);
  const ctO = await (await fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts", { headers: { Authorization: "Bearer pat_mock" } })).json();
  const rowO = (ctO.records || []).find((x) => x.fields?.["Kylas Contact ID"] === "112936");
  ok("Airtable: the copy carries the new owner", !!rowO?.fields?.Owner && rowO.fields["Kylas Owner ID"] === "74726",
     JSON.stringify(rowO?.fields?.Owner));
  const back74725 = await post("/contact-owner", { kid: "112936", ownerId: "74725" });
  ok("undo gives it back", back74725.j.ok && ownerOf(await K("/v1/contacts/112936")) === "74725");
  const sameOwner = await post("/contact-owner", { kid: "112936", ownerId: "74725" });
  ok("re-assigning to the owner it already has changes nothing", sameOwner.j.unchanged === true);

  console.log("\n8b. Source of Data when Kylas has no list for it");
  /* Ayush, 2026-11-17: "While creating companies source of data dropdown is
     not coming". On his account the COMPANY field is free text, so there were
     no options, the form rendered an empty dropdown, and no company could be
     created at all. Three shapes, all of which must leave the form usable. */
  {
    const one = async (env, what) => {
      const procs2 = [];
      const st = (file, e = {}) => procs2.push(spawn("node", [file], { cwd: REPO, env: { ...process.env, ...ENV, ...e }, stdio: "ignore" }));
      try {
        st("scripts/mock-kylas.mjs", { PORT: "9902", ...env });
        await wait("http://127.0.0.1:9902/__writes");
        st("scripts/proxy.mjs", { KYLAS_BASE: "http://127.0.0.1:9902", KYLAS_KEY: "x",
          AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock",
          AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH", PORT: "8789" });
        await wait("http://127.0.0.1:8789/health");
        const r = await (await fetch("http://127.0.0.1:8789/company-form")).json();
        console.log(`  (${what}: ${r.sources?.length || 0} option(s), free=${r.sourceFree}, seen=${(r.sourceSeen || []).length})`);
        return r;
      } finally { for (const x of procs2) { try { x.kill("SIGKILL"); } catch {} } }
    };
    const inline = await one({}, "inline picklist");
    ok("a picklist inline still gives the options", inline.sources?.length === 3 && inline.sourceFree === false);
    const viaField = await one({ MOCK_SOURCE_VIA_FIELD: "1" }, "picklist, values only on /v1/fields/{id}");
    ok("options not inline are fetched from the field itself", viaField.sources?.length === 3 && viaField.sourceFree === false,
       JSON.stringify(viaField.sources || []).slice(0, 120));
    const free = await one({ MOCK_SOURCE_TEXT: "1" }, "free text (Ayush's account)");
    ok("free text says so instead of offering an empty list", free.sourceFree === true && (free.sources || []).length === 0,
       JSON.stringify({ free: free.sourceFree, n: free.sources?.length }));
    ok("...and suggests what the account already uses", Array.isArray(free.sourceSeen) && free.sourceSeen.length > 0
       && free.sourceSeen.every((x) => x.label), JSON.stringify((free.sourceSeen || []).slice(0, 4)));
  }
  /* And a free-text source must still create: the write path sends the text. */
  {
    const procs3 = [];
    try {
      procs3.push(spawn("node", ["scripts/mock-kylas.mjs"], { cwd: REPO, stdio: "ignore",
        env: { ...process.env, ...ENV, PORT: "9903", MOCK_SOURCE_TEXT: "1" } }));
      await wait("http://127.0.0.1:9903/__writes");
      procs3.push(spawn("node", ["scripts/proxy.mjs"], { cwd: REPO, stdio: "ignore",
        env: { ...process.env, KYLAS_BASE: "http://127.0.0.1:9903", KYLAS_KEY: "x",
               AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock",
               AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH", PORT: "8790" } }));
      await wait("http://127.0.0.1:8790/health");
      const r = await fetch("http://127.0.0.1:8790/company-create", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...FORM, name: "Freetext Source Co", source: "GPTW + Re-allotment" }) });
      const j = await r.json();
      ok("a typed Source of Data creates the company", r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 160));
      const made = await (await fetch("http://127.0.0.1:9903/__companies", { headers: { "api-key": "x" } })).json();
      const co = made.find((c) => c.name === "Freetext Source Co");
      ok("...and Kylas got the text, not an option id",
         co?.customFieldValues?.cfSourceOfData === "GPTW + Re-allotment", JSON.stringify(co?.customFieldValues));
    } finally { for (const x of procs3) { try { x.kill("SIGKILL"); } catch {} } }
  }

  console.log("\n9. handing accounts over is no longer admin-only");
  /* 1.84.2 opened /reassign, /allot and /allot-people to every BD (Ayush,
     2026-11-16), with the actor logged instead. The target checks stayed. */
  const people = await get("/allot-people");
  ok("/allot-people answers for a non-admin", Array.isArray(people.people) && people.people.length > 0,
     JSON.stringify(people).slice(0, 140));
  const dry = await post("/reassign", { companies: ["1776620"], ownerId: "74726" });
  ok("/reassign dry run answers for a non-admin, and writes nothing",
     dry.status === 200 && dry.j.dryRun === true, `${dry.status} ${JSON.stringify(dry.j).slice(0, 140)}`);
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
