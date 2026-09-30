/* MOVING THE PEOPLE ON AN ACCOUNT FROM ONE BD TO ANOTHER.
 *
 * Ayush, 2026-09-30: "I can select multiple accounts, then reassign, and when
 * I reassign the associated contacts also get reassigned to that specific
 * individual." The pain behind it is accounts drifting onto the Enout super
 * admin and taking their POCs with them.
 *
 * ── WHAT THIS DOES NOT DO, AND WHY ─────────────────────────────────────
 *
 * IT DOES NOT SET THE COMPANY'S OWN OWNER. Kylas will not let it. Established
 * the hard way on 2026-09-30, on a live account (lucidity, 1777441), which is
 * the only reason it is known at all:
 *
 *   PUT /v1/companies/{id} carrying ownerId is ACCEPTED — 200, no complaint —
 *   and the field is silently DROPPED. Because the PUT replaces the record,
 *   "ignored" means "erased": the account came out of the write with no owner
 *   at all, and there was no way to put it back through the API.
 *
 *   Seven encodings were tried (number, string, {id}, {id,name}, `owner`,
 *   PATCH twice) and nine endpoints (per-record and bulk assign, owner,
 *   bulk-update, merge-patch, json-patch). Every one either 404'd, 400'd, or
 *   returned 200 and changed nothing. A 200 from this endpoint means the
 *   request was well formed, never that it did anything.
 *
 * So the company write is GONE from this file, not flagged off, and
 * test-replace's original fence — "nothing calls updateCompany" — is back up
 * exactly as it was. Its note said the day it stopped being true would be the
 * day contacts started moving on their own. It was right, it took one
 * afternoon, and it cost one account its owner.
 *
 * What remains is the part that works and is proven: the CONTACTS on the
 * selected accounts move. Contacts take ownerId as a plain number — the save
 * path has always done it and test-replace pins it. Account ownership itself
 * has to be set in Kylas' own UI.
 *
 * ── THE RULES THAT STILL HOLD ──────────────────────────────────────────
 *
 *   1. A PUT REPLACES THE RECORD. This repo has already deleted a real
 *      person's name, phone and email by sending a partial body. Every write
 *      here is the WHOLE record, read immediately beforehand, one field
 *      changed — and nothing Kylas computes for us is sent back.
 *
 *   2. NOTHING IS WRITTEN UNTIL IT IS COUNTED. plan() resolves what would move
 *      and writes nothing. The console shows that count and the person agrees
 *      to it before apply() sends a single request. "Select all" on a list of
 *      17,925 must never be one keystroke away from thousands of writes.
 *
 *   3. A CAP THAT IS NOT A SUGGESTION. apply() refuses a batch larger than
 *      MAX_ACCOUNTS rather than truncating it silently, because a caller that
 *      asked to move 500 and was told "moved 200" cannot tell which 200.
 *
 *   4. A FAILURE ON ONE ACCOUNT NEVER ABORTS THE REST. Failures are collected
 *      and reported per account, per contact.
 *
 *   5. IDEMPOTENT BY NATURE. Setting ownerId to the value it already holds is
 *      a no-op, so a retried batch costs requests and changes nothing.
 *      Contacts already on the target are skipped before they cost a write.
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

/* There is deliberately NO companyBody() here any more. It existed, it was
   tested, it round-tripped cleanly against the mock, and on a live account it
   erased an owner Kylas would not then let anybody set back. The diagnostic
   copy lives in scripts/probe-reassign.mjs, which is a tool for investigating
   this endpoint and is never reached by a save, a cron or the console. */

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
      const people = await kylas.contactsForCompany(id);
      /* COUNTED PER CONTACT, NOT PER ACCOUNT. Whether the ACCOUNT is already
         on the target is not the question any more — its owner is not ours to
         change. What matters is how many of its people are not on the target
         yet, because those are the only writes that will happen. */
      const toMove = people.filter((p) => String(idOf(p?.ownerId) ?? "") !== to);
      already += people.length - toMove.length;
      contacts += toMove.length;
      accounts.push({ id, name: co?.name || `Company ${id}`,
                      accountOwner: String(idOf(co?.ownerId) ?? ""),
                      accountOwnerName: co?.ownerId?.name || "",
                      contacts: people.length, moving: toMove.length });
    } catch (e) {
      problems.push({ id, why: e.message.slice(0, 160), status: e.status || 0 });
    }
  }
  const moving = accounts.filter((a) => a.moving > 0).length;
  log(`reassign: ${contacts} contact(s) across ${moving} account(s) would move` +
      (already ? `, ${already} already there` : "") +
      (problems.length ? `, ${problems.length} could not be read` : ""));
  return { accounts, moving, contacts, already, problems, ownerId: to, cap: MAX_ACCOUNTS,
           /* So the console never again implies something it cannot do. */
           accountOwnerMoves: false };
}

/* THE WRITE — CONTACTS ONLY.
   Sequential on purpose: the Kylas client rate-limits at about five a second
   and a burst of parallel PUTs buys nothing but 429s. */
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
      /* The company is READ, never written — for its name, and to fail the
         account early if Kylas cannot serve it at all. See the header for what
         happened the day this line was a write. */
      const co = await kylas.company(id);
      const people = await kylas.contactsForCompany(id);
      const stuck = [];
      let n = 0;
      for (const p of people) {
        try {
          /* READ IMMEDIATELY BEFORE THE WRITE. Not from the crawl, not from the
             Airtable copy: both can be an hour old, and an hour-old body written
             back over a fresh record silently reverts whatever moved in between. */
          const full = await kylas.contact(p.id);
          if (String(idOf(full?.ownerId) ?? "") === to) { skipped++; continue; }
          await kylas.updateContact(p.id, contactBody(full, to));
          contactsMoved++; n++;
        } catch (e) { stuck.push({ id: String(p.id), why: e.message.slice(0, 120) }); }
      }
      moved.push({ id, name: co?.name || `Company ${id}`, contacts: n,
                   ...(stuck.length ? { contactsFailed: stuck } : {}) });
    } catch (e) {
      failed.push({ id, why: e.message.slice(0, 160), status: e.status || 0 });
    }
    done++;
    onProgress({ done, total: ids.length });
  }
  log(`reassign: moved ${contactsMoved} contact(s) across ${moved.length} account(s) to owner ${to}` +
      (skipped ? `, ${skipped} already there` : "") +
      (failed.length ? `, ${failed.length} FAILED` : ""));
  return { moved: moved.length, contacts: contactsMoved, skipped, failed, accounts: moved,
           ownerId: to, accountOwnerMoves: false };
}

/* THE WHOLE CONTACT, with one field changed.
   Deliberately not push-kylas' bodyFor(): that builds a contact from a named
   field list, which is right when the card is the source of truth and wrong
   here, where the record is. Carry everything, set one thing, and send back
   nothing Kylas computes for us. */
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
