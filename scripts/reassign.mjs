/* MOVING THE PEOPLE ON AN ACCOUNT FROM ONE BD TO ANOTHER.
 *
 * Ayush, 2026-09-30: "I can select multiple accounts, then reassign, and when
 * I reassign the associated contacts also get reassigned to that specific
 * individual." The pain behind it is accounts drifting onto the Enout super
 * admin and taking their POCs with them.
 *
 * ── THE ACCOUNT'S OWN OWNER, AND THE THREE WRONG ANSWERS BEFORE IT ─────
 *
 * IT DOES SET IT, through a DIFFERENT ENDPOINT:
 *
 *   PUT /v1/companies/{id}/owner   {"ownerId": N}
 *
 * Proven live 2026-10-15 — turbohire (1779587), 82867 -> 74757, read back
 * through the SEARCH and changed. Not updateCompany, and never to be folded
 * into it: that one REPLACES the record, which is how lucidity (1777441) lost
 * its owner on 2026-09-30 and why test-replace's "nothing calls updateCompany"
 * fence stays up. This endpoint touches one field and replaces nothing.
 *
 * THE BODY WAS RIGHT ALL ALONG. `ownerId`, exactly as Kylas' leads flavour
 * documents it, from the very first attempt. What was broken was the READBACK:
 * GET /v1/companies/{id} does not return the owner on this account, so every
 * check read "(none)" before and after and called a write that had LANDED
 * "accepted and ignored". That one blind read produced three wrong answers in
 * a row — including a confident "this cannot be done, change it in Kylas' own
 * UI" written into this very header. `ownedBy`, the key the record itself
 * carries, 500s on this endpoint.
 *
 * The lesson is not about Kylas. It is that a readback which cannot see the
 * field is not a readback, and a verdict drawn from one is worth less than no
 * verdict at all, because it stops the search.
 *
 * What was never in doubt: the CONTACTS on the selected accounts move, through
 * PUT /v1/contacts/{id} with ownerId as a plain number.
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
  let contacts = 0, already = 0, accountOwners = 0;
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
      /* THE ACCOUNT'S OWN OWNER COUNTS AGAIN. The single GET does not return it
         on this account, so "" here means UNKNOWN, not unowned — and an unknown
         owner is treated as needing the write, because the write is a no-op
         when it is already right. */
      const accOwner = String(idOf(co?.ownerId) ?? "");
      const accMoves = accOwner !== to;
      if (accMoves) accountOwners++;
      accounts.push({ id, name: co?.name || `Company ${id}`,
                      accountOwner: accOwner,
                      accountOwnerName: co?.ownerId?.name || "",
                      accountOwnerMoving: accMoves,
                      contacts: people.length, moving: toMove.length });
    } catch (e) {
      problems.push({ id, why: e.message.slice(0, 160), status: e.status || 0 });
    }
  }
  const moving = accounts.filter((a) => a.moving > 0).length;
  log(`reassign: ${contacts} contact(s) across ${moving} account(s) would move` +
      (accountOwners ? `, and ${accountOwners} account owner(s)` : "") +
      (already ? `, ${already} already there` : "") +
      (problems.length ? `, ${problems.length} could not be read` : ""));
  return { accounts, moving, contacts, already, problems, ownerId: to, cap: MAX_ACCOUNTS,
           accountOwners,
           /* True since 2026-10-15 — see setCompanyOwner in kylas.mjs. */
           accountOwnerMoves: true };
}

/* THE WRITE — THE CONTACTS, THEN THE ACCOUNT.
   Sequential on purpose: the Kylas client rate-limits at about five a second
   and a burst of parallel PUTs buys nothing but 429s. */
export async function apply({ kylas, companies = [], ownerId, log = () => {},
                              onProgress = () => {}, concurrency = 1 }) {
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

  let contactsMoved = 0, skipped = 0, done = 0, accountOwnersMoved = 0, ownerFailed = 0;

  /* ONE ACCOUNT, START TO FINISH. Contacts in order inside it, the account's own
     owner last. Accounts are independent of each other, which is the only thing
     the concurrency below relies on: two workers never touch the same record. */
  const oneAccount = async (id) => {
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
          /* ALREADY THERE, FROM THE SEARCH ROW, WITHOUT A READ. The search that
             just listed this account's people says who owns each of them, seconds
             ago. Skipping a write on that is always safe (the worst case is a
             contact that moved in the last few seconds being left alone), and it
             spares the read that used to come first: a re-run of a half-finished
             batch is mostly contacts already moved, and each cost a request to
             be told so. */
          if (String(idOf(p?.ownerId) ?? "") === to) { skipped++; continue; }
          /* READ IMMEDIATELY BEFORE THE WRITE. Not from the crawl, not from the
             Airtable copy: both can be an hour old, and an hour-old body written
             back over a fresh record silently reverts whatever moved in between. */
          const full = await kylas.contact(p.id);
          if (String(idOf(full?.ownerId) ?? "") === to) { skipped++; continue; }
          await kylas.updateContact(p.id, contactBody(full, to));
          contactsMoved++; n++;
        } catch (e) { stuck.push({ id: String(p.id), why: e.message.slice(0, 120) }); }
      }
      /* THE ACCOUNT ITSELF, AFTER ITS PEOPLE. Order matters only for what a
         half-finished batch looks like: contacts moved under an account that
         still reads as somebody else's is the state the console has always
         shown, and is recoverable by running again. The reverse — the account
         handed over with its POCs left behind — is the split state rule 4 of
         the header exists to avoid.

         A FAILURE HERE DOES NOT FAIL THE ACCOUNT. The contacts have already
         moved and that is the half that decides whose queue they are in; the
         owner field is reported separately so a partial result is legible. */
      let ownerSet = false, ownerWhy = "";
      if (String(idOf(co?.ownerId) ?? "") !== to) {
        try {
          await kylas.setCompanyOwner(id, to);
          ownerSet = true; accountOwnersMoved++;
        } catch (e) { ownerWhy = e.message.slice(0, 120); ownerFailed++; }
      }
      return { ok: { id, name: co?.name || `Company ${id}`, contacts: n, ownerSet,
                     ...(ownerWhy ? { ownerWhy } : {}),
                     ...(stuck.length ? { contactsFailed: stuck } : {}) } };
    } catch (e) {
      return { failed: { id, why: e.message.slice(0, 160), status: e.status || 0 } };
    }
  };

  /* THE POOL. `concurrency` accounts at a time, each keeping its own requests in
     order. It only changes how many requests the Kylas client has in flight —
     the client still starts them one gap apart, so this cannot exceed the rate
     the sequential path was already held to, and the client drops back to one at
     a time by itself on the first 429. Results are put back in the order the
     accounts were given, whatever order they finished in. */
  const k = Math.max(1, Math.min(Number(concurrency) || 1, ids.length));
  const was = k > 1 && kylas.setConcurrency ? kylas.setConcurrency(k) : null;
  const before = kylas.stats ? kylas.stats() : null;
  const t0 = Date.now();
  const results = new Array(ids.length);
  try {
    let next = 0;
    await Promise.all(Array.from({ length: k }, async () => {
      while (next < ids.length) {
        const i = next++;
        results[i] = await oneAccount(ids[i]);
        done++;
        onProgress({ done, total: ids.length });
      }
    }));
  } finally {
    if (was !== null) kylas.setConcurrency(was);
  }
  const moved = results.filter((r) => r.ok).map((r) => r.ok);
  const failed = results.filter((r) => r.failed).map((r) => r.failed);

  /* WHAT IT COST, so "how fast is it" is a number and not a feeling. */
  const ms = Date.now() - t0;
  const after = kylas.stats ? kylas.stats() : null;
  const timing = { ms, accounts: ids.length, concurrency: k,
                   requests: after && before ? after.requests - before.requests : null,
                   throttled: after && before ? after.throttles - before.throttles : null,
                   perAccountMs: Math.round(ms / ids.length),
                   perContactMs: contactsMoved ? Math.round(ms / contactsMoved) : null,
                   ...(kylas.concurrency === 1 && k > 1 && after && before && after.throttles > before.throttles ? { backedOff: true } : {}) };
  log(`reassign: moved ${contactsMoved} contact(s) across ${moved.length} account(s) to owner ${to}` +
      (accountOwnersMoved ? `, and ${accountOwnersMoved} account owner(s)` : "") +
      (ownerFailed ? `, ${ownerFailed} account owner(s) REFUSED` : "") +
      (skipped ? `, ${skipped} already there` : "") +
      (failed.length ? `, ${failed.length} FAILED` : "") +
      ` — ${(ms / 1000).toFixed(1)}s, ${timing.requests ?? "?"} requests, ${k} at a time` +
      (timing.backedOff ? " (Kylas throttled; went back to one)" : ""));
  return { moved: moved.length, contacts: contactsMoved, skipped, failed, accounts: moved,
           ownerId: to, accountOwners: accountOwnersMoved, accountOwnersFailed: ownerFailed,
           accountOwnerMoves: true, timing };
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
