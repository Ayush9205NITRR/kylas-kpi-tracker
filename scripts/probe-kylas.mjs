#!/usr/bin/env node
/* Read-only probe of a live Kylas account. Answers the questions the Postman
 * collection leaves open, all in one run.
 *
 *   KYLAS_KEY=... node scripts/probe-kylas.mjs
 *   KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620
 *
 * Every call here is a GET or a search. Nothing is created, updated or deleted.
 * Raw responses are written to ./kylas-probe/ so the details can be read after.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const KEY = process.env.KYLAS_KEY;
const COMPANY = (process.argv[process.argv.indexOf("--company") + 1] || "").match(/^\d+$/)?.[0];
if (!KEY) { console.error("Set KYLAS_KEY. Get one at app.kylas.io/setup/integrations/api-keys/list"); process.exit(1); }

const OUT = "kylas-probe";
mkdirSync(OUT, { recursive: true });

let n = 0;
async function api(method, path, body, label) {
  const url = `https://api.kylas.io${path}`;
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: { "api-key": KEY, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    console.log(`  ✗ ${label}  network: ${e.message}`);
    return null;
  }
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${label.replace(/\W+/g, "-")}.json`;
  writeFileSync(file, text);
  if (!res.ok) {
    console.log(`  ✗ ${label}  HTTP ${res.status}  → ${file}`);
    return null;
  }
  console.log(`  ✓ ${label}  → ${file}`);
  try { return JSON.parse(text); } catch { return null; }
}

const list = (o) => Array.isArray(o) ? o : (o?.content || o?.data || []);

console.log("Probing Kylas (read-only)…\n");

/* ── 1. does the key work, and who is it ───────────────────────────── */
console.log("1. auth");
const me = await api("GET", "/v1/users/me", null, "users-me");
if (!me) { console.error("\nThe key was rejected. Nothing else can run."); process.exit(1); }
console.log(`     ${me.firstName || ""} ${me.lastName || ""} · id ${me.id} · tenant ${me.tenantId ?? "?"}\n`);

/* ── 2. the real picklists — closes kpi-spec §7 ────────────────────── */
console.log("2. contact fields and picklists");
const fields = await api("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200", null, "contact-fields");
if (fields) {
  const fs = list(fields);
  console.log(`     ${fs.length} fields, ${fs.filter((f) => !f.standard).length} custom`);
  for (const f of fs) {
    const picks = f.picklist?.picklistValues || f.pickLists || f.picklistValues;
    if (picks?.length) console.log(`     ${f.name || f.displayName}: ${picks.map((p) => p.name || p.displayName).join(" | ")}`);
  }
  const bd = fs.find((f) => /pipeline|stage|bd/i.test(f.displayName || f.name || ""));
  console.log(bd ? `\n     >> likely BD stage field: "${bd.displayName || bd.name}" (${f_type(bd)})`
                 : `\n     >> no obvious BD stage field on Contact — it may live on Lead instead`);
}
function f_type(f) { return f.type || f.dataType || "?"; }
console.log();

/* ── 3. the company page: does it hand us its contacts? ────────────── */
if (COMPANY) {
  console.log(`3. company ${COMPANY}`);
  const co = await api("GET", `/v1/companies/${COMPANY}`, null, "company-detail");
  if (co) {
    console.log(`     name: ${co.name}`);
    const inline = Object.entries(co).find(([k, v]) => /contact/i.test(k) && Array.isArray(v));
    console.log(inline
      ? `     >> contacts ARE included inline as "${inline[0]}" (${inline[1].length}) — one call is enough`
      : `     >> no inline contacts — a separate contact search is needed`);
    const cf = co.customFieldValues || {};
    if (Object.keys(cf).length) console.log(`     custom fields: ${Object.keys(cf).join(", ")}`);
  }

  /* Can we filter contacts by company? Every example in the Postman collection
     uses free-text multi_field, so the per-field rule shape is unverified.
     Try the standard query-builder shape and fall back to free text. */
  console.log("\n4. contacts for that company");
  const FIELDS = ["id", "firstName", "lastName", "ownerId", "company", "designation",
                  "emails", "phoneNumbers", "customFieldValues", "updatedAt"];
  const byField = await api("POST", "/v1/search/contact?page=0&size=10", {
    fields: FIELDS,
    jsonRule: { condition: "AND", valid: true, rules: [
      { id: "company", field: "company", type: "integer", input: "select", operator: "equal", value: Number(COMPANY) }] },
  }, "search-contact-by-company");
  if (byField) {
    const rows = list(byField);
    console.log(`     >> field filter WORKS — ${rows.length} contact(s)`);
    rows.slice(0, 3).forEach((r) => console.log(`        ${r.firstName || ""} ${r.lastName || ""} · ${r.designation || "—"}`));
  } else {
    console.log(`     >> field filter rejected; trying free text instead`);
    await api("POST", "/v1/search/contact?page=0&size=10", {
      fields: FIELDS,
      jsonRule: { condition: "AND", valid: true, rules: [
        { id: "multi_field", field: "multi_field", type: "multi_field", input: "multi_field", operator: "multi_field", value: String(COMPANY) }] },
    }, "search-contact-freetext");
  }
} else {
  console.log("3. company — skipped, pass --company <id> to test the company path\n");
}

/* ── 5. owner filter, which session mode needs ─────────────────────── */
console.log("\n5. contacts owned by this user (session mode)");
await api("POST", "/v1/search/contact?sort=updatedAt,desc&page=0&size=5", {
  fields: ["id", "firstName", "lastName", "ownerId", "company"],
  jsonRule: { condition: "AND", valid: true, rules: [
    { id: "ownerId", field: "ownerId", type: "integer", input: "select", operator: "equal", value: me.id }] },
}, "search-contact-by-owner");

/* ── 6. call-log outcome vocabulary ────────────────────────────────── */
console.log("\n6. reference data");
await api("GET", "/v1/pipelines/search?sort=updatedAt,desc&page=0&size=20", null, "pipelines");

console.log(`\nDone. ${n} response(s) in ./${OUT}/ — send me that folder and I will wire the fetch.`);
console.log("Nothing was created, updated or deleted.");
