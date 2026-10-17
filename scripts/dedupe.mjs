/* DUPLICATE CHECK FOR A NEW CONTACT: PHONE AND EMAIL, AGAINST THE WHOLE ACCOUNT.
 *
 * Ayush, 2026-10-16: "Duplicate check -> system kya hai..", and in the workflow
 * notes: "Adding new contact -> conflict checkups on the basis of email and
 * phone no -> if anything is incorrect -> flag them up".
 *
 * WHAT THERE WAS. The console compared the last ten digits of a phone number
 * with the contacts it had open in the list, and showed an "Already on X" pill.
 * Nothing compared an email, nothing looked past the list on screen, nothing
 * was recorded, and the pill neither blocked nor flagged. A BD adding a person
 * who already sat in Kylas under somebody else got a second record.
 *
 * WHAT THIS DOES. One question — "is anybody already holding this phone number
 * or this email?" — asked of TWO sources, because each is blind somewhere the
 * other is not:
 *
 *   the Airtable copy of Contacts   every contact the hourly sync has seen,
 *                                   with the phone and email as Kylas stores
 *                                   them. Blind to anything created in Kylas in
 *                                   the last hour.
 *   Kylas' own search (multi_field) live. Blind to whatever its free text does
 *                                   not index — whether it reaches the phone
 *                                   column is NOT something this repo has
 *                                   confirmed, so a search hit is only ever a
 *                                   CANDIDATE and is compared exactly.
 *
 * AND IT SAYS WHICH SOURCES ANSWERED. A check that found nothing because it
 * could not look is not "clear", and the verdict says `partial` or `unverified`
 * instead of pretending.
 *
 * THE VERDICT, in the order it is decided:
 *
 *   existing    the same person is already there (same phone or email, same
 *               first name, same company or no company to disagree). Creating
 *               would make a second record. Action: open the existing one.
 *   flag        somebody ELSE holds that phone or email, or the same person is
 *               there under another company, or the match sits with another BD.
 *               The save goes ahead and the flag is recorded for an admin.
 *   unverified  nothing could be searched. The save goes ahead, flagged.
 *   clear       nobody holds either, and at least one source answered.
 *
 * NOTHING HERE WRITES. classify() is pure; findCandidates() only reads. The
 * route and the save decide what to do with the verdict.
 */
import { nameKey } from "./airtable.mjs";

/* ── normalising ───────────────────────────────────────────────────────── */

/* The last ten digits, so +91, 0 and spacing cannot hide a match. Fewer than
   ten digits is not compared: a bare extension matching another bare extension
   is a coincidence, not a duplicate. */
export const normPhone = (v) => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
export const normEmail = (v) => {
  const e = String(v ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
};
const uniq = (a) => [...new Set(a.filter(Boolean))];

/* What the card (the console's contact object) holds. */
export function keysOf(card) {
  return {
    phones: uniq((card?.phones || []).map((p) => normPhone(p?.value ?? p))),
    emails: uniq((card?.emails || []).map((e) => normEmail(e?.value ?? e))),
  };
}

/* ── candidates, from either source ────────────────────────────────────── */

const parseList = (raw) => {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(String(raw || "[]")); return Array.isArray(v) ? v : []; } catch { return []; }
};
const one = (v) => (Array.isArray(v) ? v[0] : v);

/* An Airtable Contacts row. Phone / Email are the plain columns a person reads;
   Phones / Emails are the JSON the console reads. Both are written from the same
   value, but a hand-edited row may have only one of them, so both are read. */
export function candidateFromAirtable(rec) {
  const f = rec?.fields || {};
  const phones = [normPhone(f.Phone), ...parseList(f.Phones).map((p) => normPhone(p?.value ?? p))];
  const emails = [normEmail(f.Email), ...parseList(f.Emails).map((e) => normEmail(e?.value ?? e))];
  return {
    kid: String(f["Kylas Contact ID"] || ""), recordId: rec?.id || "", name: String(f.Name || "").trim(),
    companyId: String(one(f["Company Kylas ID"]) ?? ""), company: "",
    owner: String(f.Owner || ""), ownerId: String(f["Kylas Owner ID"] || ""),
    phones: uniq(phones), emails: uniq(emails), sources: ["airtable"],
  };
}

/* A Kylas contact, as search returns it. */
export function candidateFromKylas(c) {
  const co = c?.company;
  return {
    kid: String(c?.id ?? ""), recordId: "",
    name: [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim(),
    companyId: String(co && typeof co === "object" ? co.id ?? "" : co ?? ""),
    company: co && typeof co === "object" ? String(co.name || "") : "",
    owner: "", ownerId: String(c?.ownerId?.id ?? c?.ownerId ?? ""),
    phones: uniq((c?.phoneNumbers || []).map((p) => normPhone(p?.value))),
    emails: uniq((c?.emails || []).map((e) => normEmail(e?.value))),
    sources: ["kylas"],
  };
}

/* ── is it the same person ─────────────────────────────────────────────── */

const words = (n) => nameKey(n).replace(/[^\p{L}\p{N} ]/gu, "").split(" ").filter(Boolean);

/* They already share a phone number or an email, so the bar for "same person" is
   low on purpose: the first names agree, and the last names do not CONTRADICT
   (equal, or an initial, or one side has none). "Asha Rao" and "Asha R" are one
   person; "Asha Rao" and "Rohit Rao" on one phone are two, and that is exactly
   the conflict worth raising. */
export function samePerson(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  if (x[0] !== y[0]) return false;
  const lx = x.length > 1 ? x[x.length - 1] : "", ly = y.length > 1 ? y[y.length - 1] : "";
  if (!lx || !ly) return true;
  return lx === ly || lx[0] === ly[0] && (lx.length === 1 || ly.length === 1);
}

/* ── the verdict ───────────────────────────────────────────────────────── */

const KIND_TEXT = {
  "phone-conflict": "phone is on a different person",
  "email-conflict": "email is on a different person",
  "other-company": "same person, different company",
  "other-bd": "sits with another BD",
  "unverified": "could not be checked",
};

/* card:       the contact being added ({ pocName, phones, emails, companyId, ownerId, kid })
   candidates: from findCandidates
   lookup:     what each source said (for the report; it decides `coverage`) */
export function classify(card, candidates = [], lookup = {}) {
  const mine = keysOf(card);
  const ownKid = String(card?.kid || "");
  const matches = [];
  for (const c of candidates) {
    if (ownKid && c.kid === ownKid) continue;          /* editing a contact is not duplicating it */
    const byPhone = c.phones.filter((p) => mine.phones.includes(p));
    const byEmail = c.emails.filter((e) => mine.emails.includes(e));
    if (!byPhone.length && !byEmail.length) continue;
    const same = samePerson(card?.pocName, c.name);
    const cardCo = String(card?.companyId || ""), theirCo = String(c.companyId || "");
    const sameCompany = cardCo && theirCo ? cardCo === theirCo : null;
    matches.push({
      kid: c.kid, name: c.name || "(no name)", company: c.company, companyId: c.companyId,
      owner: c.owner, ownerId: c.ownerId, sources: c.sources,
      matchedOn: [...(byPhone.length ? ["phone"] : []), ...(byEmail.length ? ["email"] : [])],
      phones: byPhone, emails: byEmail, samePerson: same, sameCompany,
      otherOwner: !!(card?.ownerId && c.ownerId && String(card.ownerId) !== c.ownerId),
    });
  }

  const flags = [];
  const existing = matches.find((m) => m.samePerson && m.sameCompany !== false);
  for (const m of matches) {
    if (m === existing) continue;
    const who = `${m.name}${m.company ? ` (${m.company})` : m.companyId ? ` (company ${m.companyId})` : ""}`;
    if (m.samePerson && m.sameCompany === false)
      flags.push({ kind: "other-company", kid: m.kid, why: `${m.name} already exists under another company (${m.company || m.companyId}); this is being added to a different one` });
    else if (!m.samePerson) {
      if (m.matchedOn.includes("phone"))
        flags.push({ kind: "phone-conflict", kid: m.kid, why: `phone ${m.phones[0]} is already on ${who}` });
      if (m.matchedOn.includes("email"))
        flags.push({ kind: "email-conflict", kid: m.kid, why: `email ${m.emails[0]} is already on ${who}` });
    }
    if (m.otherOwner)
      flags.push({ kind: "other-bd", kid: m.kid, why: `${m.name} sits with ${m.owner || `user ${m.ownerId}`}, not with the BD adding them` });
  }

  /* Which sources answered. `skipped` (nothing to search with, or the copy is not
     built yet) and `failed` both mean that source did not look. */
  const answered = ["airtable", "kylas"].filter((s) => lookup[s]?.status === "ok");
  const coverage = answered.length === 2 ? "full" : answered.length === 1 ? "partial" : "none";
  const searchable = mine.phones.length + mine.emails.length > 0;

  let verdict, action, summary;
  if (!searchable) {
    verdict = "unverified"; action = "create-and-flag";
    flags.push({ kind: "unverified", why: "there is no phone number or email to check against" });
    summary = "Nothing to check against: no valid phone number or email on the card.";
  } else if (existing) {
    verdict = "existing"; action = "open";
    const inKylas = existing.sources.includes("kylas");
    summary = `Already ${inKylas ? "in Kylas" : "known here (in the Airtable copy; Kylas search did not return it)"}: ` +
      `${existing.name}${existing.company ? ` (${existing.company})` : ""}, ` +
      `same ${existing.matchedOn.join(" and ")}${existing.kid ? ` · id ${existing.kid}` : ""}. Open it instead of adding a second record.`;
  } else if (flags.length) {
    verdict = "flag"; action = "create-and-flag";
    summary = flags.map((f) => f.why).join("; ") + ".";
  } else if (coverage === "none") {
    verdict = "unverified"; action = "create-and-flag";
    flags.push({ kind: "unverified", why: "neither the Airtable copy nor Kylas search could be read" });
    summary = "Could not check: neither the Airtable copy nor Kylas search answered.";
  } else {
    verdict = "clear"; action = "create";
    summary = coverage === "full" ? "Nobody holds this phone number or email."
      : `Nobody holds this phone number or email in ${answered[0] === "airtable" ? "the Airtable copy" : "Kylas search"}; the other source did not answer.`;
  }
  return { verdict, action, summary, matches, flags, coverage, lookup, checked: mine,
           ...(existing ? { existing } : {}) };
}

/* ── looking ───────────────────────────────────────────────────────────── */

const CONTACT_FIELDS = ["Kylas Contact ID", "Name", "Phone", "Phones", "Email", "Emails", "Owner",
                        "Kylas Owner ID", "Company Kylas ID"];

/* Both sources, in parallel. Never throws: a source that fails says so in
   `lookup` and the other one is still used. `airtable` is the (possibly
   mirrored) client, `kylas` the Kylas client; either may be null. */
export async function findCandidates({ card, airtable = null, kylas = null, log = () => {}, ownerName = null } = {}) {
  const mine = keysOf(card);
  const lookup = { airtable: { status: "skipped", why: "" }, kylas: { status: "skipped", why: "" } };
  const found = new Map();
  const add = (c) => {
    const key = c.kid || `rec:${c.recordId}`;
    const had = found.get(key);
    if (!had) { found.set(key, c); return; }
    had.sources = uniq([...had.sources, ...c.sources]);
    for (const k of ["phones", "emails"]) had[k] = uniq([...had[k], ...c[k]]);
    for (const k of ["name", "company", "companyId", "owner", "ownerId"]) if (!had[k] && c[k]) had[k] = c[k];
  };
  if (!mine.phones.length && !mine.emails.length) return { candidates: [], lookup };

  const fromAirtable = async () => {
    if (!airtable) { lookup.airtable = { status: "skipped", why: "no Airtable client" }; return; }
    try {
      const recs = await airtable.listAll("Contacts", { fields: CONTACT_FIELDS, pageSize: 100, maxPages: 700, throwIfMore: true });
      let hits = 0;
      for (const r of recs) {
        const c = candidateFromAirtable(r);
        if (c.phones.some((p) => mine.phones.includes(p)) || c.emails.some((e) => mine.emails.includes(e))) { add(c); hits++; }
      }
      lookup.airtable = { status: "ok", rows: recs.length, hits };
    } catch (e) {
      /* throwIfMore: a table too big to read directly and not yet copied into D1.
         Skipped rather than paged inside somebody's request — the copy is built
         in the minutes after a deploy, and Kylas search still answers meanwhile. */
      const notReady = /more than|maxPages|throwIfMore/i.test(e.message);
      lookup.airtable = { status: notReady ? "skipped" : "failed",
                          why: notReady ? "the Airtable copy of Contacts is not built yet" : String(e.message).slice(0, 120) };
      log(`  dedupe: airtable ${lookup.airtable.status} — ${lookup.airtable.why}`);
    }
  };

  const fromKylas = async () => {
    if (!kylas?.contactsMatching) { lookup.kylas = { status: "skipped", why: "no Kylas client" }; return; }
    const queries = uniq([...mine.phones, ...mine.emails]);
    /* DISTINCT CONTACTS, not rows: the phone search and the email search both
       return the same person, and "2 real matches" for one person reads as two. */
    const seenRows = new Set(), seenHits = new Set();
    let failed = 0, last = "";
    await Promise.all(queries.map(async (q) => {
      try {
        const list = await kylas.contactsMatching(q);
        for (const k of list) {
          seenRows.add(String(k?.id ?? ""));
          const c = candidateFromKylas(k);
          if (c.phones.some((p) => mine.phones.includes(p)) || c.emails.some((e) => mine.emails.includes(e))) { add(c); seenHits.add(c.kid); }
        }
      } catch (e) { failed++; last = String(e.message).slice(0, 120); }
    }));
    lookup.kylas = failed === queries.length
      ? { status: "failed", why: last, queries: queries.length }
      : { status: "ok", rows: seenRows.size, hits: seenHits.size, queries: queries.length,
          ...(failed ? { partial: `${failed} of ${queries.length} searches failed` } : {}) };
    if (failed) log(`  dedupe: kylas search — ${failed} of ${queries.length} failed (${last})`);
  };

  await Promise.all([fromAirtable(), fromKylas()]);

  /* A human name for the owner, where a callback can supply one. */
  if (ownerName) for (const c of found.values()) if (!c.owner && c.ownerId) c.owner = await ownerName(c.ownerId).catch(() => "") || "";
  return { candidates: [...found.values()], lookup };
}

export async function checkContact(args) {
  const { candidates, lookup } = await findCandidates(args);
  return classify(args.card, candidates, lookup);
}

export { KIND_TEXT };

/* ── from a terminal ───────────────────────────────────────────────────── */
const isMain = (() => {
  try { return typeof process !== "undefined" && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()); }
  catch { return false; }
})();

if (isMain) {
  /* node --env-file=.env.local scripts/dedupe.mjs --phone 9876543210 --email a@b.com --name "Asha Rao" [--company 123] [--owner 456]
     Runs the real check against the LIVE account, read-only. It is also the probe for
     the one thing this repo has not confirmed: whether Kylas' free text reaches the phone
     column — the output says how many rows each source returned and how many were real. */
  const argv = process.argv.slice(2);
  const a = (n) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : ""; };
  const { createClient } = await import("./kylas.mjs");
  const { createAirtable } = await import("./airtable.mjs");
  const env = process.env;
  const kylas = env.KYLAS_KEY ? createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) }) : null;
  const airtable = env.AIRTABLE_PAT && env.AIRTABLE_BASE ? createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {},
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) }) : null;
  const card = { pocName: a("name"), companyId: a("company"), ownerId: a("owner"),
                 phones: a("phone") ? [{ value: a("phone") }] : [], emails: a("email") ? [{ value: a("email") }] : [] };
  const v = await checkContact({ card, airtable, kylas, log: (...x) => console.error(...x) });
  const { renderVerdict } = await import("./dedupe-report.mjs");
  console.log(renderVerdict(card, v));
  process.exit(0);
}
