/* EVERY CONTACT ON AN ACCOUNT BELONGS TO WHOEVER OWNS THE ACCOUNT.
 *
 * Ayush, 2026-10-22: "for that account — all associated contacts for that
 * account should be allotted to whoever owns that account. Check for that."
 *
 * Two passes, so a check over the whole CRM costs minutes and not hours:
 *
 *   1. candidates() — the Airtable copy (Companies + Contacts, both carrying
 *      "Kylas Owner ID") says which accounts have at least one contact on
 *      somebody else. Reads only; pure.
 *   2. verify() — each of those accounts is read again from KYLAS, the
 *      account's owner and every contact on it, and classify() decides. The
 *      copy is at most an hour old, so it only nominates; Kylas decides.
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
 *   aligned      nothing to do (the copy was behind)
 */

const idOf = (v) => String((v && typeof v === "object" ? v.id : v) ?? "");

/* companies: Airtable Companies rows ({ id: recId, fields: { "Kylas Company
   ID", "Kylas Owner ID" } }); contacts: Contacts rows ({ fields: { "Kylas
   Contact ID", Company: [recId], "Kylas Owner ID" } }). Returns the accounts
   with at least one contact whose owner is not the account's, most such
   contacts first. */
export function candidates({ companies = [], contacts = [] }) {
  const byRec = new Map();
  for (const c of companies) {
    const kid = String(c?.fields?.["Kylas Company ID"] ?? "").trim();
    if (/^\d+$/.test(kid)) byRec.set(c.id, { kid, owner: String(c.fields["Kylas Owner ID"] ?? "").trim() });
  }
  const out = new Map();
  for (const p of contacts) {
    const f = p?.fields || {};
    const co = byRec.get((f.Company || [])[0]);
    const id = String(f["Kylas Contact ID"] ?? "").trim();
    if (!co || !/^\d+$/.test(id)) continue;
    const owner = String(f["Kylas Owner ID"] ?? "").trim();
    if (owner === co.owner) continue;
    if (!out.has(co.kid)) out.set(co.kid, { id: co.kid, owner: co.owner, off: [] });
    out.get(co.kid).off.push({ id, owner });
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

/* Each account read from Kylas: its owner, its contacts, then classify().
   companyOwnerOf / contactsOfCompany come from reassign.mjs, passed in so this
   file stays free of the client. A deleted account (404) is skipped. */
export async function verify({ kylas, ids = [], apiUser = "", userOf, companyOwnerOf, contactsOfCompany,
                               concurrency = 3, onProgress = () => {} }) {
  const results = new Array(ids.length);
  let next = 0, done = 0;
  const one = async (id) => {
    try {
      const owner = await companyOwnerOf(kylas, id, await kylas.company(id));
      const people = await contactsOfCompany(kylas, id);
      return { id: String(id), owner, contacts: people.length, ...(await classify({ owner, people, apiUser, userOf })) };
    } catch (e) {
      if (e?.status === 404) return { id: String(id), status: "gone", move: [] };
      return { id: String(id), status: "error", move: [], why: String(e?.message || e).slice(0, 120) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, async () => {
    while (next < ids.length) { const i = next++; results[i] = await one(ids[i]); onProgress(++done, ids.length); }
  }));
  return results;
}
