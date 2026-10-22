/* EVERY CONTACT ON AN ACCOUNT BELONGS TO WHOEVER OWNS THE ACCOUNT.
 *
 * Ayush, 2026-10-22: "for that account — all associated contacts for that
 * account should be allotted to whoever owns that account. Check for that."
 *
 * KYLAS ONLY, NOT THE AIRTABLE COPY. The first version nominated accounts from
 * the copy and would have checked about one in twenty: on 2026-10-22 the copy
 * held 685 of Kylas' ~17,900 companies, and only 1,947 of its 37,443 contacts
 * were linked to a company at all. So:
 *
 *   1. the console's own company crawl (kylas.companies()) gives every account
 *      and its owner;
 *   2. ONE crawl of every contact (kylas.contactsChangedSince(null), 200 a
 *      page, only id / owner / company) — offAccounts() joins the two and
 *      names the accounts with a contact on somebody else. A search per
 *      account was tried first: Kylas allows about one request a second, so
 *      18,000 accounts was five hours; the contact crawl is a few hundred
 *      requests;
 *   3. those accounts are read AGAIN, owner and contacts (verify() with no
 *      owner given), and classify() decides — so a fix never acts on a crawl
 *      that is minutes old.
 *
 * WHAT IS FIXED, AND WHAT IS ONLY REPORTED (classify):
 *   fix          the account is on an active BD → its other contacts go to
 *                that BD, whoever holds them now (another BD, the Super
 *                Admin, a deactivated user, nobody)
 *   super-admin  the account itself is on the API user (Enout Super Admin) —
 *                contacts are never handed TO the API user; the account needs
 *                allotting first
 *   deactivated  the account is on a deactivated user — same: allot it first
 *   no-owner     Kylas names no owner for the account
 *   aligned      nothing to do
 */

const idOf = (v) => String((v && typeof v === "object" ? v.id : v) ?? "");

/* accounts: [{ id, owner }] from the company crawl; contacts: Kylas rows
   ({ id, ownerId, company }). Every account with at least one contact whose
   owner is not the account's, most such contacts first. Contacts on an
   account outside `accounts` (another owner, under --owners) are ignored. */
export function offAccounts(accounts = [], contacts = []) {
  const owner = new Map(accounts.map((a) => [String(a.id), String(a.owner ?? "")]));
  const out = new Map();
  for (const c of contacts) {
    const co = idOf(c?.company);
    if (!co || !owner.has(co)) continue;
    const from = idOf(c.ownerId);
    if (from === owner.get(co)) continue;
    if (!out.has(co)) out.set(co, { id: co, owner: owner.get(co), off: [] });
    out.get(co).off.push({ id: String(c.id), from });
  }
  return [...out.values()].sort((a, b) => b.off.length - a.off.length || Number(a.id) - Number(b.id));
}

/* owner: the account's owner as Kylas has it now; people: its contacts as
   Kylas has them ({ id, ownerId }). userOf(id) -> { active } | null. */
export async function classify({ owner, people = [], apiUser = "", userOf = async () => null }) {
  const move = people.map((p) => ({ id: String(p.id), from: idOf(p.ownerId) }))
    .filter((p) => p.from !== String(owner));
  if (!move.length) return { status: "aligned", move };
  if (!owner) return { status: "no-owner", move };
  if (String(owner) === String(apiUser)) return { status: "super-admin", move };
  const u = await userOf(String(owner));
  if (u && u.active === false) return { status: "deactivated", move };
  return { status: "fix", move };
}

/* items: [{ id, owner? }]. With an owner (from the crawl) only the contacts
   are read; without, the account is read too. companyOwnerOf /
   contactsOfCompany come from reassign.mjs, passed in so this file stays free
   of the client. A deleted account (404) is skipped. */
export async function verify({ kylas, items = [], apiUser = "", userOf, companyOwnerOf, contactsOfCompany,
                               concurrency = 3, onProgress = () => {} }) {
  const list = items.map((x) => (typeof x === "object" ? x : { id: x }));
  const results = new Array(list.length);
  let next = 0, done = 0;
  const one = async ({ id, owner: known }) => {
    try {
      const owner = known !== undefined ? String(known) : await companyOwnerOf(kylas, id, await kylas.company(id));
      const people = await contactsOfCompany(kylas, id);
      return { id: String(id), owner, contacts: people.length, ...(await classify({ owner, people, apiUser, userOf })) };
    } catch (e) {
      if (e?.status === 404) return { id: String(id), status: "gone", move: [] };
      return { id: String(id), status: "error", move: [], why: String(e?.message || e).slice(0, 120) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    while (next < list.length) { const i = next++; results[i] = await one(list[i]); onProgress(++done, list.length); }
  }));
  return results;
}
