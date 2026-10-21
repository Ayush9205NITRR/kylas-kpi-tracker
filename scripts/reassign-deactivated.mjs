#!/usr/bin/env node
/* ACCOUNTS HELD BY DEACTIVATED USERS -> ACTIVE BDs, ROUND ROBIN, CONTACTS WITH THEM.
 *
 * Ayush, 2026-10-21: the 178 "Oct/Nov/Dec" companies whose owner is
 * deactivated — Kylas refuses ANY update to those (400 02801020 "Invalid
 * owner."), so their month tag cannot go in until they belong to somebody
 * active. "Round robin way mein assign karo — enoutsuperadmin ko nahi, in users
 * ko: Sejal, Anjali, Muskan, Arshdeep, Mayra. Account ke sath uske contacts bhi
 * move kar dena."
 *
 *   node --env-file=.env.local scripts/reassign-deactivated.mjs --view "Oct/Nov/Dec" \
 *        --to sejal,anjali,muskan,arshdeep,mayra            dry run: the plan, nothing written
 *        ... --apply --limit 1                              the first account — look at it in Kylas
 *        ... --apply --all                                  the rest
 *
 * WHO IS MOVED: only companies whose owner Kylas says is NOT ACTIVE. An account
 * with an active owner is never touched, whatever the view says.
 *
 * WHO IT GOES TO: each name must match exactly ONE active Kylas user by first
 * name (or full name / email). No match, two matches, an inactive match, or the
 * API user (Enout Super Admin) stops it before anything is read further.
 * Round robin over the companies sorted by id, in the order the names were
 * given — the same list always gives the same split. A re-run after a stop
 * plans only what is still on a deactivated owner, round robin again.
 *
 * HOW: the one-field owner endpoints, never a whole-record PUT (a company PUT
 * hands the record to the API user and erases fields — STATE §3l2):
 *     PUT /v1/contacts/{id}/owner   {ownerId}   every contact of the account
 *     PUT /v1/companies/{id}/owner  {ownerId}   the account itself, LAST
 * Contacts first, so a stop never leaves an account handed over with its POCs
 * left behind. Each is read back; the first account whose owner does not read
 * back as the planned person STOPS the run. Before-images (old owners) go to
 * reassign-snapshot-<time>.json — note a deactivated user cannot be given a
 * record back, so this is one-way by nature.
 *
 * Logs print ids only (this repo's Actions logs are public): no company,
 * contact or person names except the first names given in --to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, toUser } from "./kylas.mjs";

const KEY = process.env.KYLAS_KEY;
const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
if (!KEY) { console.error("Set KYLAS_KEY."); process.exit(1); }
const VIEW = arg("view", "");
const IDS_FILE = arg("ids", "");
const NAMES = String(arg("to", "")).split(",").map((s) => s.trim()).filter(Boolean);
if (!NAMES.length) { console.error("--to name1,name2,... (the active BDs to share the accounts between)"); process.exit(1); }
/* --leave-active-contacts: a contact an ACTIVE BD (not the API user) already
   holds stays with them; only contacts on a deactivated user or the API user
   follow the account. Default: every contact of the account moves. */
const LEAVE_ACTIVE = has("leave-active-contacts");
/* --follow-contacts (Ayush, 2026-10-21, for the 16 accounts whose contacts an
   ACTIVE BD already holds): such an account is NOT in the round robin — it goes
   to the active BD who holds most of its contacts, those contacts stay where
   they are, and only its contacts on a deactivated user / the API user / nobody
   follow it to that BD. That BD may be outside --to. */
const FOLLOW = has("follow-contacts");
if (!VIEW && !IDS_FILE) { console.error("--view <Company List view> or --ids <file>"); process.exit(1); }

const kylas = createClient(KEY, { log: () => {}, base: BASE });
const call = kylas.raw;
const idOf = (v) => (v && typeof v === "object" ? v.id : v) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the companies ───────────────────────────────────────────────── */
let ids = [];
if (VIEW) {
  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) { console.error("--view needs AIRTABLE_PAT"); process.exit(1); }
  const AT = (process.env.AIRTABLE_API || "https://api.airtable.com").replace(/\/$/, "");
  const CO_BASE = process.env.AIRTABLE_COMPANY_BASE_ID || "app55PsyRKqkf2CAQ";
  let offset = "";
  const seen = new Set();
  do {
    const q = new URLSearchParams({ view: VIEW, pageSize: "100" });
    q.append("fields[]", "Kylas Company Id");
    if (offset) q.set("offset", offset);
    let r;
    for (let i = 0; i < 6; i++) {
      r = await fetch(`${AT}/v0/${CO_BASE}/${encodeURIComponent("Company List")}?${q}`, { headers: { authorization: `Bearer ${PAT}` } });
      if (r.status !== 429) break;
      await sleep(1000 * 2 ** i);
    }
    if (!r.ok) { console.error(`Airtable: the view "${VIEW}" could not be read — ${r.status}`); process.exit(1); }
    const page = await r.json();
    for (const rec of page.records || []) {
      const kid = String(rec.fields?.["Kylas Company Id"] ?? "").trim().replace(/\.0+$/, "");
      if (/^\d+$/.test(kid)) seen.add(kid);
    }
    offset = page.offset || "";
    await sleep(220);
  } while (offset);
  ids = [...seen];
} else {
  ids = [...new Set(readFileSync(IDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)))];
}
ids.sort((a, b) => Number(a) - Number(b));

/* ── owners ──────────────────────────────────────────────────────── */
/* Same reading as bulk-tag-companies.mjs: the single GET carries the owner as
   ownedBy on this account; the search by id is the fallback. */
const OWNER_FIELDS = ["ownerId", "owner", "ownedBy", "ownerDetails", "assignedTo", "recordOwner"];
async function companyOwner(id, rec) {
  for (const k of OWNER_FIELDS) {
    const v = idOf(rec?.[k]);
    if (v !== null && v !== undefined && v !== "") return String(v);
  }
  try {
    const r = await call("POST", "/v1/search/company?page=0&size=5", { fields: ["id", "ownerId"],
      jsonRule: { condition: "AND", valid: true, rules: [{ id: "id", field: "id", type: "long", input: "number", operator: "equal", value: Number(id) }] } });
    const row = (r?.content || r?.data || []).find((x) => String(x.id) === String(id));
    const v = row ? idOf(row.ownerId) : null;
    return v == null || v === "" ? null : String(v);
  } catch { return null; }
}
async function contactsOf(companyId) {
  const out = [];
  for (let p = 0; p < 20; p++) {
    const r = await call("POST", `/v1/search/contact?page=${p}&size=100`, { fields: ["id", "ownerId", "company"],
      jsonRule: { condition: "AND", valid: true, rules: [{ id: "company", field: "company", type: "long", input: "select", operator: "equal", value: Number(companyId) }] } });
    const rows = r?.content || r?.data || [];
    /* Only rows that say they are this company's — a filter Kylas ignored must not move strangers. */
    out.push(...rows.filter((c) => String(idOf(c.company) ?? companyId) === String(companyId)));
    if (rows.length < 100) break;
  }
  return out.map((c) => ({ id: String(c.id), owner: String(idOf(c.ownerId) ?? "") }));
}
const userCache = new Map();
async function userOf(id) {
  if (!id) return null;
  if (!userCache.has(id)) {
    let u = null;
    try { u = toUser(await call("GET", `/v1/users/${id}`)); } catch { u = null; }
    userCache.set(id, u);
  }
  return userCache.get(id);
}

/* ── who it goes to ──────────────────────────────────────────────── */
const me = toUser(await call("GET", "/v1/users/me").catch(() => ({})));
const API_USER = me.id || "74725";
/* A name is matched against Kylas' user list; a NUMBER is taken as a user id
   and read directly (the fallback if the list endpoint ever stops answering). */
const numeric = NAMES.filter((n) => /^\d+$/.test(n));
const dir = NAMES.length > numeric.length ? await kylas.users([]) : { users: [] };
let directory = [...(dir.users || [])];
for (const n of numeric) { const u = await userOf(n); if (u?.id && !directory.some((d) => String(d.id) === String(u.id))) directory.push(u); }
if (!directory.length) {
  console.error("Kylas gave no user list, so the names cannot be matched — pass Kylas user ids in --to instead. Nothing written.");
  process.exit(1);
}
const norm = (s) => String(s || "").toLowerCase().trim();
const targets = [];
for (const n of NAMES) {
  const q = norm(n);
  const hits = directory.filter((u) => String(u.id) === q || norm(u.name).split(/\s+/)[0] === q || norm(u.name) === q || norm(u.email) === q || norm(u.email).split("@")[0] === q);
  const active = hits.filter((u) => u.active !== false);
  if (active.length !== 1) {
    console.error(`"${n}": ${active.length ? `${active.length} active users match (ids ${active.map((u) => u.id).join(", ")}) — say which one (full name or email)` : `no active user matches${hits.length ? ` (${hits.length} inactive)` : ""}`}. Nothing written.`);
    process.exit(1);
  }
  const u = active[0];
  if (String(u.id) === String(API_USER) || /super\s*admin/i.test(u.name)) {
    console.error(`"${n}" is the API user / Enout Super Admin (${u.id}). Never a target. Nothing written.`);
    process.exit(1);
  }
  if (targets.some((t) => t.id === u.id)) { console.error(`"${n}" is the same user as another name. Nothing written.`); process.exit(1); }
  targets.push({ key: n, id: String(u.id) });
}
console.log(`Never: ${API_USER} (the API user / Enout Super Admin). Only companies whose owner is DEACTIVATED move.`);

/* ── the plan ────────────────────────────────────────────────────── */
console.log(`\nReading ${ids.length} companies${VIEW ? ` from the view "${VIEW}"` : ""}...`);
const plan = [];
const holds = Object.fromEntries(targets.map((t) => [t.id, 0]));
let unreadable = 0, activeOwner = 0, noOwner = 0;
for (const id of ids) {
  let rec;
  try { rec = await call("GET", `/v1/companies/${id}`); }
  catch (e) { unreadable++; continue; }
  const owner = await companyOwner(id, rec);
  if (!owner) { noOwner++; continue; }
  const u = await userOf(owner);
  if (holds[owner] !== undefined) holds[owner]++;
  if (!u || u.active !== false) { activeOwner++; continue; }
  plan.push({ id, from: owner });
}
/* WHO GETS THE +1. Round robin starts with whoever holds the FEWEST of these
   companies now, ties in the order given — so a re-run after a stop (or after
   --limit 1) keeps the split even instead of starting again from the first name. */
targets.sort((a, b) => holds[a.id] - holds[b.id] || NAMES.indexOf(a.key) - NAMES.indexOf(b.key));
console.log(`\nTargets (round robin, in this order): ${targets.map((t) => `${t.key} = ${t.id} (holds ${holds[t.id]} here now)`).join(" · ")}`);
/* An active BD (not the API user) holding a contact = somebody already working it. */
const activeBd = async (id) => !!id && id !== API_USER && (await userOf(id))?.active !== false && !!(await userOf(id));
if (FOLLOW) {
  for (const p of plan) {
    p.cs = await contactsOf(p.id);
    const tally = {};
    for (const c of p.cs) if (await activeBd(c.owner)) tally[c.owner] = (tally[c.owner] || 0) + 1;
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
    if (best) { p.to = best[0]; p.follow = true; p.toKey = `contacts' BD`; }
  }
}
const rr = plan.filter((p) => !p.follow);
rr.forEach((p, i) => { p.to = targets[i % targets.length].id; p.toKey = targets[i % targets.length].key; });
for (const p of plan) if (p.to === API_USER) { console.error(`${p.id} would go to the API user — refusing. Nothing written.`); process.exit(1); }
const perTarget = Object.fromEntries(targets.map((t) => [t.key, rr.filter((p) => p.to === t.id).length]));
const followers = plan.filter((p) => p.follow);
if (FOLLOW) {
  const by = {};
  for (const p of followers) by[p.to] = (by[p.to] || 0) + 1;
  const outside = Object.keys(by).filter((id) => !targets.some((t) => t.id === id));
  console.log(`\n--follow-contacts: ${followers.length} account(s) go to the active BD already holding their contacts (BD id: accounts) ${Object.entries(by).map(([k, n]) => `${k}: ${n}`).join(" · ") || "-"}` +
    `${outside.length ? ` — ${outside.length} of those BDs are outside --to (${outside.join(", ")})` : ""}. Round robin: the other ${rr.length}.`);
}
console.log(`\n${plan.length} companies with a DEACTIVATED owner · ${activeOwner} with an active owner (left alone) · ${noOwner} no owner found · ${unreadable} unreadable`);
console.log(`Split: ${Object.entries(perTarget).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
const fromCount = {};
for (const p of plan) fromCount[p.from] = (fromCount[p.from] || 0) + 1;
console.log(`From (deactivated owner id: companies): ${Object.entries(fromCount).map(([k, n]) => `${k}: ${n}`).join(" · ")}`);

if (!has("apply")) {
  /* The contacts that would follow — counted, with who holds them now. */
  let contacts = 0, withActiveOther = 0, withDead = 0, withApi = 0, accountsActiveOther = 0;
  for (const p of plan) {
    const cs = p.cs || await contactsOf(p.id);
    p.contacts = cs.length;
    contacts += cs.length;
    let other = 0;
    for (const c of cs) {
      const u = await userOf(c.owner);
      if (c.owner === API_USER) withApi++;
      else if (u && u.active === false) withDead++;
      else if (c.owner && c.owner !== p.to) { withActiveOther++; other++; }
    }
    if (other) accountsActiveOther++;
    console.log(`  ${p.id.padEnd(9)} owner ${p.from.padEnd(6)} (deactivated) -> ${p.toKey.padEnd(9)} ${p.to}   ${cs.length} contact(s)`);
  }
  console.log(`\nContacts on these accounts: ${contacts} — now held by: ${withDead} a deactivated user · ${withApi} the API user · ${withActiveOther} an ACTIVE BD (across ${accountsActiveOther} accounts)`);
  console.log(LEAVE_ACTIVE ? `--leave-active-contacts: the ${withActiveOther} with an active BD STAY; the rest follow their account.`
                           : `All of them follow their account (--leave-active-contacts keeps the ${withActiveOther} with their active BD).`);
  console.log(`DRY RUN — nothing written. Next: --apply --limit 1, look at that account in Kylas, then --apply --all.\n`);
  process.exit(0);
}

/* ── apply ───────────────────────────────────────────────────────── */
const LIMIT = has("all") ? Infinity : Number(arg("limit", "0"));
if (!(LIMIT > 0)) { console.error("Say how many: --limit 1 for the first one, --all for the rest."); process.exit(1); }
const snapFile = `reassign-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const snaps = [];
console.log(`\nAPPLY — up to ${LIMIT === Infinity ? "all" : LIMIT} of ${plan.length}. Before-images: ${snapFile}\n`);
let done = 0, contactsMoved = 0, contactsFailed = 0, contactsKept = 0;
for (const p of plan) {
  if (done >= LIMIT) break;
  const cs = await contactsOf(p.id);
  snaps.push({ company: p.id, owner: p.from, to: p.to, contacts: cs });
  writeFileSync(snapFile, JSON.stringify(snaps, null, 2));
  let moved = 0, kept = 0;
  const stuck = [];
  for (const c of cs) {
    if (c.owner === p.to) continue;
    if ((LEAVE_ACTIVE || p.follow) && (await activeBd(c.owner))) { kept++; continue; }
    try {
      await call("PUT", `/v1/contacts/${c.id}/owner`, { ownerId: Number(p.to) });
      const back = await call("GET", `/v1/contacts/${c.id}`);
      if (String(idOf(back?.ownerId) ?? idOf(back?.ownedBy) ?? "") !== p.to) stuck.push(`${c.id} (reads back ${idOf(back?.ownerId) ?? "?"})`);
      else moved++;
    } catch (e) { stuck.push(`${c.id} (${String(e.message).replace(/^\S+ \S+ -> /, "").slice(0, 90)})`); }
  }
  contactsMoved += moved; contactsFailed += stuck.length; contactsKept += kept;
  try { await call("PUT", `/v1/companies/${p.id}/owner`, { ownerId: Number(p.to) }); }
  catch (e) {
    console.log(`\n  STOPPED at ${p.id}: Kylas refused the account's owner — ${String(e.message).replace(/^\S+ \S+ -> /, "").slice(0, 160)}` +
      `\n  ${moved} of its contacts had moved to ${p.to}. Before-images in ${snapFile}.\n`);
    process.exit(1);
  }
  const after = await companyOwner(p.id, await call("GET", `/v1/companies/${p.id}`));
  if (after !== p.to) {
    console.log(`\n  STOPPED at ${p.id}: its owner reads back as ${after ?? "NONE"}, not ${p.to}. Before-images in ${snapFile}.\n`);
    process.exit(1);
  }
  done++;
  console.log(`  ${String(done).padStart(3)}  ${p.id.padEnd(9)} ${p.from} -> ${p.toKey} ${p.to}${p.follow ? " (follows its contacts)" : ""} ✓ · contacts ${moved}/${cs.length} moved${kept ? ` (${kept} left with their active BD)` : ""}` +
    `${stuck.length ? ` · NOT MOVED: ${stuck.join(", ")}` : ""}`);
}
console.log(`\nOWNER CHECK: ${done} account(s) read back with their new owner. Contacts moved: ${contactsMoved}${contactsKept ? ` · ${contactsKept} left with an active BD` : ""}${contactsFailed ? ` · ${contactsFailed} NOT moved (listed above)` : ""}.`);
console.log(`This run gave: ${targets.map((t) => `${t.key} ${plan.slice(0, done).filter((p) => p.to === t.id).length}`).join(" · ")}`);
if (done && done < plan.length && LIMIT !== Infinity) console.log(`Open that account in Kylas (owner, contacts), then --apply --all.`);
console.log("");
