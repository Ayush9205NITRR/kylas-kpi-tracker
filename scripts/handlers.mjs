/* Every route the console calls, and everything they are built from.
 *
 * WHY THIS IS NOT proxy.mjs ANY MORE
 * All of this used to sit in the server file, reading process.env and the
 * filesystem as the module loaded. That is the shortest way to write it and it
 * welds the handlers to one runtime: a hosted one has no process.env to read
 * at import time, no disk of its own, and no single long-lived process to hang
 * module-scope state on.
 *
 * So the same code is now a factory. Everything it needs arrives as arguments:
 *
 *   env      the configuration, whatever the runtime calls it. On a laptop
 *            that is process.env; on a Worker it is the bindings object.
 *   store    the small amount of state that outlives a request — the save
 *            journal and the company-shape probe result. See store.mjs, and
 *            note that the journal needs a STRONGLY CONSISTENT one.
 *   log      where lines go. A server writes them to stdout; a hosted runtime
 *            has its own idea, and neither should be assumed here.
 *
 * WHAT A SHELL DOES. It reads the request, hands over (url, parsedBody), turns
 * the returned object into JSON, and turns a thrown error into a status. The
 * two shells — scripts/proxy.mjs and worker/index.mjs — differ only in that.
 * Nothing runtime-specific belongs below this line.
 *
 * Handlers take (url, body). The body arrives ALREADY PARSED, because reading
 * it is exactly the part that differs: Node gives a stream, fetch gives a
 * Request. A handler that does not need one simply ignores it.
 */
import { createClient, toConsoleContact, toConsoleCompany, lookupName, idOf,
         toKylasContact, toKylasCallLog, renderRemarks, mergeRemarks } from "./kylas.mjs";
import { STAGE_ID, STAGE_LABEL, STAGE_RUNG, MILESTONE } from "./stages.mjs";
import { checkContact } from "./fields.mjs";
import { createAirtable, syncContact, readCompanyKpis,
         readContact, readCompany, readQueue,
         readCompanies, readSyncState, listTolerant,
         readRcaDue, writeRcaAnswer,
         readTeam, writeTeam, counter,
         readFocus, readResearch, writeFocus, writeResearch } from "./airtable.mjs";
import { RCA_GATES, RCA_GATE } from "./rca.mjs";
import { report, withDeltas, mergeCalls, arrivalsByCompany, seededRung } from "./report.mjs";
import { createJournal } from "./journal.mjs";
import { mirrored } from "./mirror.mjs";
import { createSaveQueue } from "./save-queue.mjs";
import { offsiteOf, quartersOf, OFFSITE_QUARTERS } from "./offsite.mjs";

/* Builds the route table. ASYNC because the company-shape hint is read from the
   store before the Kylas client is constructed — on a laptop that read is a
   file, and anywhere else it is a network call that cannot be pretended
   otherwise. Call it once per instance, not once per request. */
export async function createHandlers({ env = {}, store, log = () => {}, cache = null, mirror = null, db = null } = {}) {
  const VERSION = env.VERSION || "unknown";

  const STARTED = new Date().toISOString();

  const KEY = env.KYLAS_KEY;
  /* THROWN, NOT EXITED. A process can exit; a request handler inside a shared
     runtime cannot, and calling process.exit there would take down whatever else
     that instance was serving. The shell decides what a fatal misconfiguration
     means for it. */
  if (!KEY) throw new Error("Set KYLAS_KEY — app.kylas.io/setup/integrations/api-keys/list");

  /* Which /v1/search/company shape this account accepts, remembered across
     restarts. Three of the five fail here and each costs a full rate-limit gap,
     so re-probing spent 1.35s of every cold start re-learning the same answer.
     A file, not a constant, because the answer is per-account. */
  const shapeHint = ((await store.get("company-shape")) || "").trim();

  /* EVERY SETTING IS PASSED, none left to be picked up from the ambient
     environment. On a laptop `env` IS process.env so nothing changes; on a
     hosted runtime there is no ambient environment to read, and a client that
     quietly fell back to its defaults would talk to the live Kylas from a test
     suite. That is not hypothetical — it is what the worker suite caught. */
  const kylas = createClient(KEY, {
    log,
    shapeHint,
    ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}),
    ...(env.KYLAS_GAP ? { gap: Number(env.KYLAS_GAP) } : {}),
    ...(env.KYLAS_MAX_PAGES ? { maxPages: Number(env.KYLAS_MAX_PAGES) } : {}),
    ...(env.KYLAS_MAX_WINDOWS ? { maxWindows: Number(env.KYLAS_MAX_WINDOWS) } : {}),
    onShape: (name) => {
      /* Deliberately not awaited, and its failure deliberately ignored. This is
         a cache: the probe has already produced the answer this request needs,
         and losing the write costs 1.35s on some later cold start. */
      store.put("company-shape", name).catch(() => {});
    },
  });

  /* Which saves have already created a contact. Beside the shape hint and for the
     same reason: it is per-machine state that must outlive the process, because
     the process dying is the very thing it defends against. */
  /* The journal's storage, chosen by the shell rather than by the journal. On a
     laptop that is a file beside the repo; on a hosted runtime it is a strongly
     consistent database — see store.mjs. Keeping the choice here is what lets the
     same save path run in both places. */
  const journal = createJournal(store, { log });

  /* Airtable is optional: without a PAT the proxy still reads and writes Kylas,
     and each save reports that the Airtable half was skipped rather than failing.
     That way a missing token degrades the KPIs, not the dialling. */
  const AT_PAT = env.AIRTABLE_PAT;
  const AT_BASE = env.AIRTABLE_BASE;
  /* TWO HANDLES ON ONE CLIENT. `rawAirtable` always asks Airtable; `airtable`
     answers whole-table reads from the D1 copy when there is one (a hosted
     runtime — see mirror.mjs) and is the same client when there is not. Every
     reader uses `airtable`; only the mirror's own upkeep uses the raw one. */
  const rawAirtable = AT_PAT && AT_BASE ? createAirtable(AT_PAT, AT_BASE, {
    log,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}),
    ...(env.AIRTABLE_GAP ? { gap: Number(env.AIRTABLE_GAP) } : {}),
    ...(mirror ? { onWrite: mirror.written } : {}),
  }) : null;
  const airtable = rawAirtable && mirror ? mirrored(rawAirtable, mirror) : rawAirtable;
  /* THE CURATED RESEARCH lives in another base the team already keeps — the
     "Company List" in Company Database, one row per company keyed by its
     Kylas id, with industry, size, funding, the V/W scores and the rest.
     Read-only from here: it is edited in Airtable. The same token; it needs
     read access to that base too. */
  const RESEARCH_BASE = env.RESEARCH_BASE || "";
  const RESEARCH_TABLE = env.RESEARCH_TABLE || "Company List";
  const researchAt = AT_PAT && RESEARCH_BASE ? createAirtable(AT_PAT, RESEARCH_BASE, {
    log,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}),
  }) : null;
  /* Saves queued in D1 and carried out behind the reply (save-queue.mjs).
     Hosted runtime only — on a laptop there is nothing to gain. */
  const saves = db ? createSaveQueue({ db, log }) : null;
  /* Say so either way. On a fresh install the absence of a warning is not a
     signal anyone can act on — it reads the same as a line that never printed. */
  if (airtable) log(`airtable: ${AT_BASE}`);
  else log("airtable: not configured (set AIRTABLE_PAT and AIRTABLE_BASE) — KPIs will not be written");

  /* ── WHICH SIDE ANSWERS A READ ──────────────────────────────────────────
     Kylas is the system of record and stays the write target, but reading the
     console out of it is what made the console slow: a rate-limited, undocumented
     search endpoint that stops at a result window. Airtable, kept current by
     scripts/sync-kylas.mjs, answers the same questions in one fast query.

       READ_SOURCE=airtable   prefer Airtable, fall back to Kylas when it has
                              nothing for this request (the default when Airtable
                              is configured)
       READ_SOURCE=kylas      the old path, unchanged
       READ_SOURCE=strict     Airtable only — an empty answer stays empty

     THE FALLBACK IS THE WHOLE SAFETY MARGIN. A base that has not been synced yet
     holds nothing, and "nothing" rendered as a queue is indistinguishable from
     "you have no contacts today" — the same fault as the blank contact card and
     the 10,000-row list that claimed to be an account. So an empty Airtable
     answer is not an answer: it falls through to Kylas and says which side
     replied, on every response, so nobody has to guess. `strict` exists to test
     the Airtable path honestly, and for the day the sync is trusted. */
  const READ_SOURCE = String(env.READ_SOURCE || (AT_PAT && AT_BASE ? "airtable" : "kylas")).toLowerCase();
  const READS_AIRTABLE = airtable && READ_SOURCE !== "kylas";
  const STRICT_AIRTABLE = airtable && READ_SOURCE === "strict";
  if (READS_AIRTABLE) log(`reads: Airtable first${STRICT_AIRTABLE ? " (STRICT — no Kylas fallback)" : ", Kylas as fallback"}`);
  else log("reads: Kylas");

  /* Runs the Airtable reader, and says plainly whether it produced anything.
     A thrown error is NOT a reason to show an empty console either — it falls
     back the same way, loudly. */
  async function fromAirtable(what, fn) {
    if (!READS_AIRTABLE) return null;
    try {
      const out = await fn();
      const empty = out == null || (Array.isArray(out) && !out.length);
      if (empty && !STRICT_AIRTABLE) {
        log(`  ${what}: Airtable had nothing — asking Kylas`);
        return null;
      }
      return out;
    } catch (e) {
      if (STRICT_AIRTABLE) throw e;
      /* The message begins with the request URL, which for a projection of
         twenty fields is hundreds of characters — slicing the FRONT of it threw
         away the only part that says what went wrong and left a log line nobody
         could act on. Take the reason, not the request. */
      /* THE WHOLE ERROR TYPE, not the first word of it. This matched /INVALID/
         and logged exactly "INVALID", which is true of
         INVALID_FILTER_BY_FORMULA, INVALID_REQUEST_UNKNOWN and a dozen others —
         and the one that was actually happening could only be found by reading
         the source. Airtable puts the type in `"type":"..."`, so take that; fall
         back to a whole recognised token, then to the tail of the message. */
      const typed = /"type"\s*:\s*"([A-Z_]+)"/.exec(e.message)?.[1];
      const why = typed
        || /[A-Z][A-Z_]{4,}/.exec(e.message)?.[0]
        || e.message.slice(-120);
      log(`! ${what}: Airtable read failed (${why}) — asking Kylas`);
      return null;
    }
  }

  /* DID AN INTERRUPTED ATTEMPT ALREADY CREATE THIS CONTACT?
     Asked only when the journal holds an unfinished entry — a save that started
     and whose reply never got home. Kylas either holds the contact or it does
     not, and it is the only side that can say.

     NOT by a phone-number query, which would be the direct question. The query
     builder's accepted field list is not documented, this account 500s on shapes
     it dislikes, and a lookup that throws here would push us straight back to
     creating the duplicate. Both routes below are calls the proxy already relies
     on elsewhere, so they are known to work on this account:

       the company's roster   one request, and a POC invented inside a company
                              scope has that company. The cheap first try.
       the owner's contacts   for a contact with NO company — created from the
                              queue rather than a company page, where the roster
                              cannot be asked. The console requires an owner
                              before it will save, so there is always one. One
                              page, newest first, and a contact made moments ago
                              is at the front of it.
       everything changed     the backstop, when the owner's newest page is not
         since the attempt    enough — a busy day can push a contact created last
                              night past it. The contact was made at the moment
                              the journal wrote the entry down, so a delta from
                              just before then contains it and stops at the
                              watermark a page or two in.

     The roster is tried first and the window is still tried after it, because
     "the roster did not have it" is not the same as "Kylas does not have it" —
     the create may have landed with a different company than the retry is
     carrying, and that is exactly when a wrong answer costs a duplicate.

     A MATCH IS PHONE *AND* NAME. The question is not "does Kylas hold this
     number" — a switchboard is on twenty records — it is "did my own interrupted
     attempt make this". That attempt sent precisely the name and number the retry
     is sending now. Adopting on the number alone would fold a real second POC at
     the same company into the first; between that and a duplicate, the duplicate
     is the one a human can fix. */
  const digits10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);
  const sameName = (k, c) =>
    `${k?.firstName || ""} ${k?.lastName || ""}`.trim().toLowerCase().replace(/\s+/g, " ") ===
    String(c.pocName || "").trim().toLowerCase().replace(/\s+/g, " ");

  function pickMatch(list, c, want) {
    for (const k of list || []) {
      if (!sameName(k, c)) continue;
      for (const p of k.phoneNumbers || [])
        if (want.has(digits10(p.value))) return k;
    }
    return null;
  }

  async function findExisting(c, since) {
    const want = new Set((c.phones || []).map((p) => digits10(p.value)).filter(Boolean));
    if (!want.size) return null;

    if (c.companyId) {
      const hit = pickMatch(await kylas.contactsForCompany(c.companyId), c, want);
      if (hit) return hit;
    }

    /* Filtered by owner rather than by time, which matters more than it looks:
       the delta below decides what is recent from `updatedAt`, and whether Kylas
       sets that field on a record it has only ever created is not something this
       code should bet a duplicate on. A row with no updatedAt sorts to the back
       of this page but is still IN it. */
    if (c.ownerId) {
      const hit = pickMatch(await kylas.contactsForOwner(c.ownerId, 200), c, want);
      if (hit) return hit;
    }

    /* Ten minutes of slack: the attempt's timestamp is this machine's clock and
       updatedAt is Kylas's, and a watermark a minute the wrong side of the record
       would miss the very thing being looked for. Two days when the journal has
       no time to offer, rather than paging the whole account. */
    const from = Date.parse(since || "");
    const watermark = new Date(Number.isFinite(from) ? from - 600000
                                                     : Date.now() - 2 * 86400000).toISOString();
    const delta = await kylas.contactsChangedSince(watermark);
    const hit = pickMatch(delta.contacts, c, want);
    /* A search that stalled did not finish looking, so "not found" in it is not
       an answer. Creating anyway is still the right move — refusing the save
       would lose the associate's call over a maybe — but it is the one case where
       a duplicate can survive all of this, so it does not pass in silence. */
    if (!hit && !delta.complete)
      log(`! the contact search did not complete, so it cannot rule out that ` +
          `${c.pocName} was already created. Creating; check for a duplicate.`);
    return hit;
  }

  /* Most records carry their own owner name in metaData.idNameStore, so this is
     a fallback for the ones that do not — and every avoided request is one fewer
     against a tight rate limit. */
  const owners = new Map();
  async function ownerName(id) {
    if (!id) return "";
    const k = String(id);
    if (!owners.has(k)) {
      try {
        const u = await kylas.user(k);
        owners.set(k, [u?.firstName, u?.lastName].filter(Boolean).join(" ") || k);
      } catch {
        owners.set(k, k);   // a failed lookup should not fail the whole fetch
      }
    }
    return owners.get(k);
  }

  /* Same story for companies, and it matters more. A contact's company arrives as
     a bare id; the name is only in metaData.idNameStore — and whether the SEARCH
     endpoint populates that for `company` was never confirmed (the probe lost
     those responses to 429). When it does not, every contact from /queue has a
     blank company, and the companies list falls back to "Company 1776620".
     Resolving by id removes the dependency either way. Cached, so a queue of 100
     contacts across 30 companies costs 30 requests once, not 100 every fetch. */
  /* /companies responses, by owner key. Shared by every associate pointed at
     this proxy, which is the point: one page-through of the account serves the
     whole team for the window. */
  /* ── who is using this proxy, and what may they see ────────────────────
     The proxy holds ONE Kylas API key, and Kylas tells us whose it is. That is
     the identity: an associate runs the proxy with their own key and the console
     scopes to them; an admin's key is listed in ADMIN_EMAILS (or ADMIN_IDS) and
     unlocks the team view.

     THIS IS SCOPING, NOT SECURITY, and the difference matters. Anyone who can
     edit their own .env.local can name themselves an admin — the file is on their
     machine. What it buys is that eight people each see their own numbers by
     default instead of everyone's, which is what makes the dashboard usable and
     stops one associate's bad week being everybody's business. Real access
     control needs the proxy deployed once, centrally, with a login in front of
     it — see docs/architecture.md. */
  /* The two people who may see the whole team, named by Ayush on 2026-09-18.
     ADMIN_EMAILS in .env.local replaces this list rather than adding to it, so a
     change of who is in charge is one line and not a code edit. */
  const DEFAULT_ADMINS = ["crmadmin@enout.in", "ayush@enout.in"];
  const ADMINS = (env.ADMIN_EMAILS
    ? String(env.ADMIN_EMAILS).split(",")
    : DEFAULT_ADMINS).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ADMIN_IDS = String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const userName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
  let warnedNoEmail = false;
  function roleOf(me) {
    if (!ADMINS.length && !ADMIN_IDS.length) return "admin";   /* nobody configured: nothing to lock */
    const email = String(me?.email || "").toLowerCase();
    /* Kylas does not always return an email on /v1/users/me. If it does not, an
       ADMIN_EMAILS list can never match anybody and every key silently becomes an
       associate — including the owner's. Said once, with the fix. */
    if (!email && ADMINS.length && !ADMIN_IDS.length && !warnedNoEmail) {
      warnedNoEmail = true;
      log(`! ADMIN_EMAILS is set but Kylas returned no email for this key (id ${me?.id}).`);
      log(`  Nobody can match by email. Use ADMIN_IDS=${me?.id} instead.`);
    }
    return (email && ADMINS.includes(email)) || ADMIN_IDS.includes(String(me?.id)) ? "admin" : "associate";
  }

  /* An associate may only ask about themselves. Returns the owner the caller is
     ALLOWED to see, which is their own id unless they are an admin. */
  async function scopeOwner(requested) {
    const me = await whoami();
    if (roleOf(me) === "admin") return requested;
    const mine = String(me?.id ?? "");
    if (requested && requested !== "all" && String(requested) !== mine)
      log(`  scope: ${userName(me)} asked for owner ${requested}, served their own`);
    return mine;
  }

  const companyCache = new Map();
  const COMPANY_TTL = Number(env.COMPANY_TTL_MS || 5 * 60 * 1000);

  /* THE WHOLE ACCOUNT'S COMPANIES FROM KYLAS, crawled once and shared. Dozens
     of rate-limited pages, so it is never refreshed behind a reply — the
     scheduled job does that (maintain(), below) — and a stale list is served
     rather than a slow one. Owner names are resolved inside, so what is kept is
     what the console shows. */
  const kylasCompanies = shared("kylas-companies",
    { ttl: COMPANY_TTL, stale: 14 * 24 * 3600 * 1000, background: false }, async () => {
      const raw = await kylas.companies();
      const list = [];
      for (const co of raw) {
        const known = lookupName(co, "ownerId", co.ownerId);
        if (known && co.ownerId) owners.set(String(co.ownerId), known);
        /* Seed the name cache too — the contact mapper then never has to fetch
           a company whose name already came back on this list. */
        if (co?.id && co?.name) companyNames.set(String(co.id), co.name);
        list.push({
          ...toConsoleCompany(co),
          owner: known || (await ownerName(co.ownerId)) || "",
          ownerId: String(co.ownerId ?? ""),
        });
      }
      return { companies: list, search: kylas.lastCompanySearch?.() || {} };
    });

  /* OFFSITE TIMELINE PER COMPANY, from its contacts. It is a contact field —
     what one person at the account said about their next offsite — and the
     accounts list filters on it, so each company carries every value its
     contacts gave. Read from the D1 copy, so it costs no Airtable request once
     the copy exists; before that it is simply absent rather than slow. */
  /* OFFSITE TIMELINE, DERIVED — per company, the quarters its contacts'
     offsite rows name in their Timeline, Past and Now (scripts/offsite.mjs).
     Nobody types it; it follows the event rows. Held until one of the three
     tables it reads changes, because /companies asks on every open. */
  const offsiteShared = memo("offsite timeline", {
    ttl: 5 * 60 * 1000,
    key: mirror ? () => mirror.stamp(["Event Rows", "Contacts", "Companies"]) : null,
  }, async () => {
    const [rows, contacts, cos] = await Promise.all([
      listTolerant(airtable, "Event Rows", { fields: ["Event Type", "Timeline", "Contact", "Removed At"], pageSize: 100, maxPages: 2000 }),
      listTolerant(airtable, "Contacts", { fields: ["Company"], pageSize: 100, maxPages: 2000 }),
      airtable.listAll("Companies", { fields: ["Kylas Company ID"], pageSize: 100, maxPages: 2000 }),
    ]);
    const kidOf = new Map(cos.map((r) => [r.id, String(r.fields?.["Kylas Company ID"] || "")]));
    const companyOf = new Map(contacts.map((r) => [r.id, kidOf.get((r.fields?.Company || [])[0]) || ""]));
    const out = new Map();
    for (const r of rows) {
      const f = r.fields || {};
      if (f["Removed At"]) continue;
      const kid = companyOf.get((f.Contact || [])[0]);
      if (!kid) continue;
      const q = offsiteOf({ current: [{ eventType: f["Event Type"] || "", timeline: f.Timeline || "" }] });
      if (!q.length) continue;
      if (!out.has(kid)) out.set(kid, new Set());
      for (const k of q) out.get(kid).add(k);
    }
    return out;
  });
  /* KYLAS' OWN OFFSITE TIMELINE — the company field "Offsite Timeline
     (BD - New)", a picklist. The search hands back an option id, so the
     field's options are read once (six hours) to name it; the name, or text
     typed into an older text field, is read into quarters the same way the
     event rows are. */
  const companyFieldsShared = shared("kylas-company-fields", { ttl: 6 * 3600 * 1000, stale: 30 * 24 * 3600 * 1000 }, async () => {
    const r = await kylas.companyFields();
    const fields = Array.isArray(r) ? r : r?.content || r?.data || [];
    return { offsite: fields.filter((f) => /offsite/i.test(`${f.name} ${f.displayName}`))
      .map((f) => ({ name: f.name, label: f.displayName || "", options: findOptions(f) || [] })) };
  });
  const quartersLoose = (t) => {
    const s = String(t ?? "").trim();
    if (OFFSITE_QUARTERS.includes(s.toUpperCase())) return [s.toUpperCase()];
    return quartersOf(s.replace(/_/g, " "));
  };
  async function kylasOffsite(companies) {
    if (!companies.some((c) => c.offsiteRaw && Object.keys(c.offsiteRaw).length)) return new Map();
    const spec = await companyFieldsShared().catch(() => ({ offsite: [] }));
    const out = new Map();
    for (const c of companies) {
      const q = new Set();
      for (const [k, v] of Object.entries(c.offsiteRaw || {})) {
        const opts = spec.offsite.find((f) => f.name === k)?.options || [];
        for (const x of Array.isArray(v) ? v : [v]) {
          let t = x && typeof x === "object" ? (x.displayName ?? x.name ?? x.value ?? x.id) : x;
          const opt = opts.find((o) => String(o.id) === String(t) || o.code === t);
          if (opt) t = `${opt.code} ${opt.label}`;
          for (const k2 of quartersLoose(t)) q.add(k2);
        }
      }
      if (q.size) out.set(String(c.id), q);
    }
    return out;
  }

  async function offsiteByCompany() {
    if (!airtable) return new Map();
    try { return await offsiteShared(); } catch (e) {
      log(`  offsite timeline: not available yet (${e.message.slice(0, 80)})`);
      return new Map();
    }
  }

  /* What the last Kylas → Airtable sync managed, or null if it never ran. */
  const syncShared = shared("sync-state", { ttl: 5 * 60 * 1000, stale: 24 * 3600 * 1000 },
    async () => (rawAirtable ? (await readSyncState(rawAirtable)) : null));
  const syncState = () => syncShared();
  let warnedNeverSynced = false;
  let usersShared = null;

  /* shared(), one per key, for reads that Kylas answers per company or per
     owner. Two minutes fresh, then served while it refreshes behind the reply —
     these are one or two requests, short enough to finish there. */
  const companyFromKylas = new Map(), queueFromKylas = new Map();
  /* One company's row of the curated research, flattened: lookups come back
     as arrays, selects as { name }. Held half an hour — it is curated by
     hand, not changing under the associate's feet. */
  /* The fields the team curates for research (Ayush, 2026-09-24), and
     nothing else. "Boolean Post link" has three homes in that table; the
     first one filled wins. */
  const RESEARCH_LIST_FIELDS = ["Kylas Company Id", "linkedin - Appollo",
    "Boolean Post link - kylas", "Boolean - New", "Boolean Post Link (Demand Team)",
    "Total Funding", "Latest Funding Amount", "Latest Funding Type", "Source - Concatenate",
    "Account Pipeline Stage", "Annual Revenue", "No. of Employees (kylas)", "at_rev_per_employee"];
  const flat = (v) => Array.isArray(v) ? [...new Set(v.map(flat).filter((x) => x !== "" && x != null))].join(", ")
    : v && typeof v === "object" ? (v.name ?? v.url ?? "") : (v ?? "");
  const researchRows = new Map();
  function curatedResearch(id) {
    const key = `research:${id}`;
    if (!researchRows.has(key)) {
      if (researchRows.size > 500) researchRows.clear();
      researchRows.set(key, shared(key, { ttl: 30 * 60 * 1000, stale: 7 * 24 * 3600 * 1000 }, async () => {
        const rows = await listTolerant(researchAt, RESEARCH_TABLE, {
          fields: RESEARCH_LIST_FIELDS, formula: `{Kylas Company Id} = '${String(id).replace(/'/g, "\\'")}'`,
          pageSize: 1, maxPages: 1 });
        const r = rows[0];
        if (!r) return { found: false };
        const fields = {};
        for (const [k, v] of Object.entries(r.fields || {})) { const x = flat(v); if (x !== "") fields[k] = x; }
        return { found: true, recordId: r.id, fields };
      }));
    }
    return researchRows.get(key)();
  }

  function perKey(map, name, fn) {
    if (!map.has(name)) {
      if (map.size > 500) map.clear();
      map.set(name, shared(name, { ttl: 2 * 60 * 1000, stale: 24 * 3600 * 1000 }, fn));
    }
    return map.get(name);
  }

  /* When the company list was last served from the Kylas crawl, so the
     scheduled job refreshes it while people are using it and not overnight. */
  let touchedCompanies = 0;
  const touchCompanies = () => {
    if (!cache || Date.now() - touchedCompanies < 60_000) return;
    touchedCompanies = Date.now();
    inFlight(cache.put("companies-read-at", String(Date.now()), { ttlSeconds: 7 * 86400 }))
      .catch(() => {});
  };

  const companyNames = new Map();
  async function companyName(id) {
    if (!id) return "";
    const k = String(id);
    if (!companyNames.has(k)) {
      try {
        const co = await kylas.company(k);
        companyNames.set(k, co?.name || "");
      } catch {
        companyNames.set(k, "");   // a failed lookup must not fail the whole fetch
      }
    }
    return companyNames.get(k);
  }

  async function mapContacts(raw, company) {
    /* Seed the cache with the company we were asked about, and with every name
       the payloads did carry, so the resolve loop below has less to do. */
    if (company?.id && company.name) companyNames.set(String(company.id), company.name);
    for (const c of raw) {
      const id = idOf(c.company);
      const known = lookupName(c, "company", id);
      if (id && known) companyNames.set(String(id), known);
    }

    const out = [];
    for (const c of raw) {
      const known = lookupName(c, "ownerId", c.ownerId);
      if (known && c.ownerId) owners.set(String(c.ownerId), known);
      const mapped = toConsoleContact(c, { ownerName: known || (await ownerName(c.ownerId)), company });
      /* The name may still be missing — fetch it rather than let the console
         render an id where a human expects a company. */
      if (mapped.companyId && !mapped.company) mapped.company = await companyName(mapped.companyId);
      out.push(mapped);
    }
    return out;
  }

  /* The owner dropdown needs names, not ids, and the console cannot invent them.
     Everyone seen so far, so a fetched owner is always selectable. */
  const ownerList = () => [...owners.entries()].map(([id, name]) => ({ id, name }));

  /* WHO THIS PROXY IS, asked once rather than four times a request.
     The proxy holds exactly ONE Kylas key and Kylas answers /v1/users/me with
     the person it belongs to — an answer that cannot change while the process
     runs, short of somebody editing roles in the CRM. It was being fetched on
     every /health poll and TWICE on every /companies (scopeOwner asks, then the
     route asks again), each one behind the 450ms rate-limit gap that every other
     Kylas request also queues on.

     That was the whole of the "why is this so slow": a /companies served
     entirely from a warm cache still took 917ms, and 900 of those were two
     round trips to ask a question whose answer had not changed since boot. The
     dashboard makes several such calls to paint, and they are serialised behind
     the same gap, so it compounds.

     Ten minutes, not for ever: a role changed in Kylas should take effect
     without restarting the proxy, and the scope filter is built on this answer.
     Only a SUCCESS is cached — a failure here means Kylas is unreachable, and
     remembering that would keep the console logged out long after it came
     back. */
  /* Kept in the shared cache (see shared() below), so a fresh instance does
     not open with a round trip to Kylas to learn what the last one knew. */
  const ME_TTL = Number(env.ME_TTL_MS || 10 * 60 * 1000);
  let meShared = null;
  async function whoami() {
    meShared ||= shared("kylas-me", { ttl: ME_TTL, stale: 24 * 3600 * 1000 }, () => kylas.me());
    return meShared();
  }

  /* ── ANSWER NOW, REFRESH BEHIND IT ───────────────────────────────────────
     A read that Airtable has already answered once should not be paid for
     again while the associate waits. Every Airtable request queues behind the
     same 220ms rate-limit gap, so a table of 20,000 call rows is 200 pages and
     three quarters of a minute — and the dashboard re-read all four of its
     tables every time somebody changed the period from Week to Month, for data
     that had not moved.

     Stale-while-revalidate, then: inside the TTL the cached value is returned
     outright; past it the cached value is STILL returned, and the refresh runs
     behind it, so the slow path is paid by nobody. Only the very first call of
     the process waits.

     One flight at a time. Without that, four browser tabs opening the dashboard
     at once start four identical crawls, and Airtable's rate limiter turns them
     into four SLOW identical crawls.

     `stale` is how long a value may be served while being refreshed. Past it
     the value is too old to hand out — a proxy left running over a weekend
     would otherwise serve Friday's numbers instantly and refresh them into a
     cache nobody reads.

     `key`, when given, replaces the clock: the value is good for exactly as
     long as key() returns what it returned when the value was computed. With
     the D1 copy of the tables that key is their version, so the dashboard is
     recomputed when — and only when — a row it reads has changed, whichever
     instance changed it. */
  /* Every build in progress, so a hosted shell can keep its request alive
     until they finish (ctx.waitUntil) rather than having them cut off the
     moment the reply is sent or the client stops waiting. */
  const building = new Set();
  const inFlight = (p) => {
    const q = p.catch(() => {}).finally(() => building.delete(q));
    building.add(q);
    return p;
  };
  function memo(name, { ttl, stale = 30 * 60 * 1000, key = null }, fn) {
    let entry = null;          /* { at, value, key } */
    let inflight = null;
    const run = (k = null) => {
      if (!inflight) {
        const started = Date.now();
        inflight = inFlight(fn()
          .then((value) => { entry = { at: Date.now(), value, key: k }; return value; })
          .finally(() => { inflight = null; log(`  ${name}: read in ${Date.now() - started}ms`); }));
      }
      return inflight;
    };
    const f = async ({ fresh = false } = {}) => {
      const k = key ? await key() : null;
      if (k) return !fresh && entry && entry.key === k ? entry.value : run(k);
      const age = entry ? Date.now() - entry.at : Infinity;
      if (entry && !fresh && age < ttl) return entry.value;
      /* Serve what we have and refresh behind it — but never swallow the error
         of a background refresh, or a base that has started refusing reads looks
         exactly like one that has not changed. */
      if (entry && !fresh && age < stale) {
        run().catch((e) => log(`! ${name}: background refresh failed — ${e.message.slice(0, 120)}`));
        return entry.value;
      }
      return run();
    };
    /* Something was written, so what is held here predates it. The value is
       dropped unconditionally — serving rows from before the write is how a
       dashboard tells an associate the call they just logged did not land — and
       the rebuild is started at once, so the reader who follows the save finds
       it done or joins a flight already in progress rather than beginning one.

       THROTTLED, because a save is not rare. At 200 calls a day, rebuilding
       eagerly on every one of them would spend the whole Airtable rate limit on
       a dashboard nobody has open, and the thing it would slow down is the next
       SAVE. Past the throttle the value is still dropped; it is only the eager
       rebuild that is skipped, and the next reader does it instead. The window
       matters for one case in particular: an outbox draining thirty queued saves
       in a row must trigger one rebuild, not thirty. */
    let lastRefresh = 0;
    f.refresh = ({ atMostEvery = 30 * 1000 } = {}) => {
      entry = null;
      if (Date.now() - lastRefresh < atMostEvery) return;
      lastRefresh = Date.now();
      run().catch((e) => log(`! ${name}: refresh failed — ${e.message.slice(0, 120)}`));
    };
    return f;
  }

  /* A value kept in the store, compressed. A company crawl is about a
     megabyte of JSON, half of what one D1 row may hold; gzip takes it to a
     sixth of that. CompressionStream, Blob and Response exist in both runtimes
     this runs in, so no Node API is needed and none is used. */
  function kept(st, key) {
    const toB64 = (bytes) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const fromB64 = (b64) => {
      const bin = atob(b64); const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    /* IN PIECES WHEN IT IS BIG. One D1 value is capped at about 2 MB, and the
       company list of a 17,926-company account compresses to around a
       megabyte and grows with the account. Past PART characters it is split
       across `${key}#0..n`, and the key itself holds "parts:n". The parts are
       written before the pointer, so a reader never follows it to half a copy. */
    const PART = Number(env.KEPT_PART_CHARS || 700_000);
    return {
      async get() {
        let raw = await st.get(key);
        if (!raw) return null;
        const m = /^parts:(\d+)$/.exec(raw);
        if (m) {
          const pieces = [];
          for (let i = 0; i < Number(m[1]); i++) {
            const p = await st.get(`${key}#${i}`);
            if (p == null) return null;            /* a part expired: treat as absent */
            pieces.push(p);
          }
          raw = pieces.join("");
        }
        const text = await new Response(new Blob([fromB64(raw)]).stream()
          .pipeThrough(new DecompressionStream("gzip"))).text();
        return JSON.parse(text);
      },
      async put(entry, ttlSeconds) {
        const gz = await new Response(new Blob([JSON.stringify(entry)]).stream()
          .pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
        const b64 = toB64(new Uint8Array(gz));
        if (b64.length <= PART) { await st.put(key, b64, { ttlSeconds }); return; }
        const n = Math.ceil(b64.length / PART);
        for (let i = 0; i < n; i++)
          await st.put(`${key}#${i}`, b64.slice(i * PART, (i + 1) * PART), { ttlSeconds });
        await st.put(key, `parts:${n}`, { ttlSeconds });
      },
    };
  }

  /* ── ONE ANSWER FOR EVERY INSTANCE ───────────────────────────────────────
     memo() for things that come from KYLAS: who the key belongs to, the
     picklists, the company crawl. In memory a hosted runtime forgets them
     between requests, and each is a round trip — the crawl is dozens — so they
     are kept in the store (D1 on the Worker) and every instance reads the one
     copy. On a laptop the store is a file and this behaves like memo().

     `background: false` is for work too long to finish behind a reply (the
     crawl): a stale value is served as it is and the scheduled job refreshes
     it, rather than a request starting a crawl the runtime will cut off. */
  function shared(name, { ttl, stale = 7 * 24 * 3600 * 1000, background = true }, fn) {
    const st = cache ? kept(cache, `shared:${name}`) : null;
    let entry = null;          /* { at, value } */
    let inflight = null;
    const run = () => {
      if (!inflight) {
        const started = Date.now();
        inflight = inFlight(fn()
          .then(async (value) => {
            entry = { at: Date.now(), value };
            if (st) await st.put(entry, Math.ceil(stale / 1000)).catch((e) =>
              log(`! ${name}: could not keep a copy — ${e.message.slice(0, 120)}`));
            return value;
          })
          .finally(() => { inflight = null; log(`  ${name}: fetched in ${Date.now() - started}ms`); }));
      }
      return inflight;
    };
    const load = async () => {
      if (st && (!entry || Date.now() - entry.at >= ttl)) {
        const k = await st.get().catch(() => null);
        if (k && (!entry || k.at > entry.at)) entry = k;
      }
      return entry;
    };
    const f = async ({ fresh = false } = {}) => {
      if (fresh) return run();
      await load();
      const age = entry ? Date.now() - entry.at : Infinity;
      if (age < ttl) return entry.value;
      if (age < stale) {
        if (background) run().catch((e) => log(`! ${name}: background refresh failed — ${e.message.slice(0, 120)}`));
        return entry.value;
      }
      return run();
    };
    /* Seconds since it was fetched, or null — for the scheduled job, and for
       a response to say how old what it is showing is. */
    f.age = async () => { await load(); return entry ? Math.round((Date.now() - entry.at) / 1000) : null; };
    f.peek = async () => (await load())?.value ?? null;
    return f;
  }

  /* EVERYTHING THE DASHBOARD IS COMPUTED FROM, in one read.
     Four whole tables, none of which depends on the period, the date window or
     who is asking — those are filters applied over these rows afterwards. Held
     together so that switching Week to Month, or Everyone to one associate,
     costs arithmetic rather than another crawl of the call log.

     THE TTL IS SHORT AND THE STALE WINDOW IS LONG on purpose: a save drops this
     cache outright (see /save), so the freshness that matters — the call just
     logged — does not wait on a timer. The TTL is only for rows another
     associate's proxy wrote. */
  const REPORT_TTL = Number(env.REPORT_TTL_MS || 60 * 1000);
  const REPORT_TABLES = ["Call Log", "Call Rollup", "Stage Transitions", "Contacts", "Team"];
  const reportData = memo("report data", {
    ttl: REPORT_TTL,
    key: mirror ? () => mirror.stamp(REPORT_TABLES) : null,
  }, async () => {
    /* listTolerant, not listAll. Is Right POC and Is Discovery are FORMULA
       fields, so a base one repair-base behind does not have them — and Airtable
       rejects the whole projection for one unknown name, which took the ENTIRE
       report down with a raw 422 rather than costing the two metrics those
       fields feed. The dashboard should lose a column, not the page. */
    /* EVERY PAGE. listAll stops at 40 pages unless told otherwise — 4,000
       rows — and the call log passes that in four days at this team's volume:
       the month's numbers were silently the first 4,000 calls. Found when the
       D1 copy, which reads whole tables, disagreed with this path. */
    const ALL = { pageSize: 100, maxPages: 2000 };
    const [callRows, rolledRows, transRows, contactRows, team] = await Promise.all([
      listTolerant(airtable, "Call Log", { fields: ["Called At", "Owner", "Outcome"], ...ALL }),
      /* Days past the retention window live in Call Rollup, one row per day per
         owner per outcome, because the raw log fills an Airtable base in about
         six weeks at this call volume. Missing this read would make every month
         older than the window read zero — history silently deleted rather than
         compacted. Tolerated when absent so a base without the table still
         reports, just without the old days. */
      listTolerant(airtable, "Call Rollup", { fields: ["Day", "Owner", "Outcome", "Calls"], ...ALL })
        .catch(() => []),
      listTolerant(airtable, "Stage Transitions", { fields: ["Changed At", "Owner", "To Stage", "Contact"], ...ALL }),
      /* Right POC and discovery are DATA becoming true, not a stage move, so
         they have no transition row. The closest honest timestamp is when the
         contact's rank last rose — the save that filled the fields. */
      listTolerant(airtable, "Contacts", {
        fields: ["Name", "Owner", "Is Right POC", "Is Discovery", "KPI Rank At", "Company",
                 "First Worked At", "First Picked At"], ...ALL }),
      /* THE ROSTER FILTERS THE NUMBERS, NOT JUST THE COLUMNS.
         Dropping non-team people in the view would leave the Team column summing
         everybody while the per-person columns beside it summed the team — two
         numbers on one row that do not add up, which is the exact class of bug
         the ladder was just fixed for. It happens in the route, once, so every
         total on the page is of the same population. */
      readTeam(airtable).catch(() => []),
    ]);

    const raw = callRows.map((r) => ({ at: r.fields["Called At"], owner: r.fields.Owner,
                                       outcome: r.fields.Outcome }));
    const rolled = rolledRows.map((r) => ({ at: r.fields.Day, owner: r.fields.Owner,
                                            outcome: r.fields.Outcome,
                                            n: Number(r.fields.Calls || 0) }));
    /* A day can briefly exist in both tables — the rollup writes before it
       deletes. mergeCalls prefers the raw rows for any such day, so an
       interrupted rollup reads correctly instead of double. */
    const calls = mergeCalls(raw, rolled);
    /* A TRANSITION LINKS TO A CONTACT, AND THE LADDER COUNTS COMPANIES.
       This used to key a transition by its contact record, so booked/done/sql
       deduped per CONTACT while worked/picked/right/discovery deduped per
       company — two contacts at one account each reaching an Active Requirement
       call counted that account twice at "SQL meeting booked" and once at
       "Discovery". Two units on one ladder, which is the exact fault the
       METRICS comment above warns about. Resolved through the contact rows,
       which carry the company link and are read here anyway.

       A contact with no company link keeps its own record id — a company of
       one. Dropping it would lose the rung entirely, and an account nobody has
       linked is still an account somebody worked. */
    const companyOfContact = new Map(
      contactRows.map((r) => [r.id, (r.fields.Company || [])[0] || r.id]));
    const transitions = transRows.map((r) => {
      const contact = (r.fields.Contact || [])[0] || "";
      return { at: r.fields["Changed At"], owner: r.fields.Owner,
               to: r.fields["To Stage"], contact,
               company: companyOfContact.get(contact) || contact };
    });
    const signals = [];
    for (const r of contactRows) {
      const co = (r.fields.Company || [])[0] || r.id;
      const owner = r.fields.Owner;
      /* THE BOTTOM TWO RUNGS, per company. Written once by the writer and never
         updated, so unlike the call log they survive rollup-calls.mjs deleting
         old rows — a company's first touch cannot drift forward as history is
         compacted. report() dedupes to the FIRST arrival per company, so the
         earliest contact at a company is the one that dates it. */
      if (r.fields["First Worked At"])
        signals.push({ at: r.fields["First Worked At"], owner, company: co, metric: "worked" });
      if (r.fields["First Picked At"])
        signals.push({ at: r.fields["First Picked At"], owner, company: co, metric: "picked" });
      const at = r.fields["KPI Rank At"];
      if (!at) continue;
      if (r.fields["Is Right POC"]) signals.push({ at, owner, company: co, metric: "right" });
      if (r.fields["Is Discovery"]) signals.push({ at, owner, company: co, metric: "discovery" });
    }
    return { calls, transitions, signals, team };
  });

  /* Picklists, read once. The console cannot know what an account's custom
     fields offer, and a hardcoded list quietly renders real values as blank. */
  /* Picklists. The console cannot know what an account's custom fields offer,
     and a hardcoded list quietly renders real values as blank. They change when
     somebody edits the CRM's settings, so six hours is plenty. */
  const metaShared = shared("kylas-picklists", { ttl: 6 * 3600 * 1000, stale: 30 * 24 * 3600 * 1000 }, async () => {
    const r = await kylas.raw("GET",
      "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
    const fields = Array.isArray(r) ? r : r?.content || r?.data || [];
    const picklists = {};
    for (const f of fields) {
      const key = f.name || f.displayName;
      const values = findOptions(f);
      if (key && values) picklists[key] = values;
    }
    log(`picklists: ${Object.keys(picklists).join(", ") || "none"}`);
    return { picklists, fields: fields.map((f) => ({ name: f.name, label: f.displayName, type: f.type })) };
  });
  const meta = () => metaShared();

  /* Option arrays are nested differently per field type, so look for the shape
     rather than guessing at key names. */
  function findOptions(field, depth = 0) {
    if (!field || depth > 4) return null;
    if (Array.isArray(field)) {
      if (field.length && field.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
        return field.map((x) => ({ id: x.id, code: x.name || x.displayName, label: x.displayName || x.name }));
      for (const x of field) { const hit = findOptions(x, depth + 1); if (hit) return hit; }
      return null;
    }
    if (typeof field === "object")
      for (const k of Object.keys(field)) { const hit = findOptions(field[k], depth + 1); if (hit) return hit; }
    return null;
  }

  /* One save, carried out: Kylas, then Airtable, then the call log. What the
     queue runs in the background, and what an older console still waits for. */
  async function performSave(body) {
      const raw = body.contact;
      if (!raw) throw Object.assign(new Error("contact is required"), { status: 400 });

      /* THE KEY THAT MAKES A RETRY SAFE. Only a contact with no Kylas id can be
         duplicated, so only that case needs one.

         `lid` is the console's own local id for a contact it invented: stable
         across every retry of that save, different for two different POCs. The
         fallback is for a job queued by an older build, which has no lid — name
         and number together identify one person closely enough to be worth far
         more than nothing, and a genuine second POC on a shared landline has a
         different name.

         A save that already HAS a kid needs no key: repeating a PUT writes the
         same record twice, which is the same record. */
      const idemKey = raw.kid ? "" :
        (raw.lid ? `lid:${raw.lid}`
                 : `poc:${(raw.pocName || "").trim().toLowerCase()}|` +
                   `${((raw.phones || [])[0]?.value || "").replace(/\D/g, "")}`);
      /* Serialised per key: a double-click, or a drain racing a save, must not
         have two creates in the air at once — both would find the journal empty. */
      return journal.once(idemKey, async () => {

      /* VALIDATE BEFORE WRITING. Kylas answers a bad field with a 400 that names
         neither the field nor the rule, and the associate loses the whole save
         over it. The same rules run in the console, so this is the backstop for
         an older extension or a queued outbox job, not the first line of
         defence. A 422 carries the field list back; the console shows it.

         An existing contact may legitimately have no phone number on it — the
         rule is there to stop a NEW one being created uncallable. */
      const gate = checkContact(raw, { allowNoPhone: !!raw.kid });
      if (!gate.ok) {
        log(`! /save rejected ${raw.pocName || raw.kid}: ` +
            gate.problems.filter((p) => p.blocking).map((p) => p.why).join("; "));
        throw Object.assign(new Error(gate.problems.filter((p) => p.blocking).map((p) => p.why).join("; ")),
                            { status: 422, problems: gate.problems });
      }
      /* Write the NORMALISED copy: split phone numbers, lowercased emails, the
         name already split the way Kylas wants it. */
      const c = gate.contact;
      if (gate.problems.length) log(`  /save note: ${gate.problems.map((p) => p.why).join("; ")}`);

      /* The block is for a human reading the record, so use the name they know. */
      const stageLabel = STAGE_LABEL[c.stage] || c.stage || "";
      const result = { kid: c.kid || null, created: false, wrote: [] };

      /* KYLAS AND AIRTABLE SIDE BY SIDE. Airtable needs only the contact's
         Kylas id, so for a contact that already has one it does not wait for
         Kylas at all; for a new contact it starts the moment Kylas has made
         it, and the Kylas call log goes out beside it. Each leg reports its
         own failure on the result; only Kylas's contact write fails the save. */
      const airtableLeg = async () => {
        /* Airtable is the authoritative store, so a failure here is reported to the
           console rather than swallowed — the associate needs to know the KPI data
           did not land, even though Kylas did. */
        if (airtable) {
          try {
            /* createdHere comes from THIS side, not the console's. The console sets
               it when it believes the contact is new, and while the proxy is down it
               believes that on every save of the same contact — two offline calls
               then drain as two Call Log rows both claiming the create, and
               snapshot.mjs counts "Contacts Added" straight off that flag, so one
               new POC read as two. Only one of those saves actually POSTed to Kylas,
               and only this side knows which. */
            result.airtable = await syncContact(
              airtable, { ...c, kid: result.kid },
              body.call ? { ...body.call, createdHere: result.created } : body.call,
              { log });
            /* THE DASHBOARD MUST SEE THE CALL THAT WAS JUST LOGGED.
               Its four tables are cached, and a minute of staleness is fine for
               another associate's rows and not fine for your own: an associate who
               logs a call and opens the dashboard to check it landed is the exact
               reader this whole store exists for. Dropped rather than patched —
               rebuilt rather than patched — rebuilding is one background crawl, and
               a cache patched by hand is a second implementation of the read that
               can disagree with it. */
            /* With the D1 copy there is nothing to drop: the save's own writes
               are already in it. What is NOT is what Airtable computed from them —
               the contact's formulas, the company's rollups — so those two records
               are read back, behind the reply. */
            if (mirror) {
              inFlight(Promise.all([
                mirror.refetch(rawAirtable, "Contacts", [result.airtable?.recordId]),
                mirror.refetch(rawAirtable, "Companies", [result.airtable?.companyRecordId]),
              ])).catch(() => {});
            } else {
              reportData.refresh();
            }
          } catch (e) {
            result.airtableError = e.message;
            log(`! airtable for ${result.kid}: ${e.message}`);
          }
        } else {
          result.airtableSkipped = true;
        }
      };
      const callLogLeg = async () => {
        if (body.call && result.kid) {
          try {
            await kylas.createCallLog(toKylasCallLog({ ...c, kid: result.kid }, body.call));
            result.wrote.push("logged call");
          } catch (e) {
            /* The contact is already saved; losing the call log is recoverable and
               must not make the associate think the save failed. */
            result.callLogError = e.message;
            log(`! call log for ${result.kid}: ${e.message}`);
          }
        }
      };
      let atP = c.kid ? airtableLeg() : null;
      try {
        /* Remarks: read what is there first so a human's own text survives. */
        let existing = "";
        if (c.kid) {
          try { existing = (await kylas.contact(c.kid))?.remarks || ""; }
          catch { /* a failed read should not block the write */ }
        }
        const remarks = mergeRemarks(existing, renderRemarks(c, { stageLabel }));
        const payload = toKylasContact(c, { remarks });

        if (!c.kid) {
          /* CREATE EXACTLY ONCE PER KEY. See journal.mjs: a retry of a save whose
             reply was lost still carries no Kylas id, and without this it POSTs a
             second contact. */
          const known = await journal.lookup(idemKey);
          if (known.state === "done") {
            c.kid = known.kid;
            result.kid = known.kid;
            result.deduped = true;
            await kylas.updateContact(c.kid, payload);
            result.wrote.push("updated contact (already created by an earlier attempt)");
            log(`deduped: ${c.pocName} was already created as ${c.kid} — updated instead`);
          } else {
            /* An attempt that started and never finished. Kylas may or may not hold
               the contact; the only way to find out is to look. findExisting knows
               where: it needs no company, so a POC invented from the queue rather
               than a company page is covered too. */
            let found = null;
            if (known.state === "open") {
              log(`an earlier attempt to create ${c.pocName} never finished — checking Kylas first`);
              found = await findExisting(c, known.at).catch((e) => {
                log(`  could not check (${e.message}) — creating, a duplicate is possible`);
                return null;
              });
            }
            if (found) {
              c.kid = String(found.id);
              result.kid = c.kid;
              result.deduped = true;
              await journal.done(idemKey, c.kid);
              await kylas.updateContact(c.kid, payload);
              result.wrote.push("adopted the contact an interrupted attempt had created");
              log(`recovered: ${c.pocName} already existed as ${c.kid} — updated instead of duplicating`);
            } else {
              /* Written BEFORE the POST. If this process dies during it, the next
                 attempt finds an open entry and looks before it leaps. */
              await journal.open(idemKey);
              let made;
              try {
                made = await kylas.createContact(payload);
              } catch (e) {
                /* Refused means nothing was made, so the key goes back to unused —
                   otherwise every later retry pays for a lookup of a contact that
                   does not exist. */
                await journal.forget(idemKey);
                throw e;
              }
              result.kid = String(made?.id ?? "");
              result.created = true;
              await journal.done(idemKey, result.kid);
              result.wrote.push("created contact");
              log(`created contact ${result.kid} (${c.pocName})`);
            }
          }
        } else {
          await kylas.updateContact(c.kid, payload);
          result.wrote.push("updated contact");
          log(`updated contact ${c.kid} (${c.pocName})`);
        }
      } catch (e) {
        /* Kylas refused. Let Airtable finish before saying so, so nothing is
           cut off half-written; the retry repeats both, and both are keyed. */
        if (atP) await atP;
        throw e;
      }
      atP ||= airtableLeg();
      await Promise.all([atP, callLogLeg()]);
      return result;
      });
  }

  /* The ladder is every company joined to every arrival — hundreds of ms of
     work over tables that change a few times a minute at most. Held until
     one of them does. */
  const ladderData = memo("ladder", {
    ttl: REPORT_TTL,
    key: mirror ? () => mirror.stamp([...REPORT_TABLES, "Companies", "Focus", "Research"]) : null,
  }, async () => {
    const [{ transitions, signals, team }, companies, focus, research] = await Promise.all([
      reportData(),
      readCompanies(airtable),
      readFocus(airtable),
      readResearch(airtable),
    ]);

    /* Arrivals are keyed by the company's AIRTABLE RECORD id, because that is
       what a contact and a transition link to. Everything the app shows is
       keyed by the KYLAS id, which is also the :id in its routes. One map
       between them, built here, rather than every caller guessing. */
    const isCounted = counter(team);
    const arrivals = arrivalsByCompany({ transitions, signals });
    const kylasIdOf = new Map(companies.filter((c) => c.recordId).map((c) => [c.recordId, c.id]));
    const byKylasId = new Map();
    for (const [recordId, row] of arrivals) {
      const kid = kylasIdOf.get(recordId) || recordId;
      byKylasId.set(kid, { ...(byKylasId.get(kid) || {}), ...row });
    }
    /* The six rungs the ladder shows, in order, named as report.mjs names
       them. "worked" is the reference's "Companies reached". */
    const RUNGS = ["worked", "right", "discovery", "booked", "done", "sql"];

    const rows = companies.map((c) => {
      const a = byKylasId.get(String(c.id)) || {};
      const rungs = RUNGS.map((k) => (a[k] ? { at: a[k], source: "airtable" } : null));

      /* NOTHING MEASURED, BUT THE COMPANY IS PLAINLY SOMEWHERE. Most of the
         account has never been worked through the console, so there is no
         transition to date. The stage it sits on still implies a rung, and the
         last call still says when — so the rung is stamped from those and
         marked `seeded`, and every screen that shows it says so. Ayush,
         2026-09-19: count only real dates, but a seeded row counts at the rung
         its stage implies and nowhere else. */
      if (!rungs.some(Boolean) && c.lastCalledAt)
        rungs[seededRung(c.stage)] = { at: c.lastCalledAt, source: "seeded" };

      return {
        id: String(c.id || ""),
        name: c.name || "",
        owner: c.owner || "",
        stage: c.stage || "",
        source: c.source || "",
        lastCall: c.lastCalledAt || null,
        rungs,
      };
    }).filter((r) => r.id);

    return {
      configured: true,
      companies: rows,
      /* WHO COUNTS, decided here rather than in the app. The reference read a
         role string and looked for "Business Development Associate"; this base
         has an explicit In Funnel checkbox, which is the roster override, and
         counter() carries the rule that an unknown name counts. Two copies of
         that rule would drift, and the one in the browser would be the wrong
         one. So the answer travels with the data. */
      team: team.map((p) => ({ ...p, counted: isCounted(p.name) })),
      focus,
      research,
      syncedAt: (await readSyncState(airtable).catch(() => null))?.at || null,
    };
  });

  const routes = {
    "/meta": async () => meta(),

    "/health": async () => {
      const me = await whoami();
      return { ok: true, user: { id: me?.id, name: userName(me), email: me?.email || "" },
               role: roleOf(me), admins: ADMINS.length,
               version: VERSION, startedAt: STARTED };
    },

    /* Everything the console needs when it opens on a company page: the company
       itself, and its contacts already in console shape. */
    "/company": async (url) => {
      const id = url.searchParams.get("id");
      if (!id) throw Object.assign(new Error("id is required"), { status: 400 });
      /* A company with no contacts in Airtable is indistinguishable from a
         company Airtable has not seen, so both fall through. An allotted company
         nobody has worked yet is exactly the case that must not read as empty. */
      const held = await fromAirtable("company " + id,
        async () => { const r = await readCompany(airtable, id); return r?.contacts?.length ? r : null; });
      if (held) {
        log(`company ${id} — ${held.contacts.length} contact(s) from Airtable`);
        return { company: held.company, contacts: held.contacts, owners: ownerList(),
                 picklists: (await meta()).picklists, source: "airtable" };
      }
      /* Kept for every instance, briefly: reopening an account nobody has
         saved to yet was two Kylas round trips every time. Once somebody saves
         to it, Airtable holds it and the branch above answers instead. */
      const kc = perKey(companyFromKylas, `kylas-company:${id}`, async () => {
        const [co, raw] = [await kylas.company(id), await kylas.contactsForCompany(id)];
        const company = toConsoleCompany(co);
        return { company, contacts: await mapContacts(raw, company) };
      });
      const { company, contacts } = await kc();
      log(`company ${id} — ${contacts.length} contact(s) from Kylas`);
      return { company, contacts, owners: ownerList(),
               picklists: (await meta()).picklists, source: "kylas" };
    },

    /* The companies list and the dashboards. Companies allotted to an owner are
       the ones whose OWN owner field is that person — not the ones where they
       happen to own a contact. Deriving the list from contacts, as the console
       used to, silently hides every company that has been assigned but not yet
       worked, which is exactly the list an associate needs at the start of a day.
       ?owner= for one person, ?owner=all for the team view. */
    "/companies": async (url) => {
      const want = await scopeOwner(url.searchParams.get("owner"));
      const me = await whoami();
      const all = want === "all";
      const owner = all ? null : (want || me?.id);

      /* ONE CRAWL OF THE ACCOUNT, cached, filtered per owner here.
         The cache used to be keyed on owner, which read as prudent and was the
         same mistake the console had: no shape that works on this account can
         filter server-side, so asking for ONE owner pages the whole account
         anyway — and then asking for "everyone", or for a second name, paged it
         all over again. Ayush's log has "5000 across 25 page(s)" eight times in
         one session, ~16s each, for data that had not changed.

         So the crawl is keyed "all" and nothing else, and an owner is a filter
         over it. If Kylas ever fixes /v1/search/company so a filtering shape
         works, a server-side filter becomes worth having again — until then
         filtering here is strictly cheaper. ?fresh=1 is the Refresh button. */
      const hit = companyCache.get("all");
      const fresh = url.searchParams.get("fresh");
      const ownedBy = (list) => (owner == null ? list
        : list.filter((c) => String(c.ownerId ?? "") === String(owner)));

      /* Seconds, not minutes, with the D1 copy: rebuilding this from it is
         arithmetic, and a longer hold here would only hide another instance's
         save. */
      if (hit && !fresh && Date.now() - hit.at < (mirror ? 5000 : COMPANY_TTL)) {
        const age = Math.round((Date.now() - hit.at) / 1000);
        const companies = ownedBy(hit.body.companies);
        log(`companies for ${all ? "all owners" : owner} — ${companies.length} (cached ${age}s)`);
        return { ...hit.body, companies, owner: all ? "all" : String(owner), cachedSeconds: age };
      }

      /* THE MIRROR FIRST. Read from Airtable there is no join to fail: the
         company row and its KPI formulas are the same record, so the "no company
         matched Airtable" fault cannot arise rather than being reported better.
         ?keys=1 is a Kylas diagnostic and deliberately skips this. */
      /* A BASE THAT HAS NEVER BEEN SYNCED IS NOT THE ACCOUNT. The console
         writes a company into Airtable the first time somebody saves a call
         there, so a base the Kylas sync has never filled still holds a handful
         of rows — and "not empty" was the only test, so those few were served
         as the whole company list. That is what "not pulling the existing data
         from Kylas" was. The sync leaves a record when it runs; until it has,
         the list comes from Kylas. */
      const sync = READS_AIRTABLE ? await syncState() : null;
      if (READS_AIRTABLE && !sync && !STRICT_AIRTABLE && !warnedNeverSynced) {
        warnedNeverSynced = true;
        log("! companies: this Airtable base has never been synced from Kylas — listing from Kylas. " +
            "Run the sync once (docs/DEPLOY.md, part 9).");
      }
      if (!url.searchParams.get("keys") && (sync || STRICT_AIRTABLE)) {
        const mirror = await fromAirtable("companies", async () => {
          const list = await readCompanies(airtable);
          return list.length ? list : null;
        });
        if (mirror) {
          /* Kylas' own field rides on the crawl, when there is one. */
          const crawlNow = await kylasCompanies.peek().catch(() => null);
          const [offsite, fromKylas] = await Promise.all([offsiteByCompany(), kylasOffsite(crawlNow?.companies || [])]);
          for (const co of mirror) co.offsite = OFFSITE_QUARTERS.filter((q) =>
            offsite.get(String(co.id))?.has(q) || fromKylas.get(String(co.id))?.has(q));
          for (const co of mirror) {
            if (co.ownerId && co.owner) owners.set(String(co.ownerId), co.owner);
            if (co.id && co.name) companyNames.set(String(co.id), co.name);
          }
          const matched = mirror.filter((c) => c.kpi).length;
          /* The mirror cannot see the crawl that filled it, so the sync's own
             record of what it managed is what the truncation warning now rests
             on. Without this a short mirror reads as a complete account, which
             is the fault this whole thread has been about. */
          const short = sync?.kylas?.short || 0;
          const body = { owner: "all", companies: mirror, owners: ownerList(),
                         picklists: (await meta()).picklists,
                         kpiSource: "airtable", kpiError: "", kpiMatched: matched,
                         source: "airtable",
                         syncedAt: sync?.at || "",
                         truncated: short > 0, crawled: mirror.length,
                         pages: 0,
                         reportedTotal: sync?.kylas?.reportedTotal ?? null,
                         short,
                         hitOurCap: false, hitTheirCeiling: short > 0 };
          companyCache.set("all", { at: Date.now(), body });
          log(`companies — ${mirror.length} from Airtable, ${matched} with KPIs` +
              (sync?.at ? `, synced ${sync.at}` : ", NO sync record") +
              (short ? `, mirror is ${short} SHORT of Kylas' count` : ""));
          return { ...body, companies: ownedBy(mirror), owner: all ? "all" : String(owner) };
        }
      }

      /* ?keys=1 reports the shape this account's company search actually returns,
         WITHOUT the values — enough to find where a missing field lives, safe to
         paste. Guessing at key names is how the name came back blank for 38
         companies in the first place. A live crawl, deliberately. */
      if (url.searchParams.get("keys")) {
        const raw = await kylas.companies();
        const first = raw[0] || {};
        return {
          count: raw.length,
          shape: kylas.companyShapeName?.() || "unknown",
          topLevelKeys: Object.keys(first).sort(),
          customFieldKeys: Object.keys(first.customFieldValues || {}).sort(),
          idNameStoreKeys: Object.keys(first.metaData?.idNameStore || {}).sort(),
          nameLikeValues: Object.fromEntries(Object.entries(first)
            .filter(([k, v]) => /name|title|company/i.test(k) && typeof v !== "object")
            .map(([k, v]) => [k, typeof v])),
        };
      }
      /* The crawl is shared by every instance and refreshed by the scheduled
         job, so this is a read of the last one — not dozens of Kylas pages while
         an associate waits. Only the very first ever, or the Refresh button,
         crawls here. */
      /* NEVER CRAWLED INSIDE A REQUEST. Past Kylas' 10,000-row window the
         crawl is well over a hundred requests, which Cloudflare refuses in one
         invocation on the Free plan ("Too many subrequests") and which takes
         over a minute on any plan. The maintenance run builds it; until it
         has, this says so rather than failing. The Refresh button asks for a
         new crawl on the next run. */
      touchCompanies();
      if (fresh && cache) inFlight(cache.put("companies-want-fresh", "1", { ttlSeconds: 3600 })).catch(() => {});
      let crawl = await kylasCompanies.peek();
      /* The local proxy has no shared store and no subrequest cap: there,
         crawl here as it always did. */
      if (!crawl && !cache) crawl = await kylasCompanies({ fresh: true }).catch(() => null);
      if (!crawl) {
        log("companies: no Kylas crawl yet — the maintenance run is building it");
        /* WHY it is still building, so the console can say something a person
           can act on: the job has never run (its schedule is not registered),
           or it ran and failed (and with what). */
        const lastRun = Number((cache && (await cache.get("maintain-last-run").catch(() => null))) || 0);
        const crawlError = cache ? JSON.parse((await cache.get("companies-crawl-error").catch(() => null)) || "null") : null;
        return { owner: all ? "all" : String(owner), companies: [], owners: ownerList(),
                 picklists: (await meta()).picklists, source: "kylas", building: true,
                 lastRunSecondsAgo: lastRun ? Math.round((Date.now() - lastRun) / 1000) : null,
                 crawlError,
                 kpiSource: "none", kpiError: "", kpiMatched: 0 };
      }
      for (const co of crawl.companies) {
        if (co.ownerId && co.owner) owners.set(String(co.ownerId), co.owner);
        if (co.id && co.name) companyNames.set(String(co.id), co.name);
      }
      const [offsite, fromKylas] = await Promise.all([offsiteByCompany(), kylasOffsite(crawl.companies)]);
      const companies = crawl.companies.map(({ offsiteRaw: _raw, ...co }) => ({ ...co,
        offsite: OFFSITE_QUARTERS.filter((q) => offsite.get(String(co.id))?.has(q) || fromKylas.get(String(co.id))?.has(q)) }));
      /* AIRTABLE IS THE DEFINITION OF THE KPIs. The dashboard used to recompute
         Right POC, Successful Discovery and the three milestones in the browser
         from Kylas data, which meant the same rules lived twice and only the
         browser copy was ever on screen. The numbers come from the Airtable
         formulas now; the browser keeps its own version strictly as a fallback
         for a company Airtable has not seen yet, and says so on screen.

         A failure here is NOT a failed request. Kylas' half of this response is
         the roster an associate calls from, and it must arrive whether or not
         the KPI store is reachable. */
      let kpiSource = "none", kpiError = "", matched = 0;
      if (airtable) {
        try {
          const kpis = await readCompanyKpis(airtable, { log });
          for (const co of companies) {
            const k = kpis.get(String(co.id));
            if (k) { co.kpi = k; matched++; }
          }
          kpiSource = "airtable";
        } catch (e) {
          kpiError = e.message;
          log(`! airtable kpis: ${e.message}`);
        }
      } else {
        kpiError = "Airtable is not configured";
      }

      /* A crawl that stopped at the page cap is a correct PREFIX of the answer,
         not the answer. It travels with the rows so the console can say so —
         silently serving a short list is how 19 of Arshdeep's 250 companies got
         reported as all of them. */
      const search = crawl.search || {};
      /* TWO DIFFERENT FAULTS WITH TWO DIFFERENT FIXES, and one message used to
         cover both. Raising KYLAS_MAX_PAGES is the answer when WE stopped early;
         it does nothing at all when Kylas stops serving rows past a fixed offset
         while still reporting the true count, which is what Ayush hit. Telling
         him to raise the cap would have sent him to change a number that cannot
         help. */
      if (search.hitOurCap)
        log(`! the company list is INCOMPLETE — we stopped at ${search.pages} pages / ` +
            `${search.total} companies. Raise KYLAS_MAX_PAGES and restart.`);
      else if (search.hitTheirCeiling)
        log(`! the company list is INCOMPLETE — Kylas reports ${search.reportedTotal} ` +
            `companies and served ${search.total}, ${search.short} short. Its paged ` +
            `search will not go further; the rest need fetching by id or by updatedAt.`);

      /* The picklists too. The companies LIST page never calls /company, so
         without them the console's SOURCES stayed empty there and the Source
         filter could only offer values it happened to see in the loaded rows.
         meta() is cached, so this is free after the first call. */
      const body = { owner: "all", companies, owners: ownerList(),
                     picklists: (await meta()).picklists,
                     kpiSource, kpiError, kpiMatched: matched,
                     truncated: !!search.truncated, crawled: search.total || companies.length,
                     pages: search.pages || 1,
                     /* What Kylas itself says exists, so the console can stop
                        guessing at "an unknown amount". */
                     reportedTotal: search.reportedTotal ?? null,
                     short: search.short || 0,
                     hitOurCap: !!search.hitOurCap,
                     hitTheirCeiling: !!search.hitTheirCeiling };
      /* The WHOLE account is cached, under one key, whoever asked. */
      companyCache.set("all", { at: Date.now(), body });

      const out = ownedBy(companies);
      log(`companies for ${all ? "all owners" : owner} — ${out.length}`
          + (all ? "" : ` of ${companies.length}`)
          + (kpiSource === "airtable" ? `, ${matched} with Airtable KPIs` : ""));
      return { ...body, companies: out, owner: all ? "all" : String(owner) };
    },

    /* Every Kylas user this account has, with their status and their role here.
       No list endpoint is documented, so the client tries the likely shapes and
       falls back to resolving the owner ids already seen on companies — see
       kylas.mjs users(). */
    "/users": async (url) => {
      /* Seed the floor with every owner id we have met. Opening the dashboard
         once fills this; without it the fallback has nobody to look up. */
      const known = [...owners.keys()];
      const hit = companyCache.get("all");
      for (const c of hit?.body?.companies || []) if (c.ownerId) known.push(String(c.ownerId));

      const { source, users } = await (usersShared ||= shared("kylas-users",
        { ttl: 10 * 60 * 1000, stale: 7 * 24 * 3600 * 1000 }, () => kylas.users(known)))();
      const withRole = users.map((u) => ({
        ...u,
        role: (u.email && ADMINS.includes(u.email)) || ADMIN_IDS.includes(String(u.id))
          ? "admin" : "associate",
      }));
      /* Active first, then name. An inactive user is kept and labelled rather
         than dropped: they still own companies and still appear in history, and
         a name vanishing from a report is worse than a name marked inactive. */
      withRole.sort((a, b) => (b.active === true) - (a.active === true) ||
                              String(a.name).localeCompare(String(b.name)));
      const active = withRole.filter((u) => u.active === true).length;
      const unknown = withRole.filter((u) => u.active === null).length;
      log(`users: ${withRole.length} (${active} active${unknown ? `, ${unknown} status unknown` : ""}) via ${source}`);

      if (url.searchParams.get("active")) return { source, users: withRole.filter((u) => u.active !== false) };
      return { source, users: withRole, admins: ADMINS,
               counts: { total: withRole.length, active, unknown,
                         admins: withRole.filter((u) => u.role === "admin").length } };
    },

    /* WHY DO THE COMPANY KPIs NOT MATCH?
       The dashboard joins Kylas companies to Airtable rows on the Kylas company
       id. When that join finds nothing, every company-level number reads zero
       while the Progress section — which reads the event tables directly and
       needs no join — shows real data. Two right-looking halves and no way to
       tell which side is empty.

       This answers it in one call: what each side holds, and a sample of ids
       from both so a mismatch in FORM (a number vs a string, a stray space, an
       id from a different account) is visible rather than inferred. */
    "/kpi-debug": async () => {
      if (!airtable) return { error: "Airtable is not configured" };
      /* Airtable rejects the WHOLE read for one unknown field name, so the
         diagnostic died with a 422 on exactly the half-migrated base it exists to
         explain — the badge then said "could not check why" and the fault was
         still a mystery. Two fields are all it needs to answer the question; the
         rest are a nicety, so they are asked for once and then dropped. */
      const WANT = ["Kylas Company ID", "Name", "KPI Rank", "Right POC", "Successful Discovery"];
      let rows, fieldWarning = null;
      try {
        rows = await airtable.listAll("Companies", { fields: WANT });
      } catch (e) {
        if (!/UNKNOWN_FIELD_NAME/.test(e.message)) throw e;
        /* Airtable names the field inside escaped JSON, so pull it out rather
           than pasting the tail of the error and its closing braces. */
        const which = /Unknown field name:\s*\\?"([^"\\]+)/.exec(e.message)?.[1];
        fieldWarning = `Companies has no field ${which ? `"${which}"` : "this check asked for"
          }. Run scripts/repair-base.mjs. Read with the two join fields only.`;
        rows = await airtable.listAll("Companies", { fields: ["Kylas Company ID", "Name"] });
      }
      const ids = rows.map((r) => String(r.fields["Kylas Company ID"] ?? "").trim());
      const withId = ids.filter(Boolean);

      const hit = companyCache.get("all");
      const kylasIds = (hit?.body?.companies || []).map((c) => String(c.id));
      const set = new Set(withId);
      const overlap = kylasIds.filter((id) => set.has(id));

      /* ASK KYLAS, DO NOT INFER FROM THE CACHE.
         "None overlap, so the ids are from a different account" was a guess
         dressed as a verdict. The cached list is a capped, updatedAt-ordered
         PREFIX of the account — on Ayush's it stops at exactly 10,000, which is
         Elasticsearch's default max_result_window and not the end of his data —
         so an id missing from it says nothing about whether it exists. There is
         a direct answer one call away: GET /v1/companies/{id}.

           404 → that id is genuinely not in this Kylas account
           200 → the id is real and the CACHED LIST is what is wrong

         Five ids, because the rate limit is the scarce thing here and five is
         enough to tell a systematic fault from one bad row. */
      const probe = [];
      for (const id of withId.slice(0, 5)) {
        try {
          const co = await kylas.company(id);
          probe.push({ id, found: true, name: co?.name || "(no name)",
                       ownerId: String(co?.ownerId ?? co?.owner?.id ?? "") || null,
                       inCachedList: set.size ? kylasIds.includes(id) : false });
        } catch (e) {
          probe.push({ id, found: false, status: e.status || null, why: e.message });
        }
      }
      const real = probe.filter((p) => p.found);
      const missing = probe.filter((p) => !p.found && p.status === 404);
      /* Real in Kylas but absent from the list we joined against. */
      const unlisted = real.filter((p) => !p.inCachedList);

      const search = kylas.lastCompanySearch?.() || {};
      /* 10,000 on the nose is a ceiling, not a count. Worth naming, because the
         crawl stops there of its own accord — the page comes back short, `full`
         goes false and `truncated` stays FALSE, so nothing warned. */
      const atCeiling = kylasIds.length === 10000;

      return {
        airtable: {
          companyRows: rows.length,
          withKylasId: withId.length,
          blankKylasId: rows.length - withId.length,
          sampleIds: withId.slice(0, 5),
          sampleNames: rows.slice(0, 5).map((r) => r.fields.Name || "(no name)"),
          anyRank: rows.filter((r) => Number(r.fields["KPI Rank"] || 0) > 0).length,
        },
        kylas: {
          companiesCached: kylasIds.length,
          cachedAgeSeconds: hit ? Math.round((Date.now() - hit.at) / 1000) : null,
          sampleIds: kylasIds.slice(0, 5),
          pagesCrawled: search.pages ?? null,
          hitOurCap: !!search.truncated,
          atTenThousandCeiling: atCeiling,
        },
        probe,
        matching: overlap.length,
        ...(fieldWarning ? { fieldWarning } : {}),
        verdict: !rows.length
          ? "Airtable has NO company rows. A contact saved with no companyId writes none — check the save log."
          : !withId.length
            ? "Airtable has company rows but none carry a Kylas Company ID, so nothing can join."
            : !kylasIds.length
              ? "Nothing cached from Kylas yet — open the dashboard once, then call this again."
              : overlap.length
                ? `${overlap.length} company/companies join. The dashboard should show them.`
                /* Ordered by what each case costs to fix. A real id that is not in
                   the list is OUR bug; an id Kylas has never heard of is a data
                   fault at the write end. */
                : unlisted.length
                  ? `The ids are REAL — Kylas returned ${unlisted.length} of ${probe.length} sampled, e.g. ${
                      unlisted[0].id} "${unlisted[0].name}". They are missing from the ${
                      kylasIds.length}-company list the dashboard joins against${
                      atCeiling ? ", which stopped at exactly 10,000 — a ceiling, not the end of your account"
                                : search.truncated ? ", which stopped at our page cap" : ""
                    }. The join is fine; the Kylas side of it is incomplete.`
                  : missing.length === probe.length
                    ? `Kylas has never heard of these ids — all ${probe.length} sampled returned 404, e.g. ${
                        probe[0].id}. They were written by a console pointed at a different account (the mock, or another Kylas tenant), so the rows are stale test data.`
                    : `Sampled ${probe.length} ids: ${real.length} exist in Kylas, ${
                        missing.length} do not. Mixed, so check the write path — the probe list says which is which.`,
      };
    },

    /* The same numbers by day, by week or by month.
       Built from the two append-only tables rather than from Daily Snapshot: a
       snapshot only exists for days the cron ran and cannot be cut finer than a
       day, whereas Call Log and Stage Transitions are a complete history from the
       first save. See scripts/report.mjs. */
    /* ── the BD ladder app ───────────────────────────────────────────────
       One request, everything four screens need. The app holds the Kylas key
       nowhere and talks only to this, the same rule the console follows.

       The rung DATES come from report.mjs's firstArrivals — the same derivation
       the Progress table counts, read as dates instead of as totals. Deriving
       them a second time in the app would be two answers to one question, which
       is the bug this repo has paid for twice. */
    "/ladder": async (url) => {
      if (!airtable) return { error: "Airtable is not configured", companies: [], configured: false };
      return ladderData({ fresh: !!url.searchParams.get("fresh") });
    },

    /* A BD picking an account, or dropping it with a reason. */
    /* GET: every company's list status, { focus: { kylasId: {...} } }, for
       the console's Focus lists and the ★ on the call card. POST sets one. */
    "/focus": async (_url, body) => {
      if (!body || !Object.keys(body).length) {
        if (!airtable) return { configured: false, focus: {} };
        return { configured: true, focus: await readFocus(airtable) };
      }
      if (!airtable) throw Object.assign(new Error("Airtable is not configured, so there is nowhere to record this"), { status: 503 });
      const status = String(body.status || "");
      if (!["focus", "normal", "depri"].includes(status))
        throw Object.assign(new Error(`unknown focus status ${JSON.stringify(status)}`), { status: 400 });
      if (!body.companyId)
        throw Object.assign(new Error("companyId is required"), { status: 400 });
      const res = await writeFocus(airtable, {
        companyId: body.companyId, companyName: body.companyName || "",
        status, reason: body.reason || "", note: body.note || "",
        ownerName: body.ownerName || "", setBy: body.setBy || "",
        previous: body.previous || "normal",
      });
      log(`focus ${body.companyId} -> ${status}${body.reason ? ` (${body.reason})` : ""}`);
      return { ok: true, ...res };
    },

    /* GET ?companyId= reads one company's research (the call card's
       Research block); POST writes it. */
    "/research": async (url, body) => {
      const askId = url.searchParams.get("companyId");
      if (askId && !body?.companyId) {
        if (!researchAt) return { configured: false, research: null };
        try {
          const got = await curatedResearch(askId);
          return { configured: true, base: RESEARCH_BASE, table: RESEARCH_TABLE, ...got,
                   url: got.recordId ? `https://airtable.com/${RESEARCH_BASE}/${encodeURIComponent(RESEARCH_TABLE)}/${got.recordId}` : "" };
        } catch (e) {
          /* The usual cause: the token was made for the KPI base only. */
          const denied = /40[134]|permission|not ?found|NOT_AUTHORIZED|INVALID_PERMISSIONS/i.test(e.message);
          return { configured: true, error: denied
            ? "The server's Airtable token cannot read the Company Database base. In Airtable → Developer hub → your token, add that base (read access is enough)."
            : e.message.slice(0, 200) };
        }
      }
      if (!airtable) throw Object.assign(new Error("Airtable is not configured, so there is nowhere to record this"), { status: 503 });
      if (!body.companyId)
        throw Object.assign(new Error("companyId is required"), { status: 400 });
      const { dropped } = await writeResearch(airtable, body.companyId, body.companyName || "",
                                              body.values || {}, body.updatedBy || "");
      if (dropped?.length) log(`! this base has no Research.${dropped.join(", Research.")} — run repair-base.mjs`);
      log(`research saved for ${body.companyId}`);
      return { ok: true, dropped: dropped || [] };
    },

    "/report": async (url) => {
      if (!airtable) return { error: "Airtable is not configured", periods: [] };
      const period = ["day", "week", "month", "quarter", "year"].includes(url.searchParams.get("period"))
        ? url.searchParams.get("period") : "week";
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      /* CAREFUL: /companies filters on an owner ID (Kylas), this filters on an
         owner NAME (Airtable's Owner column holds the name the writer put there).
         Passing an id straight through here matched nothing and would have shown
         an associate an empty report while telling them it was theirs. */
      const askedId = await scopeOwner(url.searchParams.get("owner"));
      const owner = askedId === "all" ? "all"
        : (owners.get(String(askedId)) || (await ownerName(askedId)) || userName(await whoami()) || "");

      /* THE FOUR TABLES, READ ONCE FOR EVERY PERIOD AND EVERY OWNER.
         None of this depends on the period, the date window or who is asking —
         those are all filters applied below, in memory, over the same rows. It
         was being re-read on every request anyway, so switching Week to Month
         re-paid a crawl of the whole call log for numbers already in hand.
         ?fresh=1 is the Refresh button; a save drops the cache, so the next
         dashboard open sees the call just logged. */
      const { calls, transitions, signals, team } =
        await reportData({ fresh: !!url.searchParams.get("fresh") });
      const counts = counter(team);
      /* Filled below, once calls/transitions/signals all exist — an earlier
         version declared it here and read it before anything had been pushed
         into it, so the list of people left out was always empty and the funnel
         shrank with nothing on screen saying why. */
      let excluded = [];
      const pick = (list) => {
        const byOwner = owner && owner !== "all"
          ? list.filter((x) => String(x.owner || "") === owner) : list;
        return owner === "all" && team.length ? byOwner.filter((x) => counts(x.owner)) : byOwner;
      };
      /* Every owner the data mentions, before the roster narrows it — so the
         console can NAME who was left out rather than silently shrinking. */
      if (owner === "all" && team.length)
        excluded = [...new Set([...calls, ...transitions, ...signals]
          .map((x) => String(x.owner || "").trim())
          .filter((o) => o && !counts(o)))].sort();
      const out = withDeltas(report(period, { calls: pick(calls), transitions: pick(transitions),
                                              signals: pick(signals) }, { from, to }));
      log(`report ${period} ${out.from}..${out.to} — ${out.periods.length} period(s), ` +
          `${out.totals.calls} call(s)`);
      /* WHICH PERIOD THIS ACTUALLY IS. An older proxy silently falls back to
         "week" for a period it has never heard of, and a console that assumed it
         got what it asked for then computed a drill-down window from week keys as
         if they were years — "2026-NaN-0 to 2026-NaN-N". Saying so lets the
         caller notice the mismatch instead of rendering nonsense. */
      return { ...out, period, team, excluded };
    },

    /* The frozen daily numbers, for the trend chart. Read from Airtable, which
       is where the day/week/month history lives — the browser's own snapshots
       only hold call outcomes, not the company-level funnel, so a conversion
       trend cannot be computed locally. */
    "/snapshots": async (url) => {
      if (!airtable) return { snapshots: [], reason: "Airtable is not configured" };
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") || 60)));
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const rows = await airtable.list("Daily Snapshot", `IS_AFTER({Date}, '${since}')`, 400);
      const snapshots = rows.map((r) => r.fields)
        .filter((f) => f.Date)
        .sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
      log(`snapshots since ${since} — ${snapshots.length}`);
      return { snapshots, since };
    },

    /* Session mode: everything this owner holds, ordered in the browser. */
    "/queue": async (url) => {
      const me = await whoami();
      const owner = url.searchParams.get("owner") || me?.id;
      /* Airtable stores the owner's NAME, Kylas answers by id — the same trap
         that made /report show an associate an empty week labelled as theirs. */
      const name = owners.get(String(owner)) || (await ownerName(owner)) || userName(me) || "";
      const held = await fromAirtable("queue", () => readQueue(airtable, name));
      if (held) {
        log(`queue for ${name || owner} — ${held.length} contact(s) from Airtable`);
        return { owner: String(owner), contacts: held, owners: ownerList(), source: "airtable" };
      }
      const contacts = await perKey(queueFromKylas, `kylas-queue:${owner}`,
        async () => mapContacts(await kylas.contactsForOwner(owner)))();
      log(`queue for owner ${owner} — ${contacts.length} contact(s) from Kylas`);
      return { owner: String(owner), contacts, owners: ownerList(), source: "kylas" };
    },

    /* One save from the console becomes up to three Kylas calls. Ordered so that
       a failure part-way leaves the contact correct rather than half-written:
       the record first, then its call log. */
    /* A save, answered once it is SAFE rather than once it is DONE — see
       save-queue.mjs. Only for a console that says it understands the reply
       ({queue: true}); an older build still gets the save carried out before
       the answer, because it needs the Kylas id back in that answer. */
    "/save": async (url, body) => {
      if (!saves || !body.queue) return performSave(body);
      const raw = body.contact;
      if (!raw) throw Object.assign(new Error("contact is required"), { status: 400 });
      /* Checked here, before queueing, so a value Kylas would refuse is
         refused NOW — with the field named — rather than minutes later. */
      const gate = checkContact(raw, { allowNoPhone: !!raw.kid });
      if (!gate.ok) {
        const blocking = gate.problems.filter((p) => p.blocking);
        log(`! /save rejected ${raw.pocName || raw.kid}: ` + blocking.map((p) => p.why).join("; "));
        throw Object.assign(new Error(blocking.map((p) => p.why).join("; ")), { status: 422, problems: gate.problems });
      }
      /* Saves of one contact run in order, one at a time. The console's local
         id is the one name a contact has from its first save to its last. */
      const key = raw.lid ? `lid:${raw.lid}` : raw.kid ? `kid:${raw.kid}`
        : `poc:${(raw.pocName || "").trim().toLowerCase()}|${((raw.phones || [])[0]?.value || "").replace(/\D/g, "")}`;
      const { queue: _q, ...job } = body;
      const id = await saves.enqueue(key, job);
      inFlight(saves.run(id, performSave));
      log(`save queued ${id} for ${raw.pocName || raw.kid || "?"}`);
      return { queued: true, job: id, kid: raw.kid || null };
    },

    /* Where queued saves stand: done (with the result a direct save would
       have returned), still queued (with when it tries again), or dead (with
       why). The console asks until each of its saves is settled. */
    "/save-status": async (url) => {
      if (!saves) return { jobs: {} };
      const ids = String(url.searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter(Boolean);
      return { jobs: await saves.status(ids) };
    },

    /* ── RCA ────────────────────────────────────────────────────────────
       WHICH ACCOUNTS OWE AN EXPLANATION, and the reasons on offer, in one
       response. The console renders what it is given rather than deciding who is
       overdue: the rule is a management policy, and a policy that lives in six
       browsers is six policies.

       Airtable only. There is no Kylas fallback because there is nothing in Kylas
       to fall back to — it holds no rung history, which is the whole reason the
       mirror exists. An unconfigured base answers "nothing due", which is honest:
       without the data, nothing is known to be overdue. */
    "/rca": async (url) => {
      if (!airtable) return { due: [], gates: RCA_GATES, configured: false };
      const owner = url.searchParams.get("owner") || "";
      const due = await readRcaDue(airtable, { owner, log });
      return { due, gates: RCA_GATES, configured: true, owner };
    },

    "/rca-answer": async (url, body) => {
      if (!airtable) throw Object.assign(new Error("Airtable is not configured, so there is nowhere to record this"), { status: 503 });
      const gate = RCA_GATE[body.gate];
      /* A gate or a reason this build has never heard of is a console running
         older code than the proxy. Taking it would write a value the Airtable
         column cannot hold, and the 422 would name the field rather than the
         cause. */
      if (!gate) throw Object.assign(new Error(`unknown gate: ${body.gate}`), { status: 400 });
      if (!gate.reasons.some((r) => r.code === body.reason))
        throw Object.assign(new Error(`${body.reason} is not a reason offered for ${gate.key}`), { status: 400 });
      if (!body.kid) throw Object.assign(new Error("kid is required"), { status: 400 });
      const rec = await writeRcaAnswer(airtable, {
        key: `${body.kid}|${gate.key}`,
        kid: String(body.kid), recordId: body.recordId || "", gate: gate.key,
        reason: body.reason, note: body.note || "",
        since: body.since || "", days: Number(body.days),
        owner: body.owner || "", by: body.by || body.owner || "",
      });
      log(`rca: ${body.kid} ${gate.key} -> ${body.reason}`);
      return { ok: true, id: rec?.id || null };
    },

    /* ── the team roster ────────────────────────────────────────────────
       Who the funnel counts. The candidate names are everyone the base has ever
       recorded as an owner, so the panel is a list to tick rather than a form to
       type names into — a typed name that does not match the Owner column
       exactly would silently count for nobody. */
    "/team": async () => {
      if (!airtable) return { team: [], owners: [], configured: false };
      /* CANDIDATES FROM THE SAME POPULATION THE REPORT COUNTS. Reading only the
         Companies table missed anyone who owns contacts but no company — which on
         this fixture is one of two people, and on a real base is anyone who has
         been called for rather than allotted to. A roster that cannot offer you a
         name is a roster that cannot exclude them either. */
      const [team, companies, contacts] = await Promise.all([
        readTeam(airtable),
        readCompanies(airtable).catch(() => []),
        listTolerant(airtable, "Contacts", { fields: ["Owner"], pageSize: 100, maxPages: 200 })
          .catch(() => []),
      ]);
      const seen = new Set(companies.map((c) => c.owner).filter(Boolean));
      for (const r of contacts) if (r.fields?.Owner) seen.add(String(r.fields.Owner).trim());
      for (const p of team) seen.add(p.name);
      return { team, owners: [...seen].sort(), configured: true };
    },

    "/team-save": async (url, body) => {
      if (!airtable) throw Object.assign(new Error("Airtable is not configured, so there is nowhere to keep the roster"), { status: 503 });
      if (!Array.isArray(body.team)) throw Object.assign(new Error("team must be an array"), { status: 400 });
      await writeTeam(airtable, body.team);
      const team = await readTeam(airtable);
      log(`team: ${team.filter((p) => p.inFunnel).length} of ${team.length} in the funnel`);
      return { ok: true, team };
    },

    /* Whether each half of the write is configured, so the console can say so
       rather than looking like it saved everywhere. */
    "/targets": async () => ({ kylas: true, airtable: !!airtable, base: AT_BASE || null }),

    "/contact": async (url) => {
      const id = url.searchParams.get("id");
      if (!id) throw Object.assign(new Error("id is required"), { status: 400 });
      const held = await fromAirtable("contact " + id, () => readContact(airtable, id));
      if (held) { log(`contact ${id} from Airtable`); return { contact: held, source: "airtable" }; }
      const c = await kylas.contact(id);
      log(`contact ${id} from Kylas`);
      return { contact: toConsoleContact(c, { ownerName: await ownerName(c?.ownerId) }),
               raw: c, source: "kylas" };
    },
  };
  /* Where the copies stand — how old, how many rows — for a person checking
     that the scheduled job is doing its work. */
  routes["/cache-status"] = async () => ({
    mirror: mirror ? await mirror.status() : null,
    kylasCompaniesAgeSeconds: await kylasCompanies.age(),
    syncedAt: (await syncState())?.at || null,
    saves: saves ? await saves.backlog() : null,
  });

  /* THE SCHEDULED UPKEEP, every few minutes. Everything a request would
     otherwise wait for is done here instead: the D1 copy of Airtable built,
     rebuilt or topped up (mirror.mjs), and the Kylas company crawl refreshed
     while the console is in use. `rebuild` after a job that rewrote tables
     behind this server's back — the nightly sync, the weekly rollup. */
  async function maintain({ rebuild = false, only = null } = {}) {
    const out = {};
    if (cache) await cache.put("maintain-last-run", String(Date.now()), { ttlSeconds: 30 * 86400 }).catch(() => {});
    /* Saves first: a retry waiting here is a call an associate logged. */
    /* ONE BIG PIECE OF WORK PER RUN. Cloudflare caps the outside requests
       one invocation may make (50 on the Free plan, 1,000 or more on Paid),
       and a table rebuild or a Kylas crawl can each be a few hundred. So a run
       does at most one of them; the next run, a minute later, does the
       next. Nothing waits on these — readers are served the copy in hand. */
    if (saves) out.saves = await saves.drain(performSave, { max: 15 }).catch((e) => ({ error: e.message }));
    if (rebuild) {
      /* After the nightly sync or rollup: mark, do not rebuild here — the job
         that just ran has already spent this invocation's allowance. */
      if (mirror) await mirror.markStale(only).catch((e) => log(`! mirror: ${e.message}`));
      await syncShared({ fresh: true }).catch(() => {});
      return out;
    }
    const age = await kylasCompanies.age();
    const readAt = Number((cache && (await cache.get("companies-read-at").catch(() => null))) || 0);
    const wantFresh = !!(cache && (await cache.get("companies-want-fresh").catch(() => null)));
    /* Only while the list is being served FROM Kylas — once the base is
       synced the list comes from the D1 copy and this crawl would be waste. */
    const wantCrawl = Date.now() - readAt < 2 * 3600 * 1000 &&
      (wantFresh || age === null || age * 1000 > COMPANY_TTL);
    const crawl = async () => {
      /* One crawl at a time. It can outlast the minute between runs, and a
         second one started beside it would double the load on Kylas for the
         same answer. Held in the store with an expiry, so a crawl that died
         does not block the next for longer than five minutes. */
      if (cache) {
        if (await cache.get("companies-crawl-lease").catch(() => null)) { out.kylasCompanies = { skipped: "a crawl is already running" }; return; }
        await cache.put("companies-crawl-lease", String(Date.now()), { ttlSeconds: 300 }).catch(() => {});
      }
      try { await crawlNow(); } finally { if (cache) await cache.delete("companies-crawl-lease").catch(() => {}); }
    };
    const crawlNow = async () => {
      if (wantFresh) await cache.delete("companies-want-fresh").catch(() => {});
      const got = await kylasCompanies({ fresh: true }).catch((e) => ({ error: e.message }));
      out.kylasCompanies = got.error ? { error: got.error } : { companies: got.companies.length };
      /* Kept for the console's "still building" message. */
      if (cache) {
        if (got.error) await cache.put("companies-crawl-error",
          JSON.stringify({ message: got.error.slice(0, 300), at: new Date().toISOString() }), { ttlSeconds: 7 * 86400 }).catch(() => {});
        else await cache.delete("companies-crawl-error").catch(() => {});
      }
    };
    /* A company list that does not exist yet, or that somebody asked to
       refresh, comes first: without it the console has nothing to show,
       whereas a table not yet copied is still read straight from Airtable. */
    if (wantCrawl && (age === null || wantFresh)) { await crawl(); return out; }
    if (mirror && rawAirtable) out.mirror = await mirror.maintain(rawAirtable, { only, maxBuilds: 1 });
    const built = (out.mirror || []).some((r) => r.rows !== undefined);
    if (wantCrawl && !built) await crawl();
    return out;
  }

  return { routes, version: VERSION, startedAt: STARTED, maintain,
           building: () => [...building, ...(mirror ? mirror.pending() : [])] };
}
