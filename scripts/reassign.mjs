/* MOVING ACCOUNTS, AND THE PEOPLE ON THEM, FROM ONE BD TO ANOTHER.
 *
 * Ayush, 2026-09-30: "I can select multiple accounts, then reassign, and when
 * I reassign the associated contacts also get reassigned to that specific
 * individual." The pain behind it is accounts drifting onto the Enout super
 * admin and taking their POCs with them, so the cascade is the whole point:
 * an account whose contacts stayed behind has not really been handed over.
 *
 * ── WHY THIS FILE IS PARANOID ──────────────────────────────────────────
 *
 * Until now NOTHING in this tree called kylas.updateCompany, and test-replace
 * asserted exactly that, with the note: "the day it stops being true is the
 * day contacts start moving on their own." This is that day, on purpose, so
 * the rules that note was protecting are written down here instead.
 *
 *   1. A PUT REPLACES THE RECORD. On contacts this repo has already deleted a
 *      real person's name, phone and email by sending a partial body. Companies
 *      are the same endpoint family and are assumed to behave the same way, so
 *      every write here is the WHOLE record, read immediately beforehand, with
 *      exactly one field changed.
 *
 *   2. NOTHING IS WRITTEN UNTIL IT IS COUNTED. plan() resolves what would move
 *      and writes nothing. The console shows that count and the person agrees
 *      to it before apply() sends a single request. "Select all" on a list of
 *      17,925 must never be one keystroke away from 17,925 writes.
 *
 *   3. A CAP THAT IS NOT A SUGGESTION. apply() refuses a batch larger than
 *      MAX_ACCOUNTS rather than truncating it silently, because a caller that
 *      asked to move 500 and was told "moved 200" cannot tell which 200.
 *
 *   4. ONE ACCOUNT AT A TIME, AND ITS CONTACTS WITH IT. If a company write
 *      fails, its contacts are left alone — a company on the old owner with
 *      its POCs on the new one is worse than nothing having happened. Failures
 *      are collected and reported per account; they never abort the rest.
 *
 *   5. IDEMPOTENT BY NATURE. Setting ownerId to the value it already holds is
 *      a no-op, so a retried batch costs requests and changes nothing. Accounts
 *      already owned by the target are skipped before they cost a write.
 */

/* Kylas hands lookups back as {id, name} and multi-picklists as arrays of
   them; sending the object back where an id is expected drops the field, and
   a dropped field on a replacing PUT is a deleted field.

   INSIDE customFieldValues ONLY. This is push-kylas' rule, where every value
   is a picklist option or a scalar and collapsing on `id ?? value` is right. */
const idOf = (v) => (Array.isArray(v) ? v.map(idOf)
  : v && typeof v === "object" ? (v.id ?? v.value) : v);

/* AT THE TOP LEVEL IT IS NOT THE SAME RULE, and assuming it was cost a phone
   number in the first run of this file's own tests. A phone is
   {type: "MOBILE", value: "9…", primary: true} — it has a `value`, so idOf
   flattened it to the bare string and threw away the type and the primary
   flag. On a replacing PUT that is not a formatting difference, it is the
   record going back mangled.

   So: collapse ONLY something that is unmistakably a lookup — an object whose
   keys are just id and name. Everything else, structured arrays included,
   goes back exactly as Kylas served it. */
const isLookup = (v) => !!v && typeof v === "object" && !Array.isArray(v)
  && v.id !== undefined && Object.keys(v).every((k) => k === "id" || k === "name");
const topValue = (v) => {
  if (Array.isArray(v)) return v.every(isLookup) ? v.map((x) => x.id) : v;
  return isLookup(v) ? v.id : v;
};

/* Everything Kylas manages itself. Sending these back is at best ignored and
   at worst rejected, and none of them is ours to state. */
const SERVER_KEYS = new Set([
  "id", "createdAt", "updatedAt", "createdBy", "updatedBy", "recordActions",
  "entityType", "actualValue", "hasDuplicate", "converted", "convertedAt",
  "convertedBy", "pipeline", "stageUpdatedAt", "associatedContacts",
  /* metaData IS NOT DATA. It is Kylas' own id -> display-name cache for the
     lookups on the record, and it was missing from this list on the first
     live run: the company PUT carried it back, and lucidity (1777441) came
     out of that write with NO OWNER AT ALL and then refused every further
     write with 02803002. The mock merged it without complaint, which is how
     it got this far. Nothing Kylas computes for us is ours to send back. */
  "metaData", "idNameStore", "companyStage", "lastActivityAt",
  "nextActivityAt", "score", "duplicateOf", "ownerName",
]);

export const MAX_ACCOUNTS = 200;

/* THE WHOLE COMPANY, with one field changed.
   Built from the record as Kylas just served it rather than from a field list
   of our own: a field this codebase has never heard of is exactly the field a
   hand-written body would drop, and dropping it deletes it. */
export function companyBody(base, ownerId) {
  const body = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (SERVER_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    body[k] = k === "customFieldValues" ? cfv(v) : topValue(v);
  }
  /* Kylas rejects a company with no name, and a company that somehow has none
     is not one this tool should be inventing a name for. */
  if (!body.name) throw new Error("the company Kylas returned has no name — refusing to write it back");
  body.ownerId = Number(ownerId);
  return body;
}

function cfv(v) {
  const out = {};
  for (const [k, raw] of Object.entries(v || {})) {
    const id = idOf(raw);
    if (id !== undefined && id !== null && id !== "") out[k] = id;
  }
  return out;
}

/* WHAT WOULD MOVE, WITHOUT MOVING IT.
   Resolves every account and counts the contacts that would follow. This is
   what the console puts in front of the person, and it is the only honest
   basis for "are you sure": a number derived from the same reads the write
   will use, not an estimate from the row count on screen. */
export async function plan({ kylas, companies = [], ownerId, log = () => {} }) {
  const ids = [...new Set(companies.map(String).filter(Boolean))];
  const to = String(ownerId || "");
  if (!to) throw Object.assign(new Error("an owner to move them to is required"), { status: 400 });
  if (!ids.length) throw Object.assign(new Error("no accounts were selected"), { status: 400 });

  const accounts = [], problems = [];
  let contacts = 0, already = 0;
  for (const id of ids) {
    try {
      const co = await kylas.company(id);
      const held = String(idOf(co?.ownerId) ?? "");
      const people = await kylas.contactsForCompany(id);
      /* Already theirs: counted, shown, and not written. */
      const noop = held === to;
      if (noop) already++;
      accounts.push({ id, name: co?.name || `Company ${id}`, from: held,
                      fromName: co?.ownerId?.name || "", contacts: people.length, noop });
      if (!noop) contacts += people.length;
    } catch (e) {
      problems.push({ id, why: e.message.slice(0, 160), status: e.status || 0 });
    }
  }
  const moving = accounts.filter((a) => !a.noop).length;
  log(`reassign: ${moving} account(s) and ${contacts} contact(s) would move` +
      (already ? `, ${already} already there` : "") +
      (problems.length ? `, ${problems.length} could not be read` : ""));
  return { accounts, moving, contacts, already, problems, ownerId: to, cap: MAX_ACCOUNTS };
}

/* THE WRITE.
   Company first, then its contacts — see rule 4. Sequential on purpose: the
   Kylas client rate-limits at about five a second and a burst of parallel PUTs
   buys nothing but 429s. */
export async function apply({ kylas, companies = [], ownerId, log = () => {},
                              onProgress = () => {} }) {
  const ids = [...new Set(companies.map(String).filter(Boolean))];
  const to = String(ownerId || "");
  if (!to) throw Object.assign(new Error("an owner to move them to is required"), { status: 400 });
  if (!ids.length) throw Object.assign(new Error("no accounts were selected"), { status: 400 });
  /* Refused, not truncated — rule 3. */
  if (ids.length > MAX_ACCOUNTS)
    throw Object.assign(new Error(
      `${ids.length} accounts is more than one batch may move (${MAX_ACCOUNTS}). ` +
      `Re-assign them in smaller groups, so a mistake is a group and not the account.`),
      { status: 400 });

  const moved = [], failed = [];
  let contactsMoved = 0, skipped = 0, done = 0;
  for (const id of ids) {
    try {
      /* READ IMMEDIATELY BEFORE THE WRITE. Not from the crawl, not from the
         Airtable copy: both can be an hour old, and an hour-old body written
         back over a fresh record silently reverts whatever moved in between. */
      const co = await kylas.company(id);
      if (String(idOf(co?.ownerId) ?? "") === to) { skipped++; done++; onProgress({ done, total: ids.length }); continue; }
      await kylas.updateCompany(id, companyBody(co, to));

      /* ...AND ONLY THEN THE PEOPLE ON IT. A company that failed above never
         reaches this line, so its contacts stay where they are. */
      const people = await kylas.contactsForCompany(id);
      const stuck = [];
      for (const p of people) {
        try {
          const full = await kylas.contact(p.id);
          if (String(idOf(full?.ownerId) ?? "") === to) continue;
          await kylas.updateContact(p.id, contactBody(full, to));
          contactsMoved++;
        } catch (e) { stuck.push({ id: String(p.id), why: e.message.slice(0, 120) }); }
      }
      moved.push({ id, name: co?.name || `Company ${id}`, contacts: people.length - stuck.length,
                   ...(stuck.length ? { contactsFailed: stuck } : {}) });
    } catch (e) {
      failed.push({ id, why: e.message.slice(0, 160), status: e.status || 0 });
    }
    done++;
    onProgress({ done, total: ids.length });
  }
  log(`reassign: moved ${moved.length} account(s) and ${contactsMoved} contact(s) to owner ${to}` +
      (skipped ? `, ${skipped} already there` : "") +
      (failed.length ? `, ${failed.length} FAILED` : ""));
  return { moved: moved.length, contacts: contactsMoved, skipped, failed, accounts: moved, ownerId: to };
}

/* THE WHOLE CONTACT, with one field changed.
   Deliberately not push-kylas' bodyFor(): that builds a contact from a named
   field list, which is right when the card is the source of truth and wrong
   here, where the record is. Same rule as companyBody — carry everything, set
   one thing. */
export function contactBody(base, ownerId) {
  const body = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (SERVER_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    body[k] = k === "customFieldValues" ? cfv(v) : topValue(v);
  }
  if (!body.lastName) body.lastName = base?.lastName || "Unknown";
  body.ownerId = Number(ownerId);
  return body;
}
