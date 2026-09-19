/* The two views that replace the call console when the associate is not on a
   record: the dashboard on /sales/home and the companies list on
   /sales/companies/list.

   Both roll up to COMPANY, never to contact. That is the unit the KPIs are
   counted in: a company is reached, picked up, a right POC, a discovery — even
   though every one of those facts is established on a contact underneath it. */
(function (global) {

  /* ── the four metrics, per company ─────────────────────────────────── */
  const filled = (v) => String(v || "").trim() !== "";
  const rowsOf = (c) => [...(c.past || []), ...(c.current || [])];

  /* Right POC: any of budget | timeline | pax on any row, past or current. */
  const signal = (c) => rowsOf(c).some((r) => filled(r.budget) || filled(r.timeline) || filled(r.pax));
  /* Successful discovery: one row carrying the whole picture. */
  const complete = (c) => rowsOf(c).some((r) => filled(r.budget) && filled(r.timeline) && filled(r.pax));
  /* Picked up: anything other than never-touched or a no-answer. */
  const picked = (c) => !!c.stage && !NOT_CONNECTED.includes(c.stage);

  /* ── the five benchmark conversions ────────────────────────────────── */
  /* Each is a STEP between adjacent rungs — the drop-off that is actually
     managed. A single overall rate hides which step is losing companies. */
  const STEPS = [
    { from: "reached",   to: "right",     label: "Reached → Right POC" },
    { from: "right",     to: "discovery", label: "Right POC → Discovery" },
    { from: "discovery", to: "booked",    label: "Discovery → SQL booked" },
    { from: "booked",    to: "done",      label: "SQL booked → SQL done" },
    { from: "done",      to: "sql",       label: "SQL done → SQL" },
  ];

  /* Exclusive buckets, highest rung first — WHERE each company stopped.
     This is what makes a stacked bar honest: the funnel rungs are NESTED (an
     SQL company is also reached), so stacking the rungs themselves would add
     overlapping counts and produce a bar whose height means nothing. Bucketed
     by the furthest rung reached, the segments are disjoint, they sum to
     companies reached, and the chart answers the better question — at which
     step is this associate losing accounts. */
  const BUCKETS = [
    { key: "sql",       label: "SQL" },
    { key: "done",      label: "SQL done" },
    { key: "booked",    label: "SQL booked" },
    { key: "discovery", label: "Discovery" },
    { key: "right",     label: "Right POC" },
    { key: "reached",   label: "Reached only" },
  ];
  const bucketOf = (co) => (BUCKETS.find((b) => co[b.key]) || {}).key || null;

  /* ── the funnel, defined once ──────────────────────────────────────── */
  /* Ayush's six, in his order (2026-09-17). Two different kinds of test sit in
     one list: reached/right/discovery come from the event DATA, booked/done/sql
     from the STAGE. They can disagree — a company can sit at SQL with nobody
     having filled a complete row — and cumulative() below only closes the gaps
     that are logically true, so this list is NOT guaranteed to descend. Where
     it widens, the view says so. */
  const FUNNEL = [
    { key: "reached",   label: "Companies reached",    sub: "at least one call logged" },
    { key: "right",     label: "Right POC connected",  sub: "any of budget, timeline or pax" },
    { key: "discovery", label: "Successful discovery call", sub: "one complete row" },
    { key: "booked",    label: "SQL meeting booked",   sub: "booked, regardless of outcome" },
    { key: "done",      label: "SQL meeting done",     sub: "the call was held" },
    { key: "sql",       label: "SQL",                  sub: "qualified" },
  ];

  /* Only implications that are actually TRUE.
     The three stage rungs are monotonic already, being floors on one ladder.
     A complete row contains any one of its fields, so discovery genuinely
     implies right POC. And a company that produced signal or got a meeting on
     the calendar was plainly spoken to, so both imply picked up and reached.

     What is deliberately NOT here: discovery from booked. "Booked" means the
     meeting is in the diary, which is BEFORE it is held — so deriving a
     successful discovery from it would credit a call that has not happened.
     That leaves the displayed funnel able to widen at that step, and it should:
     more companies with a booked meeting than with complete qualification data
     means the fields are being skipped, which is a real finding and exactly
     what the save-time gating on a complete row is there to close. */
  function cumulative(co) {
    co.done      = co.done      || co.sql;
    co.booked    = co.booked    || co.done;
    co.right     = co.right     || co.discovery;
    co.picked    = co.picked    || co.right || co.booked;
    co.reached   = co.reached   || co.picked;
    return co;
  }

  /* One row per company, from every contact the console holds.
     `base` is the authoritative list from /companies — companies allotted to
     the owner in Kylas. Seeding from it is what makes an allotted-but-never-
     worked company appear at all; deriving purely from contacts, as this used
     to, could only ever show companies somebody had already opened. */
  /* `onlyBase` — when an owner filter is on, the allotted list IS the answer.
     Contact-derived rows would otherwise walk straight past it: any company
     the browser happens to hold a contact for got a row regardless of who it
     belongs to, which is why "Allotted to: Arshdeep Singh" listed a company
     owned by Devansh Shukla. Contacts still enrich rows that exist; they no
     longer create them. */
  /* ── the dashboard's rows, from Airtable ───────────────────────────
     DRAWN FROM THE KPI STORE, not from Kylas.
     The funnel used to be built by crawling every company in Kylas — 10,000 of
     them on Ayush's account — and joining each one back to an Airtable row. A
     company nobody has worked is a zero in every column, so 9,998 of those rows
     were noise, and when the join missed, the whole dashboard read zero while
     the Progress section (which needs no join) showed real numbers.

     Airtable holds exactly the companies somebody has actually worked, with
     their owner and every KPI already computed. That is the dashboard's
     population. Kylas' crawl still answers "how many are allotted to me",
     which is a different question and stays where it was. */
  function fromKpis(companies, owner) {
    const want = String(owner || "");
    return (companies || [])
      .filter((c) => c.kpi)
      .map((c) => {
        const k = c.kpi;
        return { id: c.id, name: k.name || c.name || ("Company " + c.id),
                 owner: k.owner || c.owner || "", ownerId: c.ownerId || "",
                 source: c.source || "", batch: c.batch || "",
                 stage: c.stage || "", kpiStage: k.stage || "",
                 rung: k.rank || 0, lastCalledAt: k.lastCalledAt || c.lastCalledAt || null,
                 contacts: new Array(k.contacts || 0),
                 pocs: { right: k.rightNames, discovery: k.discoveryNames, sql: [] },
                 modes: {}, from: "airtable",
                 reached: k.reached, picked: k.picked, right: k.right,
                 discovery: k.discovery, booked: k.booked, done: k.done, sql: k.sql };
      })
      .filter((c) => !want || want === "all" || String(c.ownerId) === want || c.owner === want)
      .map(cumulative);
  }

  function rollup(data, base, onlyBase) {
    const by = new Map();
    const row = (id, seed) => {
      /* name starts EMPTY, not "Company <id>". A placeholder here is truthy, so
         the `!co[k]` guard below would never let the real name replace it — and
         every row rendered as its own id even when Kylas had sent the name.
         The fallback is applied once, after seeding. */
      if (!by.has(id)) by.set(id, {
        id, name: "", contacts: [],
        source: "", owner: "", ownerId: "", batch: "", health: "", lastCalledAt: null,
        rung: 0, stage: "", lastQualityAt: null, modes: {},
        pocs: { right: [], discovery: [], sql: [] },
      });
      const co = by.get(id);
      if (seed) for (const k of ["name", "source", "owner", "ownerId", "batch", "health", "lastCalledAt"])
        if (!co[k] && seed[k]) co[k] = seed[k];
      if (seed?.kpi && !co.kpi) co.kpi = seed.kpi;
      return co;
    };

    /* Allotted first, so a company with no contacts still gets a row. Its
       fields — source, batch, account health, owner — live on the COMPANY in
       Kylas, which is why they were blank while this was built from contacts. */
    for (const co of base || []) {
      if (!co?.id) continue;
      row(String(co.id), { name: co.name, source: co.source, owner: co.owner,
                           ownerId: co.ownerId, batch: co.batch, health: co.accountHealth,
                           lastCalledAt: co.lastCalledAt, kpi: co.kpi });
    }

    for (const c of data) {
      const id = String(c.companyId || "");
      if (!id) continue;
      if (onlyBase && !by.has(id)) continue;      /* not allotted to this owner */
      const co = row(id, { name: c.company });
      co.contacts.push(c);
    }

    for (const co of by.values()) {
      for (const c of co.contacts) {
        if (!co.source && c.source) co.source = c.source;
        if (!co.owner && c.owner) co.owner = c.owner;

        /* The company sits at the best rung any of its POCs has reached. */
        const r = STAGE_RUNG[c.stage] || 0;
        if (r > co.rung) { co.rung = r; co.stage = c.stage; }

        /* Last quality date: the most recent stage change across its POCs. A
           second call two hours later moves it; a call that changes nothing
           does not. */
        const at = c.lastStageChangeAt || null;
        if (at && (!co.lastQualityAt || at > co.lastQualityAt)) co.lastQualityAt = at;

        /* Last called: the console's own record of a call beats the company's
           cfLastCalledAtDate, which nothing is known to maintain. Whichever is
           more recent wins, so the column is never older than the truth. */
        const called = c.lastCallAt || c.lastStageChangeAt || null;
        if (called && (!co.lastCalledAt || called > co.lastCalledAt)) co.lastCalledAt = called;

        /* How the meeting was held, counted per company per mode. This is what
           the team chart stacks; the segments come from the data rather than a
           hardcoded list, so whichever vocabulary Kylas ends up using is what
           gets charted. */
        if (c.modeOfMeeting && r >= MILESTONE.sqlMeetingBooked.floor)
          co.modes[c.modeOfMeeting] = (co.modes[c.modeOfMeeting] || 0) + 1;

        /* Who, by name — "which POC did the discovery happen with" is the
           question a manager actually asks. */
        if (signal(c)) co.pocs.right.push(c.pocName);
        if (complete(c)) co.pocs.discovery.push(c.pocName);
        if (c.stage === "SQL_SALES_QUALIFIED_LEAD") co.pocs.sql.push(c.pocName);
      }

      /* Data-driven rungs. */
      co.right = co.pocs.right.length > 0;
      co.discovery = co.pocs.discovery.length > 0;
      co.picked = co.contacts.some(picked);
      co.reached = co.contacts.some((c) => c.lastCallAt || c.lastStageChangeAt);
      /* Stage-driven rungs, each a floor on the ladder. Because KPI rank only
         rises, "is at or past" answers "ever reached" — a no-show still counts
         as booked, which is what Ayush means by "regardless of outcome". */
      co.booked = co.rung >= MILESTONE.sqlMeetingBooked.floor;
      co.done = co.rung >= MILESTONE.sqlMeetingDone.floor;
      co.sql = co.rung >= MILESTONE.sql.floor;

      /* AIRTABLE WINS. Everything above this line is the same rule set
         expressed in JavaScript, and it exists only for a company Airtable has
         not seen yet — one allotted to you that nobody has saved from the
         console. Where Airtable has the row, its formulas are the definition
         and these values are replaced wholesale rather than merged, because a
         merge of two definitions is a third definition.

         co.from records WHICH, per row, so the view can say so. A number whose
         provenance is invisible is a number nobody can check. */
      if (co.kpi) {
        const k = co.kpi;
        co.from = "airtable";
        co.reached = k.reached; co.picked = k.picked;
        co.right = k.right; co.discovery = k.discovery;
        co.booked = k.booked; co.done = k.done; co.sql = k.sql;
        co.rung = k.rank || co.rung;
        /* NOT co.stage. Airtable's "KPI Stage" is a ladder LABEL
           ("19 · Discovery Call Booked"); co.stage is a Kylas stage CODE, and
           the Stage filter and the row both match on the code. Overwriting it
           would empty the filter and render the label twice. */
        co.kpiStage = k.stage || "";
        co.stageAt = k.stageAt || "";
        if (k.rightNames.length) co.pocs.right = k.rightNames;
        if (k.discoveryNames.length) co.pocs.discovery = k.discoveryNames;
        if (k.lastCalledAt) co.lastCalledAt = k.lastCalledAt > (co.lastCalledAt || "")
          ? k.lastCalledAt : co.lastCalledAt;
        co.calls = k.calls; co.talkSeconds = k.talkSeconds;
        if (!co.name && k.name) co.name = k.name;
      } else {
        co.from = "browser";
      }
      /* Every implication in cumulative() is true whichever source supplied
         the flags, so it runs either way. */
      cumulative(co);
      /* Only now, once every source has had its say. */
      if (!co.name) co.name = "Company " + co.id;
    }
    return [...by.values()];
  }

  /* ── dashboard ─────────────────────────────────────────────────────── */
  const pct = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "—");
  const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");

  /* The allotted list is a search over up to 200 companies, so it is fetched
     once and reused by both views rather than on every repaint. */
  /* ONE fetch for the whole account, filtered in the browser.
     It used to be keyed on owner, single-slot: picking a name evicted the
     previous one and refetched from Kylas — two paginated searches at a 450ms
     gap each, plus an owner lookup for anyone unknown. Switching back refetched
     again. That is the slowness; the cache DURATION was never the problem.

     Fetching everyone costs the same as fetching one person anyway, because the
     shape that works on this account cannot filter server-side — the proxy
     already pages through the whole list and filters in memory. So do it once
     and switch owners for free.

     Persisted, and served stale on open while a refresh runs behind it, so a
     reload paints instantly instead of waiting on the network. */
  const CACHE = { at: 0, companies: [], owners: [], error: "", loading: false, from: "",
                  /* Where the KPI numbers came from this fetch: "airtable" once
                     the store answered, "none" when it is not configured or was
                     unreachable. Shown, not assumed. */
                  kpiSource: "", kpiError: "", kpiMatched: 0,
                  /* The crawl stopped at Kylas' page cap: what is here is a
                     correct prefix, not the account. Never inferred — the
                     proxy says so explicitly. */
                  truncated: false, crawled: 0,
                  reportedTotal: null, short: 0, hitTheirCeiling: false };
  const FRESH_MS = 5 * 60 * 1000;       /* older than this and we revalidate */
  let inflight = false;
  let restored = false;

  /* The proxy already works out why the join is empty — /kpi-debug compares
     both sides and returns a verdict in one sentence. Fetched once, only when
     nothing matched, because it reads every Companies row in the base. */
  const WHY = { text: "", detail: "", loading: false, asked: false };

  function ensureWhy(onReady) {
    if (WHY.asked) return;
    WHY.asked = true; WHY.loading = true;
    API.kpiDebug()
      .then((d) => {
        WHY.text = d?.verdict || d?.error || "";
        /* The ids themselves, on the hover. The verdict names the FAULT; two
           ids side by side are what let somebody recognise their own data —
           a mock id, a contact id where a company id belongs, a stray space.
           That was the one thing the old "run curl" message did give, and
           dropping it would have traded a terminal trip for a dead end. */
        const at = (d?.airtable?.sampleIds || []).slice(0, 3).join(", ");
        const ky = (d?.kylas?.sampleIds || []).slice(0, 3).join(", ");
        WHY.detail = [
          at ? `Airtable ids: ${at}` : "",
          ky ? `Kylas ids: ${ky}` : "",
          d?.fieldWarning || "",
        ].filter(Boolean).join("\n");
      })
      .catch((e) => { WHY.text = `could not check why — ${e.message}`; })
      .finally(() => { WHY.loading = false; onReady(); });
  }

  /* WHERE THE NUMBERS CAME FROM, on screen. Airtable's formulas are the
     definition of the funnel; the browser's copy is a fallback for a company
     the store has not seen. Which one produced what you are reading is not a
     detail — it is the difference between an auditable number and a guess. */
  function kpiNote(cos, opts) {
    const n = cos.filter((c) => c.from === "airtable").length;
    /* The dashboard counts what has been WORKED, which is what Airtable holds.
       Saying "9998 not saved yet" about companies nobody has opened is noise. */
    if (opts?.storeIsPopulation && n)
      return `<span class="vsrc ok" title="These are the companies somebody has saved from the console. Kylas' allotted list answers a different question — see the Companies view.">${
        n} compan${n === 1 ? "y" : "ies"} worked · from Airtable</span>`;
    if (CACHE.kpiSource === "airtable" && n === cos.length && cos.length)
      return `<span class="vsrc ok" title="Right POC, discovery and the three milestones are Airtable formulas — see scripts/schema.mjs">KPIs from Airtable</span>`;
    if (CACHE.kpiSource === "airtable" && n === 0 && cos.length) {
      /* NONE matched. "10000 not saved yet" is true and useless — it reads as
         "you have not worked these yet" when it can equally mean the join is
         broken. Say which. "check /kpi-debug" said neither: it asked the
         reader to leave the screen, open a terminal and run curl to find out
         what the proxy will answer in one call. Ask it here instead. */
      /* The CALLER's repaint, not the dashboard's. kpiNote renders in both
         views, so hard-coding dashboard() here swapped the Companies view for
         the dashboard the moment the verdict landed — you pressed Companies
         and a second later were looking at the funnel. Same callback the two
         views already hand to ensureCompanies. */
      if (opts?.repaint) ensureWhy(opts.repaint);
      return `<span class="vsrc off" title="${esc(WHY.detail
        || "Companies join to Airtable on the Kylas company id — see /kpi-debug for both sides in full")}">${
        WHY.loading ? "no company matched Airtable — finding out why…"
        : WHY.text ? esc(WHY.text)
        : "no company matched Airtable"}</span>`;
    }
    if (CACHE.kpiSource === "airtable")
      return `<span class="vsrc part" title="A company appears here as soon as it is allotted to you in Kylas. It reaches Airtable the first time somebody saves from the console.">${
        n} with KPIs · ${cos.length - n} not saved yet</span>`;
    /* NOT ASKED YET is not UNAVAILABLE. kpiSource is "" until the first
       /companies answers, and on an account with thousands of companies that
       crawl runs long enough to read the badge several times — during which
       this said Airtable was down and the numbers were the browser's own.
       Both were guesses, and the first one sent people looking for a fault in
       a store that had not been asked a question yet. */
    if (!CACHE.kpiSource)
      return `<span class="vsrc part" title="The KPI store is read as part of the company list, so this can only answer once that returns.">checking Airtable…</span>`;
    /* It answered, and the answer was no. Which no matters: a proxy started
       without AIRTABLE_PAT is a line to add to .env.local, a 401 is a dead
       token, a 404 is the wrong base id. "Unavailable" covered all three and
       pointed at none of them, with the only clue in a tooltip. */
    const why = CACHE.kpiError || "the KPI store did not answer";
    const short = why.length > 74 ? why.slice(0, 73) + "…" : why;
    return `<span class="vsrc off" title="${esc(why)}">${esc(
      /not configured/i.test(why)
        ? "Airtable is not configured on the proxy — counted in this browser"
        : `Airtable did not answer — ${short}`)}</span>`;
  }

  /* Kylas stopped answering before the account ran out. Amber, because this is
     a warning about the DATA and not a styling choice: every count on screen is
     computed over a list that is short by an unknown amount. */
  /* "Short by an unknown amount" was the best this could say while the crawl
     discarded Kylas' own totalElements. It is known now, and the two causes
     need OPPOSITE advice: raising KYLAS_MAX_PAGES fixes our cap and does
     nothing whatever for Kylas' result window. Sending somebody to change a
     number that cannot help is worse than saying nothing. */
  const truncWarn = () => {
    if (!CACHE.truncated) return "";
    const got = esc(String(CACHE.crawled));
    if (CACHE.hitTheirCeiling && CACHE.reportedTotal != null)
      return `<p class="vwarn">Kylas says this account has
        <strong>${esc(String(CACHE.reportedTotal))}</strong> companies and served
        ${got} of them — ${esc(String(CACHE.short))} are missing. Its paged search
        will not return the rest however many pages we ask for, so every count
        below is short by that many. Raising <code>KYLAS_MAX_PAGES</code> will not
        help; the remainder has to be fetched another way.</p>`;
    return `<p class="vwarn">Kylas stopped returning companies at our page limit —
       ${got} fetched, and there are more that are NOT here. Every count below is
       short by an unknown amount. Restart the proxy with a higher
       <code>KYLAS_MAX_PAGES</code>.</p>`;
  };

  const ageText = () => {
    if (!CACHE.at) return "";
    const s = Math.round((Date.now() - CACHE.at) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };

  /* Filter locally. Owner switching now touches no network at all. */
  const companiesNow = (owner) => {
    const want = String(owner || "");
    if (!want || want === "all") return CACHE.companies;
    return CACHE.companies.filter((c) =>
      String(c.ownerId) === want || c.owner === want);
  };

  /* Read the last good list off disk once per session, so the first paint has
     rows rather than a spinner. */
  async function restore() {
    if (restored) return;
    restored = true;
    try {
      const held = await Store.getSetting("companyCache");
      if (held?.companies?.length && !CACHE.companies.length) {
        CACHE.companies = held.companies;
        CACHE.owners = held.owners || [];
        CACHE.at = held.at || 0;
        CACHE.from = "stored";
        CACHE.kpiSource = held.kpiSource || "";
        /* Stored too, or a reload of a console whose proxy has no Airtable
           credentials restores "not from Airtable" without the reason, and
           the badge falls back to "did not answer" — which is not what
           happened. */
        CACHE.kpiError = held.kpiError || "";
        CACHE.kpiMatched = held.kpiMatched || 0;
        CACHE.truncated = !!held.truncated;
        CACHE.crawled = held.crawled || 0;
        CACHE.reportedTotal = held.reportedTotal ?? null;
        CACHE.short = held.short || 0;
        CACHE.hitTheirCeiling = !!held.hitTheirCeiling;
      }
    } catch { /* storage is a convenience here, never a dependency */ }
  }

  /* Returns true while a fetch is outstanding. `force` is the Refresh button —
     the answer to "the cache is too old" is a control, not a shorter timer. */
  function ensureCompanies(_owner, onReady, force) {
    if (inflight) return true;
    const fresh = CACHE.at && Date.now() - CACHE.at < FRESH_MS;
    if (!force && fresh) return false;
    /* Nothing held and a previous attempt failed: do not loop. */
    if (!force && CACHE.error && !CACHE.companies.length && CACHE.at) return false;

    /* Refresh means ask again, the verdict included — the usual reason
       somebody presses it is that they have just fixed what it told them. */
    if (force) { WHY.asked = false; WHY.text = ""; WHY.detail = ""; }

    inflight = true;
    CACHE.loading = true;
    API.companies("all", force)
      .then(async (r) => {
        CACHE.companies = r.companies || [];
        CACHE.owners = r.owners || [];
        CACHE.error = "";
        CACHE.at = Date.now();
        CACHE.from = "live";
        CACHE.kpiSource = r.kpiSource || "none";
        CACHE.kpiError = r.kpiError || "";
        CACHE.kpiMatched = r.kpiMatched || 0;
        CACHE.truncated = !!r.truncated;
        CACHE.crawled = r.crawled || 0;
        CACHE.reportedTotal = r.reportedTotal ?? null;
        CACHE.short = r.short || 0;
        CACHE.hitTheirCeiling = !!r.hitTheirCeiling;
        if (r.picklists) adoptPicklists(r.picklists);
        try {
          await Store.setSetting("companyCache",
            { at: CACHE.at, companies: CACHE.companies, owners: CACHE.owners,
              kpiSource: CACHE.kpiSource, kpiError: CACHE.kpiError,
              kpiMatched: CACHE.kpiMatched,
              truncated: CACHE.truncated, crawled: CACHE.crawled,
              reportedTotal: CACHE.reportedTotal, short: CACHE.short,
              hitTheirCeiling: CACHE.hitTheirCeiling });
        } catch { /* over quota is survivable — it is only a head start */ }
      })
      .catch((e) => {
        /* Keep whatever is held. A failed refresh must not empty the view. */
        CACHE.error = e.message;
        if (!CACHE.at) CACHE.at = Date.now();
      })
      .finally(() => { inflight = false; CACHE.loading = false; onReady(); });
    return true;
  }

  /* ── the funnel ────────────────────────────────────────────────────── */
  /* Six ordered magnitudes with a drop-off between each — bars, not tiles.
     Tiles put the six numbers side by side and the reader has to do the
     division themselves, which is the one thing a funnel is for. One series,
     so no legend: the heading names it. */
  function funnelRows(cos) {
    const counts = FUNNEL.map((f) => cos.filter((c) => c[f.key]).length);
    const top = counts[0] || 0;
    return FUNNEL.map((f, i) => ({
      ...f,
      n: counts[i],
      /* Conversion is from the PREVIOUS rung, which is the drop-off Ayush
         asked for. Share-of-top is also shown because a chain of healthy
         step rates can still end in a terrible overall rate. */
      fromPrev: i === 0 ? null : pct(counts[i], counts[i - 1]),
      ofTop: i === 0 ? null : pct(counts[i], top),
      /* Widths are a share of the widest rung, not of the first, because the
         funnel can widen at the discovery→booked step. Scaling to the first
         rung would clip a longer bar to 100% and hide exactly that. */
      width: Math.max(...counts, 1) ? Math.round((counts[i] / Math.max(...counts, 1)) * 100) : 0,
      /* A step that grows is not a rounding artefact: it means the rung above
         was recorded without the data the rung below is counted from. */
      widened: i > 0 && counts[i] > counts[i - 1],
    }));
  }

  function funnelHTML(cos) {
    const rows = funnelRows(cos);
    const grew = rows.filter((r) => r.widened);
    /* Header at the TOP, and with no bar cell — at the bottom it read as a
       seventh, empty rung, which is what made "n / of prev / of reached"
       unreadable. The words say what they measure rather than abbreviating it. */
    return `<div class="vfun">
      <div class="vfr vfh">
        <span class="fl">Rung</span>
        <span class="fn">Companies</span>
        <span class="fp">vs rung above</span>
        <span class="fo">vs reached</span>
      </div>
      ${rows.map((r) => `
      <div class="vfr${r.widened ? " grew" : ""}" title="${esc(r.label)} — ${esc(r.sub)}. ${r.n} compan${r.n === 1 ? "y" : "ies"}${
        r.fromPrev ? `, ${r.fromPrev} of the rung above` : ""}">
        <span class="fl">${esc(r.label)}</span>
        <span class="fb"><i style="width:${r.width}%"></i></span>
        <span class="fn tnum">${r.n}</span>
        <span class="fp tnum">${r.fromPrev ? esc(r.fromPrev) : "—"}${
          r.widened ? ` <em title="More companies here than at the rung above — the data the rung above is counted from was not captured.">&#9650;</em>` : ""}</span>
        <span class="fo tnum">${r.ofTop ? esc(r.ofTop) : ""}</span>
      </div>`).join("")}
    </div>
    ${grew.length ? `<p class="vnote">${grew.map((g) => esc(g.label)).join(" and ")} ${
      grew.length === 1 ? "counts" : "count"} more companies than the rung above.
      That is not a rounding error: a meeting was booked or held without budget, timeline and pax
      being captured, so the qualification rungs cannot see it. New saves are now blocked until
      those fields are filled, so this should only reflect records entered before that.</p>` : ""}`;
  }

  /* ── where companies stopped, stacked per associate ────────────────── */
  /* Six disjoint segments summing to companies reached. Palette: categorical
     slots 1-6, run through the dataviz validator against this console's
     surfaces. Three of the six fall under 3:1 on white, which obliges the
     legend and the table that ship with this chart. */
  const slot = (i) => `var(--s${(i % 6) + 1})`;

  function stackedByOwner(cos, byLabel) {
    const groups = new Map();
    for (const co of cos) {
      const b = bucketOf(co);
      if (!b) continue;                       /* never reached — not in scope */
      const k = byLabel(co) || "Unassigned";
      if (!groups.has(k)) groups.set(k, {});
      groups.get(k)[b] = (groups.get(k)[b] || 0) + 1;
    }
    const bars = [...groups.entries()]
      .map(([k, v]) => ({ k, v, total: Object.values(v).reduce((a, b) => a + b, 0) }))
      .filter((b) => b.total > 0)
      .sort((a, b) => b.total - a.total);
    if (!bars.length) return "";

    const max = Math.max(...bars.map((b) => b.total), 1);
    const legend = `<div class="vlg">${BUCKETS.map((b, i) =>
      `<span class="lg"><i style="background:${slot(i)}"></i>${esc(b.label)}</span>`).join("")}</div>`;

    const chart = `<div class="vbars">${bars.map((b) => `
      <div class="vbar">
        <span class="bk">${esc(b.k)}</span>
        <span class="bt">${BUCKETS.map((bu, i) => {
          const n = b.v[bu.key] || 0;
          if (!n) return "";
          return `<i style="width:${(n / max) * 100}%;background:${slot(i)}"
                     title="${esc(b.k)} · ${esc(bu.label)}: ${n}"></i>`;
        }).join("")}</span>
        <span class="bn tnum">${b.total}</span>
      </div>`).join("")}</div>`;

    const table = `<details class="vtbl"><summary>Show as a table</summary>
      <table><thead><tr><th>Associate</th>${BUCKETS.map((b) =>
        `<th>${esc(b.label)}</th>`).join("")}<th>Reached</th></tr></thead>
      <tbody>${bars.map((b) => `<tr><td>${esc(b.k)}</td>${
        BUCKETS.map((bu) => `<td class="tnum">${b.v[bu.key] || 0}</td>`).join("")
        }<td class="tnum">${b.total}</td></tr>`).join("")}</tbody></table></details>`;

    return `<div class="vhead sm"><h2>Where companies stopped</h2>
      <span class="vsub">Each bar is one associate's reached companies, split by the furthest rung they got to.</span></div>
      ${legend}${chart}${table}`;
  }

  /* ── the benchmark table ───────────────────────────────────────────── */
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const show = (v) => (v == null ? "—" : v + "%");

  function stepTable(cos, byLabel) {
    const count = (list, k) => list.filter((c) => c[k]).length;
    const line = (label, list) => ({
      label,
      n: count(list, "reached"),
      steps: STEPS.map((st) => rate(count(list, st.to), count(list, st.from))),
    });

    const people = [...new Set(cos.map((c) => byLabel(c) || "Unassigned"))].sort();
    const rows = [line("All", cos),
      ...(people.length > 1
        ? people.map((p) => line(p, cos.filter((c) => (byLabel(c) || "Unassigned") === p)))
        : [])];

    return `<div class="vhead sm"><h2>Step conversion</h2>
      <span class="vsub">Each column is one rung to the next — the five rates to benchmark against.</span></div>
      <div class="vsteps">
        <table>
          <thead><tr><th>Who</th><th class="tnum">Reached</th>${
            STEPS.map((st) => `<th>${esc(st.label)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr${i === 0 && rows.length > 1 ? ' class="all"' : ""}>
              <td>${esc(r.label)}</td>
              <td class="tnum">${r.n}</td>
              ${r.steps.map((v) => `<td class="tnum${v != null && v > 100 ? " over" : ""}"${
                v != null && v > 100
                  ? ' title="Above 100%: the rung above was recorded without the qualification data the rung below is counted from."'
                  : ""}>${show(v)}</td>`).join("")}
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
  }

  /* ── trend, from the frozen daily rows ─────────────────────────────── */
  /* Airtable, not the browser's own snapshots: those hold call outcomes, not
     the company-level funnel, so a conversion trend cannot be computed from
     them. Read through the proxy because the PAT lives there. */
  const SNAP = { days: 60, rows: null, error: "", loading: false };

  function trendChart() {
    if (SNAP.loading) return `<p class="vnote">Loading the trend…</p>`;
    if (SNAP.error) return `<p class="vnote">No trend yet — ${esc(SNAP.error)}.</p>`;
    const rows = SNAP.rows || [];
    if (rows.length < 2)
      return `<div class="vhead sm"><h2>Trend</h2></div>
        <p class="vnote">A line needs at least two frozen days. Days are frozen once, after they
        end, by <code>scripts/snapshot.mjs</code> — run it on a daily cron and this fills in.</p>`;

    const f = (r, k) => Number(r[k] || 0);
    const series = STEPS.map((st, i) => ({
      label: st.label, colour: slot(i),
      points: rows.map((r) => ({
        date: String(r.Date).slice(0, 10),
        v: rate(f(r, SNAPFIELD[st.to]), f(r, SNAPFIELD[st.from])),
      })),
    }));

    const W = 720, H = 200, PAD = { l: 34, r: 8, t: 8, b: 22 };
    const x = (i) => PAD.l + (i / Math.max(1, rows.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v || 0) / 100) * (H - PAD.t - PAD.b);

    const grid = [0, 25, 50, 75, 100].map((v) =>
      `<line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" class="gl"/>
       <text x="${PAD.l - 6}" y="${y(v) + 4}" class="gt2">${v}</text>`).join("");

    const lines = series.map((s) => {
      const pts = s.points.map((p, i) => (p.v == null ? null : `${x(i)},${y(p.v)}`)).filter(Boolean);
      if (pts.length < 2) return "";
      return `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.colour}"
                stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
        s.points.map((p, i) => p.v == null ? "" :
          `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" fill="${s.colour}">
             <title>${esc(s.label)} · ${esc(p.date)}: ${p.v}%</title></circle>`).join("");
    }).join("");

    const first = rows[0].Date, last = rows[rows.length - 1].Date;
    return `<div class="vhead sm"><h2>Trend</h2>
      <span class="vsub">Each of the five conversions, per frozen day. ${esc(String(first).slice(0,10))} to ${esc(String(last).slice(0,10))}.</span></div>
      <div class="vlg">${series.map((s) =>
        `<span class="lg"><i style="background:${s.colour}"></i>${esc(s.label)}</span>`).join("")}</div>
      <div class="vline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
        role="img" aria-label="Step conversion over time">${grid}${lines}</svg></div>`;
  }

  /* Snapshot column per funnel rung. */
  const SNAPFIELD = {
    reached: "Companies Reached To Date",
    right: "Companies At Right POC",
    discovery: "Companies At Discovery",
    booked: "Companies At SQL Booked",
    done: "Companies At SQL Meeting Done",
    sql: "Companies At SQL Accepted",
  };

  function ensureSnapshots(onReady) {
    if (SNAP.rows || SNAP.error || SNAP.loading) return;
    SNAP.loading = true;
    API.snapshots(SNAP.days)
      .then((r) => { SNAP.rows = r.snapshots || []; SNAP.error = r.reason || ""; })
      .catch((e) => { SNAP.error = e.message; })
      .finally(() => { SNAP.loading = false; onReady(); });
  }

  /* ── the period report ─────────────────────────────────────────────── */
  /* Month, week, day — the same numbers, cut three ways, because "how are we
     doing" is a different question at each scale and a single 14-day window
     answers none of them well.

     Fetched once per (period, owner) and cached, so flipping between Month and
     Week is instant rather than a round trip each time. */
  const REP = { data: null, period: "week", owner: "", loading: false, error: "", key: "" };

  function ensureReport(period, owner, onReady) {
    const key = `${period}|${owner}`;
    if (REP.key === key && (REP.data || REP.error)) return false;
    if (REP.loading) return true;
    REP.loading = true; REP.key = key; REP.period = period; REP.owner = owner;
    API.report(period, owner)
      .then((r) => { REP.data = r; REP.error = r?.error || ""; })
      .catch((e) => { REP.data = null; REP.error = e.message; })
      .finally(() => { REP.loading = false; onReady(); });
    return true;
  }

  const REPORT_METRICS = [
    { key: "calls", label: "Calls" },
    { key: "connects", label: "Connected" },
    { key: "right", label: "Right POC" },
    { key: "discovery", label: "Discovery" },
    { key: "booked", label: "SQL booked" },
    { key: "done", label: "SQL done" },
    { key: "sql", label: "SQL" },
  ];

  /* A number on its own motivates nobody. Every figure here carries what it was
     last period, so the reader is told whether it went up — which is the only
     part anybody acts on. */
  const deltaHTML = (n) => {
    if (n === null || n === undefined) return `<i class="d flat">—</i>`;
    if (n === 0) return `<i class="d flat">±0</i>`;
    return `<i class="d ${n > 0 ? "up" : "down"}">${n > 0 ? "▲" : "▼"}${Math.abs(n)}</i>`;
  };

  function reportSection(period, owner) {
    const loading = ensureReport(period, owner, () => dashboard(document.getElementById("vwrap")));
    const r = REP.data;

    const head = `<div class="vhead sm">
        <h2>Progress</h2>
        <span class="vsub">${r ? `${esc(r.from)} to ${esc(r.to)}` : "the same numbers by month, week and day"}</span>
        <span class="vperiod">${["month", "week", "day"].map((p) => `
          <button type="button" data-period="${p}" aria-pressed="${p === period}">${
            p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</span>
      </div>`;

    if (REP.error)
      return head + `<p class="vwarn">Could not build the report — ${esc(REP.error)}.</p>`;
    if (loading && !r) return head + `<p class="vnote">Reading the history…</p>`;
    if (!r || !r.periods.length) return head + `<p class="vnote">No history yet.</p>`;

    /* The headline: this period, against the last one. */
    const cur = r.current || {}, prev = r.previous;
    const tiles = REPORT_METRICS.map((m) => `
      <div class="rtile">
        <b>${cur[m.key] ?? 0}</b>
        <span>${esc(m.label)}</span>
        ${deltaHTML(cur.delta ? cur.delta[m.key] : null)}
      </div>`).join("");

    /* Best period and streak — the two things that read as encouragement rather
       than as a ledger. Omitted entirely when there is nothing to celebrate,
       because a "best: 0" is worse than silence. */
    const bits = [];
    if (r.streak > 1) bits.push(`<b>${r.streak}</b> ${period}s in a row with calls logged`);
    for (const m of ["discovery", "sql"]) {
      const b = r.best[m];
      if (b && cur[m] && cur[m] >= b.value)
        bits.push(`best ${period} yet for <b>${esc(REPORT_METRICS.find((x) => x.key === m).label)}</b>`);
    }
    const bestCalls = r.best.calls;
    if (bestCalls && bestCalls.key !== cur.key)
      bits.push(`most calls was <b>${bestCalls.value}</b> (${esc(bestCalls.label)})`);

    const rows = [...r.periods].reverse().map((p) => `
      <tr${p.key === cur.key ? ' class="now"' : ""}>
        <td>${esc(p.label)}</td>
        ${REPORT_METRICS.map((m) => `<td>${p[m.key]}${
          p.delta && p.delta[m.key] !== null && p.delta[m.key] !== 0
            ? ` ${deltaHTML(p.delta[m.key])}` : ""}</td>`).join("")}
      </tr>`).join("");

    return head + `
      <div class="rnow">
        <div class="rlabel">${esc(cur.label || "")}<em>${
          prev ? `vs ${esc(prev.label)}` : "no earlier period"}</em></div>
        <div class="rtiles">${tiles}</div>
      </div>
      ${bits.length ? `<p class="rgood">${bits.join(" · ")}</p>` : ""}
      <div class="vsteps rtable">
        <table>
          <thead><tr><th>${period[0].toUpperCase() + period.slice(1)}</th>${
            REPORT_METRICS.map((m) => `<th>${esc(m.label)}</th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="vnote">Counted from the call log and the stage history, so a month, a week and a
        day are the same rows cut three ways and always agree. A company is counted on the day it
        FIRST reached a rung — moving on, or back and forth, never counts twice.</p>`;
  }

  /* ── dashboard ─────────────────────────────────────────────────────── */
  let DASH_OWNER = "";          /* "" = me, "all" = the team */
  let DASH_PERIOD = "week";

  async function dashboard(host) {
    await restore();
    const loading = ensureCompanies(DASH_OWNER, () => dashboard(host));
    const dbase = companiesNow(DASH_OWNER);
    /* Airtable's own rows are the population when it has any. Falling back to
       the Kylas crawl keeps the view alive before the first save and when the
       store is unreachable — and the badge says which is on screen. */
    const fromStore = fromKpis(dbase, DASH_OWNER === "all" ? "" : DASH_OWNER);
    const cos = fromStore.length ? fromStore : rollup(DATA, dbase, dbase.length > 0);
    const team = DASH_OWNER === "all";
    const names = [...new Set(CACHE.owners.map((o) => o.name).filter(Boolean))].sort();

    host.innerHTML = `
      <div class="vhead">
        <h2>${team ? "Team" : "My"} funnel</h2>
        <span class="vsub">Every number counts companies, not contacts.</span>
      </div>
      <div class="vfilters">
        <label>Who<select id="dOwner"${API.isAdmin ? "" : " disabled"}>
          <option value=""${!team ? " selected" : ""}>${
            API.isAdmin ? "Me" : esc(API.state.user?.name || "Me")}</option>
          ${API.isAdmin ? `<option value="all"${team ? " selected" : ""}>Everyone</option>
          ${CACHE.owners.map((o) => `<option value="${esc(o.id)}"${
            String(DASH_OWNER) === String(o.id) ? " selected" : ""}>${esc(o.name)}</option>`).join("")}` : ""}
        </select></label>
        ${API.isAdmin ? "" : `<span class="vrole" title="Set ADMIN_EMAILS in .env.local to see the team">your numbers</span>`}
        <span class="vsub">${cos.length} compan${cos.length === 1 ? "y" : "ies"} allotted${
          CACHE.at ? ` · ${esc(ageText())}` : ""}</span>
        ${kpiNote(cos, { storeIsPopulation: fromStore.length > 0, repaint: () => dashboard(host) })}
        <button class="gbtn sm" id="dRefresh" type="button"${loading ? " disabled" : ""}
          title="Re-read the companies from Kylas now">${loading ? "refreshing…" : "Refresh"}</button>
      </div>
      ${CACHE.error ? `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        Showing only the companies this browser holds, so these counts are not your real funnel.</p>` : ""}
      ${truncWarn()}
      ${funnelHTML(cos)}
      <div class="vsec">${stepTable(cos, (c) => c.owner)}</div>
      <div class="vsec">${stackedByOwner(cos, (c) => c.owner)}</div>
      <div class="vsec">${reportSection(DASH_PERIOD, DASH_OWNER === "all" ? "all" : "")}</div>
      <div class="vsec">${trendChart()}</div>`;

    const sel = document.getElementById("dOwner");
    /* No network: the whole account is already held, so this is a filter. */
    if (sel) sel.onchange = () => { DASH_OWNER = sel.value; dashboard(host); };
    const rf = document.getElementById("dRefresh");
    if (rf) rf.onclick = () => { ensureCompanies(DASH_OWNER, () => dashboard(host), true); dashboard(host); };
    host.querySelectorAll(".vperiod button").forEach((b) => {
      b.onclick = () => { DASH_PERIOD = b.dataset.period; dashboard(host); };
    });
    /* Fetched once per session; the view repaints when it lands. */
    ensureSnapshots(() => dashboard(host));
  }

  /* paintDays() and the "Last 14 days" list are gone. That data is frozen into
     Airtable's Daily Snapshot and now feeds the Trend chart above, which
     answers the question the list only implied. Store.freezeDays() still runs
     on save, so the local history keeps accruing.

  /* ── companies list ────────────────────────────────────────────────── */
  /* Airtable-shaped: each dimension is a SET plus whether that set includes or
     excludes. One value was never enough — "Round-Robin and Apollo but not
     Referral" is an ordinary question and a single select cannot ask it. An
     empty set means no constraint, so "is none of" with nothing ticked is not
     a filter that hides everything. */
  const FILTERS = {
    owner: "", calledSince: "",
    source: { mode: "any", values: [] },
    stage: { mode: "any", values: [] },
    kpi: { mode: "any", values: [] },
  };

  /* ── the columns, declared once ────────────────────────────────────── */
  /* The header, the cell and the sort all come from this one list, so a column
     cannot be sortable by something it does not display. `dir` is the direction
     a FIRST click gives you: a date and a count want their biggest value first,
     a name wants A-Z. Guessing wrong here means every useful sort takes two
     clicks. */
  const COLS = [
    { c: "c1", label: "Company",     sort: "name",     dir: 1,  get: (r) => String(r.name || "").toLowerCase() },
    { c: "c2", label: "Stage",       sort: "rung",     dir: -1, get: (r) => r.rung || 0 },
    { c: "c3", label: "POCs",        sort: "contacts", dir: -1, get: (r) => r.contacts.length },
    { c: "c4", label: "Right POC",   sort: "right",    dir: -1, get: (r) => r.pocs.right.length },
    { c: "c5", label: "Discovery",   sort: "discovery",dir: -1, get: (r) => r.pocs.discovery.length },
    { c: "c6", label: "Last call",   sort: "called",   dir: -1, get: (r) => String(r.lastCalledAt || "") },
    { c: "c7", label: "Allotted to", sort: "owner",    dir: 1,  get: (r) => String(r.owner || "").toLowerCase() },
    { c: "c9", label: "Batch",       sort: "batch",    dir: 1,  get: (r) => String(r.batch || "").toLowerCase() },
  ];
  /* The list opened fixed at "highest rung first" and could not be reordered at
     all, so "who have I not called longest" — the most ordinary question anyone
     asks a 250-row grid — had no answer. */
  const SORT = { key: "rung", dir: -1 };
  const colOf = (key) => COLS.find((x) => x.sort === key) || COLS[1];

  /* Rows per screen. ~11 at comfortable, ~18 at compact: on a list this long
     that is the difference between three scrolls and one. Remembered, because
     it is a preference and not a mode. */
  let DENSITY = "comfortable";
  async function restoreDensity() {
    try { DENSITY = (await Store.getSetting("density")) || "comfortable"; } catch { /* default */ }
  }

  /* KPI is a set of booleans on the row, not one value, so "is any of" asks
     whether the company sits at ANY of the ticked rungs. */
  const matchesSet = (state, have) => {
    if (!state.values.length) return true;
    const hit = state.values.some((v) => have.includes(v));
    return state.mode === "none" ? !hit : hit;
  };

  /* A <details> popover: no library, keyboard-reachable, and it closes on the
     next click anywhere via the handler wired after render. */
  /* `counts` is how many of the CURRENT rows carry each value. Without it the
     Source filter offered values that no company row had — the account records
     "source of data" on the contact, not the company — so every choice
     returned nothing and the filter read as broken. A count next to each option
     makes that visible before you click, which is what Airtable's own filter
     menus do, and it turns "this is broken" into "there are none of those". */
  function multiFilter(id, title, options, state, labelOf = (v) => v, counts = null) {
    const n = state.values.length;
    const summary = !n ? "All"
      : n === 1 ? `${state.mode === "none" ? "not " : ""}${labelOf(state.values[0])}`
      : `${state.mode === "none" ? "none of " : "any of "}${n}`;
    return `<details class="mf" id="${id}">
      <summary title="${esc(title)}"><span>${esc(summary)}</span></summary>
      <div class="mfbody">
        <div class="mfmode">
          <button type="button" data-mode="any" aria-pressed="${state.mode === "any"}">is any of</button>
          <button type="button" data-mode="none" aria-pressed="${state.mode === "none"}">is none of</button>
        </div>
        <div class="mflist">${options.length ? options.map((v) => {
          const c = counts ? (counts.get(v) || 0) : null;
          return `<label${c === 0 ? ' class="mfzero"' : ""}><input type="checkbox" value="${esc(v)}"${
            state.values.includes(v) ? " checked" : ""}> <span>${esc(labelOf(v))}</span>${
            c === null ? "" : `<i>${c}</i>`}</label>`; }).join("")
          : `<p class="mfnone">Nothing to filter on yet.</p>`}</div>
        <div class="mffoot"><button type="button" data-clear="1">Clear</button>
          <span>${n} selected</span></div>
      </div>
    </details>`;
  }

  /* Wires one popover. Re-rendering the whole view on every tick would close
     the popover mid-use, so the state is mutated and only the row list and the
     summary are refreshed. */
  function wireMulti(id, state, onChange) {
    const root = document.getElementById(id);
    if (!root) return;
    root.querySelectorAll(".mfmode button").forEach((b) => {
      b.onclick = () => {
        state.mode = b.dataset.mode;
        root.querySelectorAll(".mfmode button").forEach((x) =>
          x.setAttribute("aria-pressed", String(x.dataset.mode === state.mode)));
        onChange();
      };
    });
    root.querySelectorAll(".mflist input").forEach((cb) => {
      cb.onchange = () => {
        const v = cb.value;
        if (cb.checked) { if (!state.values.includes(v)) state.values.push(v); }
        else state.values = state.values.filter((x) => x !== v);
        onChange();
      };
    });
    const clear = root.querySelector("[data-clear]");
    if (clear) clear.onclick = () => {
      state.values = [];
      root.querySelectorAll(".mflist input").forEach((c) => (c.checked = false));
      onChange();
    };
  }

  /* ── what is actually filtered, always visible ─────────────────────── */
  /* Scroll the filter row away and the view became "19 of 250" with no stated
     reason. That is how the owner-filter bug hid for a week: the count was
     right there and there was nothing on screen to say why. Each active
     constraint is a chip you can read and remove, and the strip sticks to the
     top of the scroller with the header. */
  function chipStrip(rows, all) {
    const chips = [];
    const add = (kind, value, text) =>
      chips.push(`<button class="vchip" type="button" data-kind="${kind}" data-value="${esc(value)}"
        title="Remove this filter">${esc(text)}<i>×</i></button>`);

    if (FILTERS.owner === "all") add("owner", "", "Allotted to: everyone");
    else if (FILTERS.owner) {
      const o = CACHE.owners.find((x) => String(x.id) === String(FILTERS.owner));
      add("owner", "", `Allotted to: ${o?.name || FILTERS.owner}`);
    }
    for (const [key, name, lab] of [["source", "Source", label],
                                    ["stage", "Stage", label],
                                    ["kpi", "KPI", (k) => (FUNNEL.find((f) => f.key === k) || {}).label || k]]) {
      const st = FILTERS[key];
      const not = st.mode === "none" ? "not " : "";
      /* One chip per VALUE, not one per dimension: removing a single stage from
         a set of four is the common correction, and a chip you can only remove
         wholesale forces you to re-tick the other three. */
      for (const v of st.values) add(key, v, `${name}: ${not}${lab(v)}`);
    }
    if (FILTERS.calledSince) add("calledSince", "", `Called since ${FILTERS.calledSince}`);

    if (!chips.length) return "";
    return `<div class="vchips">${chips.join("")}
      <button class="vchip clr" type="button" data-kind="all">Clear all</button>
      <span class="vcount">${rows.length} of ${all.length}</span></div>`;
  }

  async function companies(host) {
    /* Same allotted list the dashboard uses, so the two cannot disagree about
       which companies exist. The owner filter here is the company's own owner
       in Kylas, which is what "allotted to me" means. Rendered from cache
       first — the filters are local and must not wait on a search. */
    await restore();
    await restoreDensity();
    const who = FILTERS.owner === "all" ? "all" : FILTERS.owner;
    const loading = ensureCompanies(who, () => companies(host));
    /* An owner is selected unless the filter is cleared, and "all" is still a
       server-side answer — so in both cases the fetched list is authoritative.
       Only with no list at all (offline) do contact rows stand in. */
    const base = companiesNow(who);
    const all = rollup(DATA, base, base.length > 0);
    /* Options are what the ACCOUNT defines, not what the loaded rows happen to
       contain. Deriving them from the rows meant one company on screen gave a
       Source filter with one option — you could not filter TO something you
       could not already see, which is the opposite of what a filter is for.
       Row values are unioned in so a value Kylas no longer offers is still
       filterable while records carry it. */
    const union = (defined, present) =>
      [...new Set([...defined.filter(Boolean), ...present.filter(Boolean)])];

    /* How many rows carry each value, for the counts in the popovers. */
    const countBy = (rows, valuesOf) => {
      const m = new Map();
      for (const r of rows) for (const v of valuesOf(r)) m.set(v, (m.get(v) || 0) + 1);
      return m;
    };
    const srcCount = countBy(all, (c) => (c.source ? [c.source] : []));
    /* Values that exist first, then the rest of the account's list. Scrolling
       past 40 unused options to reach the one with rows in it is the same
       problem as not knowing the counts. */
    const sources = union(SOURCES, all.map((c) => c.source))
      .sort((a, b) => (srcCount.get(b) || 0) - (srcCount.get(a) || 0) || String(a).localeCompare(String(b)));
    const stages = union(STAGES, all.map((c) => c.stage))
      .sort((a, b) => (STAGE_RUNG[b] || 0) - (STAGE_RUNG[a] || 0));

    /* The filter test and the sort, both used by the first paint and by
       matching() below. One definition each — the shell used to describe rows
       the table then painted differently. */
    const keep = (c) =>
      matchesSet(FILTERS.source, c.source ? [c.source] : []) &&
      matchesSet(FILTERS.stage, c.stage ? [c.stage] : []) &&
      matchesSet(FILTERS.kpi, FUNNEL.filter((f) => c[f.key]).map((f) => f.key)) &&
      (!FILTERS.calledSince || (c.lastCalledAt || "") >= FILTERS.calledSince);

    const ordered = (list) => {
      const col = colOf(SORT.key);
      /* A stable tiebreak, so two companies at the same rung never swap places
         between repaints. */
      return [...list].sort((x, y) => {
        const a = col.get(x), b = col.get(y);
        if (a < b) return -SORT.dir;
        if (a > b) return SORT.dir;
        return String(x.name || "").localeCompare(String(y.name || ""));
      });
    };
    const rows = ordered(all.filter(keep));


    /* One definition, used by the first paint and by every filter tick. */
    const rowHTML = (c) => `
          <div class="vr" data-id="${esc(c.id)}">
            <span class="c1"><b>${esc(c.name)}</b><em>${esc(c.source || "—")}</em></span>
            <span class="c2">${esc(label(c.stage) || "—")}</span>
            <span class="c3">${c.contacts.length}</span>
            <span class="c4${c.pocs.right.length ? "" : " no"}"${
              c.pocs.right.length > 1 ? ` title="${esc(c.pocs.right.join(", "))}"` : ""
            }>${c.pocs.right.length ? esc(c.pocs.right.join(", ")) : "—"}</span>
            <span class="c5${c.pocs.discovery.length ? "" : " no"}"${
              c.pocs.discovery.length > 1 ? ` title="${esc(c.pocs.discovery.join(", "))}"` : ""
            }>${c.pocs.discovery.length ? esc(c.pocs.discovery.join(", ")) : "—"}</span>
            <span class="c6${c.lastCalledAt ? "" : " no"}">${day(c.lastCalledAt)}</span>
            <span class="c7${c.owner ? "" : " no"}" title="${esc(c.owner || "")}">${esc(c.owner || "—")}</span>
            <span class="c9${c.batch ? "" : " no"}">${esc(c.batch || "—")}</span>
          </div>`;

    host.innerHTML = `
      <div class="vhead">
        <h2>Companies</h2>
        <span class="vsub">${loading ? "loading…" : `${rows.length} of ${all.length}`}</span>
      </div>
      <div class="vfilters">
        <label>Allotted to<select id="fOwner"${API.isAdmin ? "" : " disabled"}>
          <option value=""${!FILTERS.owner ? " selected" : ""}>${
            API.isAdmin ? "Me" : esc(API.state.user?.name || "Me")}</option>
          ${API.isAdmin ? `<option value="all"${FILTERS.owner === "all" ? " selected" : ""}>Everyone</option>
          ${CACHE.owners.map((o) => `<option value="${esc(o.id)}"${
            String(FILTERS.owner) === String(o.id) ? " selected" : ""}>${esc(o.name)}</option>`).join("")}` : ""}
        </select></label>
        <label>Source${multiFilter("fSource", "Source of data", sources, FILTERS.source, label,
          countBy(all, (c) => (c.source ? [c.source] : [])))}</label>
        <label>Stage${multiFilter("fStage", "Pipeline stage", stages, FILTERS.stage, label,
          countBy(all, (c) => (c.stage ? [c.stage] : [])))}</label>
        <label>KPI${multiFilter("fKpi", "Funnel rung", FUNNEL.map((f) => f.key), FILTERS.kpi,
          (k) => (FUNNEL.find((f) => f.key === k) || {}).label || k,
          countBy(all, (c) => FUNNEL.filter((f) => c[f.key]).map((f) => f.key)))}</label>
        <label>Called since<input type="date" id="fSince" value="${esc(FILTERS.calledSince)}"></label>
        <button class="gbtn" id="fClear" type="button">Clear</button>
        <button class="gbtn" id="fRefresh" type="button"${loading ? " disabled" : ""}
          title="Re-read the companies from Kylas now">${loading ? "refreshing…" : "Refresh"}</button>
        <button class="gbtn" id="fDensity" type="button"
          title="${DENSITY === "compact" ? "Roomier rows" : "Fit more rows on screen"}"
        >${DENSITY === "compact" ? "Comfortable" : "Compact"}</button>
        <span class="vage">${CACHE.at ? esc(ageText())
          : ""}</span>
        ${kpiNote(all, { repaint: () => companies(host) })}
      </div>
      ${chipStrip(rows, all)}
      <div class="vtable${DENSITY === "compact" ? " dense" : ""}">
        <div class="vr vh">${COLS.map((col) => `<span class="${col.c} srt${
          SORT.key === col.sort ? " on" : ""}" data-sort="${col.sort}"
          role="button" tabindex="0"
          title="Sort by ${esc(col.label.toLowerCase())}">${esc(col.label)}<i>${
            SORT.key === col.sort ? (SORT.dir === 1 ? "↑" : "↓") : ""}</i></span>`).join("")}
        </div>
        <!-- rows painted by paint(), so the window applies to the first
             render as well as to every filter change -->
      </div>
      ${CACHE.error ? `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        This is only what the browser holds, not everything allotted to you.</p>` : ""}
      ${truncWarn()}
      <p class="vnote">Named POCs answer the question a manager actually asks — not how many right
        POCs, but which person. Stage is the highest any POC at that company has reached. A company
        with no POCs yet is one allotted to you that nobody has opened.
        <b>Batch</b> is Kylas' own <code>Batch</code> field on the company, shown as it is stored.</p>`;

    const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
    on("fOwner", "change", (e) => { FILTERS.owner = e.target.value; companies(host); });
    on("fSince", "change", (e) => { FILTERS.calledSince = e.target.value; companies(host); });
    on("fRefresh", "click", () => { ensureCompanies(who, () => companies(host), true); companies(host); });
    /* Clear is also the retry: it drops the cache so a failed fetch is tried
       again, which is otherwise a reload. */
    on("fClear", "click", () => {
      if (CACHE.error) { CACHE.owner = null; CACHE.error = ""; }
      FILTERS.owner = ""; FILTERS.calledSince = "";
      for (const k of ["source", "stage", "kpi"]) { FILTERS[k].mode = "any"; FILTERS[k].values = []; }
      companies(host);
    });
    /* Ticking a box must not re-render the whole view — that would close the
       popover on every click. Only the rows and the summary are refreshed. */
    for (const [id, st] of [["fSource", FILTERS.source], ["fStage", FILTERS.stage], ["fKpi", FILTERS.kpi]])
      wireMulti(id, st, () => { repaintRows(); repaintChips(); });

    /* Density. Stored then re-rendered, so the class and the button label can
       never disagree about which state we are in. */
    on("fDensity", "click", async () => {
      DENSITY = DENSITY === "compact" ? "comfortable" : "compact";
      try { await Store.setSetting("density", DENSITY); } catch { /* preference only */ }
      companies(host);
    });

    /* SORT. Clicking the column you are already sorted by reverses it; a new
       column starts in that column's own natural direction. Only the rows are
       repainted — re-rendering the shell would scroll you back to the top,
       which is the opposite of what someone sorting a list wants. */
    const wireSort = () => host.querySelectorAll(".vr.vh [data-sort]").forEach((h) => {
      const go = () => {
        const key = h.dataset.sort;
        if (SORT.key === key) SORT.dir = -SORT.dir;
        else { SORT.key = key; SORT.dir = colOf(key).dir; }
        repaintHead(); repaintRows();
      };
      h.addEventListener("click", go);
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
    });

    /* Redraw just the header's sort marks. */
    function repaintHead() {
      host.querySelectorAll(".vr.vh [data-sort]").forEach((h) => {
        const on = h.dataset.sort === SORT.key;
        h.classList.toggle("on", on);
        const i = h.querySelector("i");
        if (i) i.textContent = on ? (SORT.dir === 1 ? "↑" : "↓") : "";
      });
    }

    /* Chips. Rebuilt in place rather than by re-rendering the view, so removing
       one does not close a popover or lose the scroll position. */
    function repaintChips() {
      const next = chipStrip(matching(), all);
      const held = host.querySelector(".vchips");
      if (!next) { held?.remove(); return; }
      if (held) held.outerHTML = next;
      else host.querySelector(".vfilters")?.insertAdjacentHTML("afterend", next);
      wireChips();
    }
    function wireChips() {
      host.querySelectorAll(".vchips .vchip").forEach((b) => b.addEventListener("click", () => {
        const { kind, value } = b.dataset;
        if (kind === "all") {
          FILTERS.owner = ""; FILTERS.calledSince = "";
          for (const k of ["source", "stage", "kpi"]) { FILTERS[k].mode = "any"; FILTERS[k].values = []; }
        } else if (kind === "owner") FILTERS.owner = "";
        else if (kind === "calledSince") FILTERS.calledSince = "";
        else if (FILTERS[kind]) FILTERS[kind].values = FILTERS[kind].values.filter((v) => v !== value);
        /* The owner filter changes which companies are IN the list, so that one
           needs the full re-render; the rest are local. */
        companies(host);
      }));
    }
    wireChips();

    /* A row is a way into the company, not a dead end. */
    const bindRows = () => host.querySelectorAll(".vr[data-id]").forEach((r) =>
      r.addEventListener("click", () => global.openCompanyFromView?.(r.dataset.id)));

    /* The rows also carry the count in the chip strip, so a repaint that
       changes what matches has to update it. */
    /* Redraw the table and each popover's own summary in place. */
    /* Rows are rendered in a WINDOW, not all at once. At 250+ companies
       rebuilding every row's HTML on each checkbox tick is what made the list
       feel heavy — the work is proportional to the whole account, not to what
       is on screen. 60 rows fill any viewport; the rest arrive as you reach
       them, which is how a grid like Airtable's stays responsive.

       Repaints are also coalesced to one animation frame: ticking three boxes
       quickly used to do three full rebuilds. */
    const WINDOW = 60;
    let shown = WINDOW;
    let frame = null;
    let io = null;

    const matching = () => ordered(all.filter(keep));

    function paint() {
      const next = matching();
      const body = host.querySelector(".vtable");
      const head = body?.querySelector(".vr.vh");
      if (body && head) {
        const slice = next.slice(0, shown);
        body.innerHTML = head.outerHTML + (next.length
          ? slice.map(rowHTML).join("") +
            (next.length > shown
              ? `<div class="vmore" id="vmore">${next.length - shown} more…</div>` : "")
          : `<div class="vempty">Nothing matches those filters.</div>`);
        bindRows();
        /* The header is re-serialised with the body, so its listeners went with
           it — sorting worked once and then died silently. */
        wireSort(); repaintHead();

        /* Grow when the sentinel comes into view. Observer rebuilt each paint
           because the node it watches is replaced. */
        io?.disconnect();
        const sentinel = body.querySelector("#vmore");
        if (sentinel) {
          io = new IntersectionObserver((e) => {
            if (e.some((x) => x.isIntersecting)) { shown += WINDOW; paint(); }
          }, { root: host.closest("#viewport") || null, rootMargin: "200px" });
          io.observe(sentinel);
        }
      }
      const sub = host.querySelector(".vhead .vsub");
      if (sub) sub.textContent = loading ? "loading…"
        : `${next.length} of ${all.length}${next.length > shown ? ` · showing ${shown}` : ""}`;
      const cnt = host.querySelector(".vchips .vcount");
      if (cnt) cnt.textContent = `${next.length} of ${all.length}`;
      syncSummaries();
    }

    function repaintRows() {
      shown = WINDOW;                       /* a new filter starts at the top */
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = null; paint(); });
    }

    function syncSummaries() {
      for (const [id, st, lab] of [["fSource", FILTERS.source, label],
                                   ["fStage", FILTERS.stage, label],
                                   ["fKpi", FILTERS.kpi, (k) => (FUNNEL.find((f) => f.key === k) || {}).label || k]]) {
        const n = st.values.length;
        const span = document.querySelector(`#${id} > summary > span`);
        if (span) span.textContent = !n ? "All"
          : n === 1 ? `${st.mode === "none" ? "not " : ""}${lab(st.values[0])}`
          : `${st.mode === "none" ? "none of " : "any of "}${n}`;
        const count = document.querySelector(`#${id} .mffoot span`);
        if (count) count.textContent = `${n} selected`;
      }
    }

    /* LAST, after every const it leans on. `function paint` is hoisted but
       `matching` and `bindRows` are const arrows — calling paint() above their
       declarations threw "Cannot access 'matching' before initialization", and
       because the shell template had already written the subtitle, the view
       looked like it had rendered 133 rows while showing none. */
    paint();
  }

  global.Views = { rollup, dashboard, companies, FILTERS };
})(window);
