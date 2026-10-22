#!/usr/bin/env node
/* "X NAHI DIKH RAHI" — WHERE IS THIS ACCOUNT, AND WHY IS IT NOT ON THE SCREEN.
 *
 * Ayush, 2026-10-22: "Boolean Post nahi dikh rahi hai, kya reason ho sakte
 * hai". The console's accounts list is the Airtable copy (handlers.mjs
 * /companies), so an account can be missing from it for reasons Kylas never
 * shows. This asks Kylas (free-text, as its own search box does) and the copy,
 * and says which case it is:
 *
 *   not in Kylas         nothing by that name — spelling, or deleted
 *   not in the copy      in Kylas, but the sync has not brought it over yet
 *                        (companies sync nightly at 02:00 IST; a contact's
 *                        hourly sync brings its company with it)
 *   owner                in the copy, on somebody else — a BD sees only their own
 *   deactivated / Super Admin owner
 *
 *   node --env-file=.env.local scripts/find-account.mjs --name "boolean post"
 *
 * Reads only. Logs print ids and BD first names only (public Actions logs):
 * the name searched for is never echoed, and a match is described as exact or
 * partial rather than printed.
 */
import { createClient, toUser } from "./kylas.mjs";
import { createAirtable } from "./airtable.mjs";
import { companyOwnerOf, contactsOfCompany } from "./reassign.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const NAME = String(arg("name", process.env.FIND_NAME || "")).trim();
const { KYLAS_KEY, AIRTABLE_PAT } = process.env;
if (!NAME) { console.error('--name "account name"'); process.exit(1); }
for (const [k, v] of Object.entries({ KYLAS_KEY, AIRTABLE_PAT })) if (!v) { console.error(`Set ${k}.`); process.exit(1); }
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const want = norm(NAME);
const idOf = (v) => String((v && typeof v === "object" ? v.id : v) ?? "");

const kylas = createClient(KYLAS_KEY, { log: () => {}, base: process.env.KYLAS_BASE || "https://api.kylas.io" });
const at = createAirtable(AIRTABLE_PAT, process.env.AIRTABLE_BASE || "appEwJu0bleHh9b8t", { log: () => {} });
const apiUser = toUser(await kylas.me().catch(() => ({}))).id || "74725";
const userCache = new Map();
const who = async (id) => {
  if (!id) return "nobody";
  if (id === apiUser) return `Super Admin ${id}`;
  if (!userCache.has(id)) userCache.set(id, await kylas.user(id).then(toUser).catch(() => null));
  const u = userCache.get(id);
  return `${u?.name?.split(" ")[0] || "user"} ${id}${u?.active === false ? " (DEACTIVATED)" : ""}`;
};
const match = (name) => (norm(name) === want ? "exact" : norm(name).includes(want) || want.includes(norm(name)) ? "partial" : "loose");
const free = (v) => ({ condition: "AND", valid: true, rules: [{ id: "multi_field", field: "multi_field", type: "multi_field", input: "multi_field", operator: "multi_field", value: v }] });
const rows = (r) => r?.content || r?.data || [];

/* Each word too, so "Boolean Post" also finds "BooleanPost" and "Boolean Post Pvt Ltd". */
const terms = [...new Set([NAME, ...NAME.split(/\s+/).filter((w) => w.length >= 4)])];
const companies = new Map();
for (const t of terms) {
  for (const fields of [["id", "name", "ownerId", "createdAt", "updatedAt"], ["id", "name", "ownerId"]]) {
    try {
      const r = await kylas.raw("POST", "/v1/search/company?sort=updatedAt,desc&page=0&size=50", { fields, jsonRule: free(t) });
      for (const c of rows(r)) if (match(c.name) !== "loose") companies.set(String(c.id), c);
      break;
    } catch (e) { if (![400, 500].includes(e.status)) throw e; }
  }
}
const contacts = new Map();
for (const t of terms) {
  try { for (const c of await kylas.contactsMatching(t, 50)) contacts.set(String(c.id), c); } catch { /* the company half still answers */ }
}
const viaContact = [...contacts.values()].filter((c) => match(c.companyName || c.company?.name || "") !== "loose");
for (const c of viaContact) {
  const id = idOf(c.company);
  if (id && !companies.has(id)) companies.set(id, { id, name: c.companyName || c.company?.name || "", viaContact: true });
}

console.log(`Kylas: ${companies.size} account(s) whose name matches (exact or partial).`);
if (!companies.size) {
  console.log(`\nVERDICT: not in Kylas under that name — check the spelling in Kylas, or it was deleted / merged.`);
  process.exit(0);
}
for (const [id, c] of companies) {
  let rec = null;
  try { rec = await kylas.company(id); } catch (e) { console.log(`\n${id}: Kylas cannot read it (${e.status || e.message}) — deleted?`); continue; }
  const owner = await companyOwnerOf(kylas, id, rec);
  const people = await contactsOfCompany(kylas, id).catch(() => []);
  const copy = await at.list("Companies", `{Kylas Company ID}='${id}'`, 1).catch(() => []);
  const row = copy[0]?.fields || null;
  const copyContacts = await at.list("Contacts", `ARRAYJOIN({Company Kylas ID})='${id}'`, 100).catch(() => []);
  const u = owner ? (await who(owner), userCache.get(owner)) : null;
  console.log(`\n${id}  (${match(c.name || rec?.name)} match${c.viaContact ? ", found through a contact" : ""})`);
  console.log(`  Kylas:   owner ${await who(owner)} · created ${rec?.createdAt || c.createdAt || "?"} · updated ${rec?.updatedAt || c.updatedAt || "?"} · ${people.length} contact(s)` +
    (people.length ? ` on ${[...new Set(await Promise.all(people.map((p) => who(idOf(p.ownerId)))))].join(", ")}` : ""));
  console.log(`  Copy:    ${row ? `in Companies — owner ${row["Kylas Owner ID"] ? await who(String(row["Kylas Owner ID"])) : "(blank)"} · ${copyContacts.length} contact row(s)` : "NOT in Companies"}`);
  const why = [];
  if (!row) why.push("not in the Airtable copy yet, so the console cannot list it — the nightly company sync (02:00 IST) brings it, or sooner if a contact on it syncs (hourly)");
  else if (String(row["Kylas Owner ID"] || "") !== owner) why.push(`the copy still has the old owner — it moves to ${await who(owner)} at the next sync`);
  if (owner === apiUser) why.push("owned by the Super Admin — only shows under Owner: Super Admin / everyone, never in a BD's own list");
  else if (u && u.active === false) why.push("owner is DEACTIVATED — nobody sees it in their own list; allot it");
  else if (owner) why.push(`a BD sees it only if they are ${await who(owner)} — anyone else must switch Owner to everyone (admins)`);
  if (!people.length) why.push("no contacts — it shows under All accounts, but not in any calling queue");
  console.log(`  Why:     ${why.join("\n           ")}`);
}
