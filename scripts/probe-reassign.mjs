#!/usr/bin/env node
/* THE LIVE RE-ASSIGN PROBE — one account, moved, checked field by field, and
 * put back exactly where it was.
 *
 *   node --env-file=.env.local scripts/probe-reassign.mjs --list
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903 --to 74726 --write
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903 --restore
 *
 * WHY THIS EXISTS. /reassign writes COMPANIES, which nothing in this codebase
 * had ever done against a live account, using a PUT that REPLACES the record.
 * The last time a replacing PUT went out here under-tested it deleted a real
 * person's name, phone and email. So the first real write is this: one
 * account, with a full before-and-after diff of every field on the company AND
 * on every contact it drags along, and a --restore that undoes it.
 *
 * WHAT IT CHECKS, which is the whole point:
 *   the owner actually moved, on the company AND on each contact
 *   NOTHING ELSE CHANGED — every other field is compared before against after
 *                          and any difference is printed as a FAULT
 *
 * A field Kylas normalises (a phone it reformats, a picklist it re-orders) will
 * show as a difference. That is worth seeing, not worth hiding: it is exactly
 * the class of thing that quietly eats data on the next thousand records.
 *
 * WHAT IT WILL NOT DO. It touches one company and that company's contacts, it
 * never creates anything, and without --write it reads only.
 */
import { companyBody, contactBody } from "./reassign.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const CO = arg("company");
const TO = arg("to");
const WRITE = process.argv.includes("--write");
const RESTORE = process.argv.includes("--restore");
const LIST = process.argv.includes("--list");

if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
if (!CO && !LIST) {
  console.error("Pass --company <kylas id> — an account you do not mind moving.\n" +
                "Don't know one? --list shows a few, with their owners and contact counts.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));   /* Kylas: ~5/s */
const H = { "api-key": KEY, "content-type": "application/json" };
/* 429 IS NOT A FAILURE, IT IS A WAIT. Kylas throttles at about five a second
   and the first version of this probe treated a 429 as fatal — which killed
   the run AFTER the company had been written and BEFORE its contacts were,
   leaving the account moved and its people behind. That is precisely the split
   state reassign.mjs' rule 4 exists to prevent, reintroduced by the tool
   meant to verify it. scripts/kylas.mjs has always retried; this now does too. */
async function call(method, path, body, tries = 0) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (r.status === 429 && tries < 6) {
    const wait = Number(r.headers.get("retry-after") || 0) * 1000 || (500 * 2 ** tries);
    console.log(`  429 on ${path}, waiting ${wait}ms`);
    await sleep(wait);
    return call(method, path, body, tries + 1);
  }
  if (!r.ok) {
    const e = new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status; throw e;
  }
  return json;
}
const rows = (r) => r?.content || r?.data || (Array.isArray(r) ? r : []);
const idOf = (v) => (v && typeof v === "object" ? (v.id ?? v.value) : v);

/* ── --list ──────────────────────────────────────────────────────────── */
if (LIST) {
  const r = await call("POST", "/v1/search/company?page=0&size=10&sort=updatedAt,desc",
    { fields: ["id", "name", "ownerId"], jsonRule: { condition: "AND", valid: true, rules: [] } });
  console.log("\nA few of your accounts, newest first:\n");
  for (const c of rows(r)) {
    const people = await call("POST", "/v1/search/contact?page=0&size=100",
      { fields: ["id"], jsonRule: { condition: "AND", valid: true,
        rules: [{ id: "company", field: "company", type: "long", operator: "equal", value: Number(c.id) }] } })
      .catch(() => null);
    console.log(`  ${String(c.id).padEnd(9)} ${String(c.name || "").slice(0, 38).padEnd(40)}` +
                `owner ${String(idOf(c.ownerId) ?? "—").padEnd(8)} ${rows(people).length} contact(s)`);
    await sleep(220);
  }
  console.log("\nUsers on this account:\n");
  const us = await call("GET", "/v1/users?page=0&size=50").catch(() => null);
  for (const u of rows(us)) console.log(`  ${String(u.id).padEnd(9)} ${[u.firstName, u.lastName].filter(Boolean).join(" ")}`);
  console.log("\nThen: --company <id> --to <userId>            (reads only)" +
              "\n      --company <id> --to <userId> --write    (moves it)" +
              "\n      --company <id> --restore                (puts it back)\n");
  process.exit(0);
}

/* ── snapshot ────────────────────────────────────────────────────────── */
const snapFile = `/tmp/reassign-probe-${CO}.json`;
const { readFileSync, writeFileSync, existsSync } = await import("node:fs");

async function readAll() {
  const company = await call("GET", `/v1/companies/${CO}`);
  await sleep(220);
  const found = await call("POST", "/v1/search/contact?page=0&size=100",
    { fields: ["id"], jsonRule: { condition: "AND", valid: true,
      rules: [{ id: "company", field: "company", type: "long", operator: "equal", value: Number(CO) }] } });
  const contacts = [];
  for (const p of rows(found)) { contacts.push(await call("GET", `/v1/contacts/${p.id}`)); await sleep(220); }
  return { company, contacts };
}

/* Every leaf, flattened, so "nothing else changed" is a claim about the whole
   record and not about the handful of fields somebody remembered to list. */
function flat(o, prefix = "", out = {}) {
  if (o === null || typeof o !== "object") { out[prefix] = o; return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => flat(v, `${prefix}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(o)) flat(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
/* metaData.idNameStore is Kylas' own cache of "id -> display name" for the
   lookups on the record. When the owner changes, the entry for the OLD owner
   goes and one for the new one appears — that is the owner change being
   reflected, not a second field being edited, and flagging it buries the real
   diffs under noise. */
const IGNORE = /(^|\.)(updatedAt|updatedBy|recordActions|lastModified)|^metaData\.idNameStore\.ownerId\./;
function diff(before, after) {
  const a = flat(before), b = flat(after), out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORE.test(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      out.push({ key: k, before: a[k], after: b[k] });
  }
  return out;
}

const before = await readAll();
const heldCo = String(idOf(before.company.ownerId) ?? "");
console.log(`\ncompany ${CO} — ${before.company.name}`);
console.log(`  owner now      ${heldCo}${before.company.ownerId?.name ? ` (${before.company.ownerId.name})` : ""}`);
console.log(`  contacts       ${before.contacts.length}`);
for (const c of before.contacts)
  console.log(`    ${String(c.id).padEnd(9)} ${[c.firstName, c.lastName].filter(Boolean).join(" ").padEnd(24)}` +
              `owner ${idOf(c.ownerId) ?? "—"}  ` +
              `phones ${(c.phoneNumbers || []).map((p) => p.value).join("/") || "—"}  ` +
              `emails ${(c.emails || []).map((e) => e.value).join("/") || "—"}`);

/* ── --restore ───────────────────────────────────────────────────────── */
if (RESTORE) {
  if (!existsSync(snapFile)) { console.error(`\nNo snapshot at ${snapFile} — nothing to restore from.`); process.exit(1); }
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  console.log(`\nrestoring from ${snapFile} (taken ${snap.at})`);
  await call("PUT", `/v1/companies/${CO}`, companyBody(snap.company, idOf(snap.company.ownerId)));
  await sleep(220);
  for (const c of snap.contacts) {
    await call("PUT", `/v1/contacts/${c.id}`, contactBody(c, idOf(c.ownerId)));
    await sleep(220);
  }
  const now = await readAll();
  const d = [...diff(snap.company, now.company),
             ...snap.contacts.flatMap((c, i) => diff(c, now.contacts.find((n) => n.id === c.id) || {}))];
  console.log(d.length ? `\n! ${d.length} field(s) did not come back identical:` : "\nrestored — every field matches the snapshot.");
  for (const x of d.slice(0, 40)) console.log(`   ${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
  process.exit(0);
}

if (!TO) { console.error("\nPass --to <userId> (see --list) to say who it should move to."); process.exit(1); }
if (TO === heldCo) { console.error(`\nIt already belongs to ${TO} — pick somebody else, or there is nothing to prove.`); process.exit(1); }

console.log(`\nwould move company ${CO} and ${before.contacts.length} contact(s): ${heldCo} -> ${TO}`);
if (!WRITE) {
  console.log("\nREAD ONLY. The payload the company write would send:\n");
  console.log(JSON.stringify(companyBody(before.company, TO), null, 2).slice(0, 1800));
  console.log("\nAdd --write to actually move it. A snapshot is saved first, and\n" +
              "--restore puts everything back.\n");
  process.exit(0);
}

/* ── the write ───────────────────────────────────────────────────────── */
writeFileSync(snapFile, JSON.stringify({ at: new Date().toISOString(), ...before }, null, 2));
console.log(`\nsnapshot saved to ${snapFile} — --restore undoes everything below.\n`);

await call("PUT", `/v1/companies/${CO}`, companyBody(before.company, TO));
console.log("  company written");
await sleep(220);
for (const c of before.contacts) {
  await call("PUT", `/v1/contacts/${c.id}`, contactBody(c, TO));
  console.log(`  contact ${c.id} written`);
  await sleep(220);
}

const after = await readAll();

/* ── the verdict ─────────────────────────────────────────────────────── */
let faults = 0;
const ok = (what, cond) => { if (!cond) faults++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`); };
console.log("\n── did the owner move ──");
ok(`company ${CO} is now owned by ${TO}`, String(idOf(after.company.ownerId)) === String(TO));
for (const c of after.contacts)
  ok(`contact ${c.id} is now owned by ${TO}`, String(idOf(c.ownerId)) === String(TO));

console.log("\n── did anything else change ──");
const coDiff = diff(before.company, after.company).filter((d) => !/^ownerId/.test(d.key));
ok(`company: nothing but the owner changed`, coDiff.length === 0);
for (const d of coDiff) console.log(`     ! ${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
for (const b of before.contacts) {
  const a = after.contacts.find((x) => x.id === b.id) || {};
  const cd = diff(b, a).filter((d) => !/^ownerId/.test(d.key));
  ok(`contact ${b.id}: nothing but the owner changed`, cd.length === 0);
  for (const d of cd) console.log(`     ! ${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
}

console.log(`\n${faults ? `${faults} FAULT(S) — do not run this in bulk yet.` : "Clean. The move changed the owner and nothing else."}`);
console.log(`Put it back with:  node --env-file=.env.local scripts/probe-reassign.mjs --company ${CO} --restore\n`);
process.exit(faults ? 1 : 0);
