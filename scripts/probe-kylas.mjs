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

async function api(label, method, path, body, { quiet = false } = {}) {
  const started = Date.now();
  let res, text;
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

head("2 · contact schema and picklists");
const cf = await api("entities/contact/fields", "GET",
  "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
let stageField = null;
if (cf) {
  const fs = list(cf);
  console.log(`     ${fs.length} fields, ${fs.filter((f) => f.standard === false).length} custom`);
  for (const f of fs) {
    const name = f.displayName || f.name;
    const picks = f.picklist?.picklistValues || f.picklistValues || f.pickLists;
    if (picks?.length) console.log(`     · ${name}: ${picks.map((p) => p.name || p.displayName).join(" | ")}`);
    if (/pipeline|stage/i.test(name || "")) stageField = f;
  }
  console.log(stageField
    ? `     >> BD stage looks like a Contact field: "${stageField.displayName || stageField.name}"`
    : `     >> no pipeline/stage field on Contact — it is probably on Lead`);
  if (stageField?.id) await api("fields/{id} picklist", "GET", `/v1/fields/${stageField.id}`);
}
await api("entities/lead/fields", "GET",
  "/v1/entities/lead/fields?entityType=lead&custom-only=false&page=0&size=200");
await api("pipelines/search", "GET", "/v1/pipelines/search?sort=updatedAt,desc&page=0&size=20");

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
  const attempts = [
    ["company equal (number)", rule("company", "equal", Number(COMPANY))],
    ["company equal (string)", rule("company", "equal", String(COMPANY), "string", "text")],
    ["company in [number]", rule("company", "in", [Number(COMPANY)])],
    ["companyId equal", rule("companyId", "equal", Number(COMPANY))],
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

await api("search/contact by owner", "POST", "/v1/search/contact?sort=updatedAt,desc&page=0&size=5",
  { fields: CFIELDS, jsonRule: rule("ownerId", "equal", me.id) });
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
const burst = Date.now();
const codes = await Promise.all(Array.from({ length: 8 }, (_, i) =>
  api(`burst ${i + 1}`, "GET", "/v1/users/me", null, { quiet: true }).then(() => results.at(-1).status)));
const limited = codes.filter((c) => c === 429).length;
console.log(`     8 parallel requests in ${Date.now() - burst}ms · ${limited} rate-limited (429)`);
console.log(limited ? `     >> there IS a per-second limit; the writer must queue` : `     >> no limit hit at this rate`);

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
}
