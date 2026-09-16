#!/usr/bin/env node
/* Exercises every Kylas endpoint this project needs, in one run, and prints a
 * table of what worked.
 *
 *   KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620
 *   KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620 --contact 112936
 *   KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620 --contact 112936 --write
 *
 * Without --write it only reads: GETs and searches. Nothing in the CRM changes.
 * With --write it also tests the three writes the overlay depends on. Each is
 * either undone afterwards or reported as permanent — see WRITES below.
 *
 * Raw responses land in ./kylas-probe/ so the shapes can be read afterwards.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const KEY = process.env.KYLAS_KEY;
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const COMPANY = arg("company");
const CONTACT = arg("contact");
const WRITE = process.argv.includes("--write");

if (!KEY) {
  console.error("Set KYLAS_KEY — app.kylas.io/setup/integrations/api-keys/list");
  process.exit(1);
}

const OUT = "kylas-probe";
mkdirSync(OUT, { recursive: true });

const results = [];
let n = 0;

/* Kylas rate-limits hard: back-to-back requests start returning 429 within a
   few calls. Everything goes through one queue with a gap, and a 429 is retried
   with a widening wait rather than recorded as a failure. Without this the
   probe reports its own impatience as broken endpoints. */
const GAP = Number(process.env.KYLAS_GAP || 450);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(() => sleep(GAP)).then(fn));

async function api(label, method, path, body, opts = {}) {
  return queue(() => attempt(label, method, path, body, opts));
}

async function attempt(label, method, path, body, { quiet = false, tries = 4 } = {}) {
  const started = Date.now();
  let res, text;
  for (let i = 0; i < tries; i++) {
    try {
      res = await fetch(`https://api.kylas.io${path}`, {
        method,
        headers: { "api-key": KEY, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
    } catch (e) {
      results.push({ label, method, path, status: "network", note: e.message });
      if (!quiet) console.log(`  ✗ ${label} — ${e.message}`);
      return null;
    }
    if (res.status !== 429) break;
    const wait = 1200 * Math.pow(2, i);
    if (!quiet) console.log(`    · ${label} rate-limited, waiting ${wait}ms`);
    await sleep(wait);
  }
  const ms = Date.now() - started;
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${label.replace(/\W+/g, "-").slice(0, 44)}.json`;
  writeFileSync(file, text || "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  results.push({ label, method, path, status: res.status, ok: res.ok, ms, file,
                 note: res.ok ? "" : (json?.message || text || "").toString().slice(0, 120) });
  if (!quiet) console.log(`  ${res.ok ? "✓" : "✗"} ${label}  ${res.status}  ${ms}ms`);
  return res.ok ? json : null;
}

const list = (o) => Array.isArray(o) ? o : (o?.content || o?.data || o?.results || []);
const head = (s) => console.log(`\n${s}`);

/* ════════════════════════════════════════════════════════════════════ */
console.log(`Kylas endpoint probe — ${WRITE ? "READ + WRITE" : "read only"}\n`);

head("1 · identity");
const me = await api("users/me", "GET", "/v1/users/me");
if (!me) { console.error("\nKey rejected — nothing else can run."); report(); process.exit(1); }
console.log(`     ${me.firstName || ""} ${me.lastName || ""} · user ${me.id}`);
await api("users/{id}", "GET", `/v1/users/${me.id}`);

/* The response shape for picklists is not documented, so find any nested array
   of things that look like options instead of guessing at key names. */
function pickValues(field) {
  const found = [];
  (function walk(v, depth) {
    if (!v || depth > 4) return;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
        found.push(v.map((x) => x.name || x.displayName));
      else v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof v === "object") for (const k of Object.keys(v)) if (k !== "picklist" || true) walk(v[k], depth + 1);
  })(field, 0);
  return found.sort((a, b) => b.length - a.length)[0] || null;
}
const fieldType = (f) => f.type || f.dataType || f.fieldType || "?";
const fieldKey = (f) => f.name || f.displayName;

head("2 · contact schema and picklists");
const cf = await api("entities/contact/fields", "GET",
  "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
let stageField = null, companyField = null, ownerField = null;
const picklists = {};
if (cf) {
  const fs = list(cf);
  console.log(`     ${fs.length} fields, ${fs.filter((f) => f.standard === false).length} custom`);
  for (const f of fs) {
    const label = f.displayName || f.name;
    const vals = pickValues(f);
    if (vals) { picklists[label] = vals; console.log(`     · ${label} [${fieldType(f)}]: ${vals.join(" | ")}`); }
    if (/pipeline.*stage|stage.*bd/i.test(label || "")) stageField = f;
    if (/^company$/i.test(fieldKey(f) || "")) companyField = f;
    if (/^owner/i.test(fieldKey(f) || "")) ownerField = f;
  }
  console.log(`\n     BD stage   : ${stageField ? `"${stageField.displayName}" key=${fieldKey(stageField)} type=${fieldType(stageField)}` : "not on Contact"}`);
  console.log(`     company    : ${companyField ? `key=${fieldKey(companyField)} type=${fieldType(companyField)}` : "not found"}`);
  console.log(`     owner      : ${ownerField ? `key=${fieldKey(ownerField)} type=${fieldType(ownerField)}` : "not found"}`);
  if (stageField?.id) {
    const sp = await api("fields/{id} picklist", "GET", `/v1/fields/${stageField.id}`);
    const vals = sp && pickValues(sp);
    if (vals) { picklists["Pipeline Stage - BD"] = vals; console.log(`     >> STAGES: ${vals.join(" | ")}`); }
  }
}
await api("entities/lead/fields", "GET",
  "/v1/entities/lead/fields?entityType=lead&custom-only=false&page=0&size=200");
await api("entities/company/fields", "GET",
  "/v1/entities/company/fields?entityType=company&custom-only=false&page=0&size=200");

head("3 · company");
let company = null;
if (COMPANY) {
  company = await api("companies/{id}", "GET", `/v1/companies/${COMPANY}`);
  if (company) {
    console.log(`     name: ${company.name}`);
    const inline = Object.entries(company).find(([k, v]) => /contact/i.test(k) && Array.isArray(v) && v.length);
    console.log(inline
      ? `     >> contacts included inline as "${inline[0]}" (${inline[1].length}) — ONE call is enough`
      : `     >> no inline contacts — a contact search is needed`);
    const custom = company.customFieldValues || {};
    if (Object.keys(custom).length) console.log(`     custom: ${Object.keys(custom).join(", ")}`);
  }
} else console.log("     skipped — pass --company <id>");
await api("search/company", "POST", "/v1/search/company?page=0&size=5", {
  fields: ["id", "name", "ownerId", "customFieldValues"],
  jsonRule: freeText(""),
});

head("4 · contact search — which filters actually work");
const CFIELDS = ["id", "firstName", "lastName", "ownerId", "company", "designation",
                 "emails", "phoneNumbers", "customFieldValues", "updatedAt", "createdAt"];
function freeText(v) {
  return { condition: "AND", valid: true, rules: [
    { id: "multi_field", field: "multi_field", type: "multi_field", input: "multi_field", operator: "multi_field", value: v }] };
}
function rule(field, operator, value, type = "integer", input = "select") {
  return { condition: "AND", valid: true, rules: [{ id: field, field, type, input, operator, value }] };
}

await api("search/contact free text", "POST", "/v1/search/contact?page=0&size=5",
  { fields: CFIELDS, jsonRule: freeText("") });

if (COMPANY) {
  /* No per-field example exists in the Postman collection, so try the shapes a
     jQuery-QueryBuilder backend normally accepts and see which lands. */
  /* The first run returned 400 "Invalid Type" for type:"integer", so lead with
     whatever type the schema itself declares for the company field. */
  /* Settled on 2026-09-16: the schema calls company a LOOK_UP, but the query
     builder rejects that type and wants "long". Keep the others as fallbacks in
     case a future field behaves differently. */
  const key = companyField ? fieldKey(companyField) : "company";
  const attempts = [
    [`${key} equal (long)`, rule(key, "equal", Number(COMPANY), "long")],
    [`${key} in [long]`, rule(key, "in", [Number(COMPANY)], "long")],
    [`${key} equal (string)`, rule(key, "equal", String(COMPANY), "string", "text")],
  ];
  for (const [label, jsonRule] of attempts) {
    const r = await api(`search/contact ${label}`, "POST", "/v1/search/contact?page=0&size=10",
      { fields: CFIELDS, jsonRule });
    if (r) {
      const rows = list(r);
      console.log(`       >> WORKS — ${rows.length} contact(s)`);
      rows.slice(0, 3).forEach((x) => console.log(`          ${x.firstName || ""} ${x.lastName || ""} · ${x.designation || "—"}`));
      break;
    }
  }
}

/* ownerId is a LOOK_UP too, so it takes "long" for the same reason. */
await api("search/contact by owner", "POST", "/v1/search/contact?sort=updatedAt,desc&page=0&size=5",
  { fields: CFIELDS, jsonRule: rule("ownerId", "equal", me.id, "long") });
await api("search/contact due for a call", "POST", "/v1/search/contact?sort=updatedAt,desc&page=0&size=20",
  { fields: CFIELDS, jsonRule: { condition: "AND", valid: true, rules: [
      { id: "ownerId", field: "ownerId", type: "long", input: "select", operator: "equal", value: me.id },
      { id: "cfPipelineStageBd", field: "cfPipelineStageBd", type: "string", input: "select",
        operator: "not_in", value: ["NOT_INTERESTED", "INVALID_CONTACT", "GHOSTED"] }] } });
await api("search/contact sorted+paged", "POST", "/v1/search/contact?sort=updatedAt,desc&page=1&size=100",
  { fields: CFIELDS, jsonRule: freeText("") });

head("5 · one contact, in full");
let contact = null;
if (CONTACT) {
  contact = await api("contacts/{id}", "GET", `/v1/contacts/${CONTACT}`);
  if (contact) {
    console.log(`     ${contact.firstName || ""} ${contact.lastName || ""}`);
    console.log(`     keys: ${Object.keys(contact).slice(0, 18).join(", ")}…`);
    if (contact.customFieldValues) console.log(`     custom: ${Object.keys(contact.customFieldValues).join(", ") || "(none)"}`);
  }
  await api("call-logs for contact", "GET", `/v1/call-logs/${CONTACT}?relatedToType=contact`);
} else console.log("     skipped — pass --contact <id>");

head("6 · rate limit");
/* Deliberately unthrottled, and last, so the recovery wait cannot affect any
   other result. Earlier this ran mid-probe and every call after it failed. */
const burst = Date.now();
const codes = await Promise.all(Array.from({ length: 8 }, () =>
  fetch("https://api.kylas.io/v1/users/me", { headers: { "api-key": KEY } }).then((r) => r.status)));
const limited = codes.filter((c) => c === 429).length;
console.log(`     8 parallel requests in ${Date.now() - burst}ms · ${limited} returned 429`);
console.log(limited
  ? `     >> a burst of 8 is too fast. The writer must queue — ${GAP}ms between calls worked here.`
  : `     >> no limit hit at this rate`);
await sleep(3000);   // let the bucket refill before anything else runs

/* ════════════════ WRITES — only with --write ════════════════════════ */
if (WRITE) {
  head("7 · writes");
  if (!CONTACT) {
    console.log("     skipped — --write needs --contact <id>, ideally a test contact");
  } else {
    /* a. remarks round trip. The original is saved and restored afterwards. */
    const before = await api("contacts/{id} before write", "GET", `/v1/contacts/${CONTACT}`, null, { quiet: true });
    const originalRemarks = before?.remarks ?? null;
    writeFileSync(`${OUT}/contact-${CONTACT}-original.json`, JSON.stringify(before, null, 2));

    const MARK_A = "--- BD CONSOLE (auto, do not edit below) ---";
    const MARK_B = "--- END ---";
    const stamped = `${(originalRemarks || "").split(MARK_A)[0].trimEnd()}\n\n${MARK_A}\nprobe ${new Date().toISOString()}\n${MARK_B}`;
    const put = await api("PUT contacts/{id} remarks", "PUT", `/v1/contacts/${CONTACT}`, { remarks: stamped });
    if (put) {
      console.log(`     >> remarks write works — this is how overlay data reaches Kylas with no new fields`);
      const restore = { remarks: originalRemarks };
      const undo = await api("PUT contacts/{id} restore", "PUT", `/v1/contacts/${CONTACT}`, restore);
      console.log(undo ? "     >> original remarks restored" : "     !! COULD NOT RESTORE — see contact-*-original.json");
    }

    /* b. call log. There is no delete endpoint, so this one stays. */
    console.log("     note: a test call log CANNOT be deleted via the API and will remain on this contact");
    const cl = await api("POST call-logs", "POST", "/v1/call-logs/", {
      outcome: "connected", callType: "outgoing",
      startTime: new Date().toISOString(), duration: "1",
      phoneNumber: (before?.phoneNumbers?.[0]?.value) || "0000000000",
      notes: [{ description: "Endpoint probe — safe to delete." }],
      relatedTo: { entity: "contact", id: Number(CONTACT),
                   phoneNumber: (before?.phoneNumbers?.[0]?.value) || "0000000000" },
    });
    if (cl) console.log(`     >> call log created (id ${cl.id ?? "?"}) — delete it by hand in Kylas`);

    /* c. webhook round trip — fully reversible. */
    const wh = await api("POST webhooks", "POST", "/v1/webhooks/", {
      name: "enout-probe (delete me)", requestType: "POST",
      url: "https://example.invalid/enout-probe",
      authenticationType: "NONE", authenticationKey: null,
      events: ["CONTACT_CREATED", "CONTACT_UPDATED"], active: false,
    });
    if (wh?.id) {
      console.log(`     >> webhook created (${wh.id}) — CONTACT_UPDATED is available`);
      const del = await api("DELETE webhooks/{id}", "DELETE", `/v1/webhooks/${wh.id}`);
      console.log(del !== null ? "     >> webhook deleted" : `     !! delete it by hand: ${wh.id}`);
    }
  }
} else {
  head("7 · writes");
  console.log("     skipped. Re-run with --write --contact <id> to test the remarks write,");
  console.log("     the call log and the webhook round trip. Use a test contact if you have one.");
}

/* ════════════════════════════════════════════════════════════════════ */
report();

function report() {
  console.log(`\n${"─".repeat(72)}\nSUMMARY\n`);
  const pad = (s, n) => String(s).padEnd(n);
  for (const r of results.filter((x) => !/^burst/.test(x.label))) {
    console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${pad(r.status, 4)} ${pad(r.method, 6)} ${pad(r.label, 34)} ${r.note}`);
  }
  const fails = results.filter((r) => !r.ok && !/^burst/.test(r.label));
  console.log(`\n  ${results.length - fails.length}/${results.length} calls succeeded`);
  console.log(`  raw responses in ./${OUT}/ — send me that folder and I will wire the fetch`);
  if (!WRITE) console.log(`  nothing was created, updated or deleted`);

  const md = [
    `# Kylas probe — ${new Date().toISOString()}`, "",
    `User ${me?.id} · ${me?.firstName || ""} ${me?.lastName || ""}`,
    COMPANY ? `Company ${COMPANY}: ${company?.name || "?"}` : "", "",
    "## Picklists", "",
    ...Object.entries(picklists).map(([k, v]) => `- **${k}**: ${v.join(" | ")}`),
    "", "## Key fields", "",
    `- BD stage: ${stageField ? `\`${fieldKey(stageField)}\` (${fieldType(stageField)}) on Contact` : "not on Contact"}`,
    `- company: ${companyField ? `\`${fieldKey(companyField)}\` (${fieldType(companyField)})` : "?"}`,
    `- owner: ${ownerField ? `\`${fieldKey(ownerField)}\` (${fieldType(ownerField)})` : "?"}`,
    company ? `- company custom fields: ${Object.keys(company.customFieldValues || {}).join(", ") || "none"}` : "",
    "", "## Endpoints", "",
    "| ok | status | method | call | note |", "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.status} | ${r.method} | ${r.label} | ${(r.note || "").replace(/\|/g, "/")} |`),
  ].filter((x) => x !== "").join("\n");
  writeFileSync(`${OUT}/SUMMARY.md`, md);
  console.log(`\n  >> paste ./${OUT}/SUMMARY.md here — that is all I need`);
}
