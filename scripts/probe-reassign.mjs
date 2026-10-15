#!/usr/bin/env node
/* THE LIVE RE-ASSIGN PROBE — one account, moved, checked field by field, and
 * put back exactly where it was.
 *
 *   node --env-file=.env.local scripts/probe-reassign.mjs --users
 *   node --env-file=.env.local scripts/probe-reassign.mjs --list
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903 --to 74726 --write
 *   node --env-file=.env.local scripts/probe-reassign.mjs --company 903 --restore
 *
 * TO SETTLE WHETHER AN ACCOUNT'S OWNER CAN MOVE AT ALL (the open question):
 *
 *   node --env-file=.env.local scripts/probe-reassign.mjs --users
 *   node --env-file=.env.local scripts/probe-reassign.mjs --list
 *   node --env-file=.env.local scripts/probe-reassign.mjs \
 *        --company <id from --list> --reassign-endpoint <id from --users>
 *
 * Pick a --reassign-endpoint the account's contacts are NOT already on, or the
 * control is a no-op that reports success. It writes one contact (and puts it
 * back) and tries six bodies on one company, reading the record back after
 * every one.
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
import { contactBody } from "./reassign.mjs";

/* THE COMPANY BODY LIVES HERE NOW, AND ONLY HERE.
   reassign.mjs used to export one. It was removed the day Kylas proved a
   company PUT carrying ownerId is accepted and silently dropped — which, on a
   replacing PUT, erases the owner. Nothing in the product may build one again;
   test-replace asserts it. But this file is the tool for INVESTIGATING that
   endpoint, and it still has to be able to send a company body to find out
   what Kylas will take. So the copy is here, in the probe, where no save, cron
   or console request can ever reach it. */
const SERVER_KEYS = new Set([
  "id", "createdAt", "updatedAt", "createdBy", "updatedBy", "recordActions",
  "entityType", "actualValue", "hasDuplicate", "converted", "convertedAt",
  "convertedBy", "pipeline", "stageUpdatedAt", "associatedContacts",
  "metaData", "idNameStore", "companyStage", "lastActivityAt",
  "nextActivityAt", "score", "duplicateOf", "ownerName",
]);
const cfOf = (v) => (Array.isArray(v) ? v.map(cfOf)
  : v && typeof v === "object" ? (v.id ?? v.value) : v);
/* Only an object whose keys are JUST id and name is a lookup. A phone number
   has a `.value` too, and collapsing on that flattened it to a bare string —
   destroying the type and primary flag. */
const isLookup = (v) => !!v && typeof v === "object" && !Array.isArray(v)
  && v.id !== undefined && Object.keys(v).every((k) => k === "id" || k === "name");
const topOf = (v) => (Array.isArray(v) ? (v.every(isLookup) ? v.map((x) => x.id) : v)
  : isLookup(v) ? v.id : v);
function companyBody(base, ownerId) {
  const body = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (SERVER_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    body[k] = k === "customFieldValues"
      ? Object.fromEntries(Object.entries(v || {})
          .map(([kk, raw]) => [kk, cfOf(raw)])
          .filter(([, id]) => id !== undefined && id !== null && id !== ""))
      : topOf(v);
  }
  if (!body.name) throw new Error("the company Kylas returned has no name — refusing to write it back");
  body.ownerId = Number(ownerId);
  return body;
}

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const CO = arg("company");
const TO = arg("to");
const WRITE = process.argv.includes("--write");
const RESTORE = process.argv.includes("--restore");
const LIST = process.argv.includes("--list");
const USERS = process.argv.includes("--users");

if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
/* A PLACEHOLDER IS NOT AN ID. `--company ACCOUNT_ID` — the literal text out of
   an instruction — went to Kylas, came back 400, and surfaced as an unhandled
   Error with a stack trace, which reads like the tool is broken rather than
   like the argument is. Every id here is numeric; anything else is caught
   before a request goes out. */
for (const [flag, val] of [["company", CO], ["to", TO]]) {
  if (val === undefined) continue;
  if (!/^\d+$/.test(String(val))) {
    console.error(`\n--${flag} wants a numeric Kylas id, not "${val}".`);
    console.error(flag === "company"
      ? "Run --list and copy an id from the second block (the accounts that have contacts)."
      : "Run --users and copy an id from the ID column.");
    console.error("");
    process.exit(1);
  }
}
if (!CO && !LIST && !USERS && !arg("set-contact-owner")) {
  console.error("Pass --company <kylas id> — an account you do not mind moving.\n" +
                "Don't know one? --list shows a few, with their owners and contact counts.\n" +
                "--users shows who you can hand an account to, with their ids.");
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

/* THE SHAPES KYLAS ACTUALLY ACCEPTS, copied from scripts/kylas.mjs rather than
   invented here. The first version of this probe sent {rules: []} for "give me
   everything", which the mock tolerates and the live account refuses with
   003008 "Group's rules can not be empty". The free-text rule with an empty
   value is the documented floor — proven live on 2026-09-16 — and `input:
   "select"` is not optional on a field rule however redundant it looks. */
const everything = () => ({ condition: "AND", valid: true, rules: [
  { id: "multi_field", field: "multi_field", type: "multi_field",
    input: "multi_field", operator: "multi_field", value: "" }] });
const equals = (field, value, type = "long") => ({ condition: "AND", valid: true,
  rules: [{ id: field, field, type, input: "select", operator: "equal", value }] });
const contactsOf = (companyId) => call("POST", "/v1/search/contact?page=0&size=100",
  { fields: ["id"], jsonRule: equals("company", Number(companyId)) });
const idOf = (v) => (v && typeof v === "object" ? (v.id ?? v.value) : v);

/* ── WHERE A COMPANY'S OWNER ACTUALLY READS ───────────────────────────
   NOT from GET /v1/companies/{id}. That read does not carry ownerId on this
   account — all 273 companies of the October batch read "owner NONE" through
   it on 2026-10-12, and aristocrat (1780629) read "(none)" on 2026-10-15 while
   the SEARCH endpoint said 82867 in the same session.

   This cost a wrong answer. The owner probe read the single GET before and
   after each write, got "(none)" both times, and reported ACCEPTED AND IGNORED
   — when all it had established was that the field is invisible to that read.
   A blind readback proves nothing in either direction, and the whole point of
   the probe is that a 200 means nothing without one.

   So the owner is read from the search, which is the only shape that returns
   it, with the single GET as a fallback for an account where it does. */
/* The same narrating PUT as the owner probe's, hoisted so the repair flag
   above can use it too: status AND body, with a 429 wait. */
async function rawPutTop(path, body) {
  for (let t = 0; t < 6; t++) {
    try {
      const r = await fetch(`${BASE}${path}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
      const text = await r.text();
      if (r.status === 429 && t < 5) {
        const wait = Number(r.headers.get("retry-after") || 0) * 1000 || (500 * 2 ** t);
        await sleep(wait); continue;
      }
      return { status: r.status, body: text };
    } catch (e) { return { status: 0, body: `network error: ${e.message}` }; }
  }
  return { status: 429, body: "still throttled" };
}

const companyOwner = async (id) => {
  /* BOTH KEYS. Kylas carries a record's owner as `ownedBy` and the search also
     answers `ownerId`; asking for one and not the other is how a readback goes
     blind, which already cost one wrong verdict. */
  const r = await call("POST", "/v1/search/company?page=0&size=1",
    { fields: ["id", "name", "ownerId", "ownedBy"], jsonRule: equals("id", Number(id)) }).catch(() => null);
  const hit = rows(r).find((c) => String(c.id) === String(id));
  const pick = (o) => (o?.ownedBy !== undefined && idOf(o.ownedBy) != null ? idOf(o.ownedBy) : idOf(o?.ownerId));
  if (hit && (hit.ownerId !== undefined || hit.ownedBy !== undefined))
    return { id: pick(hit), via: `search:${hit.ownedBy !== undefined ? "ownedBy" : "ownerId"}` };
  const one = await call("GET", `/v1/companies/${id}`).catch(() => null);
  return { id: pick(one), via: one ? "GET (the search did not answer)" : "neither read answered" };
};

/* ── --users ─────────────────────────────────────────────────────────────
   WHO YOU CAN HAND SOMETHING TO. Every other flag here takes a Kylas USER ID
   and there was no way to find one from this tool — the id had to come from
   somebody's memory or a URL, and a typo'd id is indistinguishable from an
   endpoint that does not work ("owner reads 74756" says nothing about whether
   74756 is a person). Two shapes, because Kylas documents neither: the paged
   one first, then the bare one. Copied from kylas.mjs' own users(). */
if (USERS) {
  const shapes = [["GET /v1/users?page=0&size=200", "/v1/users?page=0&size=200"],
                  ["GET /v1/users", "/v1/users"]];
  let found = null, how = "";
  for (const [name, path] of shapes) {
    try {
      const list = rows(await call("GET", path));
      if (list.length) { found = list; how = name; break; }
      console.log(`  ${name} answered with no rows`);
    } catch (e) { console.log(`  ${name} -> ${e.status || "?"} ${String(e.message).slice(-90)}`); }
    await sleep(300);
  }
  if (!found) {
    console.log(`\nNo user-list endpoint answered. Open any contact in Kylas and read the`);
    console.log(`owner's id out of the URL, or pass --reassign-endpoint a value you know.\n`);
    process.exit(1);
  }
  console.log(`\n${found.length} user(s), via ${how}:\n`);
  console.log(`  ${"ID".padEnd(9)} ${"NAME".padEnd(26)} ${"EMAIL".padEnd(32)} ACTIVE`);
  for (const u of found) {
    const nm = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(unnamed)";
    const active = u.active ?? u.isActive ?? u.status ?? "";
    console.log(`  ${String(u.id).padEnd(9)} ${nm.slice(0, 25).padEnd(26)} ` +
                `${String(u.email || "").slice(0, 31).padEnd(32)} ${active === true ? "yes" : active === false ? "no" : String(active)}`);
  }
  console.log(`\nPass one of those ids as --reassign-endpoint <id> or --to <id>.\n`);
  process.exit(0);
}

/* ── --list ──────────────────────────────────────────────────────────── */
if (LIST) {
  const r = await call("POST", "/v1/search/company?page=0&size=10&sort=updatedAt,desc",
    { fields: ["id", "name", "ownerId"], jsonRule: everything() });
  console.log("\nA few of your accounts, newest first:\n");
  const ownerIds = new Set();
  for (const c of rows(r)) {
    const people = await contactsOf(c.id).catch(() => null);
    const owner = idOf(c.ownerId);
    if (owner != null) ownerIds.add(String(owner));
    console.log(`  ${String(c.id).padEnd(9)} ${String(c.name || "").slice(0, 38).padEnd(40)}` +
                `owner ${String(owner ?? "—").padEnd(8)} ${rows(people).length} contact(s)`);
    await sleep(220);
  }

  /* ACCOUNTS THAT ACTUALLY HAVE POCs, found from the OTHER SIDE.
     The list above showed ten accounts with 0 contacts each. On a fresh batch
     that is the truth; on a broken query it is also exactly what you see — and
     the query in question is the one reassign.mjs uses to decide which
     contacts follow an account. A cascade that silently moves nobody would
     still print "clean", so this gets checked BEFORE anything is written.

     Ask for recent CONTACTS, group them by the company each one names, then
     ask for each of those companies' contacts the way reassign.mjs will. If
     contacts plainly name a company and the per-company search returns none
     for it, the filter is broken and the probe says so in as many words. */
  console.log("\nAccounts that have contacts on them — test the cascade on one of these:\n");
  /* metaData carries Kylas' id -> display-name cache, which is where a
     lookup's NAME lives; without it every row here printed a bare id. */
  const recent = await call("POST", "/v1/search/contact?page=0&size=100&sort=updatedAt,desc",
    { fields: ["id", "firstName", "lastName", "company", "ownerId", "metaData"], jsonRule: everything() })
    .catch((e) => { console.log(`  ! could not list contacts: ${e.message.slice(0, 140)}`); return null; });
  const byCo = new Map();
  for (const c of rows(recent)) {
    const cid = String(idOf(c.company) ?? "");
    if (!cid) continue;
    const named = c.company?.name || c.metaData?.idNameStore?.company?.[cid] || "";
    const at = byCo.get(cid) || { id: cid, name: named, n: 0 };
    if (!at.name && named) at.name = named;
    at.n++; byCo.set(cid, at);
  }
  const top = [...byCo.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  let broken = 0;
  for (const t of top) {
    const back = rows(await contactsOf(t.id).catch(() => null)).length;
    if (!back) broken++;
    console.log(`  ${String(t.id).padEnd(9)} ${String(t.name || "").slice(0, 34).padEnd(36)}` +
                `${back} contact(s) by company-filter, ${t.n} seen naming it` +
                `${back ? "" : "   <-- MISMATCH"}`);
    await sleep(220);
  }
  if (!top.length) console.log("  (none found in the last 100 contacts)");
  else if (broken === top.length) {
    console.log("\n  ! THE PER-COMPANY CONTACT FILTER IS NOT WORKING ON THIS ACCOUNT.");
    console.log("    Contacts exist and name these companies, but asking for one company's");
    console.log("    contacts returns none. reassign.mjs uses that same search to decide");
    console.log("    which contacts follow an account — so the cascade would move NOBODY");
    console.log("    and still report success. Do NOT run --write. Send this output back.");
  }

  /* WHO YOU CAN HAND THEM TO. Kylas documents /v1/users/{id} but NOT a list
     endpoint, so kylas.mjs tries the likely list shapes and falls back to
     resolving the ids it already holds one at a time. Same ladder here — the
     first version called one undocumented shape, swallowed the error, and
     printed an empty list, which reads as "you have no colleagues". */
  console.log("\nUsers on this account:\n");
  let users = [];
  for (const shape of [
    () => call("GET", "/v1/users?page=0&size=200"),
    () => call("GET", "/v1/users"),
    () => call("POST", "/v1/search/user?page=0&size=200",
      { fields: ["id", "firstName", "lastName", "email"], jsonRule: everything() }),
  ]) {
    try { const got = rows(await shape()); if (got.length) { users = got; break; } } catch { /* next */ }
    await sleep(220);
  }
  if (!users.length) {
    /* The documented, certain floor: resolve the owners actually seen above. */
    for (const id of ownerIds) {
      try { users.push(await call("GET", `/v1/users/${id}`)); } catch { /* skip */ }
      await sleep(220);
    }
    if (users.length) console.log("  (no list endpoint on this account — these are the owners seen above)");
  }
  for (const u of users)
    console.log(`  ${String(u.id).padEnd(9)} ${[u.firstName, u.lastName].filter(Boolean).join(" ")}` +
                `${u.email ? `  ${u.email}` : ""}`);
  if (!users.length) console.log("  none resolved — pass --to with a Kylas user id you know.");
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
  const found = await contactsOf(CO);
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
/* updatedVia* is Kylas' AUDIT TRAIL — what made the last edit, not what the
   record holds. A contact last touched by a workflow and then by us flips
   "Workflow / Last Called Update Staus" to "API Key / Universal API Key",
   which is Kylas recording the truth. The first live run reported it as two
   FAULTS and buried a clean result under them. */
const IGNORE = /(^|\.)(updatedAt|updatedBy|recordActions|lastModified|updatedViaId|updatedViaName|updatedViaType)|^metaData\.idNameStore\.ownerId\./;

/* A SNAPSHOT A RETRY CANNOT DESTROY.
   This used to overwrite the file on every --write. The first run on lucidity
   erased the company's owner; the SECOND run then saved a fresh "before" over
   the good snapshot — capturing the already-damaged record — so --restore had
   nothing to restore TO and reported "the snapshot has no owner either". The
   one artefact that existed to survive a mistake was destroyed by repeating
   the mistake.

   The first snapshot for an account is now kept for ever. Later runs write a
   timestamped file beside it and say so, and --restore always reads the
   original. */
function saveSnapshot() {
  const body = JSON.stringify({ at: new Date().toISOString(), ...before }, null, 2);
  if (!existsSync(snapFile)) {
    writeFileSync(snapFile, body);
    console.log(`\n  snapshot saved to ${snapFile}\n`);
    return;
  }
  const also = snapFile.replace(/\.json$/, `-${Date.now()}.json`);
  writeFileSync(also, body);
  const held = JSON.parse(readFileSync(snapFile, "utf8"));
  console.log(`\n  KEEPING the first snapshot (${held.at}) — it is what --restore uses.`);
  console.log(`  This run's state saved separately to ${also}\n`);
}
function diff(before, after) {
  const a = flat(before), b = flat(after), out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORE.test(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      out.push({ key: k, before: a[k], after: b[k] });
  }
  return out;
}

/* ── --set-contact-owner <contactId> --to <userId> · PUT ONE BACK ──────
   The repair for a contact this tool moved and could not return — which
   happened once, to Vaibhav Bhandari (5358966), because the owner it was
   taken from had since been deactivated. Both known paths are tried and the
   record is read back, because on this API a 200 means the request parsed. */
const SET_CT = arg("set-contact-owner");
if (SET_CT) {
  if (!/^\d+$/.test(String(SET_CT))) { console.error(`\n--set-contact-owner wants a contact id, not "${SET_CT}".\n`); process.exit(1); }
  if (!TO) { console.error("\nPass --to <userId> as well — who the contact should end up on.\n"); process.exit(1); }
  const who = async (id) => { const u = await call("GET", `/v1/users/${id}`).catch(() => null);
    return u ? `${[u.firstName, u.lastName].filter(Boolean).join(" ")}${(u.active ?? u.isActive) === false ? " (DEACTIVATED)" : ""}` : "(unknown)"; };
  console.log(`\nContact ${SET_CT} -> owner ${TO} (${await who(TO)})`);
  const now0 = idOf((await call("GET", `/v1/contacts/${SET_CT}`).catch(() => null))?.ownerId);
  console.log(`  owner now        ${now0 ?? "(none)"}  ${now0 ? await who(now0) : ""}`);
  if (String(now0 ?? "") === String(TO)) { console.log(`  already there — nothing to do.\n`); process.exit(0); }

  const tryIt = async (what, fn) => {
    const r = await fn();
    await sleep(600);
    const got = idOf((await call("GET", `/v1/contacts/${SET_CT}`).catch(() => null))?.ownerId);
    const done = String(got ?? "") === String(TO);
    console.log(`  ${done ? "OK  " : "no  "} ${what.padEnd(34)} HTTP ${String(r.status).padEnd(4)} owner reads ${got ?? "(none)"}`);
    if (!done && r.body) console.log(`       ${String(r.body).replace(/\s+/g, " ").slice(0, 180)}`);
    return done;
  };
  let ok2 = await tryIt("PUT /v1/contacts/{id}/owner", () =>
    rawPutTop(`/v1/contacts/${SET_CT}/owner`, { ownerId: Number(TO) }));
  if (!ok2) {
    const full = await call("GET", `/v1/contacts/${SET_CT}`).catch(() => null);
    if (full) ok2 = await tryIt("PUT /v1/contacts/{id} (full record)", () =>
      rawPutTop(`/v1/contacts/${SET_CT}`, contactBody(full, Number(TO))));
  }
  console.log(ok2 ? `\n  Done.\n`
    : `\n  NEITHER PATH WORKED. If the target is deactivated, Kylas refuses it —\n` +
      `  reactivate them, or pick a live owner. Otherwise set it by hand in Kylas.\n`);
  process.exit(ok2 ? 0 : 1);
}

const before = await readAll();
const heldCo = String(idOf(before.company.ownerId) ?? "");
/* SAY WHICH MODE IS RUNNING, FIRST. Every mode prints the same account header,
   so a pasted fragment of the output is unreadable — you cannot tell a dry run
   from a write from a restore. One line fixes that. */
const MODE = process.argv.slice(2).filter((a) => a.startsWith("--")).join(" ") || "(no mode)";
console.log(`\n=== probe-reassign ${MODE} ===`);
console.log(`company ${CO} — ${before.company.name}`);
console.log(`  owner now      ${heldCo}${before.company.ownerId?.name ? ` (${before.company.ownerId.name})` : ""}`);
console.log(`  contacts       ${before.contacts.length}`);
for (const c of before.contacts)
  console.log(`    ${String(c.id).padEnd(9)} ${[c.firstName, c.lastName].filter(Boolean).join(" ").padEnd(24)}` +
              `owner ${idOf(c.ownerId) ?? "—"}  ` +
              `phones ${(c.phoneNumbers || []).map((p) => p.value).join("/") || "—"}  ` +
              `emails ${(c.emails || []).map((e) => e.value).join("/") || "—"}`);

/* ── --diff · READ ONLY. What does the record look like now, against the
      snapshot taken before the write? Run this first when something has gone
      wrong; it writes nothing and it is the only honest basis for deciding
      what to put back. ───────────────────────────────────────────────── */
if (process.argv.includes("--diff")) {
  if (!existsSync(snapFile)) { console.error(`\nNo snapshot at ${snapFile}.`); process.exit(1); }
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  console.log(`\nsnapshot taken ${snap.at}\n`);
  const d = diff(snap.company, before.company);
  console.log(d.length ? `company 1777441-style diff — ${d.length} field(s) differ from the snapshot:` : "company: identical to the snapshot.");
  for (const x of d) console.log(`   ${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
  for (const b of snap.contacts) {
    const a = before.contacts.find((x) => String(x.id) === String(b.id));
    if (!a) { console.log(`\ncontact ${b.id}: NOT FOUND ANY MORE`); continue; }
    const cd = diff(b, a);
    console.log(`\ncontact ${b.id} — ${cd.length ? `${cd.length} field(s) differ:` : "identical to the snapshot."}`);
    for (const x of cd) console.log(`   ${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
  }
  console.log("\nNothing was written. --restore puts the snapshot back.\n");
  process.exit(0);
}

/* ── --restore ───────────────────────────────────────────────────────── */
/* NARROWING, NOT GIVING UP. The first live restore died on the company PUT
   with 400 02803002 "generic.error" — a code that names neither the field nor
   the rule — and left the account ownerless because the run stopped there.
   A 400 that says nothing is not a reason to stop with the record broken: try
   a smaller body, and another, and report which one Kylas accepted, because
   that is the fact worth keeping. Same tactic kylas.mjs already uses to find
   the company SEARCH shape. */
async function putCompany(base, ownerId) {
  const full = companyBody(base, ownerId);
  const shapes = [
    ["the whole record", full],
    ["without custom fields", (({ customFieldValues, ...r }) => r)(full)],
    ["name, owner and the plain fields", {
      name: full.name, ownerId: full.ownerId,
      ...(full.website ? { website: full.website } : {}),
      ...(full.phoneNumbers ? { phoneNumbers: full.phoneNumbers } : {}),
      ...(full.emails ? { emails: full.emails } : {}) }],
    ["name and owner only", { name: full.name, ownerId: full.ownerId }],
  ];
  let last;
  for (const [what, body] of shapes) {
    try {
      const r = await call("PUT", `/v1/companies/${CO}`, body);
      console.log(`  company written — ${what}`);
      return { ok: true, what, body, res: r };
    } catch (e) {
      if (e.status !== 400) throw e;
      console.log(`  ! ${what} -> 400 ${String(e.message).slice(-120)}`);
      last = e;
      await sleep(400);
    }
  }
  throw last;
}

/* ── --reassign-endpoint <userId> · THE DOCUMENTED SHAPE ───────────────
   Kylas' own Postman collection documents "Reassign Lead":

       PUT /v1/leads/{lead_id}/owner        {"ownerId": <number>}

   — a dedicated endpoint, not a field on the record. That is why every PUT to
   /v1/companies/{id} carrying ownerId was accepted and ignored: ownership is
   simply not part of that payload. Kylas' documented Update Company body does
   not contain ownerId at all.

   The collection only documents the lead flavour, but the blind hunt got
   PUT /companies/{id}/owner -> 200 while POST to the same path -> 404, and a
   path that does not exist answers 404 to both. That asymmetry says the
   endpoint IS there.

   So test the METHOD before judging companies by it: run it on a CONTACT
   first, where ownership is known to be settable and provable, then on the
   company. If it moves the contact and not the company, the answer is about
   companies. If it moves neither, the answer is about this probe. */
const RE_EP = arg("reassign-endpoint");
if (RE_EP) {
  const n = Number(RE_EP);
  if (!Number.isFinite(n)) {
    console.error(`\n--reassign-endpoint wants a Kylas USER ID, not "${RE_EP}".`);
    console.error(`Run --users to see them.\n`);
    process.exit(1);
  }

  /* WHO THE IDS BELONG TO. Every line below reads better with a name on it,
     and a typo'd id is otherwise indistinguishable from an endpoint that does
     not work: "owner reads 74756" tells you nothing about whether 74756 was
     ever a real person. Resolved once, cached, and a failure is not fatal. */
  const NAMES = new Map();
  const whoIs = async (id) => {
    const k = String(id ?? "");
    if (!k) return "(none)";
    if (!NAMES.has(k)) {
      const u = await call("GET", `/v1/users/${k}`).catch(() => null);
      NAMES.set(k, u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || k : "(unknown user)");
    }
    return NAMES.get(k);
  };
  const withName = async (id) => `${String(id ?? "(none)").padEnd(8)} ${await whoIs(id)}`;

  const target = await whoIs(n);
  if (target === "(unknown user)") {
    console.error(`\nKylas has no user ${n}. Run --users and pick one from the list.\n`);
    process.exit(1);
  }

  /* THE RAW ANSWER, BODY AND ALL. The old version kept only the status code,
     and the status code is the least informative part: a 200 that changed
     nothing and a 200 that worked look identical, while the BODY of a 400 is
     usually Kylas naming the field it refused. */
  const rawPut = async (path, body) => {
    for (let t = 0; t < 6; t++) {
      try {
        const r = await fetch(`${BASE}${path}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
        const text = await r.text();
        if (r.status === 429 && t < 5) {
          const wait = Number(r.headers.get("retry-after") || 0) * 1000 || (500 * 2 ** t);
          console.log(`        429 — waiting ${wait}ms`);
          await sleep(wait); continue;
        }
        return { status: r.status, body: text };
      } catch (e) { return { status: 0, body: `network error: ${e.message}` }; }
    }
    return { status: 429, body: "still throttled after six tries" };
  };

  /* ONE ATTEMPT, FULLY NARRATED: what was sent, what came back, what the
     record said before and after, and what that combination means. */
  const attempt = async (label, path, readPath, body, readOwner) => {
    const read = readOwner || (async () => ({ id: idOf((await call("GET", readPath).catch(() => null))?.ownerId), via: "GET" }));
    const b4 = await read();
    const start = b4.id;
    console.log(`\n    ${label}`);
    console.log(`      PUT  ${path}`);
    console.log(`      body ${JSON.stringify(body)}`);
    console.log(`      owner before     ${await withName(start)}   [via ${b4.via}]`);
    if (String(start ?? "") === String(n)) {
      console.log(`      SKIPPED — already owned by the target, so nothing here could be proved.`);
      return { verdict: null, status: null };
    }
    const res = await rawPut(path, body);
    const clean = String(res.body || "").replace(/\s+/g, " ").trim();
    console.log(`      <-   HTTP ${res.status}${clean ? ` ${clean.slice(0, 220)}` : " (empty body)"}`);
    await sleep(700);
    const af = await read();
    const now = af.id;
    console.log(`      owner after      ${await withName(now)}   [via ${af.via}]`);
    /* A READ THAT CANNOT SEE THE FIELD IS NOT EVIDENCE. If the owner is
       invisible both before and after, "unchanged" is a statement about the
       read, not about the write — which is exactly the mistake the first live
       run made on aristocrat. Say so instead of concluding. */
    if (start == null && now == null) {
      console.log(`      => CANNOT TELL — neither read returns an owner for this record, so`);
      console.log(`         "unchanged" here means invisible, not untouched.`);
      return { verdict: null, status: res.status, blind: true };
    }
    const landed = String(now ?? "") === String(n);
    const moved = String(now ?? "") !== String(start ?? "");
    console.log(`      => ${landed ? "LANDED — the owner is now the target"
      : moved ? "MOVED, BUT NOT TO THE TARGET — read the body above"
      : res.status >= 200 && res.status < 300
        ? "ACCEPTED AND IGNORED — 200 with the owner unchanged, the whole trap"
        : "REFUSED — nothing changed"}`);
    return { verdict: landed, status: res.status, moved, before: start, after: now };
  };

  console.log(`\n── PUT /{entity}/{id}/owner, the shape Kylas documents ──────────────`);
  console.log(`Kylas' own collection documents PUT /v1/leads/{id}/owner {"ownerId": N}`);
  console.log(`— a dedicated endpoint, not a field on the record, which is why every`);
  console.log(`company PUT carrying ownerId was accepted and dropped. The collection`);
  console.log(`documents that flavour for LEADS only, but a blind hunt got`);
  console.log(`PUT /companies/{id}/owner -> 200 while POST on the same path -> 404,`);
  console.log(`and a path that does not exist answers 404 to both. That asymmetry is`);
  console.log(`the loose end this settles.\n`);
  console.log(`  target owner     ${n}  ${target}`);
  console.log(`  subject account  ${CO}  ${String(before.company?.name || "(unnamed)").slice(0, 44)}`);
  const coOwner0 = await companyOwner(CO);
  console.log(`  its owner now    ${await withName(coOwner0.id)}   [via ${coOwner0.via}]`);
  console.log(`  contacts on it   ${before.contacts.length}`);

  /* ── the control, on a contact ──────────────────────────────────────
     A contact's owner IS settable — PUT /v1/contacts/{id} with ownerId is what
     the product does every day — so if /owner does not move a contact either,
     the probe is asking wrongly and nothing can be concluded about companies.
     The control runs FIRST for that reason. */
  console.log(`\n  1 · THE CONTROL — a contact, where ownership is known to be settable.`);
  /* NEVER MOVE A CONTACT YOU CANNOT MOVE BACK. The first live run picked
     Vaibhav Bhandari (5358966), whose owner was Charu Rathi (76689) — a
     DEACTIVATED user. The move landed, the restore came back 400, and the
     probe left somebody's contact on the wrong person. Kylas will not assign a
     record to an inactive user, so an inactive current owner means the control
     is a one-way trip. Checked before anything is written. */
  const activeOf = async (id) => {
    const u = await call("GET", `/v1/users/${id}`).catch(() => null);
    return u ? (u.active ?? u.isActive ?? true) : null;
  };
  let victim = null, refused = [];
  for (const c of before.contacts) {
    const own = idOf(c.ownerId);
    if (String(own ?? "") === String(n)) continue;
    if (own == null) { refused.push(`${c.id} has no owner to restore to`); continue; }
    const live = await activeOf(own);
    if (live === false) { refused.push(`${c.id} is owned by ${await whoIs(own)} (${own}), who is DEACTIVATED — Kylas will not give a record back to an inactive user`); continue; }
    victim = c; break;
  }
  if (!victim && refused.length) {
    console.log(`\n    No contact here can be moved AND PUT BACK:`);
    for (const r of refused.slice(0, 6)) console.log(`      - ${r}`);
    console.log(`    Pick another --company, or reactivate the owner in Kylas first.`);
  }
  let ct = { verdict: null };
  let restored = "not needed";
  if (!victim && !refused.length) {
    console.log(`\n    SKIPPED — every contact on this account is already owned by ${n}.`);
    console.log(`    Re-run with an owner none of them has, or the control is a no-op`);
    console.log(`    that reports success.`);
  } else if (!victim) {
    /* already explained above */
  } else {
    const was = idOf(victim.ownerId);
    ct = await attempt(`contact ${victim.id} — ${[victim.firstName, victim.lastName].filter(Boolean).join(" ") || "(unnamed)"}`,
      `/v1/contacts/${victim.id}/owner`, `/v1/contacts/${victim.id}`, { ownerId: n });
    /* PUT IT BACK. This is live data and the control is OUR doing, not the
       account's. The old version moved a real contact and walked away. */
    if (ct.verdict === true) {
      await sleep(500);
      let back = await rawPut(`/v1/contacts/${victim.id}/owner`, { ownerId: Number(was) });
      await sleep(600);
      let check = idOf((await call("GET", `/v1/contacts/${victim.id}`).catch(() => null))?.ownerId);
      /* SECOND WAY HOME. /owner refusing does not mean the contact is stuck:
         PUT /v1/contacts/{id} with ownerId is the path the product itself uses
         and it may accept an owner /owner would not. Tried before giving up,
         because giving up here leaves live data wrong. */
      if (String(check ?? "") !== String(was ?? "")) {
        console.log(`    /owner refused the way back (HTTP ${back.status}) — trying the full record PUT`);
        const full = await call("GET", `/v1/contacts/${victim.id}`).catch(() => null);
        if (full) {
          back = await rawPut(`/v1/contacts/${victim.id}`, contactBody(full, Number(was)));
          await sleep(600);
          check = idOf((await call("GET", `/v1/contacts/${victim.id}`).catch(() => null))?.ownerId);
        }
      }
      restored = String(check ?? "") === String(was ?? "")
        ? `yes — contact ${victim.id} is back on ${await withName(was)}`
        : `NO — contact ${victim.id} reads ${await withName(check)}, wanted ${await withName(was)} (HTTP ${back.status})`;
      console.log(`\n    control undone?  ${restored}`);
      if (!/^yes/.test(restored)) {
        console.log(`\n    !! THIS IS LIVE DATA AND IT IS STILL WRONG. Put it back with:`);
        console.log(`       node --env-file=.env.local scripts/probe-reassign.mjs \\`);
        console.log(`            --set-contact-owner ${victim.id} --to ${was}`);
        console.log(`       ...or set it by hand in Kylas. Do not leave it.`);
      }
    }
  }

  /* ── the question itself ────────────────────────────────────────────
     Several shapes on the company, because "the endpoint is there" and "this
     exact body is what it wants" are two claims and only one of them has any
     evidence. Each is read back; the first that lands stops the rest. */
  console.log(`\n  2 · THE COMPANY — ${CO}. Several bodies, each read back.`);
  /* ownedBy IS THE FIELD KYLAS ACTUALLY USES, and it was missing from this
     list until 2026-10-15. Every shape here said `ownerId`, which is what the
     LEADS reassignment endpoint documents — but on a record Kylas carries the
     owner as `ownedBy`, either {id,name} or a bare id, and the whole
     kylas-airtable-sync repo reads it that way (02_contact_sync, 03_deal_sync,
     06_account_health, 08_deal_rot). Its client also WRITES it:
     update_company_owner() tries PUT /companies/{id}/owner {"ownerId"} and
     then falls back to a full PUT with body["ownedBy"] = {id}.

     And its restore_company_owners.py says, from a real incident on
     2026-07-01, that "field PUTs to /companies/{id} that OMIT the owner make
     Kylas silently reassign the company to the API user". That is proof
     ownership IS writable through the company endpoint — a PUT that leaves it
     out changes it — so the question was never whether it can be written, only
     under which key. `ownedBy` is the candidate this list never tried. */
  const shapes = [
    ["ownedBy wrapped — the field Kylas reads", `/v1/companies/${CO}/owner`, { ownedBy: { id: n } }],
    ["ownedBy as a bare id", `/v1/companies/${CO}/owner`, { ownedBy: n }],
    ["as documented for leads", `/v1/companies/${CO}/owner`, { ownerId: n }],
    ["ownerId as a string", `/v1/companies/${CO}/owner`, { ownerId: String(n) }],
    ["wrapped, the way lookups come back", `/v1/companies/${CO}/owner`, { ownerId: { id: n } }],
    ["under `owner` instead", `/v1/companies/${CO}/owner`, { owner: { id: n } }],
    ["the bare id, no envelope", `/v1/companies/${CO}/owner`, n],
    ["the plural path, in case it is /owners", `/v1/companies/${CO}/owners`, { ownedBy: { id: n } }],
  ];
  /* THE FULL-RECORD PUT IS OPT-IN, AND THAT IS NOT CAUTION FOR ITS OWN SAKE.
     It REPLACES the record. It is how lucidity (1777441) lost its owner, and
     kylas-airtable-sync's restore_company_owners.py exists because three such
     runs on 2026-07-01 reassigned companies across the whole account to the
     API user. A shape that has destroyed data twice does not belong in a
     default run of a diagnostic, however much we want the answer — the
     dedicated /owner shapes above cannot erase anything, so they go first and
     alone. --try-full-put adds it, for a company you can afford to repair. */
  if (process.argv.includes("--try-full-put")) {
    shapes.push(["the full record with ownedBy set (REPLACES THE RECORD)", `/v1/companies/${CO}`,
      { ...companyBody(before.company, n), ownedBy: { id: n } }]);
  } else {
    console.log(`\n  (not trying the full-record PUT: it replaces the record and has erased`);
    console.log(`   an owner before. Add --try-full-put on a company you can repair.)`);
  }
  let co = { verdict: false };
  const tried = [];
  for (const [label, path, body] of shapes) {
    const r = await attempt(label, path, `/v1/companies/${CO}`, body, () => companyOwner(CO));
    tried.push({ label, path, body, ...r });
    if (r.verdict === true) { co = r; break; }
    if (r.verdict === null) { co = r; break; }
    await sleep(500);
  }
  if (!co.verdict) co = tried.find((t) => t.verdict === null) || { verdict: false };

  /* ── the verdict ────────────────────────────────────────────────────── */
  console.log(`\n  ── WHAT THIS SHOWS ─────────────────────────────────────────────────`);
  const statuses = tried.map((t) => `${t.status ?? "skip"}`).join(", ");
  console.log(`  contact control : ${ct.verdict === true ? "moved" : ct.verdict === null ? "not run" : "did NOT move"}`);
  console.log(`  company attempts: ${tried.length} (${statuses})`);
  console.log(`  control undone  : ${restored}`);
  console.log("");
  if (co.verdict === true) {
    console.log(`  THE COMPANY OWNER IS SETTABLE, through:`);
    console.log(`      PUT ${co.path || `/v1/companies/${CO}/owner`}`);
    console.log(`      ${JSON.stringify(tried.find((t) => t.verdict === true)?.body)}`);
    console.log(`  reassign.mjs can use this and the account cascade goes back in. It`);
    console.log(`  is a dedicated endpoint, so it does NOT replace the record and none`);
    console.log(`  of the PUT-erases-fields risk applies. Send this block back.`);
  } else if (co.verdict === null) {
    /* SKIPPED IS NOT FAILED. This branch used to sit AFTER the control's, so a
       run where every company shape was skipped — because the account was
       already on the target — printed "companies do not expose it" on the
       strength of the contact alone, having tested the company zero times.
       That is how 1780629 was written off: the earlier write had in fact
       landed, so the next run found nothing left to change and the verdict
       read as a failure. A shape that never ran proves nothing either way. */
    console.log(`  INCONCLUSIVE — every company shape was SKIPPED, so the company was never`);
    console.log(`  actually tested. ${tried.length === 1 ? "The one shape" : `All ${tried.length} shapes`} found it already owned by ${n}${
      ct.verdict === true ? ", and the contact control moving says nothing about companies" : ""}.`);
    console.log(`  NOTE THAT CAREFULLY: if it is already on the target and you did not set`);
    console.log(`  it by hand, an EARLIER run of this probe is what put it there — which`);
    console.log(`  would mean the endpoint works. Re-run against a company that is NOT on`);
    console.log(`  ${n} yet, with --reassign-endpoint set to somebody it is not on, to settle it.`);
  } else if (ct.verdict === true) {
    console.log(`  THE METHOD IS RIGHT AND COMPANIES DO NOT EXPOSE IT. The contact moved`);
    console.log(`  through /owner; the company did not, on ${tried.length} different bodies.`);
    console.log(`  That is the answer: ownership of an ACCOUNT is not settable through`);
    console.log(`  this API, which is exactly how Kylas' collection documents it`);
    console.log(`  (reassignment for leads only). Contacts-only stands. Account owners`);
    console.log(`  have to be changed in Kylas' own UI, and nothing more is worth trying.`);
  } else if (ct.verdict === null) {
    console.log(`  INCONCLUSIVE — the control never ran, so "the company did not move"`);
    console.log(`  cannot be told apart from "this probe asks wrongly". Re-run with an`);
    console.log(`  owner the contacts on this account are not already sitting on.`);
  } else {
    console.log(`  NEITHER MOVED, so /owner is a LEADS endpoint and not a general one —`);
    console.log(`  which is how Kylas documents it. The 200 that started this hunt was`);
    console.log(`  a well-formed request landing nowhere, which this API does often.`);
    console.log(`  Contacts still move the proven way, PUT /v1/contacts/{id} with`);
    console.log(`  ownerId, which is what the product already does.`);
  }
  console.log(`\n  A 200 from this API means the request was well formed. It never means`);
  console.log(`  anything happened. Every line above read the record back.\n`);
  process.exit(co.verdict === true ? 0 : 1);
}
/* ── --move-contacts <userId> · THE SHIPPED ENGINE, ON REAL DATA ───────
   Everything above investigates Kylas. This exercises OUR code: it calls
   reassign.mjs' own plan() and apply() through an adapter over this file's
   HTTP client, so what runs here is exactly what the console's Re-assign
   button runs — not a re-implementation of it that might agree with the tests
   and disagree with production.

   Snapshot first, diff after, --restore undoes it. */
const MOVE = arg("move-contacts");
if (MOVE) {
  const { plan, apply } = await import("./reassign.mjs");
  /* The five methods reassign.mjs asks for, over this probe's rate-limited,
     429-retrying client. */
  const adapter = {
    company: (id) => call("GET", `/v1/companies/${id}`),
    contactsForCompany: async (id) => rows(await contactsOf(id)),
    contact: (id) => call("GET", `/v1/contacts/${id}`),
    updateContact: (id, body) => call("PUT", `/v1/contacts/${id}`, body),
    updateCompany: () => { throw new Error("the probe refuses to write a company here"); },
  };
  console.log(`\nrunning reassign.mjs against company ${CO}, target owner ${MOVE}\n`);
  const p = await plan({ kylas: adapter, companies: [CO], ownerId: MOVE, log: (m) => console.log("  " + m) });
  console.log(`  would move ${p.contacts} contact(s); ${p.already} already there` +
              `${p.problems.length ? `; ${p.problems.length} unreadable` : ""}`);
  console.log(`  the account's own owner: ${p.accounts[0]?.accountOwner || "(none)"} — NOT changed by this`);
  if (!process.argv.includes("--write")) {
    console.log("\n  READ ONLY so far. Add --write to actually move them.\n");
    process.exit(0);
  }
  if (!p.contacts) { console.log("\n  Nothing to move.\n"); process.exit(0); }

  saveSnapshot();
  const r = await apply({ kylas: adapter, companies: [CO], ownerId: MOVE, log: (m) => console.log("  " + m) });
  console.log(`  moved ${r.contacts} contact(s); ${r.failed.length} account(s) failed`);

  const after = await readAll();
  let faults = 0;
  const ok2 = (w, c) => { if (!c) faults++; console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); };
  console.log("\n  ── did the people move ──");
  for (const c of after.contacts)
    ok2(`contact ${c.id} is owned by ${MOVE}`, String(idOf(c.ownerId)) === String(MOVE));
  console.log("\n  ── did anything else change ──");
  for (const b of before.contacts) {
    const a = after.contacts.find((x) => String(x.id) === String(b.id)) || {};
    const d = diff(b, a).filter((x) => !/^ownerId/.test(x.key));
    ok2(`contact ${b.id}: nothing but the owner changed`, d.length === 0);
    for (const x of d) console.log(`     ! ${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
  }
  const cd = diff(before.company, after.company);
  ok2("the company record was not touched at all", cd.length === 0);
  for (const x of cd) console.log(`     ! ${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
  console.log(`\n  ${faults ? `${faults} FAULT(S).` : "Clean. The contacts moved and nothing else changed."}`);
  console.log(`  Undo: --company ${CO} --restore\n`);
  process.exit(faults ? 1 : 0);
}

/* ── --owner-field · READ ONLY. IS IT WRITABLE AT ALL? ─────────────────
   Seven encodings all came back accepted and none set the owner, so the next
   question is not "which shape" but "is this field updatable by the API".
   Kylas' own field metadata answers it — and it is a read, so it costs
   nothing and risks nothing. Should have been the FIRST thing asked. */
if (process.argv.includes("--owner-field")) {
  const f = await call("GET",
    "/v1/entities/company/fields?entityType=company&custom-only=false&page=0&size=200");
  const all = rows(f);
  const owner = all.filter((x) => /owner/i.test(x.name || "") || /owner/i.test(x.displayName || ""));
  console.log(`\n${all.length} company fields. Anything owner-shaped:\n`);
  for (const x of owner) console.log(JSON.stringify(x, null, 2));
  if (!owner.length) console.log("  (none — that is itself the answer)");
  /* What the API says it will let us change, so the next attempt is informed
     rather than another guess. */
  const writable = all.filter((x) => x.updatable === true || x.editable === true)
    .map((x) => x.name).filter(Boolean);
  console.log(`\nfields this key may update (${writable.length}):\n  ${writable.join(", ") || "(the flag is not reported)"}`);
  console.log("\nNothing was written.\n");
  process.exit(0);
}

/* ── --hunt-owner <userId> · IS THERE A DEDICATED ENDPOINT ─────────────
   Ownership in a CRM is often its own action rather than a field on the
   record — an assign endpoint, a bulk owner update, a merge-patch. PATCH came
   back 415, which is a CONTENT TYPE complaint, not a refusal of the method,
   so that gets another go with the right header before anything else.
   Runs against whatever --company says, so point it at the account that is
   already broken rather than a healthy one. */
const HUNT = arg("hunt-owner");
if (HUNT) {
  const n = Number(HUNT);
  const tries = [
    ["PATCH + merge-patch content type", "PATCH", `/v1/companies/${CO}`, { ownerId: n },
      { "content-type": "application/merge-patch+json" }],
    ["PATCH + json-patch content type", "PATCH", `/v1/companies/${CO}`,
      [{ op: "replace", path: "/ownerId", value: n }], { "content-type": "application/json-patch+json" }],
    ["PUT  /companies/{id}/owner", "PUT", `/v1/companies/${CO}/owner`, { ownerId: n }],
    ["POST /companies/{id}/owner", "POST", `/v1/companies/${CO}/owner`, { ownerId: n }],
    ["PUT  /companies/{id}/assign", "PUT", `/v1/companies/${CO}/assign`, { ownerId: n }],
    ["POST /companies/{id}/assign", "POST", `/v1/companies/${CO}/assign`, { ownerId: n }],
    ["POST /companies/assign (bulk)", "POST", `/v1/companies/assign`, { ids: [Number(CO)], ownerId: n }],
    ["POST /companies/bulk-update", "POST", `/v1/companies/bulk-update`,
      { ids: [Number(CO)], fields: { ownerId: n } }],
    ["PUT  /companies/owner (bulk)", "PUT", `/v1/companies/owner`, { ids: [Number(CO)], ownerId: n }],
  ];
  console.log(`\nhunting for an endpoint that sets a company's owner. Target: ${HUNT}\n`);
  for (const [what, method, path, body, headers] of tries) {
    let sent = "";
    try {
      const r = await fetch(`${BASE}${path}`, { method,
        headers: { ...H, ...(headers || {}) }, body: JSON.stringify(body) });
      sent = `${r.status}`;
      if (r.status === 429) { await sleep(1200); }
    } catch (e) { sent = `network ${e.message.slice(0, 40)}`; }
    await sleep(300);
    const now = await call("GET", `/v1/companies/${CO}`).catch(() => null);
    const got = idOf(now?.ownerId);
    const landed = String(got ?? "") === String(HUNT);
    console.log(`  ${landed ? "LANDED " : "no     "} ${what.padEnd(36)} -> ${String(sent).padEnd(6)} owner reads ${got ?? "(none)"}`);
    if (landed) { console.log(`\n  ^ THAT is how a company owner moves. Send this line back.\n`); process.exit(0); }
    await sleep(300);
  }
  console.log("\n  Nothing set it. Send the whole output back — on this evidence the");
  console.log("  company owner is not settable through the API at all, and the feature");
  console.log("  has to move contacts only and leave account ownership to Kylas' UI.\n");
  process.exit(1);
}

/* ── --try-owner <userId> · WHICH ENCODING DOES A COMPANY OWNER TAKE ───
   Kylas ACCEPTED a company PUT carrying `ownerId: 74756` — 200, no complaint —
   and left the company with no owner at all. A contact takes a bare number
   there (test-replace pins it, and the save path has always worked); a company
   evidently does not, and because the PUT replaces, "ignored" means "erased".
   That is the worst possible failure mode: a success code for a field the
   server dropped.

   So: one encoding at a time, smallest body that Kylas already accepted, read
   back after each, stop at the first that actually lands. The same "one field
   at a time" tactic probe-write.mjs used on contacts, and for the same reason
   — a 400 here names neither the field nor the rule, and a 200 means nothing. */
const TRY = arg("try-owner");
if (TRY) {
  const snap = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : null;
  const base = snap?.company || before.company;
  const full = companyBody(base, TRY);
  const plain = { name: full.name,
    ...(full.website ? { website: full.website } : {}),
    ...(full.phoneNumbers ? { phoneNumbers: full.phoneNumbers } : {}),
    ...(full.emails ? { emails: full.emails } : {}) };
  const n = Number(TRY);
  const attempts = [
    ["PATCH, ownerId as a number", "PATCH", { ownerId: n }],
    ["PATCH, ownerId as {id}", "PATCH", { ownerId: { id: n } }],
    ["PUT, ownerId as {id}", "PUT", { ...plain, ownerId: { id: n } }],
    ["PUT, ownerId as a string", "PUT", { ...plain, ownerId: String(n) }],
    ["PUT, owner as {id}", "PUT", { ...plain, owner: { id: n } }],
    ["PUT, ownerId as {id,name}", "PUT", { ...plain, ownerId: { id: n, name: "" } }],
    ["PUT, ownerId as a number (the one that erased it)", "PUT", { ...plain, ownerId: n }],
  ];
  console.log(`\nlooking for the encoding a COMPANY owner actually takes. Target: ${TRY}\n`);
  for (const [what, method, body] of attempts) {
    let sent = "";
    try { await call(method, `/v1/companies/${CO}`, body); sent = "accepted"; }
    catch (e) { sent = `${e.status} ${String(e.message).slice(-90)}`; }
    await sleep(300);
    const now = await call("GET", `/v1/companies/${CO}`).catch(() => null);
    const got = idOf(now?.ownerId);
    const landed = String(got ?? "") === String(TRY);
    console.log(`  ${landed ? "LANDED " : "no     "} ${what.padEnd(46)} ${sent} · owner reads ${got ?? "(none)"}`);
    if (landed) {
      console.log(`\n  ^ THIS is the shape. Tell Claude: "${what}".`);
      console.log(`    reassign.mjs must send it this way before anything else moves.\n`);
      process.exit(0);
    }
    await sleep(300);
  }
  console.log("\n  None of them set the owner. Send this whole output back —");
  console.log("  the company owner may not be writable through this endpoint at all,");
  console.log("  in which case the cascade has to change shape.\n");
  process.exit(1);
}

/* ── --fix-owner <userId> · THE RECOVERY OF LAST RESORT ────────────────
   Sets the company's owner and nothing else, narrowing until Kylas accepts
   it. For the case this tool created once and must be able to undo: an
   account left with no owner at all, where the snapshot is missing or is
   itself ownerless. It prefers the snapshot's other fields when there is one,
   so it is not a licence to flatten the record. */
const FIX = arg("fix-owner");
if (FIX) {
  const snap = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : null;
  const base = snap?.company || before.company;
  console.log(`\nsetting company ${CO}'s owner to ${FIX}` +
              `${snap ? ` (other fields from the snapshot of ${snap.at})` : " (other fields as they stand now)"}`);
  await putCompany(base, FIX);
  await sleep(220);
  const now = await call("GET", `/v1/companies/${CO}`);
  const got = idOf(now.ownerId);
  console.log(`  owner is now ${got ?? "(still none)"}`);
  process.exit(String(got) === String(FIX) ? 0 : 1);
}

if (RESTORE) {
  if (!existsSync(snapFile)) { console.error(`\nNo snapshot at ${snapFile} — nothing to restore from.`); process.exit(1); }
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  const wasOwner = idOf(snap.company.ownerId);
  console.log(`\nrestoring from ${snapFile} (taken ${snap.at})`);
  /* RESTORE THE CONTACTS, WHATEVER THE COMPANY SAYS.
     This used to refuse outright when the snapshot had no company owner —
     and it refused on moonfroglabs, whose contacts were sitting on the wrong
     person, because of a company field that was ALREADY empty before anything
     was written and that Kylas will not let us set anyway. The undo was
     blocked by something it was never going to touch.

     The engine moves contacts. So does the undo. The company's owner is
     reported and left alone, exactly as the forward path does it. */
  if (wasOwner == null)
    console.log(`  the company had no owner when the snapshot was taken — it still will not,` +
                `\n  and that is not something this tool can set. Restoring the CONTACTS.`);
  else
    console.log(`  the company's owner in the snapshot: ${wasOwner} (left alone — Kylas does not` +
                `\n  allow it to be set through the API; see reassign.mjs)`);
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
saveSnapshot();

/* If every shape is refused this THROWS before a single contact is touched —
   rule 4, and the reason the forward write goes through the same narrowing as
   the restore. An account left ownerless with its contacts moved on is the
   worst state this tool can produce. */
try {
  await putCompany(before.company, TO);
} catch (e) {
  console.error(`\n! the company write was refused in every shape: ${e.message}`);
  console.error(`  NOTHING ELSE WAS TOUCHED. The snapshot is at ${snapFile};`);
  console.error(`  check the record with --diff before doing anything else.\n`);
  process.exit(1);
}
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
