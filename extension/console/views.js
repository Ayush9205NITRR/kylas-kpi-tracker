/* The two views that replace the call console when the associate is not on a
   record: the dashboard on /sales/home and the companies list on
   /sales/companies/list.

   Both roll up to COMPANY, never to contact. That is the unit the KPIs are
   counted in: a company is reached, picked up, a right POC, a discovery — even
   though every one of those facts is established on a contact underneath it. */
(function (global) {

  /* NOT SIGNED IN IS NOT AN OUTAGE, and must not read like one. The server is
     up and the address is right; "Could not reach Kylas" sent people hunting
     for a fault that was not there. The button is here because the console's
     "sign in" badge is hidden behind the Dashboard — see signInNow() in
     overlay.js, which is what clicking it runs. */
  const signInNote = (what) => `<p class="vwarn vsign">Not signed in — ${esc(what)}.
      <button type="button" class="gbtn sm vsignbtn" data-signin>Sign in with Google</button>
      <span class="vsignwhy"></span></p>`;

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
        id, name: "", contacts: [], offsite: [],
        source: "", owner: "", ownerId: "", batch: "", health: "", lastCalledAt: null,
        rung: 0, stage: "", kylasStage: "", lastQualityAt: null, modes: {},
        pocs: { right: [], discovery: [], sql: [] },
      });
      const co = by.get(id);
      /* kylasStage is the COMPANY's own stage field, kept apart from co.stage,
         which is the highest rung any of its POCs reached. On the companies
         list no contacts are loaded at all, so co.stage is empty for every row
         and anything reading it alone describes the whole account as "not
         reached". Two different facts, two fields — merging them would make the
         Stage filter match rows whose POCs are somewhere else entirely. */
      if (seed) for (const k of ["name", "source", "owner", "ownerId", "batch",
                                 "health", "lastCalledAt", "kylasStage", "acctStage"])
        if (!co[k] && seed[k]) co[k] = seed[k];
      if (seed?.kpi && !co.kpi) co.kpi = seed.kpi;
      if (seed?.offsite?.length) co.offsite = [...new Set([...co.offsite, ...seed.offsite])];
      if (seed?.nextCall && (!co.nextCall || seed.nextCall < co.nextCall)) co.nextCall = seed.nextCall;
      /* The enrichment block from the server, whole — it is one object per
         company and there is nothing here to merge. Left off entirely for a
         company the Company Database has no row for, which is what the
         Unknown chips count. */
      if (seed?.enrich && !co.enrich) co.enrich = seed.enrich;
      return co;
    };

    /* Allotted first, so a company with no contacts still gets a row. Its
       fields — source, batch, account health, owner — live on the COMPANY in
       Kylas, which is why they were blank while this was built from contacts. */
    for (const co of base || []) {
      if (!co?.id) continue;
      row(String(co.id), { name: co.name, source: co.source, owner: co.owner,
                           ownerId: co.ownerId, batch: co.batch, health: co.accountHealth,
                           lastCalledAt: co.lastCalledAt, kylasStage: co.stage, kpi: co.kpi,
                           offsite: co.offsite, nextCall: co.nextCall, enrich: co.enrich,
                           /* The server's calculated account stage — the furthest
                              rung any of this account's contacts has reached. */
                           acctStage: co.acctStage });
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
        /* Derived from the event rows on this browser's card, possibly not
           saved yet — the same rule the server applies (offsite.js). */
        for (const q of global.Offsite ? Offsite.offsiteOf(c) : []) if (!co.offsite.includes(q)) co.offsite.push(q);
        /* A call-back set on this browser's card, possibly not saved yet. */
        if (c.nextCallDate && (!co.nextCall || c.nextCallDate < co.nextCall)) co.nextCall = c.nextCallDate;
        if (!co.owner && c.owner) co.owner = c.owner;

        /* The company sits at the best rung any of its POCs has reached. */
        const r = STAGE_RUNG[c.stage] || 0;
        if (r > co.rung) { co.rung = r; co.stage = c.stage; }
        /* And the ACCOUNT STAGE is that same calculation over every contact,
           including the ones this browser has open but not saved yet. The
           server computed it from the KPI base; a contact moved on this card
           a moment ago is not in there, and the row should not wait for a
           save to tell the truth. */
        if (r > (STAGE_RUNG[co.acctStage] || 0)) co.acctStage = c.stage;

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

      /* ONLY CONTACTS THIS CONSOLE HAS WORKED COUNT. Opening an account loads
         its contacts from Kylas with whatever stage Kylas holds — "Activation",
         say — and counting that stage made every account anybody merely
         clicked on read as picked up and reached. Airtable, which this stands
         in for, only ever counts a stage a console save wrote, so the same rule
         here: a contact counts once a call was logged or a stage set on it in
         the console. Kylas' own stage still shows on the row; it just does not
         move the funnel. */
      const worked = co.contacts.filter((c) => c.lastCallAt || c.lastStageChangeAt);
      const workedRung = worked.reduce((m, c) => Math.max(m, STAGE_RUNG[c.stage] || 0), 0);
      /* Data-driven rungs. Event rows are typed in the console, so they are
         real signal whoever's contact they sit on. */
      co.right = co.pocs.right.length > 0;
      co.discovery = co.pocs.discovery.length > 0;
      co.picked = worked.some(picked);
      co.reached = worked.length > 0;
      /* Stage-driven rungs, each a floor on the ladder. Because KPI rank only
         rises, "is at or past" answers "ever reached" — a no-show still counts
         as booked, which is what Ayush means by "regardless of outcome". */
      co.booked = workedRung >= MILESTONE.sqlMeetingBooked.floor;
      co.done = workedRung >= MILESTONE.sqlMeetingDone.floor;
      co.sql = workedRung >= MILESTONE.sql.floor;

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
  /* The day it happened here, for display. */
  const day = (iso) => (iso ? (global.Day.dayOf(iso) || "—") : "—");

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
                  reportedTotal: null, short: 0, hitTheirCeiling: false,
                  readSource: "", syncedAt: "" };
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
    if (CACHE.building) {
      const held = CACHE.companies.length ? " Until then these are the companies this browser last had." : "";
      /* Say WHY it is still building, in terms of what to do about it. */
      if (CACHE.buildLastRun == null)
        return `<p class="vwarn">The company list has not been built yet, because the server's
          background job has never run. Its schedule is not set up in Cloudflare: open
          <b>Workers &amp; Pages</b> in the Cloudflare dashboard once, then run
          <code>npx wrangler deploy</code> again.${held}</p>`;
      if (CACHE.buildError) {
        const plan = /subrequest/i.test(CACHE.buildError.message || "")
          ? " Your Cloudflare account is on the Free plan, which does not allow a job this size — upgrade to Workers Paid in the Cloudflare dashboard."
          : "";
        return `<p class="vwarn">Building the company list from Kylas failed:
          ${esc(CACHE.buildError.message || "")}.${plan} It is tried again every minute.${held}</p>`;
      }
      return `<p class="vwarn">The server is building the company list from Kylas — the first
        time takes two or three minutes, and it fills in here by itself.${held}</p>`;
    }
    if (!CACHE.truncated) return "";
    const got = esc(String(CACHE.crawled));
    /* READ FROM THE MIRROR, the shortfall is the SYNC's, and the fix is to run
       the sync — not to re-ask Kylas, which is what the wording below would
       send somebody off to do. A message that names the wrong action is worse
       than one that names none. */
    if (CACHE.readSource === "airtable" && CACHE.reportedTotal != null)
      return `<p class="vwarn">This list is the Airtable mirror: ${got} companies,
        and Kylas reports <strong>${esc(String(CACHE.reportedTotal))}</strong> —
        ${esc(String(CACHE.short))} are not here. The last sync could not reach them,
        so every count below is short by that many.
        Run <code>node scripts/sync-kylas.mjs --apply</code>; if it still stops short,
        its log says why.</p>`;
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
        CACHE.readSource = held.readSource || "";
        CACHE.syncedAt = held.syncedAt || "";
      }
      /* The report and the RCA list, restored the same way the companies are.
         Both were memory-only, so every reopen of the console paid for them
         again from cold — and they are the two most expensive reads there are:
         the report walks the whole Call Log, the Rollup, every transition and
         every contact; the RCA list walks every contact and every RCA row.
         A dashboard that takes four seconds to show numbers it showed a minute
         ago is the thing being fixed. */
      const rep = await Store.getSetting("reportCache");
      if (rep && typeof rep === "object") for (const [k, v] of Object.entries(rep)) DISK.report[k] = v;
      const rca = await Store.getSetting("rcaCache");
      if (rca && typeof rca === "object") for (const [k, v] of Object.entries(rca)) DISK.rca[k] = v;
      /* The team roster and the trend chart too — the last two screens that
         opened on a spinner. Shown at once, asked again behind it. */
      const team = await Store.getSetting("teamCache");
      if (team?.list && !TEAM.list.length) {
        TEAM.list = team.list; TEAM.owners = team.owners || []; TEAM.configured = team.configured !== false;
      }
      const snap = await Store.getSetting("snapCache");
      if (snap?.rows && !SNAP.rows && snap.days === SNAP.days) SNAP.rows = snap.rows;
    } catch { /* storage is a convenience here, never a dependency */ }
  }

  /* ── stale while revalidate ───────────────────────────────────────────
     Airtable's trick, and it is not a longer timer: show what you have the
     instant you have it, ask again in the background, repaint only if the
     answer changed. The cost of being a minute stale is nothing; the cost of
     an empty screen is that nobody waits.

     Two entries per key, at most: the answer and when it arrived. Kept small
     and written back on every success, because the value of this is entirely
     in surviving the reload. */
  const DISK = { report: {}, rca: {} };
  const SWR_TTL = 5 * 60 * 1000;

  async function persist(which) {
    try {
      /* Only the most recent few keys. The report is keyed by level, owner and
         window, so drilling around a year would otherwise grow this without
         bound until the storage quota threw and took the whole cache with it. */
      const src = DISK[which];
      const keys = Object.keys(src).sort((a, b) => (src[b].at || 0) - (src[a].at || 0)).slice(0, 8);
      await Store.setSetting(which === "report" ? "reportCache" : "rcaCache",
        Object.fromEntries(keys.map((k) => [k, src[k]])));
    } catch { /* over quota is survivable — it is only a head start */ }
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
        /* The server has no company list from Kylas yet — its background job
           is building one. Keep whatever this browser holds, say so, and ask
           again in a minute rather than in five. */
        if (r.building) {
          CACHE.building = true; CACHE.error = "";
          CACHE.buildLastRun = r.lastRunSecondsAgo ?? null;
          CACHE.buildError = r.crawlError || null;
          CACHE.at = Date.now() - FRESH_MS + 60 * 1000;
          if (r.picklists) adoptPicklists(r.picklists);
          return;
        }
        CACHE.building = false;
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
        CACHE.readSource = r.source || "";
        CACHE.syncedAt = r.syncedAt || "";
        if (r.picklists) adoptPicklists(r.picklists);
        try {
          await Store.setSetting("companyCache",
            { at: CACHE.at, companies: CACHE.companies, owners: CACHE.owners,
              kpiSource: CACHE.kpiSource, kpiError: CACHE.kpiError,
              kpiMatched: CACHE.kpiMatched,
              truncated: CACHE.truncated, crawled: CACHE.crawled,
              reportedTotal: CACHE.reportedTotal, short: CACHE.short,
              hitTheirCeiling: CACHE.hitTheirCeiling,
              readSource: CACHE.readSource, syncedAt: CACHE.syncedAt });
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

  /* THE FOUR NUMBERS, before any table.
     The dashboard opened straight into a six-row funnel, a step-conversion
     table, a stacked bar and a period report — all correct, all requiring you
     to read a table before knowing whether today is going well. Ayush's ask was
     that the team stays constantly aware of where the KPIs stand, and a number
     you have to find is not one you are aware of.

     These are not new measurements. Every one is lifted from funnelRows, so the
     headline and the table below it cannot disagree — a summary computed a
     second way is a second answer waiting to happen.

     FOUR, not six. The last two rungs are the rarest events in the funnel and
     would show 0 most days, and four zeroes teach people to stop looking. The
     table underneath still has all six. */
  function headlineHTML(cos) {
    const rows = funnelRows(cos);
    const at = (key) => rows.find((r) => r.key === key) || { n: 0, fromPrev: null };
    const tiles = [
      { k: "reached",   label: "Companies reached", sub: "at least one call logged" },
      { k: "right",     label: "Right POC",         sub: "of reached" },
      { k: "discovery", label: "Discovery",         sub: "of right POC" },
      { k: "booked",    label: "SQL booked",        sub: "of discovery" },
    ];
    return `<div class="vgrid vhead4">${tiles.map((t, i) => {
      const r = at(t.k);
      return `<div class="vt${i ? " v2" : ""}">
        <b class="tnum">${r.n}</b>
        <span>${esc(t.label)}</span>
        <i>${i === 0 ? esc(t.sub) : `${r.fromPrev || "—"} ${esc(t.sub)}`}</i>
      </div>`;
    }).join("")}</div>`;
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
    if (SNAP.loading && !SNAP.rows) return `<p class="vnote">Loading the trend…</p>`;
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
    /* Once a session, even when a stored copy is already on screen. */
    if (SNAP.fetched || SNAP.error || SNAP.loading) return;
    SNAP.loading = true;
    const held = !!SNAP.rows;
    API.snapshots(SNAP.days)
      .then((r) => {
        SNAP.rows = r.snapshots || []; SNAP.error = r.reason || "";
        Store.setSetting("snapCache", { days: SNAP.days, rows: SNAP.rows }).catch(() => {});
      })
      /* A failed refresh keeps the stored copy rather than replacing it with an error. */
      .catch((e) => { if (!held) SNAP.error = e.message; })
      .finally(() => { SNAP.loading = false; SNAP.fetched = true; onReady(); });
  }

  /* ── the period report ─────────────────────────────────────────────── */
  /* Month, week, day — the same numbers, cut three ways, because "how are we
     doing" is a different question at each scale and a single 14-day window
     answers none of them well.

     Fetched once per (period, owner) and cached, so flipping between Month and
     Week is instant rather than a round trip each time. */
  const REP = { data: null, period: "week", owner: "", loading: false, error: "", key: "" };

  function ensureReport(period, owner, onReady, from = "", to = "") {
    const key = `${period}|${owner}|${from}|${to}`;
    if (REP.key === key && (REP.data || REP.error)) return false;
    if (REP.loading) return true;

    /* WHAT WE ALREADY HAVE, NOW. Painted before the request is even made, so
       switching level or reopening the console is instant on anything looked at
       in the last little while. `stale` is only about whether to ask again — it
       never withholds what is in hand. */
    const held = DISK.report[key];
    if (held) { REP.data = held.data; REP.error = ""; REP.key = key; REP.at = held.at; }
    const stale = !held || Date.now() - (held.at || 0) > SWR_TTL;
    if (!stale) return false;

    REP.loading = true; REP.key = key; REP.period = period; REP.owner = owner;
    API.report(period, owner, from, to)
      .then((r) => {
        REP.data = r; REP.error = r?.error || ""; REP.at = Date.now();
        if (!r?.error) { DISK.report[key] = { at: REP.at, data: r }; persist("report"); }
      })
      /* A failed revalidate must not throw away a good answer. Offline, the
         dashboard keeps showing last night's numbers and says how old they are,
         which is worth more than an error where a table was. */
      .catch((e) => { if (!held) { REP.data = null; REP.error = e.message; } })
      .finally(() => { REP.loading = false; onReady(); });
    /* Held something? Then nothing is "loading" as far as the view is
       concerned — there is a table on screen. */
    return !held;
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

  /* ── ONE TABLE ────────────────────────────────────────────────────────
     The dashboard used to be five views of the same six numbers: four tiles, a
     funnel table, a step-conversion table, a stacked bar per associate and a
     period table — each correct, each saying again what the one above it had
     just said. Ayush asked for a table. This is the table.

     COUNTS AND CONVERSIONS IN ONE GRID, not two. They are the same rows: the
     conversion is the count beside it divided by the count before it, and
     putting them in separate tables means reading a row twice to ask one
     question. Two header bands rather than two tables.

     LEVELS, top down. Year opens into quarters, a quarter into months, a month
     into weeks, a week into days — which is how somebody actually reads a
     number they do not like: what made that year, which quarter, which month,
     which day. The level buttons jump straight there; clicking a row goes down
     one and leaves a crumb to come back by. */
  const LEVELS = [
    { key: "year", label: "Year" },
    { key: "quarter", label: "Quarter" },
    { key: "month", label: "Month" },
    { key: "week", label: "Week" },
    { key: "day", label: "Day" },
  ];
  /* What each level opens into. Mirrors DRILL_INTO in report.mjs; the browser
     cannot import it, so it is stated once here and nowhere else. */
  const INTO = { year: "quarter", quarter: "month", month: "week", week: "day", day: null };

  /* The columns. `of` names the metric the rate is measured against, so the
     table and its header can never disagree about what a percentage means. */
  /* THE SAME RUNGS AS THE LADDER, so the two tables cannot disagree about a
     period. Calls stays as the first column because "how many dials went out"
     is a real question and the only one here that is not a company count; it
     sits outside the conversion band for that reason. */
  const COUNT_COLS = [
    { key: "calls", label: "Calls" },
    { key: "worked", label: "Worked" },
    { key: "picked", label: "Picked" },
    { key: "right", label: "Right POC" },
    { key: "discovery", label: "Discovery" },
    { key: "booked", label: "SQL booked" },
  ];
  const RATE_COLS = [
    { key: "picked", of: "worked", label: "→ Picked" },
    { key: "right", of: "picked", label: "→ Right POC" },
    { key: "discovery", of: "right", label: "→ Discovery" },
    { key: "booked", of: "discovery", label: "→ Booked" },
  ];

  /* Where the report is pointed: which level, and the window a drill-down has
     narrowed it to. The trail is what "back" means. */
  let DASH_LEVEL = "month";
  let DASH_FROM = "", DASH_TO = "";
  let DASH_TRAIL = [];

  /* Local, because the browser has no report.mjs. Only the two levels a drill
     can produce need it. */
  function rangeOf(level, key) {
    if (level === "year") return [`${key}-01-01`, `${key}-12-31`];
    if (level === "quarter") {
      const y = key.slice(0, 4), q = Number(key.slice(6));
      const first = (q - 1) * 3 + 1, last = first + 2;
      const endDay = new Date(Date.UTC(Number(y), last, 0)).getUTCDate();
      return [`${y}-${String(first).padStart(2, "0")}-01`,
              `${y}-${String(last).padStart(2, "0")}-${endDay}`];
    }
    if (level === "month") {
      const [y, m] = key.split("-");
      const endDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
      return [`${key}-01`, `${key}-${endDay}`];
    }
    if (level === "week") {
      /* Plain-date arithmetic on a plain date — no instant, so no timezone.
         Putting this through one would move the week's end a day. */
      return [key, global.Day.shiftDay(key, 6)];
    }
    return [key, key];
  }

  /* ── the ladder ───────────────────────────────────────────────────────
     From Ayush's reference design: the six rungs down the side, the team's
     number and its step conversion, then one column per associate with a bar
     scaled across that row. It answers the two questions the old dashboard
     needed four blocks for — where is the funnel leaking, and who is leaking it
     — in one grid you read left to right.

     The numbers are the SAME ones the Progress table below shows, for the same
     period: currentByOwner comes back with the report rather than from a second
     request, so this costs nothing and cannot disagree with the row it sits
     above. */
  /* THE LADDER COUNTS COMPANIES AT EVERY RUNG.
     It used to open on "Calls logged" and "Connected", which are per-CALL flows
     off the Call Log's outcome field, while the five rungs above them are
     per-COMPANY first arrivals. Two units in one column, so the thing could not
     be monotonic and wasn't: four calls all logged as no-answer gave Connected
     0 sitting directly under Right POC 2, which is impossible — you cannot
     reach the right person at a company nobody ever spoke to.

     The bottom two rungs are now Companies worked and Companies picked, counted
     from First Worked At / First Picked At, which the writer sets once per
     contact and never updates. That matters: the obvious source is the call
     log, and rollup-calls.mjs deletes old call rows, so anything derived from
     it drifts forward as history is compacted.

     "Picked", not "Connected" — Ayush's word, and the better one. A call is
     picked up or it is not; "connected" reads like a line status. */
  const RUNGS = [
    { key: "worked",    name: "Companies worked" },
    { key: "picked",    name: "Companies picked" },
    { key: "right",     name: "Right POC connected" },
    { key: "discovery", name: "Successful discovery call" },
    { key: "booked",    name: "SQL meeting booked" },
    { key: "done",      name: "SQL meeting done" },
    { key: "sql",       name: "SQL" },
  ];
  const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "—";
  const initials = (n) => {
    const p = String(n || "?").trim().split(/\s+/);
    return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase();
  };
  /* A stable colour per person, so the same associate is the same swatch on
     every screen. Hue only — it is an identifier, not a judgement, so it never
     borrows the accent or the flag colours. */
  const hueOf = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  /* ── the team panel ───────────────────────────────────────────────────
     Ticking who is in the funnel. A LIST OF EVERY NAME THE BASE HAS EVER
     RECORDED AS AN OWNER, not a box to type into: a typed name that does not
     match the Owner column exactly counts for nobody, silently, and there is
     nothing on screen that would ever say so.

     Membership is one checkbox. Role is beside it because it is worth knowing
     who somebody is, but it decides nothing — the design this came from tested
     the role text against a regular expression, and "BD Associate" instead of
     "Business Development Associate" drops a person out of the funnel with no
     explanation anywhere. */
  const TEAM = { list: [], owners: [], at: 0, loading: false, error: "", configured: true };

  function ensureTeam(repaint) {
    const held = TEAM.list.length > 0;
    if (TEAM.loading || (TEAM.at && Date.now() - TEAM.at < SWR_TTL)) return TEAM.loading && !held;
    TEAM.loading = true;
    API.team()
      .then((r) => {
        TEAM.list = r.team || []; TEAM.owners = r.owners || [];
        TEAM.configured = r.configured !== false; TEAM.error = "";
        Store.setSetting("teamCache", { list: TEAM.list, owners: TEAM.owners, configured: TEAM.configured })
          .catch(() => {});
      })
      .catch((e) => { if (!held) TEAM.error = e.message; })
      .finally(() => { TEAM.loading = false; TEAM.at = Date.now(); repaint?.(); });
    /* Holding a stored roster? Then nothing is "loading" as far as the view is concerned. */
    return !held;
  }

  function openTeamSheet(repaint) {
    const known = new Map(TEAM.list.map((p) => [p.name, p]));
    /* Every candidate, with what the roster currently says about them. A name
       nobody has ruled on is counted — so it opens ticked, which is what the
       report is already doing. */
    const rows = TEAM.owners.map((name) => ({
      name,
      role: known.get(name)?.role || "",
      inFunnel: known.has(name) ? known.get(name).inFunnel : true,
      seen: known.has(name),
    }));
    const s = document.createElement("div");
    s.className = "scrim";
    const draw = (msg) => {
      const n = rows.filter((r) => r.inFunnel).length;
      s.innerHTML = `<div class="sheet wide">
        <div class="h"><h3>Who is in the funnel</h3>
          <span class="vsub">${n} of ${rows.length}</span>
          <button class="gbtn" id="tx" type="button">Close</button></div>
        <div class="b">
          <p class="dnote">Only these people are counted in the team funnel and given a column on
            the ladder. Everyone the base has ever recorded as an owner is listed — leavers and
            admin accounts included, which is the point. A name nobody has ruled on counts.</p>
          <div class="teamrows">
            ${rows.map((r, i) => `<label class="teamrow">
              <input type="checkbox" data-i="${i}"${r.inFunnel ? " checked" : ""}>
              <span class="nm">${esc(r.name)}</span>
              <input class="role" type="text" data-role="${i}" value="${esc(r.role)}"
                placeholder="Role — optional" aria-label="Role for ${esc(r.name)}">
              ${r.seen ? "" : `<i class="new" title="Not on the roster yet">new</i>`}
            </label>`).join("")}
          </div>
          <div class="dactions">
            <button class="gbtn" id="tsave" type="button">Save roster</button>
            <span class="vsub" id="tmsg">${esc(msg || "")}</span>
          </div>
        </div></div>`;
      s.querySelector("#tx").onclick = () => { s.remove(); repaint?.(); };
      s.querySelectorAll("[data-i]").forEach((b) => b.onchange = () => {
        rows[Number(b.dataset.i)].inFunnel = b.checked;
        s.querySelector(".sheet .vsub").textContent =
          `${rows.filter((r) => r.inFunnel).length} of ${rows.length}`;
      });
      s.querySelectorAll("[data-role]").forEach((b) => b.oninput = () => {
        rows[Number(b.dataset.role)].role = b.value;
      });
      s.querySelector("#tsave").onclick = async () => {
        const msgEl = s.querySelector("#tmsg");
        msgEl.textContent = "saving…";
        try {
          const r = await API.teamSave(rows.map(({ name, role, inFunnel }) => ({ name, role, inFunnel })));
          TEAM.list = r.team || []; TEAM.at = Date.now();
          /* The report was built from the OLD roster, so it has to be asked
             again — otherwise the ladder keeps the columns you just removed.
             The stored copies go too: they are keyed by period and window, and
             every one of them counted the wrong population.

             REP.data IS LEFT ALONE. Nulling it blanked the ladder and the
             Progress table until the refetch landed — several seconds of empty
             page after a click, which reads as having broken something. The old
             numbers stay up and are replaced when the new ones arrive, which is
             what every other read here does. */
          for (const k of Object.keys(DISK.report)) delete DISK.report[k];
          persist("report");
          REP.key = "";
          s.remove(); repaint?.();
        } catch (e) { msgEl.textContent = `not saved — ${e.message}`.slice(0, 120); }
      };
    };
    draw();
    document.body.appendChild(s);
    s.addEventListener("click", (e) => { if (e.target === s) { s.remove(); repaint?.(); } });
  }

  function ladderHTML(r) {
    if (!r || !r.current) return "";
    const cur = r.current, prev = r.previous;
    const people = (r.currentByOwner || []).slice()
      .sort((a, b) => b.sql - a.sql || b.calls - a.calls || String(a.owner).localeCompare(String(b.owner)));
    const prevOf = Object.fromEntries((r.previousByOwner || []).map((o) => [o.owner, o]));
    const pc = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");

    /* Bars are scaled across THE ROW, not the table: rung 1 is always the
       biggest number and a single scale would flatten every rung below it into
       an invisible sliver. */
    const rowMax = RUNGS.map((rg) => Math.max(1, ...people.map((p) => p[rg.key] || 0)));

    return `
      <div class="vsec">
        <div class="vhead sm"><h2>The ladder</h2>
          <span class="vsub">${esc(cur.label)} · every number counts companies, not contacts</span>
          <button class="gbtn sm" id="teamBtn" type="button"
            title="Choose who is counted in the funnel">Team${people.length ? ` · ${people.length}` : ""}</button></div>
        ${(r.excluded || []).length ? `<p class="vnote">Not counted: ${
          r.excluded.map((n) => esc(n)).join(", ")}. Change that under <b>Team</b>.</p>` : ""}
        <div class="card scroll"><table class="ladder">
          <thead><tr>
            <th class="rung">Rung</th><th class="teamcol">Team</th><th class="conv">Step conv.</th>
            ${people.map((p) => `<th><span class="bdh" title="${esc(p.owner)}">
              <span class="av" style="background:hsl(${hueOf(p.owner)} 42% 44%)">${esc(initials(p.owner))}</span>
              <span>${esc(firstName(p.owner))}</span></span></th>`).join("")}
          </tr></thead>
          <tbody>
            ${RUNGS.map((rg, i) => {
              /* A RUNG CAN EXCEED THE ONE BELOW IT, legitimately. These count
                 ARRIVALS IN THIS PERIOD, and a company worked in January can
                 become a Right POC in March — March then shows 0 worked and 1
                 right POC. That is the correct answer to "what moved this
                 month", and it is also exactly what a broken funnel looks like,
                 so it is marked and explained rather than left to be guessed
                 at. Without this the table invites the reading Ayush gave it:
                 "I don't know why there is a mismatch." */
              const over = i > 0 && (cur[rg.key] || 0) > (cur[RUNGS[i - 1].key] || 0);
              return `<tr${over ? ' class="carried"' : ""}>
              <td class="rung"><span class="rungname">
                <i class="step r${Math.min(i, 5)}">${i + 1}</i>${esc(rg.name)}</span></td>
              <td class="teamcol"><b class="tnum">${cur[rg.key] || 0}</b>${
                prev ? deltaHTML(cur.delta ? cur.delta[rg.key] : null) : ""}</td>
              <td class="conv">${i === 0 ? "—"
                : `<b class="tnum">${pc(cur[rg.key] || 0, cur[RUNGS[i - 1].key] || 0)}</b>
                   <span>of ${esc(RUNGS[i - 1].name)}</span>${
                     over ? ` <i class="carry" title="More companies reached this rung than reached the one above it inside this period. They were worked earlier and moved up now \u2014 it is not a miscount.">carried in</i>` : ""}`}</td>
              ${people.map((p) => {
                const v = p[rg.key] || 0;
                return `<td><div class="cellv tnum${v ? "" : " zero"}">${v}</div>
                  <div class="lbar"><i class="r${Math.min(Math.max(i, 2), 5)}" style="width:${v / rowMax[i] * 100}%"></i></div></td>`;
              }).join("")}
            </tr>`;}).join("")}
          </tbody>
        </table></div>
        <p class="vnote">Every rung counts <b>companies</b>, and each one the companies that
          reached it <b>inside this period</b> — so a company worked in January and qualified in
          March counts under worked in January and under Right POC in March. A rung marked
          <i class="carry">carried in</i> has more companies than the rung above it for that
          reason, not because a number is wrong.</p>
        ${people.length > 1 ? "" : `<p class="vnote">One associate is in this period, so the
          per-person columns say the same thing as the team column. They separate as soon as more
          than one person logs a call inside it.</p>`}
      </div>`;
  }

  function reportSection(owner) {
    const loading = ensureReport(DASH_LEVEL, owner,
      () => dashboard(document.getElementById("vwrap")), DASH_FROM, DASH_TO);
    const r = REP.data;

    const crumbs = `<span class="vcrumbs">
      ${DASH_TRAIL.length ? `<button type="button" data-crumb="-1">All time</button>` : ""}
      ${DASH_TRAIL.map((t, i) => `<button type="button" data-crumb="${i}">${esc(t.label)}</button>`).join("")}
    </span>`;

    const head = `<div class="vhead sm">
        <h2>Progress</h2>
        <span class="vsub">${r ? `${esc(r.from)} to ${esc(r.to)}` : "counts and conversion, one row per period"}</span>
        ${crumbs}
        <span class="vperiod">${LEVELS.map((l) => `
          <button type="button" data-period="${l.key}" aria-pressed="${l.key === DASH_LEVEL}">${
            esc(l.label)}</button>`).join("")}</span>
      </div>`;

    if (REP.error) return head + (API.needsSignIn ? signInNote("the report needs a sign-in to build")
      : `<p class="vwarn">Could not build the report — ${esc(REP.error)}.</p>`);
    if (loading && !r) return head + `<p class="vnote">Reading the history…</p>`;
    if (!r || !r.periods.length) return head + `<p class="vnote">No history in this window yet.</p>`;

    const cur = r.current || {};
    /* THE SERVER'S PERIOD, not the one we asked for. A proxy that predates a
       level falls back to "week" without complaint, and drilling on rows that
       are not the level you think they are computes a window from the wrong key
       shape. Trust what came back. */
    const level = r.period || DASH_LEVEL;
    const stale = level !== DASH_LEVEL;
    const canDrill = !stale && !!INTO[level];
    const rate = (p, c) => {
      const d = p[c.of] || 0;
      if (!d) return "—";
      return Math.round(((p[c.key] || 0) / d) * 100) + "%";
    };

    const rows = [...r.periods].reverse().map((p) => `
      <tr${p.key === cur.key ? ' class="now"' : ""}${
        canDrill ? ` data-into="${esc(p.key)}" tabindex="0" role="button"` : ""}>
        <td class="pl">${esc(p.label)}${canDrill ? `<i class="into">\u203a</i>` : ""}</td>
        ${COUNT_COLS.map((c) => `<td class="tnum">${p[c.key] || 0}${
          p.delta && p.delta[c.key] ? ` ${deltaHTML(p.delta[c.key])}` : ""}</td>`).join("")}
        ${RATE_COLS.map((c) => `<td class="tnum rt">${rate(p, c)}</td>`).join("")}
      </tr>`).join("");

    return head + `
      ${stale ? `<p class="vwarn">This proxy does not know the
        <b>${esc(DASH_LEVEL)}</b> level and answered with <b>${esc(level)}</b> instead. It is running
        an older build than the console — restart it from the repo. Drilling is off until it
        matches, because the rows are not the period they are labelled.</p>` : ""}
      <div class="vsteps rtable onegrid">
        <table>
          <thead>
            <tr class="band">
              <th></th>
              <th colspan="${COUNT_COLS.length}">How many — calls, then companies</th>
              <th colspan="${RATE_COLS.length}" class="rt">Conversion, each from the one before</th>
            </tr>
            <tr>
              <th>${esc((LEVELS.find((l) => l.key === level) || {}).label || level)}</th>
              ${COUNT_COLS.map((c) => `<th>${esc(c.label)}</th>`).join("")}
              ${RATE_COLS.map((c) => `<th class="rt">${esc(c.label)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="vnote">${canDrill
        ? `Click any row to open it — ${esc(LEVELS.find((l) => l.key === DASH_LEVEL).label.toLowerCase())}
           opens into ${esc(INTO[DASH_LEVEL])}s. `
        : ""}Counted from the call log and the stage history, so every level is the same rows cut a
        different way and they always agree. A company is counted on the period it FIRST reached a
        rung — moving on, or back and forth, never counts twice.</p>`;
  }

  /* ── RCA: why an account stopped moving ────────────────────────────────
     The funnel already says WHERE accounts are lost. It cannot say why, and a
     conversion rate nobody can explain gets reported and never acted on.

     Asked here rather than on the contact card because it is a question about
     an account nobody has opened in a month — the one place it will never come
     up is the record itself. It rides above both views as a strip, not a modal:
     a dialog on load is dismissed by reflex, and this has to survive being
     ignored today and answered on Friday.

     WHO IS DUE IS THE PROXY'S ANSWER, not this file's. The rule is a management
     policy; six browsers deciding it independently is six policies. */
  const RCA = { due: [], gates: [], at: 0, loading: false, error: "", owner: null };

  /* WHOSE STALLED ACCOUNTS, resolved from whichever view is asking. Both views
     carry their own owner selection and they are different variables, so the
     strip has to be told rather than guess — asking for "" got the whole team's
     stalls onto one associate's screen, including accounts that were never
     theirs to explain.

     "" from the selector means me, "all" means the team and therefore no
     filter, and an id is somebody else, whose NAME is what the base stores. */
  function rcaOwner(sel) {
    if (sel === "all") return "";
    if (!sel) return API.state.user?.name || "";
    return CACHE.owners.find((o) => String(o.id) === String(sel))?.name || "";
  }

  /* Keyed on the resolved owner: the cache must not answer for one person with
     another's list, which a plain 5-minute timer would do the moment an admin
     switched the selector. */
  function ensureRca(sel, repaint) {
    const owner = rcaOwner(sel);
    const fresh = RCA.owner === owner && RCA.at && Date.now() - RCA.at < SWR_TTL;
    if (RCA.loading || fresh) return RCA.loading;

    /* Same as the report: show the stored answer at once, then revalidate. */
    const held = DISK.rca[owner];
    if (held && RCA.owner !== owner) {
      RCA.due = held.data.due || []; RCA.gates = held.data.gates || [];
      RCA.error = ""; RCA.at = held.at; RCA.owner = owner;
      if (Date.now() - (held.at || 0) <= SWR_TTL) return false;
    }
    RCA.loading = true;
    RCA.owner = owner;
    API.rca(owner)
      .then((r) => {
        RCA.due = r.due || []; RCA.gates = r.gates || []; RCA.error = "";
        DISK.rca[owner] = { at: Date.now(), data: { due: RCA.due, gates: RCA.gates } };
        persist("rca");
      })
      /* A failure here must not take the view with it. The dashboard's job is
         the funnel; this is an addition to it. */
      /* Keep what we had rather than blanking the strip on a failed refresh. */
      .catch((e) => { if (!held) { RCA.error = e.message; RCA.due = []; } })
      .finally(() => { RCA.loading = false; RCA.at = Date.now(); repaint?.(); });
    return true;
  }

  const rcaGate = (key) => RCA.gates.find((g) => g.key === key) || null;

  function rcaStrip() {
    if (RCA.error) return "";
    const n = RCA.due.length;
    if (!n) return "";
    /* One line. The count is the message; the detail is one click away, because
       a strip that lists nine accounts is a view, and this sits on top of one. */
    const worst = RCA.due[0];
    return `<div class="vrca">
      <b>${n}</b>
      <span>account${n === 1 ? "" : "s"} stalled with no reason recorded${
        worst ? ` — longest is <b>${esc(worst.name)}</b>, ${worst.days} days` : ""}</span>
      <button class="gbtn sm" id="rcaOpen" type="button">Give reasons</button>
    </div>`;
  }

  /* One account at a time, largest stall first, with the reasons as chips.
     Typing is optional and the note is the only free text — the whole point is
     that an answer costs one click, or it will not be given. */
  function openRcaSheet(repaint) {
    const s = document.createElement("div");
    s.className = "scrim";
    let i = 0;
    const draw = () => {
      const item = RCA.due[i];
      if (!item) {
        s.innerHTML = `<div class="sheet"><div class="h"><h3>Done</h3>
          <button class="gbtn" id="rx" type="button">Close</button></div>
          <div class="b"><p class="dnote">Every stalled account has a reason recorded.</p></div></div>`;
        s.querySelector("#rx").onclick = () => { s.remove(); repaint?.(); };
        return;
      }
      const g = rcaGate(item.gate);
      s.innerHTML = `<div class="sheet wide">
        <div class="h"><h3>${esc(g?.title || "Why has this stalled?")}</h3>
          <span class="vsub">${i + 1} of ${RCA.due.length}</span>
          <button class="gbtn" id="rx" type="button">Close</button></div>
        <div class="b">
          <div class="rcaWho"><b>${esc(item.name)}</b>
            <em>stuck ${item.days} days · since ${esc(day(item.since))}</em></div>
          <p class="dnote">${esc(g?.ask || "")}</p>
          <div class="rcaReasons">${(g?.reasons || []).map((r) =>
            `<button class="rchip" type="button" data-code="${esc(r.code)}">${esc(r.label)}</button>`).join("")}</div>
          <label class="rcaNote">Anything worth remembering (optional)
            <textarea id="rcaNote" rows="2" placeholder="e.g. asked us to call back after their AGM"></textarea></label>
          <div class="dactions">
            <button class="gbtn" id="rcaSkip" type="button">Skip for now</button>
            <span class="vsub" id="rcaMsg"></span>
          </div>
        </div></div>`;
      s.querySelector("#rx").onclick = () => { s.remove(); repaint?.(); };
      s.querySelector("#rcaSkip").onclick = () => { i++; draw(); };
      s.querySelectorAll(".rchip").forEach((b) => b.onclick = async () => {
        const msg = s.querySelector("#rcaMsg");
        s.querySelectorAll(".rchip").forEach((x) => { x.disabled = true; });
        b.classList.add("on");
        msg.textContent = "saving…";
        try {
          await API.rcaAnswer({
            kid: item.kid, recordId: item.recordId, gate: item.gate,
            reason: b.dataset.code, note: s.querySelector("#rcaNote").value.trim(),
            since: item.since, days: item.days, owner: item.owner,
            by: API.state.user?.name || item.owner,
          });
          /* Removed from the list here rather than re-fetching: the proxy would
             give the same answer, and a round trip between two clicks is how a
             nine-account queue stops being worth finishing. */
          RCA.due.splice(i, 1);
          draw();
        } catch (e) {
          s.querySelectorAll(".rchip").forEach((x) => { x.disabled = false; });
          b.classList.remove("on");
          msg.textContent = `not saved — ${e.message}`.slice(0, 120);
        }
      });
    };
    draw();
    document.body.appendChild(s);
    s.addEventListener("click", (e) => { if (e.target === s) { s.remove(); repaint?.(); } });
  }

  function wireRca(host, repaint) {
    const b = host.querySelector("#rcaOpen");
    if (b) b.addEventListener("click", () => openRcaSheet(repaint));
  }

  /* ── dashboard ─────────────────────────────────────────────────────── */
  let DASH_OWNER = "";          /* "" = me, "all" = the team */

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
      ${CACHE.error ? (API.needsSignIn
        ? signInNote("showing only the companies this browser holds, so these counts are not your real funnel")
        : `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        Showing only the companies this browser holds, so these counts are not your real funnel.</p>`) : ""}
      ${truncWarn()}
      ${/* THE FOUR TILES ARE GONE, and the ladder is why. They counted companies
           sitting at a rung RIGHT NOW, all time; the ladder counts companies
           that FIRST reached it inside the period. Both are useful and they are
           not the same question — but under the same six words, on one screen,
           "Companies reached 34" above "Companies reached 0" reads as a bug.
           The ladder is the one Ayush's design asks for and the one with the
           conversions in it, so it keeps the labels. headlineHTML is still in
           this file if the all-time view is wanted back somewhere it cannot be
           mistaken for this one. */""}
      ${rcaStrip()}
      ${/* THE LADDER FIRST, then the period table under it. The ladder is this
           period across the team and each associate; the table is every period.
           Same numbers, same report, one request. */
        ladderHTML(REP.data)}
      <div class="vsec">${reportSection(DASH_OWNER === "all" ? "all" : "")}</div>
      ${/* THE PER-ASSOCIATE COMPARISON SURVIVES, but only where it answers
           something. On your own numbers it is one row saying what the four
           tiles above already said; across the team it is the only place you
           can see whose funnel is leaking. The funnel table, the stacked bar
           and the trend chart are gone from the page — each was a fifth view of
           the same six numbers. stepTable, stackedByOwner, funnelHTML and
           trendChart are all still in this file, so putting any of them back is
           one line. */
        team ? `<div class="vsec">${stepTable(cos, (c) => c.owner)}</div>` : ""}`;

    const sel = document.getElementById("dOwner");
    /* No network: the whole account is already held, so this is a filter. */
    if (sel) sel.onchange = () => { DASH_OWNER = sel.value; dashboard(host); };
    const rf = document.getElementById("dRefresh");
    if (rf) rf.onclick = () => { ensureCompanies(DASH_OWNER, () => dashboard(host), true); dashboard(host); };
    /* A level button JUMPS, and a jump is a fresh start: keeping a window from
       a drill-down would show "Year" filtered to one week and look broken. */
    host.querySelectorAll(".vperiod button").forEach((b) => {
      b.onclick = () => {
        DASH_LEVEL = b.dataset.period;
        DASH_FROM = ""; DASH_TO = ""; DASH_TRAIL = [];
        dashboard(host);
      };
    });

    /* Opening a row: go down one level, narrowed to that row's dates, and leave
       a crumb. The crumb carries the window it came from rather than being
       recomputed on the way back — recomputing is how a breadcrumb ends up
       somewhere the user has never been. */
    const drill = (key) => {
      const next = INTO[DASH_LEVEL];
      if (!next) return;
      let [from, to] = rangeOf(DASH_LEVEL, key);
      if (!from || !to || /NaN/.test(from + to)) return;   /* never navigate to a window we cannot compute */
      /* CLAMPED TO TODAY. Opening the current year handed back four quarters,
         and the three that have not happened yet sat at the top of the table as
         zeros — the newest period is first, so the first thing you read after
         drilling was a row about the future. A period that has not started is
         not a period with no activity. */
      const today = global.Day.today();
      if (from > today) return;
      if (to > today) to = today;
      const row = REP.data?.periods.find((p) => p.key === key);
      DASH_TRAIL = [...DASH_TRAIL, { label: row?.label || key, level: DASH_LEVEL, from, to }];
      DASH_LEVEL = next; DASH_FROM = from; DASH_TO = to;
      dashboard(host);
    };
    host.querySelectorAll("tr[data-into]").forEach((tr) => {
      tr.addEventListener("click", () => drill(tr.dataset.into));
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drill(tr.dataset.into); }
      });
    });
    host.querySelectorAll(".vcrumbs button").forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.crumb);
        if (i < 0) { DASH_TRAIL = []; DASH_FROM = ""; DASH_TO = ""; DASH_LEVEL = "month"; }
        else {
          const t = DASH_TRAIL[i];
          DASH_TRAIL = DASH_TRAIL.slice(0, i);
          DASH_LEVEL = t.level;
          const prev = DASH_TRAIL[DASH_TRAIL.length - 1];
          DASH_FROM = prev ? prev.from : ""; DASH_TO = prev ? prev.to : "";
        }
        dashboard(host);
      };
    });
    /* Fetched once per session; the view repaints when it lands. */
    ensureSnapshots(() => dashboard(host));
    ensureRca(DASH_OWNER, () => dashboard(host));
    wireRca(host, () => dashboard(host));
    ensureTeam(() => dashboard(host));
    const tb = host.querySelector("#teamBtn");
    if (tb) tb.addEventListener("click", () => openTeamSheet(() => dashboard(host)));
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

  /* ── the board ─────────────────────────────────────────────────────────
     A COMPANY IS IN YOUR LOOP UNTIL IT LEAVES IT, and the question the list has
     to answer is which ones are still in it and which have gone quiet. The
     table answers "what do I have"; it takes a sort and two filters to answer
     "what do I do next", and that is the question 200 times a day.

     COLUMNS ARE THE LOOP STATE, NOT THE SOURCE. Source says where a name came
     from, which is how you pick today's pile — a filter. It says nothing about
     what to do with the account, so a board keyed on it shows six piles that
     all need the same unknown amount of work. The state is the thing that
     changes, so the state is the axis.

     Assignment reuses bucketOf, the same exclusive buckets the dashboard's
     stacked bar is built from, so the board and the chart cannot come to
     different conclusions about where a company stopped. Two ends collapse:
     everything past a booked meeting is one column, because the loop this is
     for ends when the meeting is in the diary, and everything with no call yet
     is one column, because bucketOf has nothing to say about it. */
  const LANES = [
    { key: "untouched", label: "Untouched", hint: "allotted, never called" },
    { key: "working",   label: "Working",   hint: "called, no signal yet" },
    { key: "right",     label: "Right POC", hint: "budget, timeline or pax" },
    { key: "discovery", label: "Discovery", hint: "one complete row" },
    { key: "booked",    label: "SQL booked", hint: "meeting in the diary" },
    { key: "closed",    label: "Closed",    hint: "every POC on a dead end" },
  ];

  /* EXHAUSTION IS A PROPERTY OF EVERY POC, NOT OF THE HIGHEST ONE.
     co.stage is the HIGHEST rung any POC reached, and the dead ends sit low on
     the ladder — so a company whose only contact is Not Interested still shows
     MQL, and testing that would leave it in the working column for ever. It has
     left the loop when there is nobody left to call.

     The second clause is not a nicety. On the companies list NO contacts are
     loaded — the view reads the Airtable mirror, not the console's roster — so
     the first clause is false for every row on the page it matters most on, and
     the Closed column sat empty while three companies that belonged in it were
     filed under Working. The company's own stage is the only evidence available
     there, and it is real evidence. */
  const exhausted = (co) =>
    (co.contacts.length > 0 && co.contacts.every((c) => EXIT_STAGES.includes(c.stage)))
    || (co.contacts.length === 0 && EXIT_STAGES.includes(co.kylasStage));

  function laneOf(co) {
    if (exhausted(co)) return "closed";
    const b = bucketOf(co);                 /* null when never reached */
    if (!b) return "untouched";
    if (b === "sql" || b === "done" || b === "booked") return "booked";
    if (b === "reached") return "working";
    return b;                               /* right | discovery */
  }

  /* Days since the last call — the whole prioritisation signal. Null for a
     company nobody has called, which is not "infinitely stale", it is a
     different state with its own column. */
  /* MIDNIGHTS CROSSED, not hours elapsed. This was
     `Math.floor((Date.now() - t) / 864e5)`, a rolling twenty-four hours — so
     a call at 23:00 yesterday read "Today" at nine this morning, with a green
     freshness dot, on an account nobody had touched since the day before.
     Everything downstream of this is affected: the Last call column, the five
     freshness bands, the stale flag and "Days since last call". day.js. */
  const daysSince = (iso) => global.Day.daysAgo(iso);
  /* Amber is the flag colour and this is a flag: an account in the loop that
     nobody has touched in a fortnight is the thing the board exists to surface.
     One threshold, not a gradient — a scale of five ambers is a heat map, and a
     heat map is read as decoration. */
  const STALE_DAYS = 14;

  /* ── ACCOUNTS: the stage families, and the explorer under them ─────────
     From Ayush's reference design. Two halves that answer different halves of
     one question: the FAMILIES say what shape the book is in — how much has
     never been touched, how much is stuck trying to connect, how much is
     actually being talked to — and the EXPLORER is where you go once a tile
     tells you which pile to look at.

     Families come from docs/stages.json, where every stage is placed by hand.
     The reference sorted them with regular expressions over the stage name,
     which is right for sample data and wrong for a picklist we know: "Followup
     - CNC" matches both the follow-up rule and the CNC rule and whichever is
     written first silently wins. gen-stages refuses a stage in no family or in
     two.

     EVERYTHING IS COMPUTED FROM THE LIST ALREADY IN MEMORY. The companies are
     fetched once for the board and the dashboard; the families, the tiles, the
     freshness bars, every chip count and the table are all passes over that
     same array. No request is made for any of it. */
  const FRESH = [
    { k: "fresh", label: "Called ≤ 7 days", max: 7 },
    { k: "warm",  label: "8–30 days",      max: 30 },
    { k: "cool",  label: "31–90 days",     max: 90 },
    { k: "cold",  label: "90+ days",            max: Infinity },
    { k: "never", label: "Never called",        max: null },
  ];
  const freshOf = (co) => {
    const d = daysSince(co.lastCalledAt);
    if (d === null) return "never";
    return FRESH.find((f) => f.max !== null && d <= f.max).k;
  };

  /* The rung a company has reached, as an index into KPI_LABELS. -1 is "not
     reached". Read off the same booleans the board and the funnel use, highest
     first, so a company cannot be one rung here and another there. */
  const KPI_LABELS = ["Not reached", "Reached", "Right POC", "Discovery", "SQL booked", "SQL done", "SQL"];
  const KPI_ORDER = ["reached", "right", "discovery", "booked", "done", "sql"];
  const kpiOf = (co) => {
    for (let i = KPI_ORDER.length - 1; i >= 0; i--) if (co[KPI_ORDER[i]]) return i;
    return -1;
  };

  /* Filter state for the explorer. A SET per dimension, same as the board's
     filters — "Apollo and LinkedIn but not Referral" is an ordinary question. */
  /* STAGE IS A CHIP ROW, NOT A PANE. It used to be six blocks of tiles above
     the table — most of the first screen, one stage selectable at a time, and
     no way at all to reach the 5,949 companies Kylas has no stage for, because
     a company with no stage belongs to no family and so had no tile. A set of
     chips answers the same question in one line, takes two stages at once, and
     has a chip for the blank. */
  const ACC = { stages: new Set(), stageOpen: false, stageFind: "", sources: new Set(), kpis: new Set(),
                /* CALL-BACKS FIRST IS THE DEFAULT ORDER. A promised call-back is
                   the one thing on this screen with a deadline, so an account
                   due today should not have to be sorted for — it is the first
                   thing the list shows, every morning, with no clicks. With no
                   call-backs set anywhere this degrades to last-call-newest,
                   which is what the list used to open on. */
                fresh: new Set(), owner: "", sort: "next", limit: 100, offsite: "",
                srcOpen: false, srcFind: "", srcScroll: 0,
                /* the condition, as in Airtable's text filter */
                srcOp: "any", srcText: "",
                /* "" | "focus" | "normal" | "depri" — the focus-list status */
                /* the focus list and the call-back, as chip rows on top of
                   every other filter */
                focusSet: new Set(), nextSet: new Set(),
                /* which columns are shown, and whether the picker is open.
                   Filled from the stored choice on first paint. */
                cols: new Set(), colsOpen: false,
                /* REQ-03's bands. Each is a Set of band keys ("r3", "f1", a
                   source employee bucket, a funding-stage name), plus a floor
                   for the priority score. The bands themselves are computed
                   from the raw number every time — see enrich.js. */
                rev: new Set(), emp: new Set(), round: new Set(), fstage: new Set(),
                offsiteSet: new Set(), priMin: "", moreOpen: false,
                /* the demand team's own pipeline stage, out of Company List */
                apsSet: new Set(),
                /* THE SEARCH BOX. One string, every word of which has to land
                   somewhere on the row — see textOf below. Not remembered and
                   not in the stored preference: it is the most temporary
                   question on the screen. */
                q: "",
                /* Hand-set column widths, in pixels, keyed by column. Absent
                   means "whatever the layout gives it". */
                widths: {},
                /* "table" or "board". The board is the same rows, the same
                   filters and the same sort, stacked into the six call
                   buckets instead of listed. */
                view: "table" };
  const focusOf = (co) => (global.Focus ? Focus.of(co.id) : "normal");
  let priTimer = null, qTimer = null;
  /* The column being dragged, or null. Module-level because the listeners
     that read it are bound once and outlive any one paint. */
  let GRIP = null;

  /* WHAT IS REMEMBERED, AND WHAT IS NOT. The columns and the bands are a way
     of working — a BD who lives in funding stage should find it there
     tomorrow. The owner, the stage and the call-back chips are a question
     being asked right now, and restoring those would mean opening the list
     one morning already filtered to something you set last Thursday and have
     forgotten. So: the shape of the table persists, the question does not. */
  const ACC_PREF = "accountsView";
  let prefsReady = false;
  async function loadAccPrefs() {
    if (prefsReady) return;
    prefsReady = true;
    let saved = null;
    try { saved = await Store.getSetting(ACC_PREF); } catch { /* first run */ }
    ACC.cols = new Set(Array.isArray(saved?.cols) ? saved.cols.filter((k) => ACOLS.some((c) => c.k === k))
                                                  : COL_DEFAULTS);
    if (saved?.sort && SORT_KEYS.includes(saved.sort)) ACC.sort = saved.sort;
    if (saved?.view === "board" || saved?.view === "table") ACC.view = saved.view;
    if (saved?.widths && typeof saved.widths === "object")
      for (const [k, w] of Object.entries(saved.widths))
        if (ACOLS.some((c) => c.k === k) && Number.isFinite(Number(w))) ACC.widths[k] = Number(w);
    /* A link wins over the stored preference: somebody followed it to see
       one particular thing, and showing them their own columns instead is
       not what they clicked. */
    readHash();
  }
  const saveAccPrefs = () => {
    try { Store.setSetting(ACC_PREF, { cols: [...ACC.cols], sort: ACC.sort, widths: ACC.widths, view: ACC.view }); }
    catch { /* a browser with no storage still works, it just forgets */ }
  };
  const SORT_KEYS = ["next", "recent", "stale", "kpi", "priority", "revenue", "az"];

  /* ── a filter set as a link ──────────────────────────────────────────
     "Everyone in ₹100–500 Cr with a call-back overdue" is a question worth
     sending to somebody, and reading out eight chips over a call is not
     sending it. The whole filter state encodes into the console's own URL,
     which every associate can open because they all have the extension: the
     link is chrome-extension://<the same id>/console/console.html#accounts=…

     Written to the address bar as it changes, so Back works and a reload
     keeps the question, and read on open. Not a router — one parameter, and
     anything in it the console does not recognise is ignored rather than
     being an error, because a link outlives the filter it was made with. */
  const LINK_SETS = { stage: "stages", src: "sources", kpi: "kpis", fresh: "fresh", next: "nextSet",
                      focus: "focusSet", rev: "rev", emp: "emp", round: "round", fstage: "fstage",
                      off: "offsiteSet", aps: "apsSet" };
  function filtersToQuery() {
    const q = new URLSearchParams();
    for (const [short, prop] of Object.entries(LINK_SETS))
      if (ACC[prop].size) q.set(short, [...ACC[prop]].join("~"));
    if (ACC.owner) q.set("owner", ACC.owner);
    if (ACC.q) q.set("q", ACC.q);
    if (ACC.priMin !== "") q.set("pri", ACC.priMin);
    if (ACC.srcOp !== "any" && ACC.srcText) { q.set("srcop", ACC.srcOp); q.set("srctext", ACC.srcText); }
    if (ACC.sort !== "next") q.set("sort", ACC.sort);
    if (FB.tree.items.length) q.set("fb", JSON.stringify(FB.tree));
    q.set("cols", [...ACC.cols].join("~"));
    return q.toString();
  }
  function applyQuery(str) {
    const q = new URLSearchParams(str || "");
    if (![...q.keys()].length) return false;
    for (const [short, prop] of Object.entries(LINK_SETS)) {
      ACC[prop].clear();
      for (const v of (q.get(short) || "").split("~").filter(Boolean))
        ACC[prop].add(prop === "kpis" ? Number(v) : v);
    }
    ACC.owner = q.get("owner") || "";
    ACC.q = q.get("q") || "";
    ACC.priMin = q.get("pri") || "";
    ACC.srcOp = q.get("srcop") || "any";
    ACC.srcText = q.get("srctext") || "";
    if (SORT_KEYS.includes(q.get("sort"))) ACC.sort = q.get("sort");
    /* A tree out of a link is text somebody could have edited. Anything that
       is not the shape this build understands is dropped, not repaired. */
    try {
      const t = JSON.parse(q.get("fb") || "null");
      FB.tree = t && Array.isArray(t.items) ? { join: t.join === "or" ? "or" : "and", items: t.items } : { join: "and", items: [] };
    } catch { FB.tree = { join: "and", items: [] }; }
    const cols = (q.get("cols") || "").split("~").filter((k) => ACOLS.some((c) => c.k === k));
    if (q.has("cols")) ACC.cols = new Set(cols);
    return true;
  }
  const HASH = "#accounts=";
  function writeHash() {
    if (!global.location || VIEW_MODE !== "accounts") return;
    const next = HASH + filtersToQuery();
    if (location.hash !== next) history.replaceState(null, "", next);
  }
  function readHash() {
    const h = String(global.location?.hash || "");
    return h.startsWith(HASH) ? applyQuery(h.slice(HASH.length)) : false;
  }

  /* WHAT THE SEARCH BOX LOOKS AT. Everything on the row that is a name
     rather than a number: the company, who owns it, where it came from, both
     pipeline stages. Not the money — "100" would match half the list through
     a revenue figure nobody was searching for. */
  const textOf = (co) => [co.name, co.owner, co.source, label(stageOf(co)), co.enrich?.aps]
    .filter(Boolean).join(" ").toLowerCase();
  /* Every word has to land, in any order and anywhere on the row: "acme ravi"
     finds Ravi's Acme without caring which column holds which.

     The terms are split once per query, not once per company. accMatch runs
     for every chip on every row — eight chip rows over 17,900 accounts is
     most of a million calls per keystroke, and splitting a string inside that
     is a quarter of a second the box spends not showing what was typed. */
  let Q_TERMS = [], Q_FOR = null;
  const qTerms = () => {
    if (ACC.q !== Q_FOR) { Q_FOR = ACC.q; Q_TERMS = ACC.q.toLowerCase().split(/\s+/).filter(Boolean); }
    return Q_TERMS;
  };
  const qMatch = (co) => {
    const terms = qTerms();
    if (!terms.length) return true;
    const hay = textOf(co);
    return terms.every((t) => hay.includes(t));
  };

  /* `skip` leaves one dimension out, so a chip row can show what its own
     options WOULD give rather than counting only what is already selected —
     otherwise every unticked chip reads 0 and the filter cannot be widened.
     The search box is NOT skippable: it is the question being asked, and a
     chip counting rows the search has already ruled out would be lying. */
  function accMatch(co, skip) {
    if (!qMatch(co)) return false;
    if (skip !== "stage" && ACC.stages.size && !ACC.stages.has(stageOf(co) || "")) return false;
    if (ACC.owner && String(co.owner || "") !== ACC.owner) return false;
    if (skip !== "source" && !sourceMatches(co.source || "")) return false;
    if (skip !== "offsite" && ACC.offsiteSet.size &&
        !VALUE_OF.offsite(co).some((q) => ACC.offsiteSet.has(q))) return false;
    if (skip !== "rev" && ACC.rev.size && !ACC.rev.has(VALUE_OF.rev(co))) return false;
    if (skip !== "emp" && ACC.emp.size && !ACC.emp.has(VALUE_OF.emp(co))) return false;
    if (skip !== "round" && ACC.round.size && !ACC.round.has(VALUE_OF.round(co))) return false;
    if (skip !== "fstage" && ACC.fstage.size && !ACC.fstage.has(VALUE_OF.fstage(co))) return false;
    if (skip !== "aps" && ACC.apsSet.size && !ACC.apsSet.has(VALUE_OF.aps(co))) return false;
    /* "at least N". A company with no score is not "0" — it is unscored, so it
       drops out of a floor rather than sitting at the bottom of it. */
    if (ACC.priMin !== "" && !(Number(co.enrich?.pri) >= Number(ACC.priMin))) return false;
    /* The condition builder, ANDed after everything the chips said. */
    if (skip !== "fb" && !fbMatchNode(co, FB.tree)) return false;
    if (skip !== "focus" && ACC.focusSet.size && !ACC.focusSet.has(focusOf(co))) return false;
    if (skip !== "next" && ACC.nextSet.size && !ACC.nextSet.has(nextOf(co))) return false;
    if (skip !== "kpi" && ACC.kpis.size && !ACC.kpis.has(kpiOf(co))) return false;
    if (skip !== "fresh" && ACC.fresh.size && !ACC.fresh.has(freshOf(co))) return false;
    return true;
  }

  /* THE FAMILIES STRIP IS GONE — it was six blocks of stage tiles above the
     table, and `famsHTML` rendered it. Removed for the Stage chip row below:
     the tiles ate the first screen to say what one line of chips says, only
     one stage could be lit at a time, and a company Kylas has no stage for
     belonged to no family, so thousands of accounts had no tile to reach them
     by. The freshness bar under each tile went with it; "Last call" is its own
     chip row and answers the same question for whatever is on screen. */

  /* ── the explorer ─────────────────────────────────────────────────── */
  /* What each chip row reads off a company. One place, so a row's counts and
     its filter can never disagree about what the chip means. Each is wrapped
     rather than named directly: half of these are declared further down the
     file, and naming them here would read them before they exist. */
  const VALUE_OF = {
    source: (c) => c.source || "—",
    kpi: (c) => kpiOf(c),
    focus: (c) => focusOf(c),
    next: (c) => nextOf(c),
    fresh: (c) => freshOf(c),
    stage: (c) => stageOf(c) || "",
    /* THE BANDS. Computed from the raw number on every read — nobody types
       "₹50–100 Cr" into a field, and a band that was written down once is
       wrong the day the number behind it changes. */
    rev: (c) => global.Enrich.bandOf(global.Enrich.REVENUE_BANDS, c.enrich?.rev ?? null),
    round: (c) => global.Enrich.bandOf(global.Enrich.ROUND_BANDS, c.enrich?.amt ?? null),
    emp: (c) => c.enrich?.emp || global.Enrich.UNKNOWN,
    fstage: (c) => c.enrich?.type || global.Enrich.UNKNOWN,
    aps: (c) => c.enrich?.aps || global.Enrich.UNKNOWN,
    /* A company can name more than one quarter, so this one answers with a
       list and the chips mean "contains any" — see MULTI below. */
    offsite: (c) => ((c.offsite || []).length ? c.offsite : [global.Enrich.UNKNOWN]),
  };
  /* Rows whose value is a LIST. Their chips count a company once per value it
     holds, and select as "has any of these" rather than "is one of these". */
  const MULTI = new Set(["offsite"]);

  /* `values` fixes the chips and their order; pass null to take them from the
     data instead, busiest first. `limit` then caps how many are shown until
     the row is expanded — with the picked ones always among them, because a
     chip you cannot see is a filter you cannot turn off. */
  const chipRow = (all, lbl, key, values, labelOf, set, swatch, opts = {}) => {
    const pool = all.filter((c) => accMatch(c, key));
    const cnt = new Map();
    for (const c of pool) {
      for (const v of MULTI.has(key) ? VALUE_OF[key](c) : [VALUE_OF[key](c)])
        cnt.set(v, (cnt.get(v) || 0) + 1);
    }
    let vals = values || [...new Set([...cnt.keys(), ...set])]
      /* `byFloor` keeps a banded row in its own order rather than by count:
         employee buckets are a scale, and "10000+" before "51-200" (which is
         what sorting them as text gives) reads as a mistake. */
      .sort(opts.byFloor
        ? (a, b) => global.Enrich.empFloor(a) - global.Enrich.empFloor(b)
        : (a, b) => (cnt.get(b) || 0) - (cnt.get(a) || 0)
          || String(labelOf(a)).localeCompare(String(labelOf(b))));
    const cap = opts.limit || 0;
    let extra = 0;
    if (cap && !opts.expanded && vals.length > cap) {
      const picked = vals.filter((v) => set.has(v));
      const rest = vals.filter((v) => !set.has(v));
      const shown = [...picked, ...rest].slice(0, Math.max(cap, picked.length));
      extra = vals.length - shown.length;
      vals = shown;
    }
    const chip = (v) => {
      const n = cnt.get(v) || 0;
      return `<button class="chip${n ? "" : " zero"}" type="button" data-f="${key}" data-v="${esc(String(v))}"
        aria-pressed="${set.has(v)}">${swatch ? swatch(v) : ""}${esc(labelOf(v))}<span class="k tnum">${n}</span></button>`;
    };
    return `<div class="frow"><span class="lbl">${esc(lbl)}</span>${vals.map(chip).join("")}${
      extra ? `<button class="chip more" type="button" data-more="${esc(key)}">+${extra} more ${
        esc(extra === 1 ? (opts.moreOne || "value") : (opts.moreNoun || "values"))}</button>`
      : opts.expanded && cap ? `<button class="chip more" type="button" data-more="${esc(key)}">Show fewer</button>` : ""}</div>`;
  };

  /* SOURCE OF DATA, the way Airtable's own filter works. It is free text in
     Kylas, so a full account carries hundreds of distinct values: one chip each
     buried the table under a screen of them, and a native select cannot pick
     more than one or be searched. So a button that says what is picked, and a
     panel with a search box, a checkbox per value with how many accounts it
     holds (under the other filters), picked values pinned to the top, and a
     Clear. Ticking applies at once, as in Airtable. */
  const srcName = (v) => (v === "—" ? "No source" : v);
  /* The conditions Source of Data can be filtered by. It is free text, so
     "contains" matters as much as picking values: "GPTW" is in a hundred
     differently-spelled sources. */
  const SRC_OPS = {
    any: "is any of", none: "is none of", contains: "contains", notcontains: "does not contain",
    empty: "is empty", notempty: "is not empty",
  };
  function sourceMatches(src) {
    const v = String(src || "");
    const t = ACC.srcText.trim().toLowerCase();
    switch (ACC.srcOp) {
      case "any": return !ACC.sources.size || ACC.sources.has(v || "—");
      case "none": return !ACC.sources.size || !ACC.sources.has(v || "—");
      case "contains": return !t || v.toLowerCase().includes(t);
      case "notcontains": return !t || !v.toLowerCase().includes(t);
      case "empty": return !v.trim();
      case "notempty": return !!v.trim();
      default: return true;
    }
  }
  const srcActive = () => (ACC.srcOp === "any" || ACC.srcOp === "none") ? ACC.sources.size > 0
    : (ACC.srcOp === "contains" || ACC.srcOp === "notcontains") ? !!ACC.srcText.trim() : true;

  /* SOURCE OF DATA, the way Airtable's own filter works: a button that says
     what the filter is, and a panel with the condition on top. "is any of" /
     "is none of" give a searchable checklist with counts, picked values
     pinned first; "contains" / "does not contain" take text and show which
     values it matches; "is empty" / "is not empty" need nothing else. Every
     change applies at once. */
  function sourcePicker(all, sources) {
    const cnt = new Map();
    for (const c of all.filter((c) => accMatch(c, "source"))) cnt.set(c.source || "—", (cnt.get(c.source || "—") || 0) + 1);
    const sel = ACC.sources;
    const op = ACC.srcOp;
    const ranked = [...sources].sort((a, b) => (sel.has(b) - sel.has(a))
      || (cnt.get(b) || 0) - (cnt.get(a) || 0) || String(a).localeCompare(String(b)));
    const text = ACC.srcText.trim();
    const summary = !srcActive() ? "All"
      : op === "any" ? (sel.size === 1 ? srcName([...sel][0]) : `any of ${sel.size}`)
      : op === "none" ? (sel.size === 1 ? `not ${srcName([...sel][0])}` : `none of ${sel.size}`)
      : op === "contains" ? `contains “${text}”`
      : op === "notcontains" ? `doesn’t contain “${text}”`
      : SRC_OPS[op];
    let list;
    if (op === "any" || op === "none") {
      list = `
        <input id="srcFind" class="msel-find" type="search" placeholder="Find a source…"
          aria-label="Find a source" autocomplete="off" value="${esc(ACC.srcFind)}">
        <div class="msel-list" id="srcList">
          ${ranked.map((v) => `<label class="msel-opt${sel.has(v) ? " on" : ""}" data-name="${esc(srcName(v).toLowerCase())}">
            <input type="checkbox" data-src="${esc(v)}"${sel.has(v) ? " checked" : ""}>
            <span class="msel-name">${esc(srcName(v))}</span><span class="msel-n">${cnt.get(v) || 0}</span></label>`).join("")}
          <p class="msel-empty" id="srcNoMatch" hidden>No source matches.</p>
        </div>
        <div class="msel-foot"><span>${sel.size ? `${sel.size} of ${ranked.length} selected` : `${ranked.length} sources`}</span>
          <button type="button" class="gbtn sm" id="srcClear"${sel.size ? "" : " disabled"}>Clear</button></div>`;
    } else if (op === "contains" || op === "notcontains") {
      const t = text.toLowerCase();
      const hit = t ? ranked.filter((v) => v !== "—" && v.toLowerCase().includes(t)) : [];
      const body = !t
        ? `<p class="msel-empty">Type to see which sources ${op === "contains" ? "match" : "are left out"}.</p>`
        : hit.length
          ? `<p class="msel-hint">${hit.length} source${hit.length === 1 ? "" : "s"} contain “${esc(text)}”${op === "notcontains" ? " — these are left out" : ""}:</p>` +
            hit.map((v) => `<div class="msel-opt ro"><span></span><span class="msel-name">${esc(v)}</span><span class="msel-n">${cnt.get(v) || 0}</span></div>`).join("")
          : `<p class="msel-empty">No source contains “${esc(text)}”.</p>`;
      list = `
        <input id="srcText" class="msel-find" type="text" placeholder="Type text, e.g. GPTW"
          aria-label="Source of Data ${esc(SRC_OPS[op])}" autocomplete="off" value="${esc(ACC.srcText)}">
        <div class="msel-list msel-preview" id="srcList">${body}</div>
        <div class="msel-foot"><span>${t ? "Not case-sensitive" : ""}</span>
          <button type="button" class="gbtn sm" id="srcClear"${t ? "" : " disabled"}>Clear</button></div>`;
    } else {
      list = `<p class="msel-hint">Accounts whose Source of Data is ${op === "empty" ? "blank" : "filled in"}.</p>
        <div class="msel-foot"><span></span><button type="button" class="gbtn sm" id="srcClear">Clear</button></div>`;
    }
    return `<div class="msel" id="srcPick">
      <button type="button" class="msel-btn${srcActive() ? " on" : ""}" id="srcBtn"
        aria-haspopup="true" aria-expanded="${ACC.srcOpen}">
        <span class="msel-k">Source of Data</span><span class="msel-v">${esc(summary)}</span><span class="msel-caret" aria-hidden="true">▾</span>
      </button>
      ${ACC.srcOpen ? `<div class="msel-pop" role="dialog" aria-label="Filter by Source of Data">
        <select id="srcOp" class="msel-op" aria-label="Condition">
          ${Object.entries(SRC_OPS).map(([k, v]) => `<option value="${k}"${op === k ? " selected" : ""}>${esc(v)}</option>`).join("")}
        </select>
        ${list}
      </div>` : ""}
    </div>`;
  }

  /* OFFSITE TIMELINE — the quarters a company's offsite rows name in their
     Timeline, Past and Now, derived (offsite.js) rather than typed. A company
     matches a quarter if any of its contacts' rows named it. */
  /* One copy of these names, in offsite.js, beside the rules that produce
     them — this file used to hold a second one and they drifted. */
  const offLabel = (v) => global.Offsite.LABEL[v] || String(v || "").replace(/_/g, " ");
  /* ── THE CONDITION BUILDER ──────────────────────────────────────────
     Airtable's filter panel, over these companies: `Where <field> <is>
     <value>`, conditions joined by and/or, and one level of groups so
     "A and (B or C)" is sayable.

     IT SITS ON TOP OF THE CHIPS, not instead of them. The chips are the
     everyday path and they have something this cannot have: every chip says
     what it would give BEFORE you click it. A builder can only tell you
     after. So the chips stay for "due today", and this is here for the slice
     that chips cannot express — revenue over $10M, overdue or never called,
     not Seed — which is a real question somebody asks about once a month.
     Both apply, and the header says so when both are on.

     One level of nesting, deliberately. Two levels of groups is a query
     language, and a query language on a screen BDs use between calls is a
     thing people get wrong silently. */
  const FB_TYPES = {
    /* what each operator needs in the value box: nothing, one, or a list */
    contains: 1, ncontains: 1, is: 1, isnot: 1, atleast: 1, atmost: 1,
    anyof: "list", noneof: "list", between: 2, empty: 0, notempty: 0,
    on: 1, before: 1, after: 1, within: 1, ago: 1,
  };
  /* WHAT KIND OF BOX the value is typed into, where a plain text box is
     wrong. A date picker beats asking somebody to type 2026-04-01 in the
     right order, and "within the next ___ days" is a number with a word
     after it, not a date. */
  const FB_INPUT = { on: "date", before: "date", after: "date", within: "days", ago: "days" };
  /* THE OPERATORS EACH TYPE OFFERS. This is the whole of "filter in
     accordance with the column's type": pick a column, and the second
     dropdown holds exactly the questions that column can answer. */
  const FB_OPS = {
    text: { contains: "contains", ncontains: "does not contain", is: "is", isnot: "is not",
            empty: "is empty", notempty: "is not empty" },
    enum: { anyof: "is any of", noneof: "is none of", empty: "is empty", notempty: "is not empty" },
    multi: { anyof: "has any of", noneof: "has none of", empty: "is empty", notempty: "is not empty" },
    num: { atleast: "is at least", atmost: "is at most", is: "is", between: "is between",
           empty: "is empty", notempty: "is not empty" },
    /* "within" and "ago" are the two a BD actually asks — "due in the next
       three days", "not called in the last thirty" — and both are relative to
       today, so they keep working tomorrow. A fixed date answers the other
       kind of question and is kept for it. */
    date: { on: "is", before: "is before", after: "is after",
            within: "is within the next", ago: "was in the last",
            empty: "is empty", notempty: "is not empty" },
    link: { notempty: "has a link", empty: "has none",
            contains: "URL contains", ncontains: "URL does not contain" },
  };
  /* Shown as the group headings in the field dropdown, so the type a column
     is filtered as is on screen rather than inferred from which operators
     turned up. */
  const FB_TYPE_LABEL = { text: "Text", enum: "Single select", multi: "Multiple select",
                          num: "Number", date: "Date", link: "Link" };
  /* THE THREE FIELDS THAT ARE NOT COLUMNS. Everything else the builder can
     ask about is a column, read straight off ACOLS. These three are things
     the table shows in another column's cell — the star on the company name,
     the dot beside the last call — and they earn a row of their own because
     a band and a date answer different questions. */
  const FB_EXTRA = () => [
    { k: "focus", label: "Focus list", type: "enum", get: (c) => focusOf(c),
      valueList: () => Object.keys(FOCUS_CHIPS), labelOf: (v) => FOCUS_CHIPS[v] },
    { k: "fresh", label: "Last call, banded", type: "enum", get: (c) => freshOf(c),
      valueList: () => FRESH.map((z) => z.k), labelOf: (v) => FRESH.find((z) => z.k === v)?.label || v },
    { k: "days", label: "Days since last call", type: "num", get: (c) => daysSince(c.lastCalledAt) },
  ];

  /* Every field the builder can ask about: one per filterable column, in the
     table's own order, then the three above. `values` is a function so a list
     built from the data is current, not whatever existed when this file
     loaded. */
  function FB_FIELDS(all) {
    const vals = (get) => [...new Set(all.map(get).flat().filter((v) => v !== "" && v != null))];
    const build = (k, label, ff) => ({
      k, label: ff.label || label, type: ff.type, get: ff.get,
      labelOf: ff.labelOf, blankOk: ff.blankOk,
      /* Alphabetical unless the field says otherwise, and never the order the
         rows happened to arrive in — a checklist that reshuffles when the
         data does is one nobody can find anything in twice. */
      values: () => (ff.valueList ? ff.valueList() : vals(ff.get))
        .sort(ff.order || ((a, b) => String(ff.labelOf ? ff.labelOf(a) : a)
          .localeCompare(String(ff.labelOf ? ff.labelOf(b) : b)))),
    });
    return [...ACOLS.filter((c) => c.ff).map((c) => build(c.k, c.label, c.ff)),
            ...FB_EXTRA().map((f) => build(f.k, f.label, f))];
  }
  let FB_CACHE = [];
  const fbField = (k) => FB_CACHE.find((f) => f.k === k) || FB_CACHE[0];

  /* A condition is { f, op, v: [] }. A group is { join, items: [condition] }.
     An empty value means the condition is still being written, so it does not
     filter anything yet — a half-typed row must not empty the table. */
  const fbNeeds = (op) => FB_TYPES[op] ?? 1;
  function fbReady(c) {
    /* A LINK OUTLIVES THE FILTER IT WAS MADE WITH, and a field can change
       type between builds — "Next call" was a bucket and is now a date. An
       operator its type no longer offers is not a filter, it is a leftover,
       and it must narrow nothing rather than silently empty the table. */
    if (!FB_OPS[fbField(c.f)?.type]?.[c.op]) return false;
    const n = fbNeeds(c.op);
    if (n === 0) return true;
    if (n === "list") return c.v.length > 0;
    return c.v.slice(0, n).filter((x) => String(x ?? "").trim() !== "").length === n;
  }
  /* The numbers people type are the ones they say: 10M, 2.5b, 40 — all read
     by the same parser the columns use. */
  const fbNum = (s) => global.Enrich.num(s);
  /* Kylas hands back "2026-04-17" for some fields and a full timestamp for
     others, and comparing those two as strings quietly puts every timestamp
     after every date. day.js reduces both to the day they fell on here. */
  const fbDay = (v) => global.Day.dayOf(v);
  const fbToday = () => global.Day.today();
  const fbShift = (days) => global.Day.shift(days);

  function fbTest(co, c) {
    const f = fbField(c.f);
    if (!f || !fbReady(c)) return true;
    const raw = f.get(co);
    const list = Array.isArray(raw) ? raw : [raw];
    const filled = list.some((x) => x !== "" && x !== null && x !== undefined
      && x !== global.Enrich.UNKNOWN);
    switch (c.op) {
      case "empty": return !filled;
      case "notempty": return filled;
      case "anyof": return list.some((x) => c.v.includes(String(x)));
      case "noneof": return !list.some((x) => c.v.includes(String(x)));
      case "contains": return String(raw ?? "").toLowerCase().includes(String(c.v[0]).toLowerCase());
      case "ncontains": return !String(raw ?? "").toLowerCase().includes(String(c.v[0]).toLowerCase());
      case "is": return f.type === "num"
        ? Number(raw) === fbNum(c.v[0])
        : String(raw ?? "").toLowerCase() === String(c.v[0]).toLowerCase();
      case "isnot": return String(raw ?? "").toLowerCase() !== String(c.v[0]).toLowerCase();
      /* A company with no figure is not "below ten million", it is unknown —
         so it drops out of every comparison rather than counting as zero. */
      case "atleast": return raw != null && Number(raw) >= fbNum(c.v[0]);
      case "atmost": return raw != null && Number(raw) <= fbNum(c.v[0]);
      case "between": return raw != null && Number(raw) >= fbNum(c.v[0]) && Number(raw) <= fbNum(c.v[1]);
      /* Dates. An account with no date is not "before 1 April", it has never
         been called — so, as with the numbers above, it drops out of every
         comparison rather than sorting to one end of it. */
      case "on": return filled && fbDay(raw) === fbDay(c.v[0]);
      case "before": return filled && fbDay(raw) < fbDay(c.v[0]);
      case "after": return filled && fbDay(raw) > fbDay(c.v[0]);
      /* Both windows INCLUDE today, and both are half-open at the other end.
         "within the next 0 days" is today alone, which is what somebody
         typing 0 into a call-back filter means. */
      case "within": { const d = fbDay(raw);
        return filled && d >= fbToday() && d <= fbShift(Math.max(0, fbNum(c.v[0]) || 0)); }
      case "ago": { const d = fbDay(raw);
        return filled && d <= fbToday() && d >= fbShift(-Math.max(0, fbNum(c.v[0]) || 0)); }
      default: return true;
    }
  }
  function fbMatchNode(co, node) {
    const live = node.items.filter((it) => (it.items ? it.items.some(fbReady) : fbReady(it)));
    if (!live.length) return true;
    const one = (it) => (it.items ? fbMatchNode(co, it) : fbTest(co, it));
    return node.join === "or" ? live.some(one) : live.every(one);
  }
  const fbCount = (node = FB.tree) => node.items
    .reduce((n, it) => n + (it.items ? fbCount(it) : (fbReady(it) ? 1 : 0)), 0);
  const fbActive = () => fbCount() > 0;
  const FB = { open: false, tree: { join: "and", items: [] } };
  const fbNew = () => ({ f: "revenue", op: "atleast", v: [""] });

  function fbRowHTML(c, path) {
    const f = fbField(c.f);
    const ops = FB_OPS[f.type];
    const need = fbNeeds(c.op);
    const labelOf = f.labelOf || ((v) => v);
    let value = "";
    if (need === "list") {
      const opts = f.values().filter((v) => !c.v.includes(String(v)));
      value = `<div class="fb-pills">
        ${c.v.map((v) => `<span class="fb-pill">${esc(labelOf(v))}<button type="button" data-fbdrop="${path}" data-v="${esc(v)}" aria-label="Remove">×</button></span>`).join("")}
        <select class="fb-add" data-fbadd="${path}" aria-label="Add a value">
          <option value="">${c.v.length ? "+ add" : "Choose…"}</option>
          ${opts.map((v) => `<option value="${esc(v)}">${esc(labelOf(v))}</option>`).join("")}
          ${f.blankOk && !c.v.includes("") ? `<option value="">— No stage —</option>` : ""}
        </select></div>`;
    } else if (need >= 1) {
      const kind = FB_INPUT[c.op];
      const box = (i, ph, type = "text") => `<input class="fb-val${kind ? ` fb-${kind}` : ""}" type="${type}"
        data-fbv="${path}" data-i="${i}" value="${esc(c.v[i] ?? "")}"
        ${type === "text" ? `placeholder="${esc(ph)}"` : ""} autocomplete="off">`;
      /* A date operator gets a date picker, a "within N days" one gets a
         number with the word after it, and everything else a text box that
         says what it wants. "10M" and "1.2b" are read by the same parser the
         columns use, so the placeholder can promise them. */
      const ph = f.type === "num" ? "e.g. 10M" : "value";
      value = kind === "date" ? box(0, "", "date")
        : kind === "days" ? `${box(0, "", "number")}<span class="fb-and">days</span>`
        : need === 2 ? `${box(0, "from")}<span class="fb-and">and</span>${box(1, "to")}`
        : box(0, ph);
    }
    return `<div class="fb-row" data-path="${path}">
      <select class="fb-f" data-fbf="${path}" aria-label="Field">
        ${Object.entries(FB_TYPE_LABEL).map(([t, tl]) => {
          const mine = FB_CACHE.filter((x) => x.type === t);
          return mine.length ? `<optgroup label="${esc(tl)}">${mine.map((x) =>
            `<option value="${esc(x.k)}"${x.k === c.f ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</optgroup>` : "";
        }).join("")}
      </select>
      <select class="fb-op" data-fbop="${path}" aria-label="Condition">
        ${Object.entries(ops).map(([k, v]) => `<option value="${k}"${k === c.op ? " selected" : ""}>${esc(v)}</option>`).join("")}
      </select>
      <div class="fb-v">${value}</div>
      <button type="button" class="fb-x" data-fbdel="${path}" aria-label="Remove this condition">✕</button>
    </div>`;
  }
  const fbJoinCell = (node, i, path) => (i === 0 ? `<span class="fb-w">Where</span>`
    : i === 1 ? `<select class="fb-join" data-fbjoin="${path}" aria-label="and or or">
        ${["and", "or"].map((j) => `<option value="${j}"${node.join === j ? " selected" : ""}>${j}</option>`).join("")}
      </select>`
    : `<span class="fb-w dim">${esc(node.join)}</span>`);

  function filterPanel() {
    const body = FB.tree.items.map((it, i) => {
      const lead = fbJoinCell(FB.tree, i, "");
      if (!it.items) return `<div class="fb-line">${lead}${fbRowHTML(it, String(i))}</div>`;
      return `<div class="fb-line"><div class="fb-lead">${lead}</div>
        <div class="fb-group">${it.items.map((c, j) =>
          `<div class="fb-line">${fbJoinCell(it, j, String(i))}${fbRowHTML(c, `${i}.${j}`)}</div>`).join("")}
          <button type="button" class="fb-add-btn" data-fbaddcond="${i}">+ Add condition</button>
        </div></div>`;
    }).join("");
    return `<div class="msel" id="fbPick">
      <button type="button" class="msel-btn${fbActive() ? " on" : ""}" id="fbBtn"
        aria-haspopup="true" aria-expanded="${FB.open}">
        <span class="msel-k">Filter</span><span class="msel-v">${fbActive() ? `${fbCount()} condition${fbCount() === 1 ? "" : "s"}` : "None"}</span><span class="msel-caret" aria-hidden="true">▾</span>
      </button>
      ${FB.open ? `<div class="msel-pop fb-pop" role="dialog" aria-label="Build a filter">
        <p class="fb-hint">Applied on top of the chips above.</p>
        ${body || `<p class="msel-empty">No conditions yet.</p>`}
        <div class="fb-foot">
          <button type="button" class="fb-add-btn" id="fbAdd">+ Add condition</button>
          <button type="button" class="fb-add-btn" id="fbAddGroup">+ Add condition group</button>
          <span class="fb-sp"></span>
          <button type="button" class="gbtn sm" id="fbClear"${fbActive() || FB.tree.items.length ? "" : " disabled"}>Clear</button>
        </div>
      </div>` : ""}
    </div>`;
  }

  /* ── the stage picker ───────────────────────────────────────────────
     A dropdown rather than a row of chips (Ayush, 2026-09-28). The chips
     were right about the filter — multi-select, "is any of", with the blank
     as a value you can reach — and wrong about the space: twenty-three
     stages is two wrapped lines above a table, every time, whether or not
     anybody is filtering by stage today. The same control as Source of Data,
     so the toolbar reads as one thing: a button saying what is picked, and a
     searchable checklist behind it.

     Counts still leave stage out of their own reckoning, so an unticked
     stage says what it would give rather than zero. */
  function stagePicker(all) {
    const cnt = new Map();
    for (const c of all.filter((x) => accMatch(x, "stage"))) {
      const k = stageOf(c) || "";
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    const sel = ACC.stages;
    /* Picked first so they are never scrolled away from, then busiest. */
    const ranked = [...new Set([...cnt.keys(), ...sel])]
      .sort((a, b) => (sel.has(b) - sel.has(a)) || (cnt.get(b) || 0) - (cnt.get(a) || 0)
        || stageName(a).localeCompare(stageName(b)));
    const summary = !sel.size ? "All"
      : sel.size === 1 ? stageName([...sel][0]) : `any of ${sel.size}`;
    return `<div class="msel" id="stagePick">
      <button type="button" class="msel-btn${sel.size ? " on" : ""}" id="stageBtn"
        aria-haspopup="true" aria-expanded="${ACC.stageOpen}">
        <span class="msel-k">Stage</span><span class="msel-v">${esc(summary)}</span><span class="msel-caret" aria-hidden="true">▾</span>
      </button>
      ${ACC.stageOpen ? `<div class="msel-pop" role="dialog" aria-label="Filter by pipeline stage">
        <input id="stageFind" class="msel-find" type="search" placeholder="Find a stage…"
          aria-label="Find a stage" autocomplete="off" value="${esc(ACC.stageFind)}">
        <div class="msel-list" id="stageList">
          ${ranked.map((v) => `<label class="msel-opt${sel.has(v) ? " on" : ""}" data-name="${esc(stageName(v).toLowerCase())}">
            <input type="checkbox" data-stagev="${esc(v)}"${sel.has(v) ? " checked" : ""}>
            <span class="msel-name">${esc(stageName(v))}</span><span class="msel-n">${cnt.get(v) || 0}</span></label>`).join("")}
          <p class="msel-empty" id="stageNoMatch" hidden>No stage matches.</p>
        </div>
        <div class="msel-foot"><span>${sel.size ? `${sel.size} of ${ranked.length} selected` : `${ranked.length} stages`}</span>
          <button type="button" class="gbtn sm" id="stageClear"${sel.size ? "" : " disabled"}>Clear</button></div>
      </div>` : ""}
    </div>`;
  }

  /* ── the columns picker ─────────────────────────────────────────────
     Airtable's own gesture: a button that says how many are on, and a
     checklist behind it. The choice is this person's and is remembered —
     a BD who works on funding stage should not re-tick it every morning. */
  function columnPicker() {
    const opt = ACOLS.filter((c) => !c.fixed);
    const n = opt.filter((c) => ACC.cols.has(c.k)).length;
    return `<div class="msel" id="colPick">
      <button type="button" class="msel-btn" id="colBtn"
        aria-haspopup="true" aria-expanded="${ACC.colsOpen}">
        <span class="msel-k">Columns</span><span class="msel-v">${n}</span><span class="msel-caret" aria-hidden="true">▾</span>
      </button>
      ${ACC.colsOpen ? `<div class="msel-pop" role="dialog" aria-label="Which columns to show">
        <div class="msel-list">${opt.map((c) => `<label class="msel-opt">
          <input type="checkbox" data-col="${esc(c.k)}"${ACC.cols.has(c.k) ? " checked" : ""}>
          <span>${esc(c.label)}</span></label>`).join("")}</div>
        <div class="msel-foot"><span></span>
          <button type="button" class="gbtn sm" id="colWidthReset">Reset widths</button>
          <button type="button" class="gbtn sm" id="colReset">Reset</button></div>
      </div>` : ""}
    </div>`;
  }

  /* ── more filters ───────────────────────────────────────────────────
     The enrichment bands. Folded away by default because most days nobody
     touches them, and open on its own whenever one of them is doing
     something — a filter that is narrowing the list while hidden behind a
     closed section is how you end up certain you have forty accounts.

     Every row carries an Unknown chip, and it is not noise: it says how much
     of the account still has no enrichment behind it, which is a number the
     demand team wants to see go down. */
  function moreFilters(all) {
    const E = global.Enrich;
    const open = ACC.moreOpen || moreActive();
    const bandRow = (lbl, key, bands, set) => chipRow(all, lbl, key,
      [...bands.map((b) => b.key), E.UNKNOWN], (v) => E.bandLabel(bands, v), set);
    return `<div class="morefil${open ? " open" : ""}">
      <button type="button" class="morebtn" id="moreBtn" aria-expanded="${open}">
        ${open ? "▾" : "▸"} More filters${moreActive() ? `<span class="k tnum">${moreCount()}</span>` : ""}
      </button>
      ${open ? `<div class="morebody">
        ${chipRow(all, "Account stage", "aps", null, (v) => (v === E.UNKNOWN ? "Unknown" : v), ACC.apsSet,
          null, { limit: 10, expanded: ACC.apsMore, moreNoun: "stages", moreOne: "stage" })}
        ${bandRow("Revenue", "rev", E.REVENUE_BANDS, ACC.rev)}
        ${chipRow(all, "Employees", "emp", null, (v) => (v === E.UNKNOWN ? "Unknown" : v), ACC.emp,
          null, { byFloor: true })}
        ${bandRow("Latest round", "round", E.ROUND_BANDS, ACC.round)}
        ${chipRow(all, "Funding stage", "fstage", null, (v) => (v === E.UNKNOWN ? "Unknown" : v), ACC.fstage,
          null, { limit: 8, expanded: ACC.fstageMore, moreNoun: "stages", moreOne: "stage" })}
        ${chipRow(all, "Offsite timeline", "offsite", null,
          (v) => (v === E.UNKNOWN ? "Not known yet" : offLabel(v)), ACC.offsiteSet)}
        <div class="frow"><span class="lbl">Priority</span>
          <label class="pri">at least
            <input type="number" id="accPri" min="0" step="1" value="${esc(ACC.priMin)}"
              placeholder="any" aria-label="Minimum priority score"></label>
        </div>
      </div>` : ""}
    </div>`;
  }
  const moreSets = () => [ACC.rev, ACC.emp, ACC.round, ACC.fstage, ACC.offsiteSet, ACC.apsSet];
  const moreCount = () => moreSets().reduce((n, s) => n + s.size, 0) + (ACC.priMin === "" ? 0 : 1);
  const moreActive = () => moreCount() > 0;

  /* FOCUS LISTS, AS A FILTER. Which accounts each BD has picked to work (★)
     and which they dropped — set on the call card. A panel listing them all
     was tried and does not survive a BD with a hundred picks, so it is one
     select beside the others: every focus account, one BD's, the dropped
     ones, or the rest. The table then shows them with every other filter
     still applying. (focus.js) */
  const FOCUS_CHIPS = { focus: "★ Focus", normal: "Not picked", depri: "Deprioritized" };
  /* NEXT CALL — the earliest call-back set on a contact still in play at the
     company (saved to Airtable since 1.20). "Today" is this machine's day. */
  const localDay = () => global.Day.today();
  const nextIn = (co) => (co.nextCall ? global.Day.daysUntil(co.nextCall) : null);
  const nextOf = (co) => { const d = nextIn(co); return d === null ? "none" : d < 0 ? "overdue" : d === 0 ? "today" : d <= 7 ? "week" : "later"; };
  const NEXT_CHIPS = { overdue: "Overdue", today: "Due today", week: "Next 7 days", later: "Later", none: "No call-back" };
  const nextText = (co) => {
    const d = nextIn(co);
    if (d === null) return "—";
    if (d < 0) return `Overdue ${-d}d`;
    if (d === 0) return "Today";
    return new Date(co.nextCall + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  };

  /* ── the columns ────────────────────────────────────────────────────
     Company is always there and always first; everything else is the
     associate's choice, kept per person. The defaults are the seven Ayush
     named (stage, owner, source, offsite, KPI status, last call, priority)
     plus the call-back, which is the one column with a deadline in it.

     `w` is the column's share of the row. `num` right-aligns and sets
     tabular figures, so a column of money reads down the decimal point.
     A cell with nothing behind it is an em dash, NEVER a zero: Apollo
     writes 0 where it has no figure, and "₹0" reads as a fact. */
  const en = (c) => c.enrich || {};
  const E = global.Enrich;
  const dash = (s) => (s === "" || s === null || s === undefined ? "—" : s);
  /* A link as a small chip. New tab, and noopener — these are third-party
     URLs out of a shared table. */
  const linkChip = (url, text) => (url
    ? `<a class="lnk" href="${esc(url)}" target="_blank" rel="noopener noreferrer"
         title="${esc(url)}" data-stop="1">${esc(text)}</a>` : "—");

  /* EVERY COLUMN DECLARES ITS TYPE, AND THE FILTER MENU IS BUILT FROM THAT.
     This is the Airtable gesture, and the reason it is one table rather than
     two: the columns and the filter fields used to be separate lists, and a
     column added to one and forgotten in the other is invisible — the column
     appears, and the only thing that goes wrong is that you cannot filter on
     it, which nobody reports as a bug. Now a column IS a filter field, and
     what you can ask about it follows from `ff.type`:

       text    contains · does not contain · is · is not · empty · not empty
       enum    is any of · is none of · empty · not empty          (checklist)
       multi   has any of · has none of · empty · not empty        (checklist)
       num     at least · at most · is · between · empty · not empty
       date    is · before · after · within the next N days ·
               in the last N days · empty · not empty
       link    has a link · has none · URL contains · URL does not contain

     `get` reads the raw value — the number, the ISO date, the url — never the
     rendered cell, because "₹—" is not a value you can compare. A column with
     no `ff` cannot be filtered on, and that has to be a decision, not a
     slip. */
  const ACOLS = [
    { k: "company", label: "Company", w: "1.6fr", fixed: true, cls: "co",
      ff: { type: "text", get: (c) => c.name || "" },
      cell: (c) => `${focusOf(c) === "focus" ? `<i class="fstar" title="On a focus list">★</i> ` : ""}${esc(c.name)}${
        focusOf(c) === "depri" ? ` <i class="dp" title="${esc([Focus.entry(c.id)?.reason, Focus.entry(c.id)?.note].filter(Boolean).join(" — "))}">deprioritized</i>` : ""}` },
    { k: "stage", label: "Pipeline stage", w: "1.3fr", on: true,
      /* blankOk: "no stage" is a real answer on thousands of accounts, so the
         checklist offers it rather than making it unreachable. */
      /* Wrapped, not named: stageName and offLabel below are declared further
         down this file, and naming one here would read it before it exists —
         the same trap VALUE_OF carries a note about. */
      ff: { type: "enum", get: (c) => stageOf(c) || "", labelOf: (v) => stageName(v), blankOk: true },
      cell: (c) => esc(label(stageOf(c)) || "—") },
    { k: "owner", label: "Owner", w: "1fr", on: true,
      ff: { type: "enum", get: (c) => c.owner || "" },
      cell: (c) => esc(c.owner || "—") },
    { k: "source", label: "Source of Data", w: ".9fr", on: true,
      ff: { type: "enum", get: (c) => c.source || "" },
      cell: (c) => esc(c.source || "—") },
    { k: "offsite", label: "Offsite", w: ".7fr", on: true,
      /* The one genuinely multi-valued column: a company can name two
         quarters, so the checklist means "has any of" and not "is". */
      ff: { type: "multi", get: (c) => c.offsite || [],
            valueList: () => global.Offsite.FY_ORDER, labelOf: (v) => offLabel(v) },
      cell: (c) => ((c.offsite || []).length ? esc(c.offsite.map(offLabel).join(", ")) : "—") },
    { k: "kpi", label: "KPI status", w: ".95fr", on: true,
      ff: { type: "enum", get: (c) => String(kpiOf(c)),
            valueList: () => ["-1", "0", "1", "2", "3", "4", "5"],
            labelOf: (v) => KPI_LABELS[Number(v) + 1] },
      cell: (c) => { const k = kpiOf(c); return `<i class="kpi r${k < 0 ? "n" : k}">${esc(KPI_LABELS[k + 1])}</i>`; } },
    { k: "last", label: "Last call", w: ".9fr", on: true, cls: "lc",
      /* The DATE, not the "31–90 days" band the cell shows. The band is a
         separate field below — asking "before 1 April" is a different
         question from "cold", and a band cannot answer it. */
      ff: { type: "date", label: "Last call date", get: (c) => c.lastCalledAt || "" },
      cell: (c) => { const d = daysSince(c.lastCalledAt);
        return `<i class="f-${freshOf(c)}"></i>${d === null ? "Never" : d === 0 ? "Today" : `${d}d ago`}`; } },
    { k: "next", label: "Next call", w: ".85fr", on: true,
      ff: { type: "date", label: "Next call date", get: (c) => c.nextCall || "" },
      cell: (c) => `<span class="nc nc-${nextOf(c)}">${esc(nextText(c))}</span>` },
    { k: "priority", label: "Priority", w: ".55fr", on: true, num: true,
      ff: { type: "num", get: (c) => en(c).pri ?? null },
      cell: (c) => dash(en(c).pri ?? "") },
    /* Dollars, as Apollo stores them. Nothing is converted — see enrich.js. */
    { k: "revenue", label: "Revenue", w: ".8fr", num: true,
      ff: { type: "num", get: (c) => en(c).rev ?? null },
      cell: (c) => dash(esc(E.usdText(en(c).rev))) },
    { k: "rpe", label: "Rev / employee", w: ".85fr", num: true,
      ff: { type: "num", get: (c) => en(c).rpe ?? null },
      cell: (c) => dash(esc(E.usdText(en(c).rpe))) },
    { k: "employees", label: "Employees", w: ".7fr", num: true,
      /* Apollo hands over a BAND ("51-200"), never a count, so this is a
         select and not a number however much it looks like one. Ordered by
         where each band starts — "10000+" above "51-200" is what sorting
         these as text gives, and it reads as a mistake. */
      ff: { type: "enum", get: (c) => (en(c).emp && en(c).emp !== E.UNKNOWN ? en(c).emp : ""),
            order: (a, b) => E.empFloor(a) - E.empFloor(b) },
      cell: (c) => dash(en(c).emp && en(c).emp !== E.UNKNOWN ? esc(en(c).emp) : "") },
    { k: "funding", label: "Total funding", w: ".8fr", num: true,
      ff: { type: "num", get: (c) => en(c).fund ?? null },
      cell: (c) => dash(esc(E.usdText(en(c).fund))) },
    { k: "round", label: "Latest round", w: ".8fr", num: true,
      ff: { type: "num", get: (c) => en(c).amt ?? null },
      cell: (c) => dash(esc(E.usdText(en(c).amt))) },
    { k: "fstage", label: "Funding stage", w: "1fr",
      ff: { type: "enum", get: (c) => en(c).type || "" },
      cell: (c) => dash(esc(en(c).type || "")) },
    /* ACCOUNT PIPELINE STAGE — CALCULATED, and the highest one wins.
       An account with three contacts has three pipeline stages, and the
       account sits at the furthest of them by the 26-rung order in
       docs/stages.json. That is a different fact from the two columns either
       side of it:

         Pipeline stage    the company's own Pipeline Stage - BD in Kylas, a
                           single value somebody typed on the company record,
                           which goes stale the moment a POC moves
         Account stage     THIS — computed from the contacts
         Demand team stage Company List's Account Pipeline Stage column, a
                           reference the demand team maintains by hand

       Where they disagree somebody has worked the account somewhere the other
       two cannot see, which is why all three are available. Blank means no
       contact of this account has been saved yet, not "nothing is happening".
       (Ayush, 2026-09-29.) */
    { k: "acct", label: "Account stage", w: "1.3fr", on: true,
      ff: { type: "enum", get: (c) => acctStageOf(c),
            labelOf: (v) => stageName(v),
            /* Furthest first: this is a ladder, and sorting its rungs
               alphabetically is how "Activation" ends up above "SQL". */
            order: (a, b) => (STAGE_RUNG[b] || 0) - (STAGE_RUNG[a] || 0) },
      cell: (c) => { const v = acctStageOf(c); return v ? esc(label(v) || v) : "—"; } },
    /* The demand team's own read, kept and clearly named rather than confused
       with the calculated one above. Off by default — it is a second opinion,
       not the answer. */
    { k: "aps", label: "Demand team stage", w: "1.1fr",
      ff: { type: "enum", get: (c) => en(c).aps || "" },
      cell: (c) => dash(esc(en(c).aps || "")) },
    /* A url is not text. "Which accounts still have no LinkedIn" is the
       question actually asked of these two, every week, and on a text field
       that is "is empty" hidden among five operators that make no sense for
       a link. So they get their own four. */
    { k: "linkedin", label: "LinkedIn", w: ".6fr",
      ff: { type: "link", get: (c) => en(c).li || "" },
      cell: (c) => linkChip(en(c).li, "in") },
    { k: "boolean", label: "Boolean post", w: ".7fr",
      ff: { type: "link", get: (c) => en(c).bp || "" },
      cell: (c) => linkChip(en(c).bp, "post") },
  ];
  const COL_DEFAULTS = ACOLS.filter((c) => c.on).map((c) => c.k);
  const colsOn = () => ACOLS.filter((c) => c.fixed || ACC.cols.has(c.k));
  /* A hand-set width wins over the column's share of the row. Mixing px and
     fr in one grid is fine: the pinned columns take their pixels and the rest
     divide what is left. */
  const gridOf = (cols) => cols.map((c) => (ACC.widths[c.k] ? `${ACC.widths[c.k]}px` : c.w)).join(" ");

  /* ── THE BOARD ──────────────────────────────────────────────────────
     The same accounts as the table, stacked into Ayush's six call buckets
     (docs/stages.json `families`) instead of listed. A bucket is a pile to
     work: pick one, and everything in it wants the same kind of call.

     IT GROUPS ON THE CALCULATED ACCOUNT STAGE, not on the company's own Kylas
     field — the furthest rung any of its contacts has reached. That is the
     whole reason the buckets mean anything: an account whose three POCs sit
     at CNC, MQL and Follow-up 2 is a Follow-up 2 account, and it belongs in
     the pile you would actually call it from.

     THE BUCKETS ARE NOT THE LADDER'S ORDER. The 26 rungs are a funnel; these
     are an action order, which is a different axis. Discovery Call No-Show is
     rung 20 and needs a call today; Not Interested is rung 10 and never needs
     one again. Sorting the board by rung would interleave the two.

     Every filter above still applies, because the board is handed the same
     rows the table would have shown. Filter to one owner and the board is
     that person's day. */
  function boardHTML(rows) {
    const cards = new Map(STAGE_FAMILIES.map((f) => [f.key, []]));
    /* An account with no contact saved yet has no calculated stage. It is not
       "Not started" — that is a real stage somebody set — so it gets its own
       pile rather than being quietly filed under one of the six. */
    const unplaced = [];
    for (const c of rows) {
      const st = acctStageOf(c);
      const k = st ? FAMILY_OF[st] : null;
      if (k && cards.has(k)) cards.get(k).push(c); else unplaced.push(c);
    }
    const col = (key, label, hint, list) => {
      /* Call-backs first inside every column, whatever the table is sorted
         by: a pile is worked from the top, and the top of a calling pile is
         whatever was promised soonest. */
      const sorted = [...list].sort((a, b) =>
        (a.nextCall ? 0 : 1) - (b.nextCall ? 0 : 1)
        || String(a.nextCall || "").localeCompare(String(b.nextCall || ""))
        || String(b.lastCalledAt || "").localeCompare(String(a.lastCalledAt || "")));
      const cap = BOARD_LIMIT[key] || 50;
      const shown = sorted.slice(0, cap);
      return `<section class="bcol" data-bkey="${esc(key)}">
        <header><h3>${esc(label)}</h3><span class="bn tnum">${list.length}</span>
          <em>${esc(hint)}</em></header>
        <div class="bcards">
          ${shown.map((c) => {
            const nk = nextOf(c), d = daysSince(c.lastCalledAt);
            return `<button type="button" class="bcard" data-id="${esc(c.id)}">
              <b class="co">${focusOf(c) === "focus" ? `<i class="fstar">★</i> ` : ""}${esc(c.name)}</b>
              <span class="bstage">${esc(label2(acctStageOf(c)))}</span>
              <span class="bmeta">
                ${c.nextCall ? `<i class="nc nc-${nk}">${esc(nextText(c))}</i>` : ""}
                <i class="f-${freshOf(c)}"></i>${d === null ? "Never called" : d === 0 ? "Called today" : `${d}d ago`}
                ${ACC.owner ? "" : ` · ${esc(String(c.owner || "—").split(/\s+/)[0])}`}
              </span>
            </button>`;
          }).join("")}
          ${list.length > shown.length
            ? `<p class="bmore">${list.length - shown.length} more — narrow the filters to see them</p>` : ""}
          ${list.length ? "" : `<p class="bempty">Nothing here.</p>`}
        </div>
      </section>`;
    };
    return `<div class="board">
      ${STAGE_FAMILIES.map((f) => col(f.key, f.label, f.hint, cards.get(f.key))).join("")}
      ${unplaced.length ? col("none", "No contacts yet", "nobody has been saved against these", unplaced) : ""}
    </div>`;
  }
  /* One cap for every column. A pile of nine thousand untouched accounts is
     not a pile anybody works from, and rendering it costs the scroll. */
  const BOARD_LIMIT = { new: 50, cnc: 50, active: 100, meeting: 100, newpoc: 50, closed: 25, none: 25 };
  /* A stage's own name, for the line under the company. */
  const label2 = (code) => (code ? (label(code) || code) : "—");

  function explorerHTML(all, owners) {
    const cols = colsOn();
    /* Rebuilt each paint so a value list offers what the data holds now. */
    FB_CACHE = FB_FIELDS(all);
    const sources = [...new Set(all.map((c) => c.source || "—"))].sort();
    const SORTS = { next: "Call-backs first", recent: "Last call, newest", stale: "Last call, oldest",
                    kpi: "Furthest along", priority: "Priority, highest", revenue: "Revenue, largest",
                    az: "A–Z" };
    /* BLANKS LAST, ALWAYS. Sorting descending puts them last by accident and
       ascending puts them first, which reads as "these are the smallest" when
       what it means is "we do not know". So absence is its own bucket, at the
       bottom, whichever way the numbers are going. */
    const byNum = (get) => (a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x;
    };
    const cmp = {
      recent: (a, b) => String(b.lastCalledAt || "").localeCompare(String(a.lastCalledAt || "")),
      stale: (a, b) => String(a.lastCalledAt || "").localeCompare(String(b.lastCalledAt || "")),
      kpi: (a, b) => kpiOf(b) - kpiOf(a) || String(b.lastCalledAt || "").localeCompare(String(a.lastCalledAt || "")),
      /* Anything with a call-back first, earliest date first — so overdue sits
         above today, today above the rest. Everything without one keeps the
         default order behind them: last call newest. */
      next: (a, b) => (a.nextCall ? 0 : 1) - (b.nextCall ? 0 : 1)
        || String(a.nextCall || "").localeCompare(String(b.nextCall || ""))
        || String(b.lastCalledAt || "").localeCompare(String(a.lastCalledAt || "")),
      priority: byNum((c) => (c.enrich?.pri ?? null)),
      revenue: byNum((c) => (c.enrich?.rev ?? null)),
      az: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    }[ACC.sort];
    const rows = all.filter((c) => accMatch(c)).sort(cmp);
    const any = ACC.stages.size || ACC.owner || srcActive() || ACC.kpis.size || ACC.fresh.size
      || ACC.focusSet.size || ACC.nextSet.size || moreActive() || fbActive() || !!ACC.q;

    /* A sentence about what is on screen, so the number at the top is not the
       only thing the header says. Only the parts that are true. */
    const parts = [];
    if (rows.length) {
      const bySrc = {}, byOwn = {};
      for (const c of rows) { bySrc[c.source || "—"] = (bySrc[c.source || "—"] || 0) + 1;
                              byOwn[c.owner || "—"] = (byOwn[c.owner || "—"] || 0) + 1; }
      const topSrc = Object.entries(bySrc).sort((a, b) => b[1] - a[1])[0];
      const topOwn = Object.entries(byOwn).sort((a, b) => b[1] - a[1])[0];
      const coldN = rows.filter((c) => ["cool", "cold"].includes(freshOf(c))).length;
      const never = rows.filter((c) => freshOf(c) === "never").length;
      if (topSrc && Object.keys(bySrc).length > 1) parts.push(`Most came from ${esc(topSrc[0])} (${topSrc[1]})`);
      if (topOwn && Object.keys(byOwn).length > 1 && !ACC.owner)
        parts.push(`${esc(String(topOwn[0]).split(/\s+/)[0])} owns the most (${topOwn[1]})`);
      if (coldN) parts.push(`${coldN} have not had a call in over a month`);
      if (never) parts.push(`${never} never called`);
    }
    const shown = rows.slice(0, ACC.limit);

    /* ── TODAY'S FOLLOW-UPS ──────────────────────────────────────────
       The call-backs promised for today, and the ones already missed. This
       is the only thing on the screen with a deadline, and until now it was
       a chip among fourteen other chips with the same weight as "Employees".
       Ayush, 2026-09-29: "today followup where next call date is of today,
       unke followup".

       It counts the WHOLE account list, not the filtered rows — a promise
       does not stop being due because you are looking at Series B companies
       — and it says so when the two differ, or the number would look wrong
       to anyone who had filtered. One line: the count is the message, and
       one click filters to them. Nothing shows when nothing is owed, which
       is most afternoons. Amber only when something is overdue: a broken
       promise is a flag, work due today is not. */
    const due = { overdue: 0, today: 0 };
    for (const c of all) { const k = nextOf(c); if (k in due) due[k]++; }
    const owed = due.overdue + due.today;
    const inView = shown.length < all.length || any;
    const dueHere = inView ? rows.filter((c) => ["overdue", "today"].includes(nextOf(c))).length : owed;
    const strip = !owed ? "" : `<div class="vrca vfu${due.overdue ? "" : " calm"}">
      <b>${owed}</b>
      <span>${[due.overdue ? `<b>${due.overdue}</b> overdue` : "",
               due.today ? `<b>${due.today}</b> due today` : ""].filter(Boolean).join(" · ")
        }${inView && dueHere !== owed ? ` — ${dueHere} of them in this filtered list` : ""}</span>
      <button class="gbtn sm" id="accToday" type="button">Show them</button>
    </div>`;

    return `
      ${strip}
      <div class="card explorer">
        <div class="exhead">
          <h2>${esc(ACC.stages.size === 1 ? stageName([...ACC.stages][0]) : "All accounts")}</h2>
          <span class="exn tnum">${rows.length} ${rows.length === 1 ? "company" : "companies"}</span>
          ${any ? `<button class="gbtn sm" id="accClear" type="button">Clear filters</button>` : ""}
          <button class="gbtn sm" id="accLink" type="button"
            title="Copy a link that opens this list with these filters">Copy link</button>
          <p>${parts.length ? esc(parts.join(" · ")) + "." : (rows.length ? "" : "Nothing matches these filters.")}</p>
        </div>
        <div class="extools">
          <div class="srch">
            <input id="accQ" type="search" value="${esc(ACC.q)}" placeholder="Search accounts…"
              aria-label="Search accounts by name, owner, source or stage" autocomplete="off" spellcheck="false">
          </div>
          <select id="accOwner" aria-label="Owner">
            <option value="">All owners</option>
            ${owners.map((o) => `<option value="${esc(o)}"${ACC.owner === o ? " selected" : ""}>${esc(o)}</option>`).join("")}
          </select>
          <select id="accSort" aria-label="Sort">
            ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${ACC.sort === k ? " selected" : ""}>${esc(v)}</option>`).join("")}
          </select>
          <div class="vtoggle" role="group" aria-label="How to show the accounts">
            <button type="button" id="accTable"${ACC.view === "table" ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>Table</button>
            <button type="button" id="accBoard"${ACC.view === "board" ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>Board</button>
          </div>
          ${stagePicker(all)}
          ${filterPanel()}
          ${sourcePicker(all, sources)}
          ${columnPicker()}
        </div>
        ${chipRow(all, "KPI status", "kpi", [-1, 0, 1, 2, 3, 4, 5],
          (v) => KPI_LABELS[v + 1], ACC.kpis, (v) => `<span class="sw r${v < 0 ? "n" : v}"></span>`)}
        ${chipRow(all, "Last call", "fresh", FRESH.map((z) => z.k),
          (v) => FRESH.find((z) => z.k === v).label, ACC.fresh, (v) => `<span class="sw f-${v}"></span>`)}
        ${chipRow(all, "Next call", "next", Object.keys(NEXT_CHIPS), (v) => NEXT_CHIPS[v], ACC.nextSet)}
        ${chipRow(all, "Focus list", "focus", Object.keys(FOCUS_CHIPS), (v) => FOCUS_CHIPS[v], ACC.focusSet)}
        ${moreFilters(all)}
        ${ACC.view === "board" ? boardHTML(rows) : `
        <div class="accscroll"><div class="acctable" style="--acols:${gridOf(cols)}">
          <div class="vr vh">${cols.map((col) =>
            `<span class="${col.num ? "num" : ""}">${esc(col.label)}<i class="cgrip" data-grip="${esc(col.k)}"
              title="Drag to resize · double-click to reset" role="separator" aria-hidden="true"></i></span>`).join("")}</div>
          ${shown.length ? shown.map((c) =>
            `<div class="vr" data-id="${esc(c.id)}">${cols.map((col) =>
              `<span class="${col.cls || ""}${col.num ? " num" : ""}">${col.cell(c)}</span>`).join("")}</div>`
          ).join("") : `<div class="vempty">Nothing matches these filters.</div>`}
        </div></div>
        ${rows.length > ACC.limit
          ? `<button class="gbtn" id="accMore" type="button">Show ${
              Math.min(100, rows.length - ACC.limit)} more of ${rows.length - ACC.limit}</button>` : ""}`}
      </div>`;
  }

  let VIEW_MODE = "board";
  /* WHAT THE COLUMNS MEAN is now a choice, not a decision taken for you.
     Three axes, because there are three questions and they are asked on
     different days: "what do I do next" (state), "where is my pipeline sitting"
     (stage), "which list is paying" (source). Whichever is not the axis stays
     available as a filter, so the board narrows rather than needing a
     different board. */
  const AXES = [
    { key: "state",  label: "KPI state" },
    { key: "stage",  label: "Pipeline stage" },
    { key: "source", label: "Source of Data" },
  ];
  let GROUP_BY = "state";

  async function restoreViewMode() {
    try { VIEW_MODE = (await Store.getSetting("companiesView")) || "board"; }
    catch { /* default */ }
    try { GROUP_BY = (await Store.getSetting("companiesGroupBy")) || "state"; }
    catch { /* default */ }
    if (!AXES.some((a) => a.key === GROUP_BY)) GROUP_BY = "state";
    /* One view. A stored preference from before the board was removed would
       otherwise render a mode with no control to leave it by. */
    VIEW_MODE = "accounts";
  }

  /* The company's stage: its POCs' best rung where contacts are loaded, its own
     mirrored stage otherwise. Same fallback the card's stage line uses, so a
     company cannot be filed under one stage and labelled with another. */
  const stageOf = (co) => co.stage || co.kylasStage || "";
  /* THE ACCOUNT'S STAGE, which is a calculation and not a field: the furthest
     rung any contact of the account has reached, by docs/stages.json. The
     server sends it (from the KPI base); co.stage is the same calculation over
     the contacts THIS browser has loaded, which is fresher when a card is
     open. Whichever is further along is the account's stage. */
  const acctStageOf = (co) => {
    const a = co.acctStage || "", b = co.stage || "";
    if (!a) return b;
    if (!b) return a;
    return (STAGE_RUNG[b] || 0) > (STAGE_RUNG[a] || 0) ? b : a;
  };
  /* A stage's name for a chip. The blank one is a real answer — thousands of
     allotted companies have never been given a stage in Kylas — so it is
     named rather than left as an empty chip. */
  const stageName = (code) => (code ? (label(code) || code) : "No stage");

  /* LANES, for whichever axis is selected.
     state  — fixed six, because the funnel has a shape and an empty rung is
              information: "nothing in Discovery" is the finding.
     stage  — only the stages actually present. The picklist has 23 and a board
              of 23 columns, 19 of them empty, is not a board.
     source — only the sources present, busiest first, with the unattributed
              rows gathered rather than dropped: "where did these come from" is
              a real question and a silent omission is not an answer. */
  function lanesFor(list) {
    if (GROUP_BY === "state") {
      const by = new Map(LANES.map((l) => [l.key, []]));
      for (const c of list) by.get(laneOf(c))?.push(c);
      return LANES.map((l) => ({ ...l, list: by.get(l.key) || [] }));
    }
    const by = new Map();
    for (const c of list) {
      const k = GROUP_BY === "stage" ? stageOf(c) : (c.source || "");
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    }
    const out = [...by.entries()].map(([k, arr]) => ({
      key: k || "(none)",
      label: k ? (GROUP_BY === "stage" ? label(k) : k)
               : (GROUP_BY === "stage" ? "No stage" : "No source"),
      /* No hint. The fixed six explain themselves because their names are
         internal jargon; a stage or a source is its own explanation, and the
         count is already in the header beside it. */
      hint: "",
      list: arr,
    }));
    if (GROUP_BY === "stage")
      out.sort((a, b) => (STAGE_RUNG[b.key] || 0) - (STAGE_RUNG[a.key] || 0));
    else
      out.sort((a, b) => b.list.length - a.list.length || a.label.localeCompare(b.label));
    return out;
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
    for (const [key, name, lab] of [["source", "Source of Data", label],
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
    await restoreViewMode();
    await loadAccPrefs();
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
    /* Owner names as the mirror stores them — the explorer filters on the name,
       not the Kylas id the "Allotted to" select above uses. */
    const ownerNames = [...new Set(all.map((c) => c.owner).filter(Boolean))].sort();


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

    /* ── the board ───────────────────────────────────────────────────────
       WHAT A CARD HAS TO ANSWER, and nothing else: which company, how cold,
       and — once there is one — which human. Everything the table shows that
       does not serve "do I call this next" is left to the table: batch, POC
       counts, owner (the filter already says whose list this is), the account
       health tag nobody maintains. Four lines, so a column of them is scannable
       at a glance rather than read.

       The named POC is on the card because it is the question a manager
       actually asks — not how many right POCs, which person — and because on
       this board it is also the reason the card has stopped moving. */
    /* THE COLUMN ALREADY SAYS ONE OF THESE, so the card does not repeat it.
       Grouped by stage, every card in a column carries the same stage line;
       grouped by source, the same source. Repeating the axis on every card is
       the noise that made the first version feel like a table cut into strips.
       Name, when it was last touched, and the two facts the column is not
       telling you. */
    const cardHTML = (c) => {
      const d = daysSince(c.lastCalledAt);
      const stale = d !== null && d >= STALE_DAYS;
      const who = c.pocs.discovery[0] || c.pocs.right[0] || "";
      const more = (c.pocs.discovery.length || c.pocs.right.length) - 1;
      const showStage = GROUP_BY !== "stage";
      const showSource = GROUP_BY !== "source";
      return `
        <button class="vcard${stale ? " stale" : ""}" type="button" data-id="${esc(c.id)}">
          <b>${esc(c.name)}</b>
          ${showStage ? `<em>${esc(label(stageOf(c)) || c.kpiStage || "Not reached")}</em>` : ""}
          ${who ? `<span class="who" title="${esc([...c.pocs.discovery, ...c.pocs.right].join(", "))}"
            >${esc(who)}${more > 0 ? ` +${more}` : ""}</span>` : ""}
          <span class="foot">
            ${showSource ? `<i class="src">${esc(c.source || "no source")}</i>` : ""}
            <i class="age">${d === null ? "never called"
              : d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`}</i>
          </span>
        </button>`;
    };

    /* Cards per column before the rest are held back. A board is only lighter
       than the table if it does not build 250 cards to show you nine. */
    const PER_LANE = 12;
    const openLanes = new Set();

    /* COLDEST FIRST, always. This is the one ordering the board exists for, so
       it is not a sort control: a column sorted any other way answers a
       question you can already ask the table. A company never called has no
       date, and sorts to the top of Untouched, where it belongs. */
    const byColdest = (a, b) => String(a.lastCalledAt || "").localeCompare(String(b.lastCalledAt || ""));

    const laneHTML = (lane, list) => {
      const cap = openLanes.has(lane.key) ? list.length : PER_LANE;
      return `
        <section class="vcol" data-lane="${lane.key}">
          <header><b>${esc(lane.label)}</b><span>${list.length}</span>
            ${lane.hint ? `<em>${esc(lane.hint)}</em>` : ""}</header>
          <div class="vcards">
            ${list.length ? list.slice(0, cap).map(cardHTML).join("")
                          : `<p class="vnone">Nothing here.</p>`}
            ${list.length > cap
              ? `<button class="vmorec" type="button" data-lane="${lane.key}">${
                   list.length - cap} more…</button>` : ""}
          </div>
        </section>`;
    };

    const boardHTML = (list) => {
      const lanes = lanesFor(list);
      for (const l of lanes) l.list.sort(byColdest);
      if (!lanes.length)
        return `<div class="vempty">Nothing matches those filters.</div>`;
      return `<div class="vboard">${lanes.map((l) => laneHTML(l, l.list)).join("")}</div>`;
    };

    host.innerHTML = `
      <div class="vhead">
        <h2>Companies</h2>
        <span class="vsub">${loading ? "loading…"
          : VIEW_MODE === "accounts" ? `${all.length} allotted`
          : `${rows.length} of ${all.length}`}</span>
      </div>
      ${API.state.user?.kylasMatch === false ? `<p class="vwarn">You are signed in as <b>${esc(API.state.user.email)}</b>, but no Kylas
        user has that email — so “Me” owns no accounts. Ask an admin to set your Kylas user's email to this address.</p>` : ""}
      <div class="vfilters">
        <label>Allotted to<select id="fOwner"${API.isAdmin ? "" : " disabled"}>
          <option value=""${!FILTERS.owner ? " selected" : ""}>${
            esc(`Me — ${API.state.user?.name || API.state.user?.email || "signed in"}`)}</option>
          ${API.isAdmin ? `<option value="all"${FILTERS.owner === "all" ? " selected" : ""}>Everyone</option>
          ${CACHE.owners.map((o) => `<option value="${esc(o.id)}"${
            String(FILTERS.owner) === String(o.id) ? " selected" : ""}>${esc(o.name)}</option>`).join("")}` : ""}
        </select></label>
        ${/* THE EXPLORER HAS ITS OWN, AND BETTER. In Accounts mode these four
             are a second set of controls for source, stage, funnel rung and
             last-call — the chips below carry live counts and the tiles ARE the
             stage filter. Two controls for one dimension disagree the moment
             somebody uses both, which is the complaint that started this
             rewrite. "Allotted to" stays, because it decides which companies
             are fetched rather than which are shown. */
          VIEW_MODE === "accounts" ? "" : `
        <label>Source${multiFilter("fSource", "Source of data", sources, FILTERS.source, label,
          countBy(all, (c) => (c.source ? [c.source] : [])))}</label>
        <label>Stage${multiFilter("fStage", "Pipeline stage", stages, FILTERS.stage, label,
          countBy(all, (c) => (c.stage ? [c.stage] : [])))}</label>`}
        ${/* The funnel filter IS the board's columns, so on the board it is a
             second control for one thing — and two controls for one thing
             disagree the moment somebody uses both. In Accounts it is the KPI
             status chip row. */
          VIEW_MODE !== "table" ? "" :
        `<label>KPI${multiFilter("fKpi", "Funnel rung", FUNNEL.map((f) => f.key), FILTERS.kpi,
          (k) => (FUNNEL.find((f) => f.key === k) || {}).label || k,
          countBy(all, (c) => FUNNEL.filter((f) => c[f.key]).map((f) => f.key)))}</label>`}
        ${VIEW_MODE === "accounts" ? "" :
        `<label>Called since<input type="date" id="fSince" value="${esc(FILTERS.calledSince)}"></label>
        <button class="gbtn" id="fClear" type="button">Clear</button>`}
        <button class="gbtn" id="fRefresh" type="button"${loading ? " disabled" : ""}
          title="Re-read the companies from Kylas now">${loading ? "refreshing…" : "Refresh"}</button>
        ${VIEW_MODE === "board" ? `<label>Group by<select id="fGroup">
          ${AXES.map((a) => `<option value="${a.key}"${GROUP_BY === a.key ? " selected" : ""}>${esc(a.label)}</option>`).join("")}
        </select></label>` : ""}
        ${/* BOARD AND TABLE ARE GONE — Ayush, 2026-09-19: "we can remove the Board
             and Table views. Instead, we can keep it as Accounts." They were
             three answers to one question, and the explorer does what both did:
             the families are the board's columns with counts, and the table is
             under them with every filter the grid had. boardHTML, laneHTML and
             the COLS table are still in this file and unreferenced, so either
             comes back as one line if it turns out to be missed. */""}
        ${VIEW_MODE === "board" ? "" : `<button class="gbtn" id="fDensity" type="button"
          title="${DENSITY === "compact" ? "Roomier rows" : "Fit more rows on screen"}"
        >${DENSITY === "compact" ? "Comfortable" : "Compact"}</button>`}
        <span class="vage">${CACHE.at ? esc(ageText())
          : ""}</span>
        ${kpiNote(all, { repaint: () => companies(host) })}
      </div>
      ${chipStrip(rows, all)}
      ${rcaStrip()}
      ${VIEW_MODE === "accounts" ? explorerHTML(all, ownerNames)
        : VIEW_MODE === "board" ? boardHTML(rows) : `
      <div class="vtable${DENSITY === "compact" ? " dense" : ""}">
        <div class="vr vh">${COLS.map((col) => `<span class="${col.c} srt${
          SORT.key === col.sort ? " on" : ""}" data-sort="${col.sort}"
          role="button" tabindex="0"
          title="Sort by ${esc(col.label.toLowerCase())}">${esc(col.label)}<i>${
            SORT.key === col.sort ? (SORT.dir === 1 ? "↑" : "↓") : ""}</i></span>`).join("")}
        </div>
        <!-- rows painted by paint(), so the window applies to the first
             render as well as to every filter change -->
      </div>`}
      ${CACHE.error ? (API.needsSignIn
        ? signInNote("this is only what the browser holds, not everything allotted to you")
        : `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        This is only what the browser holds, not everything allotted to you.</p>`) : ""}
      ${truncWarn()}
      ${VIEW_MODE === "board"
        ? `<p class="vnote">Every company sits in exactly one column, and inside a column the coldest
        is first — the top of each is what has gone quiet longest, and anything untouched for
        ${STALE_DAYS} days or more is marked. ${GROUP_BY === "state"
          ? `Columns are where each account stopped. <b>Closed</b> is a company with nobody left to
             call: every POC on it has reached a dead end.`
          : GROUP_BY === "stage"
          ? `Columns are the pipeline stage the company's furthest POC has reached, best first.
             Only stages with companies in them are shown.`
          : `Columns are where the name came from, busiest first.`}
        Whatever is not the column is still a filter above, so this narrows rather than needing a
        different board.</p>`
        : `<p class="vnote">Named POCs answer the question a manager actually asks — not how many right
        POCs, but which person. Stage is the highest any POC at that company has reached. A company
        with no POCs yet is one allotted to you that nobody has opened.
        <b>Batch</b> is Kylas' own <code>Batch</code> field on the company, shown as it is stored.</p>`}`;

    /* The board needs the page, not the reading measure. */
    host.closest(".vwrap")?.classList.toggle("board", VIEW_MODE === "board");
    /* The companies view has its own owner selector, and it is not the
       dashboard's. */
    ensureRca(FILTERS.owner, () => companies(host));
    wireRca(host, () => companies(host));

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
    /* Board or table. A MODE, not a preference — it changes what the view is
       for — but remembered all the same, because being put back in the other
       one every morning is its own kind of broken. */
    on("fGroup", "change", async (e) => {
      GROUP_BY = e.target.value;
      try { await Store.setSetting("companiesGroupBy", GROUP_BY); } catch { /* preference only */ }
      companies(host);
    });

    host.querySelectorAll("#fMode button").forEach((b) => b.addEventListener("click", async () => {
      VIEW_MODE = b.dataset.mode;
      try { await Store.setSetting("companiesView", VIEW_MODE); } catch { /* preference only */ }
      companies(host);
    }));

    /* ── explorer wiring ──────────────────────────────────────────────
       Every one of these is a pure re-render over the list already in memory.
       Nothing here goes to the network, which is the whole reason the tiles and
       the chips can carry live counts at all. */
    /* Every filter change goes through here, so the address bar and the
       screen cannot drift apart. */
    const redraw = () => { writeHash(); return companies(host); };

    /* A COMPANY ROW HAS TO OPEN THE COMPANY. bindRows lives inside paint(), and
       paint() returns immediately in this mode — so the explorer's rows were
       the only table in the app with no click handler, and clicking an account
       did nothing at all. Bound here, where the rest of this view is wired. */
    const setView = (v) => { ACC.view = v; saveAccPrefs(); redraw(); };
    on("accTable", "click", () => setView("table"));
    on("accBoard", "click", () => setView("board"));
    /* A card opens the account, exactly as a row does. */
    host.querySelectorAll(".bcard[data-id]").forEach((b) =>
      b.addEventListener("click", () =>
        global.openCompanyFromView?.(b.dataset.id, b.querySelector(".co")?.textContent?.trim() || "")));
    host.querySelectorAll(".acctable .vr[data-id]").forEach((r) =>
      r.addEventListener("click", (e) => {
        /* The LinkedIn and boolean-post chips are links inside a row that is
           itself a button. Without this, opening one also opened the company
           behind it. */
        if (e.target.closest("[data-stop]")) return;
        global.openCompanyFromView?.(r.dataset.id, r.querySelector(".co")?.textContent || "");
      }));
    /* A row that hides its long tail says so, and says it as a chip, so
       reaching the rest is the same gesture as picking one. */
    /* One flag per row that can be capped — named after the row, so adding a
       capped row is one entry here and not a second branch. */
    const MORE_FLAG = { fstage: "fstageMore", aps: "apsMore" };
    host.querySelectorAll(".chip[data-more]").forEach((b) => b.addEventListener("click", () => {
      const flag = MORE_FLAG[b.dataset.more];
      if (flag) ACC[flag] = !ACC[flag];
      redraw();
    }));
    /* Which set a chip row belongs to. One table, so a row added to the
       markup and forgotten here fails loudly rather than silently toggling
       "Last call". */
    const SETS = { source: () => ACC.sources, kpi: () => ACC.kpis, focus: () => ACC.focusSet,
                   next: () => ACC.nextSet, stage: () => ACC.stages, fresh: () => ACC.fresh,
                   rev: () => ACC.rev, emp: () => ACC.emp, round: () => ACC.round,
                   fstage: () => ACC.fstage, offsite: () => ACC.offsiteSet, aps: () => ACC.apsSet };
    host.querySelectorAll(".chip[data-f]").forEach((b) => b.addEventListener("click", () => {
      const { f, v } = b.dataset;
      const set = SETS[f]?.();
      if (!set) return;
      const val = f === "kpi" ? Number(v) : v;
      if (set.has(val)) set.delete(val); else set.add(val);
      ACC.limit = 100; saveAccPrefs(); redraw();
    }));
    /* ── columns, and the bands behind More filters ── */
    /* Everything else off, the two call-back chips on, call-backs first. A
       filter is what this is, so it goes through the same state as the chips
       rather than becoming a fourth kind of view — Clear filters undoes it,
       and Copy link carries it. */
    on("accToday", "click", () => {
      ACC.stages.clear(); ACC.owner = ""; ACC.sources.clear(); ACC.kpis.clear(); ACC.fresh.clear();
      ACC.focusSet.clear();
      for (const st of moreSets()) st.clear();
      ACC.priMin = ""; ACC.q = ""; FB.tree = { join: "and", items: [] };
      ACC.srcOpen = false; ACC.srcFind = ""; ACC.srcOp = "any"; ACC.srcText = "";
      ACC.nextSet = new Set(["overdue", "today"]);
      ACC.sort = "next"; ACC.limit = 100;
      saveAccPrefs(); redraw();
    });
    on("accLink", "click", async () => {
      const url = String(location.href).split("#")[0] + HASH + filtersToQuery();
      try { await navigator.clipboard.writeText(url); toast("Link copied — it opens this list with these filters"); }
      catch { toast("Could not copy — the link is in the address bar"); }
    });
    on("colBtn", "click", () => { ACC.colsOpen = !ACC.colsOpen; ACC.srcOpen = ACC.stageOpen = false; redraw(); });
    on("colReset", "click", () => { ACC.cols = new Set(COL_DEFAULTS); saveAccPrefs(); redraw(); });
    on("colWidthReset", "click", () => { ACC.widths = {}; saveAccPrefs(); redraw(); });

    /* ── the search box ──
       Redrawn a beat after the last key, and then given the focus and the
       caret back — the whole card is re-rendered, so the box the person is
       typing into is a different element by the time they press the next key.
       Same shape as the priority box above it, for the same reason. */
    on("accQ", "input", (e) => {
      ACC.q = e.target.value;
      ACC.limit = 100;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        const at = document.activeElement?.id;
        redraw();
        if (at !== "accQ") return;
        const box = document.getElementById("accQ");
        if (!box) return;
        box.focus({ preventScroll: true });
        try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* not a text box */ }
      }, 200);
    });
    on("accQ", "keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      clearTimeout(qTimer);
      ACC.q = ""; ACC.limit = 100; redraw();
    });

    /* ── resizing a column ──
       Seventeen columns do not fit on any screen the BD team has, so the
       table scrolls sideways — and then "Company" at 1.6fr is luxurious while
       "Account stage" truncates every value it holds. The width is dragged
       here and kept per person, like the choice of columns itself.

       The drag does NOT redraw: it writes the grid template straight onto the
       table, sixty times a second, and only saves on release. Re-rendering
       every frame would rebuild several hundred rows per pixel and the edge
       would lag a long way behind the cursor.

       The two document listeners are bound ONCE, not per paint: this runs
       again on every redraw, and a pair added each time would end the morning
       with a hundred of them. */
    if (!global.__gripBound) {
      global.__gripBound = true;
      document.addEventListener("mousemove", (e) => {
        if (!GRIP) return;
        /* A floor, not zero: a column dragged to nothing cannot be found again
           to drag back. The ceiling keeps one column from pushing every other
           one off the far end of the scroll. */
        ACC.widths[GRIP.k] = Math.round(Math.min(Math.max(GRIP.w + (e.clientX - GRIP.x), 64), 640));
        document.querySelector(".acctable")?.style.setProperty("--acols", gridOf(colsOn()));
      });
      document.addEventListener("mouseup", () => {
        if (!GRIP) return;
        GRIP = null;
        document.body.classList.remove("colresize");
        saveAccPrefs();
      });
    }
    host.querySelectorAll(".cgrip[data-grip]").forEach((g) => {
      g.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        GRIP = { k: g.dataset.grip, x: e.clientX, w: g.parentElement.getBoundingClientRect().width };
        document.body.classList.add("colresize");
      });
      /* Double-click gives the column back to the layout, rather than to some
         other number somebody has to guess at. */
      g.addEventListener("dblclick", (e) => {
        e.preventDefault(); e.stopPropagation();
        delete ACC.widths[g.dataset.grip];
        saveAccPrefs(); redraw();
      });
    });
    host.querySelectorAll("[data-col]").forEach((b) => b.addEventListener("change", () => {
      if (b.checked) ACC.cols.add(b.dataset.col); else ACC.cols.delete(b.dataset.col);
      saveAccPrefs(); redraw();
    }));
    on("moreBtn", "click", () => { ACC.moreOpen = !moreActive() && !ACC.moreOpen; redraw(); });
    on("accPri", "input", (e) => {
      ACC.priMin = e.target.value.trim();
      ACC.limit = 100;
      /* Redrawn on a delay so typing "12" does not filter on "1" first and
         throw the cursor out of the box it is in. */
      clearTimeout(priTimer);
      priTimer = setTimeout(() => { const at = document.activeElement?.id; redraw();
        if (at === "accPri") document.getElementById("accPri")?.focus(); }, 350);
    });
    /* ── the condition builder ── */
    /* A path is "2" for a top-level row or "1.0" for one inside a group, so
       every control carries where it belongs and nothing has to be counted
       back from the DOM. */
    const fbAt = (path) => {
      const [i, j] = String(path).split(".").map(Number);
      const top = FB.tree.items[i];
      return j === undefined ? top : top?.items?.[j];
    };
    const fbNodeOf = (path) => (String(path).includes(".") ? FB.tree.items[Number(String(path).split(".")[0])] : FB.tree);
    on("fbBtn", "click", () => {
      FB.open = !FB.open;
      if (FB.open) { ACC.srcOpen = ACC.stageOpen = ACC.colsOpen = false; if (!FB.tree.items.length) FB.tree.items.push(fbNew()); }
      redraw();
    });
    on("fbAdd", "click", () => { FB.tree.items.push(fbNew()); redraw(); });
    on("fbAddGroup", "click", () => { FB.tree.items.push({ join: "or", items: [fbNew()] }); redraw(); });
    on("fbClear", "click", () => { FB.tree = { join: "and", items: [] }; ACC.limit = 100; redraw(); });
    host.querySelectorAll("[data-fbaddcond]").forEach((b) => b.addEventListener("click", () => {
      FB.tree.items[Number(b.dataset.fbaddcond)]?.items.push(fbNew()); redraw();
    }));
    host.querySelectorAll("[data-fbdel]").forEach((b) => b.addEventListener("click", () => {
      const [i, j] = String(b.dataset.fbdel).split(".").map(Number);
      if (j === undefined) FB.tree.items.splice(i, 1);
      else {
        FB.tree.items[i].items.splice(j, 1);
        /* A group with nothing left in it is not a group. */
        if (!FB.tree.items[i].items.length) FB.tree.items.splice(i, 1);
      }
      ACC.limit = 100; redraw();
    }));
    host.querySelectorAll("[data-fbf]").forEach((sel) => sel.addEventListener("change", () => {
      const c = fbAt(sel.dataset.fbf);
      if (!c) return;
      c.f = sel.value;
      /* The operators change with the field, so an operator the new field has
         no idea about is replaced by its first — "contains" on a number is
         not a question. */
      const ops = Object.keys(FB_OPS[fbField(c.f).type]);
      if (!ops.includes(c.op)) c.op = ops[0];
      c.v = [];
      ACC.limit = 100; redraw();
    }));
    host.querySelectorAll("[data-fbop]").forEach((sel) => sel.addEventListener("change", () => {
      const c = fbAt(sel.dataset.fbop);
      if (!c) return;
      const was = fbNeeds(c.op), now = fbNeeds(sel.value);
      c.op = sel.value;
      /* Switching between "one value" and "a list" means what was typed no
         longer fits the box it was typed into. */
      if (was !== now) c.v = [];
      ACC.limit = 100; redraw();
    }));
    host.querySelectorAll("[data-fbjoin]").forEach((sel) => sel.addEventListener("change", () => {
      fbNodeOf(sel.dataset.fbjoin + (sel.dataset.fbjoin ? ".0" : "")).join = sel.value;
      ACC.limit = 100; redraw();
    }));
    host.querySelectorAll("[data-fbadd]").forEach((sel) => sel.addEventListener("change", () => {
      const c = fbAt(sel.dataset.fbadd);
      if (!c || !sel.selectedIndex) return;
      c.v = [...new Set([...c.v, sel.value])];
      ACC.limit = 100; redraw();
    }));
    host.querySelectorAll("[data-fbdrop]").forEach((b) => b.addEventListener("click", () => {
      const c = fbAt(b.dataset.fbdrop);
      if (!c) return;
      c.v = c.v.filter((v) => v !== b.dataset.v);
      ACC.limit = 100; redraw();
    }));
    /* Typed values apply a moment after the last key, and the caret goes back
       where it was — the table redraws underneath the box being typed into. */
    let fbTimer = null;
    host.querySelectorAll("[data-fbv]").forEach((box) => box.addEventListener("input", () => {
      const c = fbAt(box.dataset.fbv);
      if (!c) return;
      c.v[Number(box.dataset.i)] = box.value;
      ACC.limit = 100;
      clearTimeout(fbTimer);
      fbTimer = setTimeout(() => {
        const path = box.dataset.fbv, i = box.dataset.i;
        redraw();
        const again = document.querySelector(`[data-fbv="${path}"][data-i="${i}"]`);
        if (again) { again.focus({ preventScroll: true });
          try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* ignore */ } }
      }, 400);
    }));

    /* ── the Stage picker ── */
    const stageList = document.getElementById("stageList");
    const findStage = () => {
      if (!stageList) return;
      const q = ACC.stageFind.trim().toLowerCase();
      let shown = 0;
      stageList.querySelectorAll(".msel-opt").forEach((o) => {
        o.hidden = !!q && !o.dataset.name.includes(q);
        if (!o.hidden) shown++;
      });
      const none = document.getElementById("stageNoMatch");
      if (none) none.hidden = shown > 0;
    };
    if (ACC.stageOpen) {
      findStage();
      if (stageList) stageList.scrollTop = ACC.stageScroll || 0;
      const box = document.getElementById("stageFind");
      if (box) {
        box.focus({ preventScroll: true });
        try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* not a text box */ }
      }
    }
    on("stageBtn", "click", () => {
      ACC.stageOpen = !ACC.stageOpen; ACC.stageScroll = 0;
      if (!ACC.stageOpen) ACC.stageFind = ""; else ACC.srcOpen = ACC.colsOpen = false;
      redraw();
    });
    on("stageFind", "input", (e) => { ACC.stageFind = e.target.value; findStage(); });
    on("stageFind", "keydown", (e) => { if (e.key === "Escape") { ACC.stageOpen = false; ACC.stageFind = ""; redraw(); } });
    stageList?.querySelectorAll("input[data-stagev]").forEach((cb) => cb.addEventListener("change", () => {
      const v = cb.dataset.stagev;
      if (cb.checked) ACC.stages.add(v); else ACC.stages.delete(v);
      ACC.stageScroll = stageList.scrollTop; ACC.limit = 100; redraw();
    }));
    on("stageClear", "click", () => { ACC.stages.clear(); ACC.limit = 100; redraw(); });

    /* ── the Source of Data picker ── */
    const srcList = document.getElementById("srcList");
    const findSrc = () => {
      /* Only the checklist is searched; the "contains" preview is not. */
      if (!srcList || !document.getElementById("srcFind")) return;
      const q = ACC.srcFind.trim().toLowerCase();
      let shown = 0;
      srcList.querySelectorAll(".msel-opt").forEach((o) => {
        o.hidden = !!q && !o.dataset.name.includes(q);
        if (!o.hidden) shown++;
      });
      const none = document.getElementById("srcNoMatch");
      if (none) none.hidden = shown > 0;
    };
    if (ACC.srcOpen) {
      /* Re-opened by a redraw: put the reader back where they were. */
      findSrc();
      if (srcList) srcList.scrollTop = ACC.srcScroll;
      const box = document.getElementById("srcText") || document.getElementById("srcFind");
      if (box) {
        box.focus({ preventScroll: true });
        try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* not a text box */ }
      }
    }
    on("srcBtn", "click", () => { ACC.srcOpen = !ACC.srcOpen; ACC.srcScroll = 0; if (!ACC.srcOpen) ACC.srcFind = ""; redraw(); });
    on("srcFind", "input", (e) => { ACC.srcFind = e.target.value; findSrc(); });
    on("srcFind", "keydown", (e) => { if (e.key === "Escape") { ACC.srcOpen = false; ACC.srcFind = ""; redraw(); } });
    srcList?.querySelectorAll("input[data-src]").forEach((cb) => cb.addEventListener("change", () => {
      const v = cb.dataset.src;
      if (cb.checked) ACC.sources.add(v); else ACC.sources.delete(v);
      ACC.srcScroll = srcList.scrollTop; ACC.limit = 100; redraw();
    }));
    on("srcClear", "click", () => {
      ACC.sources.clear(); ACC.srcText = "";
      if (ACC.srcOp === "empty" || ACC.srcOp === "notempty") ACC.srcOp = "any";
      ACC.limit = 100; redraw();
    });
    on("srcOp", "change", (e) => { ACC.srcOp = e.target.value; ACC.srcScroll = 0; ACC.limit = 100; redraw(); });
    /* Applied as you type, a moment after the last key. The table redraws
       underneath, and the field gets the focus and caret back. */
    let srcTimer = null;
    on("srcText", "input", (e) => {
      ACC.srcText = e.target.value;
      clearTimeout(srcTimer);
      srcTimer = setTimeout(() => { ACC.limit = 100; redraw(); }, 250);
    });
    /* Enter applies it now and closes, as Airtable does; Escape closes too.
       Either way the text typed is kept. */
    on("srcText", "keydown", (e) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(srcTimer);
      ACC.srcText = e.target.value; ACC.srcOpen = false; ACC.limit = 100; redraw();
    });
    /* A click anywhere else closes it, as a dropdown should. Bound once. */
    if (!global.__srcOutside) {
      global.__srcOutside = true;
      document.addEventListener("mousedown", (e) => {
        /* Closing keeps the filter, as Airtable does. This used to reset the
           condition and its text, so "contains GPTW" vanished the moment you
           clicked the table to look at what it found. */
        let shut = false;
        for (const [open, id, clear] of [["srcOpen", "#srcPick", () => { ACC.srcFind = ""; }],
                                         ["stageOpen", "#stagePick", () => { ACC.stageFind = ""; }],
                                         ["colsOpen", "#colPick", () => {}]]) {
          if (!ACC[open] || e.target.closest?.(id)) continue;
          ACC[open] = false; clear(); shut = true;
        }
        if (FB.open && !e.target.closest?.("#fbPick")) { FB.open = false; shut = true; }
        if (shut) global.__srcRedraw?.();
      });
    }
    global.__srcRedraw = redraw;
    /* A LINK PASTED INTO A CONSOLE THAT IS ALREADY OPEN changes only the
       fragment, and a browser does not reload the page for that — it fires
       one event and expects to be listened to. Without this, following a
       colleague's filter link while the console was up did nothing at all,
       which looks exactly like a broken link. Bound once. */
    global.__hashRedraw = () => { if (host.isConnected && host.querySelector(".explorer")) redraw(); };
    if (!global.__hashBound) {
      global.__hashBound = true;
      addEventListener("hashchange", () => {
        if (!readHash()) return;
        ACC.limit = 100;
        global.__hashRedraw?.();
      });
    }
    /* Focus lists load on their own and change from the call card: repaint
       this view when they do, if it is the one on screen. Bound once. */
    global.__focusRedraw = () => { if (host.isConnected && host.querySelector(".explorer")) redraw(); };
    if (global.Focus && !global.__focusBound) { global.__focusBound = true; Focus.onChange(() => global.__focusRedraw?.()); }
    global.Focus?.load();
    on("accOwner", "change", (e) => { ACC.owner = e.target.value; ACC.limit = 100; redraw(); });
    on("accSort", "change", (e) => { ACC.sort = e.target.value; saveAccPrefs(); redraw(); });
    on("accMore", "click", () => { ACC.limit += 100; redraw(); });
    on("accClear", "click", () => {
      ACC.stages.clear(); ACC.owner = ""; ACC.sources.clear(); ACC.kpis.clear(); ACC.fresh.clear();
      ACC.focusSet.clear(); ACC.nextSet.clear();
      for (const s of moreSets()) s.clear();
      ACC.priMin = ""; FB.tree = { join: "and", items: [] }; ACC.q = "";
      ACC.srcOpen = false; ACC.srcFind = ""; ACC.srcOp = "any"; ACC.srcText = "";
      ACC.limit = 100; redraw();
    });

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

    /* A row is a way into the company, not a dead end. So is a card — the board
       would be a picture rather than a tool if its cards did not open. */
    const bindRows = () => {
      host.querySelectorAll(".vr[data-id], .vcard[data-id]").forEach((r) =>
        r.addEventListener("click", () => global.openCompanyFromView?.(r.dataset.id)));
      host.querySelectorAll(".vmorec[data-lane]").forEach((b) =>
        b.addEventListener("click", () => { openLanes.add(b.dataset.lane); paint(); }));
    };

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
      /* THE ACCOUNTS VIEW PAINTS ITSELF, in one pass, from the same array.
         paint() exists for the board and the table; it used to fall through to
         `host.querySelector(".vtable")`, which matched the explorer's own table
         and refilled it with board rows — the header said "14 companies" while
         the grid below showed all 43 in the wrong columns. */
      if (VIEW_MODE === "accounts") return;
      const next = matching();
      /* The board rebuilds whole. It is bounded by PER_LANE per column rather
         than by a scroll window, so the work is proportional to what is on
         screen either way — which is the same reason the table windows. */
      const board = host.querySelector(".vboard");
      if (board) {
        board.outerHTML = boardHTML(next);
        bindRows();
        const sub = host.querySelector(".vhead .vsub");
        if (sub) sub.textContent = loading ? "loading…" : `${next.length} of ${all.length}`;
        const cnt = host.querySelector(".vchips .vcount");
        if (cnt) cnt.textContent = `${next.length} of ${all.length}`;
        syncSummaries();
        return;
      }
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
