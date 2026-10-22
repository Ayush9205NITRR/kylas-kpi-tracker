#!/usr/bin/env node
/* "X NAHI DIKH RAHI" — IS THIS ACCOUNT IN KYLAS, AND WHY IS IT NOT ON THE SCREEN.
 *
 * Ayush, 2026-10-22: "Boolean Post nahi dikh rahi hai, kya reason ho sakte
 * hai". This reads what the console reads — the Kylas company crawl
 * (handlers.mjs /companies serves it whenever the Airtable copy is short of the
 * account, which on 2026-10-22 it was: 685 of ~17,900) — and looks for the name
 * there, then for contacts whose company carries that name. For each account
 * found: its owner, whether that owner is active, its contacts and who holds
 * them, and so which screens show it.
 *
 *   node --env-file=.env.local scripts/find-account.mjs --name "boolean post"
 *
 * Reads only. PUBLIC LOGS: a matched name is printed as its first three
 * letters and its length ("Boo… 12 chars"), never whole; ids and BD first
 * names otherwise.
 */
import { createClient, toUser } from "./kylas.mjs";
import { companyOwnerOf, contactsOfCompany } from "./reassign.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const NAME = String(arg("name", process.env.FIND_NAME || "")).trim();
if (!NAME) { console.error('--name "account name"'); process.exit(1); }
if (!process.env.KYLAS_KEY) { console.error("Set KYLAS_KEY."); process.exit(1); }
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const want = norm(NAME);
const words = NAME.toLowerCase().split(/\s+/).map(norm).filter((w) => w.length >= 4);
const idOf = (v) => String((v && typeof v === "object" ? v.id : v) ?? "");
const hint = (s) => `"${String(s || "").trim().slice(0, 3)}…" ${String(s || "").trim().length} chars`;
/* exact | contains the whole name | has one of its words | null. An empty name
   matches nothing — the first version let "" through as a partial match. */
const match = (name) => {
  const n = norm(name);
  if (!n) return null;
  if (n === want) return "exact";
  if (n.includes(want) || (n.length >= 5 && want.includes(n))) return "partial";
  if (words.some((w) => n.includes(w))) return "word";
  return null;
};

const kylas = createClient(process.env.KYLAS_KEY, { log: () => {}, base: process.env.KYLAS_BASE || "https://api.kylas.io" });
const apiUser = toUser(await kylas.me().catch(() => ({}))).id || "74725";
const userCache = new Map();
const userOf = async (id) => {
  if (!userCache.has(id)) userCache.set(id, await kylas.user(id).then(toUser).catch(() => null));
  return userCache.get(id);
};
const who = async (id) => {
  if (!id) return "nobody";
  if (id === apiUser) return `Super Admin ${id}`;
  const u = await userOf(id);
  return `${u?.name?.split(" ")[0] || "user"} ${id}${u?.active === false ? " (DEACTIVATED)" : ""}`;
};

console.log("Reading every account from Kylas (the list the console shows)…");
const crawl = await kylas.companies();
const cs = kylas.lastCompanySearch();
console.log(`${crawl.length} accounts${cs?.reportedTotal ? ` of the ${cs.reportedTotal} Kylas reports` : ""}${cs?.truncated ? " — the list is SHORT, an account can be missing from it" : ""}.`);
const found = new Map();
for (const c of crawl) { const m = match(c.name); if (m) found.set(String(c.id), { id: String(c.id), name: c.name, how: m }); }

/* Contacts whose company is called that — Kylas' own free-text search. */
for (const t of [NAME, ...words]) {
  let list = [];
  try { list = await kylas.contactsMatching(t, 50); } catch { continue; }
  for (const p of list) {
    const coName = p.companyName || (p.company && typeof p.company === "object" ? p.company.name : "");
    const m = match(coName), id = idOf(p.company);
    if (m && id && !found.has(id)) found.set(id, { id, name: coName, how: `${m}, through a contact — NOT in the console's list` });
  }
}

const rank = { exact: 0, partial: 1, word: 2 };
const hits = [...found.values()].sort((a, b) => (rank[a.how.split(",")[0]] ?? 3) - (rank[b.how.split(",")[0]] ?? 3));
console.log(`\n${hits.filter((h) => h.how === "exact").length} exact · ${hits.filter((h) => h.how.startsWith("partial")).length} containing the whole name · ` +
  `${hits.filter((h) => h.how.startsWith("word")).length} sharing a word.`);
if (!hits.some((h) => h.how !== "word")) {
  console.log(`\nVERDICT: no account in Kylas is called that. Check the spelling in Kylas itself (search there), ` +
    `or it was deleted / merged.${hits.length ? " The word matches are listed below in case one is it." : ""}`);
}
for (const h of hits.slice(0, 15)) {
  let rec = null;
  try { rec = await kylas.company(h.id); } catch (e) { console.log(`\n${h.id}  ${hint(h.name)} (${h.how}) — Kylas cannot read it (${e.status || e.message}): deleted?`); continue; }
  const owner = await companyOwnerOf(kylas, h.id, rec);
  const people = await contactsOfCompany(kylas, h.id).catch(() => []);
  const holders = [...new Set(await Promise.all(people.map((p) => who(idOf(p.ownerId)))))];
  const u = owner && owner !== apiUser ? await userOf(owner) : null;
  console.log(`\n${h.id}  ${hint(h.name)} (${h.how})`);
  console.log(`  owner ${await who(owner)} · created ${rec?.createdAt || "?"} · updated ${rec?.updatedAt || "?"} · ` +
    `${people.length} contact(s)${people.length ? ` on ${holders.join(", ")}` : ""}`);
  const shows = [];
  if (owner === apiUser) shows.push("on the Super Admin: in All accounts only with Owner = everyone / Super Admin; in nobody's own list or queue");
  else if (u?.active === false) shows.push("owner DEACTIVATED: in nobody's own list; admins see it with Owner = everyone — allot it");
  else if (owner) shows.push(`in ${await who(owner)}'s own list; everyone else only with Owner = everyone (admins)`);
  if (!people.length) shows.push("no contacts: listed under All accounts, but never in a calling queue");
  console.log(`  Shows:  ${shows.join("\n          ")}`);
}
if (hits.length > 15) console.log(`\n…and ${hits.length - 15} more word matches.`);
