/* Kylas client: queueing, retries, and the mapping between their record shapes
   and the console's. Shared by the proxy and any script that needs it. */
import { STAGE_ID } from "./stages.mjs";
import { splitPhone, ISO_OF, checkEmail, splitName, e164 } from "./fields.mjs";

/* SETTINGS COME FROM THE CALLER, WITH process.env AS THE FALLBACK — and the
   fallback is written defensively because `process` does not exist in every
   runtime this now has to load in. Reading it at module scope was fine while
   the only caller was a Node script and is not fine now: on a hosted runtime
   the configuration arrives as an argument, and an unguarded process.env is
   either a ReferenceError or, worse, an empty object that silently sends the
   test suite at the real api.kylas.io. That is precisely what happened. */
const fromEnv = (name, fallback) => {
  try {
    const v = typeof process !== "undefined" && process?.env ? process.env[name] : "";
    return v === undefined || v === "" ? fallback : v;
  } catch { return fallback; }
};

const CODE_BY_ID = Object.fromEntries(Object.entries(STAGE_ID).map(([code, id]) => [String(id), code]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(key, {
  log = () => {}, shapeHint = "", onShape = () => {},
  base = fromEnv("KYLAS_BASE", "https://api.kylas.io"),
  /* Kylas throttles hard — a burst of 8 drew three 429s and even sequential
     calls a few hundred ms apart were refused. Everything funnels through one
     queue, this far apart. */
  gap = Number(fromEnv("KYLAS_GAP", 450)),
  maxPages = Number(fromEnv("KYLAS_MAX_PAGES", 60)),         /* 12,000 companies */
  maxWindows = Number(fromEnv("KYLAS_MAX_WINDOWS", 200)),
} = {}) {
  const BASE = base;
  const GAP = gap;
  const STUCK_MS = 60_000;
  let chain = Promise.resolve();

/* A rejected promise must not stay in the chain: `chain.then(...)` off a
   rejected chain rejects with the ORIGINAL error, so one failed request would
   make every later one fail with the same stale message for the life of the
   process. The chain keeps only the timing, never the outcome. */
  /* The gap is measured from the previous request, not slept before every
     one. Sleeping first cost a full gap on the FIRST request of every cold
     instance — on a hosted runtime that is most requests — to space it from a
     request that never happened. */
  let last = 0;
  const call = (method, path, body) => {
    const run = chain.then(() => {
      const wait = last + GAP - Date.now();
      return wait > 0 ? sleep(wait) : null;
    }).then(() => { last = Date.now(); return attempt(method, path, body); });
    /* Not for ever — see the same line in airtable.mjs. */
    chain = Promise.race([run.then(() => {}, () => {}), sleep(STUCK_MS)]);
    return run;
  };

  async function attempt(method, path, body, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "api-key": key, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        /* A request that never answers must fail, not hang: the retry logic and
           the save journal know what to do with a failure. */
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.status === 429) {
        const wait = 1200 * 2 ** i;
        log(`429 on ${path}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
    const err = new Error(`${method} ${path} -> still rate limited after ${tries} tries`);
    err.status = 429;
    throw err;
  }

  const rows = (o) => (Array.isArray(o) ? o : o?.content || o?.data || []);

  /* The search fields the console actually needs. */
  /* Search returns ONLY what is asked for, so anything missing here comes back
     blank in the console even though Kylas holds it. */
  /* Search returns ONLY what is asked for, so anything missing here comes back
     blank in the console even though Kylas holds it. metaData carries the
     id -> name map for every lookup on the record, which is where company and
     owner names come from. */
  const CONTACT_FIELDS = ["id", "firstName", "lastName", "salutation", "ownerId",
    "company", "companyName", "designation", "department", "emails", "phoneNumbers",
    "linkedin", "remarks", "customFieldValues", "metaData", "createdAt", "updatedAt"];

  /* Same rule as contacts: search returns only what it is asked for, and
     metaData carries the owner id -> name map so the list can show an owner
     without a request per company. */
  const COMPANY_FIELDS = ["id", "name", "ownerId", "website", "phoneNumbers", "emails",
    "customFieldValues", "metaData", "createdAt", "updatedAt"];
  /* Exactly what the probe proved this endpoint returns, plus metaData for the
     owner name. Anything beyond this is what the 500 is suspected to be about. */
  const COMPANY_LEAN = ["id", "name", "ownerId", "customFieldValues", "metaData"];

  /* The schema calls company and ownerId LOOK_UP, but the query builder rejects
     that and wants "long". Confirmed live — see docs/kylas-picklists.md. */
  const rule = (field, value, type = "long", operator = "equal") =>
    ({ condition: "AND", valid: true,
       rules: [{ id: field, field, type, input: "select", operator, value }] });

  /* The shape /v1/search/company will accept, discovered at runtime.
     Ordered cheapest-and-most-useful first: a server-side owner filter with
     the full field list, then progressively less, ending at "ask for the bare
     minimum and filter in memory". Each entry says whether the server did the
     filtering, because if it did not we must do it ourselves or every associate
     sees the whole account. */
  const freeText = (v = "") => ({ condition: "AND", valid: true, rules: [
    { id: "multi_field", field: "multi_field", type: "multi_field",
      input: "multi_field", operator: "multi_field", value: v }] });

  const COMPANY_SHAPES = [
    { name: "ownerId/long + full fields",
      body: (o) => ({ fields: COMPANY_FIELDS, jsonRule: rule("ownerId", o) }), filtered: true },
    { name: "ownerId/long + lean fields",
      body: (o) => ({ fields: COMPANY_LEAN, jsonRule: rule("ownerId", o) }), filtered: true },
    { name: "ownerId/integer + lean fields",
      body: (o) => ({ fields: COMPANY_LEAN, jsonRule: rule("ownerId", o, "integer") }), filtered: true },
    /* Proven by the probe on 2026-09-16, so it is the reliable floor. It cannot
       filter, hence filtered:false. */
    { name: "free-text + lean fields, filtered here",
      body: () => ({ fields: COMPANY_LEAN, jsonRule: freeText("") }), filtered: false },
    { name: "lean fields, no rule",
      body: () => ({ fields: COMPANY_LEAN }), filtered: false },
  ];
  /* Remembered once one works. A hint from the caller lets a restarted proxy
     skip the probe entirely: three shapes fail on this account and each costs
     a full rate-limit gap, so the probe alone was 1.35s of every cold start
     after the first ever run. */
  let companyShape = shapeHint ? COMPANY_SHAPES.find((s) => s.name === shapeHint) || null : null;
  if (companyShape) log(`company search: using remembered shape "${companyShape.name}"`);

  /* PAGINATED. One page of 200 was not "the companies allotted to you", it was
     "the 200 most recently updated companies in the account" — and when the
     winning shape cannot filter server-side, the owner filter then ran over
     just those 200. On an account with 250+ companies that showed 19 of
     Arshdeep's and silently dropped the rest. Keep asking until a short page
     comes back. */
  const PAGE = 200;
  /* Raised from 25 on 2026-09-18. Ayush's account paged the full 25 and logged
     "5000 across 25 page(s)" — which is exactly MAX_PAGES × PAGE, so the crawl
     stopped at the CAP and not at the end of the data. Every owner count was
     then computed over a list that might have been missing companies, and
     nothing said so. The cap is a stop against a runaway loop, so it stays;
     hitting it is now reported as the incomplete answer it is. */
  const MAX_PAGES = maxPages;

  /* What the last crawl did, for the proxy to pass on. A truncated list is not
     an error — it is a correct prefix of a wrong length — so it travels
     alongside the rows rather than as an exception. */
  let lastSearch = { pages: 0, total: 0, truncated: false };

  /* ── past the result window, by updatedAt ──────────────────────────────
     Offset paging cannot reach beyond the endpoint's result window: ask for
     page 50 and it returns a short page while still reporting a larger total.
     No number of pages helps, because the limit is on the OFFSET.

     Timestamps have no such limit. The search is already sorted updatedAt
     descending, so once the offset crawl runs out we take the oldest record we
     hold and ask for the ones older than that. Each window starts again at
     offset 0, so the ceiling is never approached. This is keyset pagination:
     the cursor is a value in the data, not a position in a list.

     Which rule expresses "updatedAt < X" is not documented for this endpoint,
     so it is discovered the same way the search shape was. */
  const boundRule = (iso, { field = "updatedAt", type = "date", operator = "less", value = iso } = {}) =>
    ({ condition: "AND", valid: true,
       rules: [{ id: field, field, type, input: "text", operator, value }] });

  const BOUND_SHAPES = [
    { name: "updatedAt/date less", body: (iso) => boundRule(iso) },
    { name: "updatedAt/datetime less", body: (iso) => boundRule(iso, { type: "datetime" }) },
    { name: "updatedAt/string less", body: (iso) => boundRule(iso, { type: "string" }) },
    { name: "updatedAt/long less (epoch ms)",
      body: (iso) => boundRule(iso, { type: "long", value: String(Date.parse(iso)) }) },
  ];
  const boundShapeFor = new Map();   /* entity -> shape, discovered once each */

  const stamp = (c) => Date.parse(c?.updatedAt ?? c?.updatedAt ?? 0) || 0;

  /* THE DANGEROUS FAILURE IS NOT REJECTION, IT IS INDIFFERENCE.
     A rule the server does not understand may come back 400 — fine, try the
     next. But it may equally come back 200 having ignored the rule, and then
     every window returns the same newest rows forever: an infinite loop that
     looks like progress, or a "complete" list that is the first page repeated.
     So a shape only counts as working when the rows it returns are ACTUALLY
     older than the bound. Accepting a 200 as proof would have been the bug. */
  async function findBoundShape(iso, ownerId, fields, entity = "company") {
    const cut = Date.parse(iso);
    for (const s of BOUND_SHAPES) {
      try {
        const body = await call("POST", page(0, entity), { fields, jsonRule: s.body(iso) });
        const got = rows(body);
        if (!got.length) {           /* nothing older: honoured, and we are done */
          log(`${entity} window: "${s.name}" works (empty beyond the bound)`);
          return s;
        }
        const newest = Math.max(...got.map(stamp));
        if (newest >= cut) {
          log(`${entity} window: "${s.name}" returned 200 but IGNORED the bound ` +
              `(newest row is not older) — not usable`);
          continue;
        }
        log(`${entity} window: "${s.name}" works`);
        return s;
      } catch (e) {
        if (![400, 404, 500].includes(e.status)) throw e;
        log(`${entity} window: "${s.name}" -> ${e.status}, trying the next`);
      }
    }
    return null;
  }

  /* Walk backwards from `fromISO`, newest-first, a window at a time. Returns
     the extra rows; the caller owns de-duplication. */
  async function crawlOlderThan(fromISO, ownerId, fields, haveIds, entity = "company") {
    const MAX_WINDOWS = maxWindows;
    let boundShape = boundShapeFor.get(entity);
    if (boundShape === undefined) {
      boundShape = await findBoundShape(fromISO, ownerId, fields, entity);
      boundShapeFor.set(entity, boundShape);
    }
    if (!boundShape) {
      log(`! ${entity} window: no rule expresses "updatedAt <" on this account — ` +
          `the list stays short. The rest must be fetched by id.`);
      return { extra: [], windows: 0, stalled: false, usable: false };
    }

    const extra = [];
    /* INCLUSIVE OF THE BOUNDARY, deliberately. The obvious cursor is "older
       than the oldest row I hold", and it is wrong: every record sharing that
       exact timestamp is then excluded for ever. On a mock where 600 companies
       carried one timestamp it dropped 300 of them outright.
       Asking for < (oldest + 1ms) is the same as <= oldest without needing a
       second operator the endpoint may not have. The boundary row comes back
       once more per window and de-duplication drops it — one redundant row,
       against silently losing every tie. */
    const after = (ms) => new Date(ms + 1).toISOString();
    let cursorMs = Date.parse(fromISO), windows = 0, stalled = false;
    while (windows < MAX_WINDOWS) {
      let got;
      try {
        got = rows(await call("POST", page(0, entity),
                              { fields, jsonRule: boundShape.body(after(cursorMs)) }));
      } catch (e) {
        log(`! ${entity} window: ${e.message} — stopping with ${extra.length} extra`);
        break;
      }
      windows++;
      if (!got.length) break;                       /* reached the far end */

      const fresh = got.filter((c) => !haveIds.has(String(c.id)));
      for (const c of fresh) { extra.push(c); haveIds.add(String(c.id)); }

      const stamps = got.map(stamp).filter(Boolean);
      const oldest = stamps.length ? Math.min(...stamps) : 0;

      /* NO PROGRESS IS A STOP, NOT A RETRY. Either every row was already held,
         or the cursor did not move: both mean the next request returns this
         same page, for ever. The cause is more records sharing one updatedAt
         than a page can carry, and no cursor of this kind can walk past it —
         so say so and leave the shortfall reported rather than spinning. */
      if (!fresh.length || !oldest || oldest >= cursorMs) {
        stalled = true;
        log(`! ${entity} window: no progress at ${new Date(cursorMs).toISOString()} — ` +
            `${got.length} row(s), ${fresh.length} new. More records share one ` +
            `updatedAt than a page holds; they cannot be walked this way.`);
        break;
      }
      cursorMs = oldest;
      /* A window shorter than a page is the end of the data, not of a page. */
      if (got.length < PAGE) break;
    }
    if (windows >= MAX_WINDOWS)
      log(`! ${entity} window: stopped at KYLAS_MAX_WINDOWS (${MAX_WINDOWS})`);
    if (extra.length) log(`${entity} window: +${extra.length} across ${windows} window(s)`);
    return { extra, windows, stalled, usable: true };
  }

  async function searchCompany(size, ownerId) {
    const mine = (list) => (ownerId == null ? list
      : list.filter((c) => Number(c.ownerId ?? c.owner?.id) === Number(ownerId)));

    /* Settle the shape on page 0, then reuse it for the rest. The remembered
       shape goes first and the rest stay behind it: a hint from a previous run
       is a shortcut, never a commitment, so a stale hint (a different account,
       or Kylas fixing the endpoint) costs one failed call rather than the whole
       view. */
    /* A shape that filters server-side cannot be used when there is nobody to
       filter BY. With ownerId null it would send a rule asking for owner
       "null" and Kylas answers with an empty page — so the Everyone view came
       back empty rather than with the account. It is masked on this account
       today only because those three shapes 500 here anyway; the day Kylas
       fixes that endpoint the team dashboard would silently go blank. */
    const usable = ownerId == null ? COMPANY_SHAPES.filter((s) => !s.filtered) : COMPANY_SHAPES;
    const tries = companyShape && usable.includes(companyShape)
      ? [companyShape, ...usable.filter((s) => s !== companyShape)]
      : usable;
    let shape = null, first = null, last, reportedTotal = null;
    for (const s of tries) {
      try {
        /* KEEP THE ENVELOPE, not just the rows. Kylas states how many records
           matched, in totalElements, and we were throwing it away — so the one
           number that says whether our list is complete was discarded on every
           crawl. Ayush's dashboard read "10000 of 10000" while his account
           plainly held more, and nothing could contradict it. */
        const body = await call("POST", page(0), s.body(ownerId));
        first = rows(body);
        const t = Number(body?.totalElements ?? body?.total ?? NaN);
        reportedTotal = Number.isFinite(t) ? t : null;
        if (companyShape !== s) { log(`company search: "${s.name}" works`); onShape(s.name); }
        companyShape = shape = s;
        break;
      } catch (e) {
        last = e;
        /* Only a rejected REQUEST is worth trying another shape for. A 401, a
           429 or a network failure says nothing about the body, and retrying
           four variants would just spend the rate limit. */
        if (![400, 404, 500].includes(e.status)) throw e;
        log(`company search: "${s.name}" -> ${e.status}, trying the next shape`);
      }
    }
    if (!shape) throw new Error(`/v1/search/company rejected every known shape. Last: ${last?.message}`);

    const all = [...first];
    /* A page shorter than we asked for is the last one. */
    let pages = 1, full = first.length === PAGE;
    for (let p = 1; full && p < MAX_PAGES; p++) {
      const next = rows(await call("POST", page(p), shape.body(ownerId)));
      all.push(...next);
      pages++;
      full = next.length === PAGE;
      first = next;
    }
    /* THREE WAYS THE LIST CAN BE SHORT, and only one of them was detected.
         our cap   — still a full page when MAX_PAGES ran out
         their cap — the endpoint stops serving rows past a fixed offset while
                     still reporting the true match count. 10,000 is
                     Elasticsearch's default max_result_window and this endpoint
                     is search-backed, so the crawl ends on a short page and
                     `full` goes false: our own truncation check CANNOT see it.
         neither    — we really did reach the end
       totalElements settles it without another request. */
    let shortBy = reportedTotal != null ? reportedTotal - all.length : 0;

    /* SHORT, AND KYLAS SAYS SO. Continue by timestamp from the oldest record
       the offset crawl reached. Nothing is re-fetched — the offset pass already
       holds the newest `all.length`, and this picks up strictly older ones — so
       an account that fits under the window pays for none of this. */
    let windows = 0, windowStalled = false, windowUsable = null;
    if (shortBy > 0 && all.length) {
      const seenIds = new Set(all.map((c) => String(c.id)));
      const oldest = Math.min(...all.map(stamp).filter(Boolean));
      if (oldest) {
        log(`company search: ${shortBy} short of Kylas' own count — continuing by ` +
            `updatedAt from ${new Date(oldest).toISOString()}`);
        const r = await crawlOlderThan(new Date(oldest).toISOString(), ownerId,
                                       shape.body(ownerId).fields, seenIds);
        all.push(...r.extra);
        windows = r.windows; windowStalled = r.stalled; windowUsable = r.usable;
        shortBy = reportedTotal - all.length;
      } else {
        /* No usable timestamps means no cursor. Say so rather than looping. */
        log(`! company search: rows carry no updatedAt, so the window crawl has ` +
            `no cursor. The list stays ${shortBy} short.`);
      }
    }

    /* STILL SHORT: READ IT OLDEST-FIRST. The result window caps how FAR into
       one ordering the search will go, not which records it will return — so
       the same search sorted the other way serves the oldest 10,000. Together
       the two ends cover twice the window (20,000) with no filter rule at all.
       The updatedAt windows above can fail on an account whose search ignores
       the rule, or whose bulk-imported companies share one timestamp; this
       needs neither. On Ayush's account the windows added nothing and 7,926 of
       17,926 were missing — this is what closes that. */
    let reversePages = 0;
    if (shortBy > 0 && all.length) {
      log(`company search: still ${shortBy} short — reading the list oldest-first to reach the rest`);
      const seenIds = new Set(all.map((c) => String(c.id)));
      let rfull = true, added = 0;
      for (let p = 0; rfull && p < MAX_PAGES; p++) {
        const next = rows(await call("POST", page(p, "company", "asc"), shape.body(ownerId)));
        reversePages++;
        rfull = next.length === PAGE;
        let fresh = 0;
        for (const c of next) {
          if (seenIds.has(String(c.id))) continue;
          seenIds.add(String(c.id)); all.push(c); added++; fresh++;
        }
        /* A search that ignored the sort returns the newest again: nothing new
           on the first page means the other end is not reachable this way. */
        if (p === 0 && !fresh && next.length) {
          log(`! company search: the oldest-first read returned only companies already held — ` +
              `this account's search ignores the sort direction`);
          break;
        }
        if (reportedTotal != null && all.length >= reportedTotal) break;
      }
      shortBy = reportedTotal - all.length;
      log(`company search: oldest-first added ${added} across ${reversePages} page(s)` +
          (shortBy > 0 ? ` — still ${shortBy} short` : " — the list is complete"));
    }

    lastSearch = { pages, total: all.length, windows, windowStalled, windowUsable, reversePages,
                   reportedTotal,
                   short: shortBy > 0 ? shortBy : 0,
                   hitOurCap: full && pages >= MAX_PAGES,
                   /* Their ceiling, AFTER the window crawl has had its go. A
                      shortfall that the windows closed is not a truncation —
                      reporting one would put a warning on a complete list. */
                   hitTheirCeiling: shortBy > 0 && !(full && pages >= MAX_PAGES),
                   truncated: (full && pages >= MAX_PAGES) || shortBy > 0 };
    if (lastSearch.hitOurCap)
      log(`! company search STOPPED AT OUR CAP after ${pages} pages (${all.length} companies). ` +
          `Raise KYLAS_MAX_PAGES.`);
    if (lastSearch.hitTheirCeiling)
      log(`! company search: Kylas reports ${reportedTotal} companies but served only ` +
          `${all.length} — it stopped ${shortBy} short of its own count on a short page. ` +
          `A paged search cannot reach the rest; fetch them by id or by updatedAt window.`);
    if (all.length >= PAGE)
      log(`company search: ${all.length} across ${pages} page(s)` +
          (windows ? ` + ${windows} updatedAt window(s)` : ""));

    /* Server-side filtering is only trustworthy when the shape claims it. */
    const out = shape.filtered && ownerId != null ? all : mine(all);
    /* De-dupe: pages are sorted by updatedAt, and a record updated mid-scan can
       land on two of them. */
    const seen = new Set();
    return out.filter((c) => { const k = String(c.id); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /* Both searches page the same way and both meet the same result window, so
     the entity is a parameter rather than a second copy of the crawl. */
  const page = (n, entity = "company", dir = "desc") =>
    `/v1/search/${entity}?sort=updatedAt,${dir}&page=${n}&size=${PAGE}`;

  return {
    raw: call,
    me: () => call("GET", "/v1/users/me"),
    user: (id) => call("GET", `/v1/users/${id}`),
    company: (id) => call("GET", `/v1/companies/${id}`),

    async contactsForCompany(companyId, size = 100) {
      const r = await call("POST", `/v1/search/contact?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: CONTACT_FIELDS, jsonRule: rule("company", Number(companyId)) });
      return rows(r);
    },

    /* EVERY CONTACT CHANGED SINCE A MOMENT, newest first.
       The nightly sync wants a delta, and a delta needs no clever filter: the
       search is already sorted updatedAt descending, so page from the newest
       and stop at the first row older than the watermark. A normal night is a
       few hundred rows and never comes near the result window.

       The FIRST run has no watermark and therefore pages the lot, which does
       meet the window — so it continues by timestamp exactly as the company
       crawl does. Same code, different entity. */
    async contactsChangedSince(sinceISO, { onPage = () => {} } = {}) {
      const sinceMs = sinceISO ? Date.parse(sinceISO) : 0;
      const all = [];
      const seen = new Set();
      const older = (c) => sinceMs && (Date.parse(c?.updatedAt || 0) || 0) < sinceMs;

      let pages = 0, full = true, reportedTotal = null, reachedWatermark = false, scanned = 0;
      /* STOPPING EARLY IS ONLY SAFE IF THE SORT WAS HONOURED.
         "Page newest-first and stop at the first old row" is correct when the
         server sorts as asked, and silently lossy when it does not: one
         out-of-order row ends the scan and every changed record behind it is
         dropped. sort= is a request, not a guarantee — this endpoint has
         already been caught ignoring a filter it accepted — so the order is
         CHECKED on the rows as they arrive, and the early stop is given up the
         moment it does not hold. Slower, and it cannot lose anybody. */
      let sorted = true, prevStamp = Infinity;
      for (let p = 0; full && p < MAX_PAGES && !reachedWatermark; p++) {
        const body = await call("POST", page(p, "contact"),
                                { fields: CONTACT_FIELDS, jsonRule: freeText("") });
        const got = rows(body);
        if (p === 0) {
          const t = Number(body?.totalElements ?? body?.total ?? NaN);
          reportedTotal = Number.isFinite(t) ? t : null;
        }
        pages++;

        /* NEVER BREAK MID-PAGE. Checking the order as rows go by does not
           protect anything: the early stop fires on the FIRST old row, which
           on an unsorted list can be row one — before any disorder has been
           seen. A page is cheap and already paid for, so take all of it, and
           stop only when a WHOLE page turned out to be old. Local disorder
           then costs nothing, and a delta still stops after a page or two. */
        let kept = 0;
        scanned += got.length;
        for (const c of got) {
          const ts = stamp(c);
          if (ts > prevStamp) {
            if (sorted) log(`! contact search: results are NOT in updatedAt order — ` +
                            `scanning every page rather than trusting the sort`);
            sorted = false;
          }
          prevStamp = ts;
          if (older(c)) continue;
          kept++;
          const k = String(c.id);
          if (!seen.has(k)) { seen.add(k); all.push(c); }
        }
        onPage(all.length);
        full = got.length === PAGE;
        /* An entire page older than the watermark means the delta is behind us
           — but only if the order can be relied on at all. */
        if (sorted && sinceMs && got.length && kept === 0) reachedWatermark = true;
      }

      /* Only a FULL pull can be cut short by the window — a delta stops at the
         watermark long before it. */
      let windows = 0, stalled = false;
      /* SHORT BECAUSE THE SERVER RAN OUT, not because we filtered.
         The test used to be `all.length < reportedTotal`, and all.length is
         what survived the WATERMARK — so a delta of one contact out of four
         looked like a 3-record shortfall and set the window crawl off chasing
         records it had already decided it did not want. Rows SCANNED is the
         honest measure of what the endpoint actually served. */
      if (!reachedWatermark && reportedTotal != null && scanned < reportedTotal && all.length) {
        const oldest = Math.min(...all.map(stamp).filter(Boolean));
        if (oldest) {
          log(`contact search: ${reportedTotal - all.length} short — continuing by updatedAt`);
          const r = await crawlOlderThan(new Date(oldest).toISOString(), null,
                                         CONTACT_FIELDS, seen, "contact");
          /* A window may reach past the watermark; the caller asked for a
             delta, so honour it here too. */
          for (const c of r.extra) if (!older(c)) all.push(c);
          windows = r.windows; stalled = r.stalled;
        }
      }
      log(`contact search: ${all.length} changed` +
          (sinceISO ? ` since ${sinceISO}` : " (full)") +
          ` across ${pages} page(s)` + (windows ? ` + ${windows} window(s)` : ""));
      return { contacts: all, pages, windows, stalled, reportedTotal,
               complete: reachedWatermark || windows > 0 || !stalled };
    },

    /* ONE PAGE. This has always fetched page 0 and stopped, so an associate
       with more than `size` allotted contacts saw the newest `size` of them and
       nothing said otherwise — 100 of 402 in the fixture that caught it. The
       queue is moving to Airtable, which pages properly, so this is now the
       FALLBACK path; a fallback that is quietly short is worse than no
       fallback, so it says so. */
    async contactsForOwner(ownerId, size = 100) {
      const r = await call("POST", `/v1/search/contact?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: CONTACT_FIELDS, jsonRule: rule("ownerId", Number(ownerId)) });
      const out = rows(r);
      const total = Number(r?.totalElements ?? NaN);
      if (Number.isFinite(total) && total > out.length)
        log(`! queue from Kylas is ONE PAGE: ${out.length} of ${total} for owner ${ownerId}. ` +
            `The rest are not in it. Sync Airtable and read the queue from there.`);
      return out;
    },

    /* "Companies allotted to me" is the company's OWN owner field, not "a
       company where I own a contact" — confirmed by Ayush 2026-09-17. The two
       give different lists, and only this one shows a company that has been
       assigned but never worked.

       /v1/search/company is undocumented and brittle: asking for the same
       field list that works on contacts returns
       500 java.lang.NullPointerException. Rather than guess at the one true
       shape, try candidates in order and keep the first that answers — the
       same tactic the probe used to settle the contact-company filter. The
       winner is remembered, so this costs one extra request per process at
       most, and the log names it so it can be pinned later. */
    async companiesForOwner(ownerId, size = 200) {
      return searchCompany(size, Number(ownerId));
    },

    async companies(size = 200) {
      return searchCompany(size, null);
    },

    /* Which shape won, for the /companies?keys=1 diagnostic. */
    /* ── the user directory ──────────────────────────────────────────
       Kylas documents /v1/users/me, /v1/users/{id}, activate and deactivate —
       but NO list endpoint. So the same runtime fallback the company search
       needed: try the likely list shapes, and fall back to resolving the ids we
       already hold one at a time, which is documented and therefore certain.

       `ids` are owner ids already seen on companies and contacts, so the floor
       never has to guess who exists. */
    async users(ids = []) {
      const shapes = [
        { name: "GET /v1/users?page&size", go: () => call("GET", "/v1/users?page=0&size=200") },
        { name: "GET /v1/users", go: () => call("GET", "/v1/users") },
        { name: "POST /v1/search/user", go: () => call("POST", "/v1/search/user?page=0&size=200",
            { fields: ["id", "firstName", "lastName", "email", "active", "status"],
              jsonRule: { condition: "AND", valid: true, rules: [] } }) },
      ];
      for (const s of shapes) {
        try {
          const list = rows(await s.go());
          if (Array.isArray(list) && list.length) {
            log(`users: "${s.name}" works — ${list.length}`);
            return { source: s.name, users: list.map(toUser) };
          }
        } catch (e) {
          if (![400, 403, 404, 405, 500].includes(e.status)) throw e;
          log(`users: "${s.name}" -> ${e.status}, trying the next shape`);
        }
      }
      /* The floor. One request each, which is why it is last. */
      const want = [...new Set(ids.map(String).filter(Boolean))];
      log(`users: no list endpoint — resolving ${want.length} known id(s) one by one`);
      const out = [];
      for (const id of want) {
        try { out.push(toUser(await call("GET", `/v1/users/${id}`))); }
        catch (e) { log(`users: ${id} -> ${e.status || e.message}`); }
      }
      return { source: "GET /v1/users/{id} per known owner", users: out };
    },

    companyShapeName: () => companyShape?.name || "not yet determined",
    lastCompanySearch: () => ({ ...lastSearch }),

    contact: (id) => call("GET", `/v1/contacts/${id}`),

    createContact: (body) => call("POST", "/v1/contacts", body),
    updateContact: (id, body) => call("PUT", `/v1/contacts/${id}`, body),
    createCallLog: (body) => call("POST", "/v1/call-logs/", body),
  };
}

/* ── writing ───────────────────────────────────────────────────────── */

export const MARK_A = "--- BD CONSOLE (auto, do not edit below) ---";
export const MARK_B = "--- END ---";

/* Rewrite only between the markers. Anything a human typed above them is
   theirs and must survive, so the block is replaced rather than the field. */
export function mergeRemarks(existing, block) {
  const before = String(existing || "").split(MARK_A)[0].replace(/\s+$/, "");
  if (!block) return before;
  return `${before}${before ? "\n\n" : ""}${MARK_A}\n${block}\n${MARK_B}`;
}

const line = (label, value) => (value ? `${label.padEnd(10)} ${value}` : null);
const row = (r) => [r.eventType, r.budget, r.timeline, r.pax].filter(Boolean).join(" | ");

/* What a Kylas user sees on the record. Readable, not parsed back — the numbers
   come from Airtable, this is context for whoever opens the contact. */
export function renderRemarks(c, { stageLabel } = {}) {
  const rows = (list, label) => (list || []).map((r) => row(r)).filter(Boolean)
    .map((t, i) => line(i ? "" : label, t)).filter(Boolean);
  const out = [
    line("Stage", stageLabel || c.stage),
    line("Owner", c.owner),
    line("Next call", [c.nextCallDate, c.nextCallTime].filter(Boolean).join(" ")),
    ...rows(c.past, "Past"),
    ...rows(c.current, "Current"),
    line("Vendor", c.vendorInfo),
    line("Mode", c.modeOfMeeting),
    line("Offering", c.serviceOffering ? "pitched on this call" : ""),
    line("Notes", (c.current || []).map((r) => r.remarks).filter(Boolean).join(" · ")),
  ].filter(Boolean);
  return out.join("\n");
}

/* The console's shape back into Kylas'. Only fields Kylas owns — the overlay's
   own data lives in Airtable and in the remarks block. */
export function toKylasContact(c, { remarks } = {}) {
  const { firstName, lastName } = splitName(c.pocName);
  const body = {
    firstName: firstName || undefined,
    lastName: lastName || "Unknown",
    designation: c.designation || undefined,
    linkedin: c.linkedin || undefined,
    emails: (c.emails || []).map((e) => ({ e, r: checkEmail(e.value) }))
      .filter(({ r }) => r.ok)
      .map(({ e, r }) => ({ type: e.type || "OFFICE", value: r.value, primary: !!e.primary })),
    /* Kylas wants the NATIONAL number in `value` and the country in `dialCode`.
       Anything else — "+918319585041", a pasted "0 8319 585041" — comes back as
       400 002008 "Invalid Mobile Number", which names neither the field nor the
       rule. splitPhone puts every form into the one shape Kylas accepts, so a
       PUT also repairs a record that was stored wrong earlier. */
    phoneNumbers: (c.phones || []).map((p) => ({ p, s: splitPhone(p.value, p.cc) }))
      .filter(({ s }) => s.value)
      .map(({ p, s }) => ({ type: p.type || "MOBILE", dialCode: s.cc || "+91",
                            code: ISO_OF[s.cc || "+91"] || undefined,
                            value: s.value, primary: !!p.primary })),
    customFieldValues: {},
  };
  if (c.companyId) body.company = Number(c.companyId);
  if (c.ownerId) body.ownerId = Number(c.ownerId);
  if (remarks !== undefined) body.remarks = remarks;

  /* A picklist is set by value id, never by code. */
  const stageId = STAGE_ID[c.stage];
  if (stageId) body.customFieldValues.cfPipelineStageBd = stageId;
  if (c.source) body.customFieldValues.cfSourceOfData = c.source;
  if (!Object.keys(body.customFieldValues).length) delete body.customFieldValues;

  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/* Kylas' own call-log vocabulary, which is not the console's. */
const OUTCOME = { "No answer": "no_answer", "Wrong POC": "connected",
                  "Right POC": "connected", "Discovery": "connected" };

export function toKylasCallLog(c, call) {
  const phone = (c.phones || []).find((p) => p.primary) || (c.phones || [])[0];
  /* The log wants the number as it would be dialled, so E.164 and not whatever
     shape the field happens to hold. */
  const number = phone ? e164(phone) : "";
  return {
    outcome: OUTCOME[call.outcome] || "connected",
    callType: "outgoing",
    startTime: call.at || new Date().toISOString(),
    duration: String(call.duration || 0),
    phoneNumber: number,
    notes: call.note ? [{ description: call.note }] : undefined,
    relatedTo: { entity: "contact", id: Number(c.kid), phoneNumber: number },
  };
}

/* ── mapping ───────────────────────────────────────────────────────────
   Kylas shapes are not fully documented and vary by endpoint, so every
   accessor below tolerates more than one form rather than assuming one. A
   wrong guess here shows up as a blank field, not a crash. */

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
export const idOf = (v) => (v && typeof v === "object" ? pick(v.id, v.value) : v);
const nameOf = (v) => (v && typeof v === "object" ? pick(v.name, v.displayName, v.label) : undefined);

/* Kylas ships a lookup table with every record:
     metaData.idNameStore.company  = { "1770964": "renewbuy" }
     metaData.idNameStore.ownerId  = { "74752": "Rubal Sansanwal" }
   Reading it is both more accurate and cheaper than resolving ids with extra
   requests, which matters against a tight rate limit. */
export function lookupName(record, field, id) {
  const store = record?.metaData?.idNameStore?.[field];
  if (!store || id === undefined || id === null || id === "") return undefined;
  return store[String(id)];
}

/* A stage can come back as the code, the numeric id, or an object. */
export function stageCode(v) {
  const raw = v && typeof v === "object" ? pick(v.name, v.code, v.id, v.value) : v;
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw);
  return CODE_BY_ID[s] || s;
}

export function toConsoleContact(c, { ownerName, company } = {}) {
  const cf = c.customFieldValues || {};
  const companyId = pick(idOf(c.company), company?.id, "");
  const ownerId = pick(c.ownerId, "");
  const name = [pick(c.salutationName), pick(c.firstName), pick(c.lastName)].filter(Boolean).join(" ").trim();
  return {
    kid: String(pick(c.id, "") ?? ""),
    salutation: pick(stageCode(c.salutation), "") || "",
    pocName: name || pick(c.name, ""),
    /* Company arrives as a bare id. The name is in metaData; failing that, the
       caller knows which company it asked for. */
    company: pick(lookupName(c, "company", companyId), nameOf(c.company), c.companyName,
                  company?.name, "") || "",
    companyId: String(companyId ?? ""),
    linkedin: pick(c.linkedin, "") || "",
    designation: pick(c.designation, c.department, "") || "",

    emails: (c.emails || []).map((e, i) => ({
      type: pick(e.type, "OFFICE"), value: pick(e.value, "") || "",
      primary: e.primary ?? i === 0,
    })),
    /* Normalised on the way IN as well: a record already stored with the
       country code inside `value` would otherwise display as +91+918319..., and
       the first save of it would fail. */
    phones: (c.phoneNumbers || []).map((p, i) => {
      const s = splitPhone(pick(p.value, "") || "", pick(p.dialCode, "+91"));
      return { type: pick(p.type, "MOBILE"), cc: s.cc || "+91",
               value: s.value, primary: p.primary ?? i === 0 };
    }),

    stage: stageCode(pick(cf.cfPipelineStageBd, c.cfPipelineStageBd)),
    stageLabel: lookupName(c, "cfPipelineStageBd", pick(cf.cfPipelineStageBd, c.cfPipelineStageBd)) || "",
    source: stageCode(pick(cf.cfSourceOfData, c.cfSourceOfData)),
    nextCallDate: "", nextCallTime: "",
    remarks: pick(c.remarks, "") || "",
    offsiteTimeline: "",
    owner: pick(lookupName(c, "ownerId", ownerId), ownerName, c.ownerName, "") || "",
    ownerId: String(ownerId ?? ""),

    /* Overlay-owned, so Kylas has nothing to say about them yet. */
    past: [], current: [],
    vendorInfo: "", serviceOffering: false, modeOfMeeting: "",
    done: false, flagged: false,
    /* Present and empty rather than absent: the Airtable reader returns it, and
       a key that exists on one source and not the other is a difference the
       console can see. */
    exitReason: "",

    _kylas: { updatedAt: c.updatedAt, createdAt: c.createdAt },
  };
}

/* A Kylas user, in the one shape the rest of the code wants. Active is not
   reported consistently — `active`, `status`, or nothing at all — so every form
   is read and "unknown" is preserved rather than guessed as false. Marking a
   real associate inactive would quietly drop them from the team view. */
export function toUser(u) {
  const active = u?.active !== undefined ? !!u.active
    : u?.status !== undefined ? /^(active|enabled|true)$/i.test(String(u.status))
    : null;
  return {
    id: String(pick(u?.id, "") ?? ""),
    name: [pick(u?.firstName), pick(u?.lastName)].filter(Boolean).join(" ").trim()
      || pick(u?.name, u?.email, "") || "",
    email: String(pick(u?.email, "") || "").toLowerCase(),
    active,
  };
}

export function toConsoleCompany(co) {
  const cf = co?.customFieldValues || {};
  /* `name` is the key on both GET /v1/companies/{id} and the search endpoint.
     companyName is kept only because contacts use it, and one mapper reading
     both shapes is cheaper than two. When 38 companies rendered as their own
     ids the cause was not the response at all — views.rollup() seeded rows with
     a truthy "Company <id>" placeholder that its own !empty guard then refused
     to overwrite. Check the mapping before blaming the API. */
  const id = pick(co?.id, "") ?? "";
  const name = pick(co?.name, co?.companyName, "") || "";
  return {
    id: String(id),
    name,
    stage: stageCode(cf.cfPipelineStageBd),
    lastCalledAt: pick(cf.cfLastCalledAtDate, null),
    accountHealth: pick(cf.cfAccountHealthBd, null),
    source: stageCode(cf.cfSourceOfData),
    batch: pick(cf.cfBatch, null),
    website: pick(cf.cfWebsite, co?.website, null),
  };
}
