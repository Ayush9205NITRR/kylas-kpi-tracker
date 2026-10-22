#!/usr/bin/env node
/* CONTACTS ON SOMEBODY OTHER THAN THEIR ACCOUNT'S OWNER — FIND THEM, MOVE THEM.
 *
 * Ayush, 2026-10-22: "all associated contacts for that account should be
 * allotted to whoever owns that account. Check for that." The rule and what is
 * only reported are in align.mjs.
 *
 *   node --env-file=.env.local scripts/align-contacts.mjs                  the check: nothing written
 *   ... --owners "sejal,mayra"                                             only accounts these people own
 *   ... --apply --limit 1                                                  the first account — look at it in Kylas
 *   ... --apply --all                                                      the rest
 *
 * The check reads every account from Kylas (the console's own crawl), the
 * contacts of each, and reads the ones that are off again, owner included —
 * align.mjs says why it is not the Airtable copy. About an hour for the whole
 * CRM; --owners narrows it. --apply moves each contact with PUT /v1/contacts/{id}/owner
 * (one field; never a whole-record PUT) through reassign.mjs allot(), which
 * re-reads the account first and reads the owner back. The account's own owner
 * never changes here. Before-images (contact id, old owner) go to
 * align-snapshot-<time>.json.
 *
 * Logs print ids and BD names only (this repo's Actions logs are public).
 */
import { writeFileSync } from "node:fs";
import { createClient, toUser } from "./kylas.mjs";
import { allot, companyOwnerOf, contactsOfCompany, MAX_ALLOT } from "./reassign.mjs";
import { verify } from "./align.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const { KYLAS_KEY } = process.env;
if (!KYLAS_KEY) { console.error("Set KYLAS_KEY."); process.exit(1); }
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const OWNERS = String(arg("owners", "")).split(",").map(norm).filter(Boolean);

const kylas = createClient(KYLAS_KEY, { log: () => {}, base: process.env.KYLAS_BASE || "https://api.kylas.io" });

/* ── who is who ──────────────────────────────────────────────────── */
const me = toUser(await kylas.me().catch(() => ({})));
const API_USER = me.id || "74725";
const users = new Map((await kylas.users([]).catch(() => ({ users: [] }))).users.map((u) => [u.id, u]));
const userCache = new Map();
async function userOf(id) {
  if (!id) return null;
  if (users.has(id)) return users.get(id);
  if (!userCache.has(id)) userCache.set(id, await kylas.user(id).then(toUser).catch(() => null));
  return userCache.get(id);
}
const label = (id) => {
  if (!id) return "nobody";
  if (id === API_USER) return "Super Admin";
  const u = users.get(id) || userCache.get(id);
  return `${u?.name?.split(" ")[0] || "user"} ${id}${u?.active === false ? " (deactivated)" : ""}`;
};
const ownerSet = new Set();
for (const o of OWNERS) {
  if (/^\d+$/.test(o)) { ownerSet.add(o); continue; }
  const hits = [...users.values()].filter((u) => norm(u.name) === o || norm(u.name).split(" ")[0] === o || u.email === o);
  if (hits.length !== 1) { console.error(`--owners: "${o}" matches ${hits.length} Kylas users — use the id.`); process.exit(1); }
  ownerSet.add(hits[0].id);
}

/* ── 1 · every account, from the console's own crawl ─────────────── */
console.log("Reading every account from Kylas (the console's own crawl)…");
const crawl = await kylas.companies();
const cs = kylas.lastCompanySearch();
console.log(`${crawl.length} accounts${cs?.reportedTotal ? ` of the ${cs.reportedTotal} Kylas reports` : ""}${cs?.truncated ? " — SHORT: the rest are not checked" : ""}.`);
let accounts = crawl.map((c) => ({ id: String(c.id), owner: String((c.ownerId && typeof c.ownerId === "object" ? c.ownerId.id : c.ownerId) ?? "") }));
if (ownerSet.size) {
  accounts = accounts.filter((c) => ownerSet.has(c.owner));
  console.log(`--owners ${[...ownerSet].map(label).join(", ")}: ${accounts.length} account(s).`);
}
const LIMIT = has("all") ? Infinity : Number(arg("limit", "0"));
const MAX_CHECK = Number(arg("max", "0")) || Infinity;
accounts = accounts.slice(0, MAX_CHECK);

/* ── 2 · every account's contacts ─────────────────────────────────── */
const progress = (what) => { let last = -1; const t0 = Date.now();
  return (d, n) => { const p = Math.floor((d / n) * 20); if (p !== last) { last = p;
    console.log(`  ${what} ${d}/${n} · ${Math.round((Date.now() - t0) / 1000)}s`); } }; };
console.log(`\nReading the contacts of ${accounts.length} account(s) from Kylas…`);
const first = await verify({ kylas, items: accounts, apiUser: API_USER, userOf, companyOwnerOf, contactsOfCompany,
  concurrency: Number(arg("concurrency", "4")), onProgress: progress("read") });
const off = first.filter((r) => !["aligned", "gone"].includes(r.status));
console.log(`${first.length - off.length} aligned · ${off.length} with a contact on somebody else (or unreadable).`);

/* ── 3 · those again, owner included — nothing acts on the crawl ──── */
console.log(`\nReading those ${off.length} again, owner included…`);
const checked = await verify({ kylas, items: off.map((r) => r.id), apiUser: API_USER, userOf, companyOwnerOf, contactsOfCompany,
  onProgress: progress("re-read") });
const by = (s) => checked.filter((r) => r.status === s);
const fix = by("fix");
const count = (list) => list.reduce((a, r) => a + r.move.length, 0);
console.log(`\nRESULT (Kylas, now):`);
console.log(`  fix          ${String(fix.length).padStart(5)} account(s) on an active BD · ${count(fix)} contact(s) on somebody else → move to the account's owner`);
console.log(`  super-admin  ${String(by("super-admin").length).padStart(5)} account(s) on the Super Admin · ${count(by("super-admin"))} contact(s) — allot the account first (contacts are never moved TO the Super Admin)`);
console.log(`  deactivated  ${String(by("deactivated").length).padStart(5)} account(s) on a deactivated user · ${count(by("deactivated"))} contact(s) — allot the account first`);
console.log(`  no-owner     ${String(by("no-owner").length).padStart(5)} · aligned on the re-read ${by("aligned").length} · deleted ${by("gone").length} · unreadable ${by("error").length}`);

const tally = (pairs) => Object.entries(pairs.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
if (fix.length) {
  console.log(`\nTo fix, by the account's owner (accounts · contacts that move to them):`);
  const per = {};
  for (const r of fix) { (per[r.owner] ||= { a: 0, c: 0 }); per[r.owner].a++; per[r.owner].c += r.move.length; }
  for (const [o, v] of Object.entries(per).sort((a, b) => b[1].c - a[1].c)) console.log(`  ${label(o).padEnd(28)} ${v.a} · ${v.c}`);
  console.log(`\n...and who holds those contacts now:`);
  for (const [o, n] of tally(fix.flatMap((r) => r.move.map((m) => m.from)))) console.log(`  ${label(o).padEnd(28)} ${n}`);
}
const notFix = [...by("super-admin"), ...by("deactivated")];
if (notFix.length) {
  console.log(`\nNot fixed here — the account itself needs an owner (account id: owner · contacts on others):`);
  for (const r of notFix.slice(0, 40)) console.log(`  ${r.id.padEnd(9)} ${label(r.owner)} · ${r.move.length}`);
  if (notFix.length > 40) console.log(`  …and ${notFix.length - 40} more`);
}
writeFileSync("align-plan.json", JSON.stringify(checked.map(({ id, owner, status, move }) => ({ id, owner, status, move })), null, 2));

if (!has("apply")) {
  console.log(`\nCHECK ONLY — nothing written (plan in align-plan.json). Next: --apply --limit 1, look at that account in Kylas, then --apply --all.\n`);
  process.exit(0);
}

/* ── apply ───────────────────────────────────────────────────────── */
if (!(LIMIT > 0)) { console.error("Say how many: --limit 1 for the first one, --all for the rest."); process.exit(1); }
const todo = fix.slice(0, LIMIT);
const snapFile = `align-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(snapFile, JSON.stringify(todo.map((r) => ({ company: r.id, owner: r.owner, contacts: r.move })), null, 2));
console.log(`\nAPPLY — ${todo.length} of ${fix.length} account(s). Before-images: ${snapFile}\n`);
let fixed = 0, moved = 0, failed = 0;
for (let i = 0; i < todo.length; i += MAX_ALLOT) {
  const batch = todo.slice(i, i + MAX_ALLOT);
  /* The account goes to the person who already owns it — so allot() moves only
     the contacts, every one of them (leaveActive: false), and reads the
     account's owner back unchanged. */
  const r = await allot({ kylas, apiUser: API_USER, leaveActive: false, keepOwner: true,
    assignments: batch.map((x) => ({ company: x.id, ownerId: x.owner })) });
  for (const x of r.results) {
    if (x.ok && x.from === x.to) fixed++;
    moved += x.contactsMoved; failed += x.contactsFailed.length;
    const bad = !x.ok ? ` · ${x.why}` : x.from !== x.to ? ` · OWNER CHANGED ${x.from} -> ${x.to}?` : "";
    console.log(`  ${x.id.padEnd(9)} ${label(x.to)} · ${x.contactsMoved} contact(s) moved` +
      `${x.contactsFailed.length ? ` · NOT MOVED: ${x.contactsFailed.map((f) => `${f.id} (${f.why})`).join(", ")}` : ""}${bad}`);
  }
  console.log(`  — ${Math.min(i + MAX_ALLOT, todo.length)}/${todo.length}`);
}
console.log(`\nDONE: ${fixed}/${todo.length} account(s) with their contacts now on the account's owner · ${moved} contact(s) moved` +
  `${failed ? ` · ${failed} NOT moved (listed above)` : ""}.\n`);
process.exit(failed || fixed < todo.length ? 1 : 0);
