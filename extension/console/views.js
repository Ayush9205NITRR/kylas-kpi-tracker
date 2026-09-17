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
    { key: "discovery", label: "Successful AR call",   sub: "one complete row" },
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
  function rollup(data, base) {
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
      return co;
    };

    /* Allotted first, so a company with no contacts still gets a row. Its
       fields — source, batch, account health, owner — live on the COMPANY in
       Kylas, which is why they were blank while this was built from contacts. */
    for (const co of base || []) {
      if (!co?.id) continue;
      row(String(co.id), { name: co.name, source: co.source, owner: co.owner,
                           ownerId: co.ownerId, batch: co.batch, health: co.accountHealth,
                           lastCalledAt: co.lastCalledAt });
    }

    for (const c of data) {
      const id = String(c.companyId || "");
      if (!id) continue;
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
  const CACHE = { owner: null, companies: [], owners: [], error: "" };

  async function loadCompanies(owner) {
    const want = owner || "";
    if (CACHE.owner === want && !CACHE.error) return CACHE.companies;
    try {
      const r = await API.companies(want);
      CACHE.owner = want;
      CACHE.companies = r.companies || [];
      CACHE.owners = r.owners || [];
      CACHE.error = "";
    } catch (e) {
      /* Offline: fall back to contact-derived companies and say so, rather than
         render an empty funnel that reads as "you have done nothing". */
      CACHE.owner = want; CACHE.companies = []; CACHE.error = e.message;
    }
    return CACHE.companies;
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
      <div class="vfr${r.widened ? " grew" : ""}" title="${esc(r.label)} — ${r.n} compan${r.n === 1 ? "y" : "ies"}${
        r.fromPrev ? `, ${r.fromPrev} of the rung above` : ""}">
        <span class="fl">${esc(r.label)}<em>${esc(r.sub)}</em></span>
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

  /* ── call-mode breakdown, stacked by mode ──────────────────────────── */
  /* Segments come from the data, not a fixed list: the Mode of Meeting
     vocabulary is still unsettled (In Person/Virtual/Calls/Text in the schema
     vs Video/Audio/In-Person in the dashboard spec), and a hardcoded list
     renders real values as nothing. Slots are assigned in a FIXED order over
     the sorted mode names, so a filter that drops a mode cannot repaint the
     survivors. Palette: categorical slots 1-3, validated for both surfaces. */
  function modeChart(cos, byLabel) {
    const groups = new Map();
    const modes = new Set();
    for (const co of cos) {
      const k = byLabel(co) || "Unassigned";
      if (!groups.has(k)) groups.set(k, {});
      for (const [m, n] of Object.entries(co.modes || {})) {
        groups.get(k)[m] = (groups.get(k)[m] || 0) + n;
        modes.add(m);
      }
    }
    const keys = [...modes].sort();
    const bars = [...groups.entries()]
      .map(([k, v]) => ({ k, v, total: Object.values(v).reduce((a, b) => a + b, 0) }))
      .filter((b) => b.total > 0)
      .sort((a, b) => b.total - a.total);
    if (!bars.length || !keys.length) return "";

    const max = Math.max(...bars.map((b) => b.total), 1);
    const slot = (i) => `var(--s${(i % 3) + 1})`;
    /* Legend always, for two or more series — identity must never be colour
       alone, and the light aqua slot sits under 3:1 on white, which obliges
       visible labels and the table below. */
    const legend = `<div class="vlg">${keys.map((m, i) =>
      `<span class="lg"><i style="background:${slot(i)}"></i>${esc(m)}</span>`).join("")}</div>`;

    const chart = `<div class="vbars">${bars.map((b) => `
      <div class="vbar">
        <span class="bk">${esc(b.k)}</span>
        <span class="bt">${keys.map((m, i) => {
          const n = b.v[m] || 0;
          if (!n) return "";
          return `<i style="width:${(n / max) * 100}%;background:${slot(i)}"
                     title="${esc(b.k)} · ${esc(m)}: ${n}"></i>`;
        }).join("")}</span>
        <span class="bn tnum">${b.total}</span>
      </div>`).join("")}</div>`;

    /* The table is the accessible equal, not an afterthought — it is also what
       discharges the contrast warning on the light palette. */
    const table = `<details class="vtbl"><summary>Show as a table</summary>
      <table><thead><tr><th>Associate</th>${keys.map((m) => `<th>${esc(m)}</th>`).join("")}<th>Total</th></tr></thead>
      <tbody>${bars.map((b) => `<tr><td>${esc(b.k)}</td>${
        keys.map((m) => `<td class="tnum">${b.v[m] || 0}</td>`).join("")}<td class="tnum">${b.total}</td></tr>`).join("")}
      </tbody></table></details>`;

    return `<div class="vhead sm"><h2>Call mode</h2>
      <span class="vsub">Meetings at booked or beyond, split by how they were held.</span></div>
      ${legend}${chart}${table}`;
  }

  /* ── dashboard ─────────────────────────────────────────────────────── */
  let DASH_OWNER = "";          /* "" = me, "all" = the team */

  async function dashboard(host) {
    const base = await loadCompanies(DASH_OWNER);
    const cos = rollup(DATA, base);
    const team = DASH_OWNER === "all";
    const names = [...new Set(CACHE.owners.map((o) => o.name).filter(Boolean))].sort();

    host.innerHTML = `
      <div class="vhead">
        <h2>${team ? "Team" : "My"} funnel</h2>
        <span class="vsub">Every number counts companies, not contacts.</span>
      </div>
      <div class="vfilters">
        <label>Who<select id="dOwner">
          <option value=""${!team ? " selected" : ""}>Me</option>
          <option value="all"${team ? " selected" : ""}>Everyone</option>
          ${CACHE.owners.map((o) => `<option value="${esc(o.id)}"${
            String(DASH_OWNER) === String(o.id) ? " selected" : ""}>${esc(o.name)}</option>`).join("")}
        </select></label>
        <span class="vsub">${cos.length} compan${cos.length === 1 ? "y" : "ies"}${
          CACHE.error ? " · from this browser only" : " allotted"}</span>
      </div>
      ${CACHE.error ? `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        Showing only the companies this browser holds, so these counts are not your real funnel.</p>` : ""}
      ${funnelHTML(cos)}
      <div id="vmode">${team ? modeChart(cos, (c) => c.owner) : ""}</div>
      <div id="vdays"></div>`;

    const sel = document.getElementById("dOwner");
    if (sel) sel.onchange = () => { DASH_OWNER = sel.value; dashboard(host); };
    paintDays(document.getElementById("vdays"));
  }

  /* Frozen days, so the trend does not silently rewrite itself. */
  async function paintDays(host) {
    if (!host) return;
    await Store.freezeDays();
    const rows = await Store.series(14);
    const max = Math.max(...rows.map((r) => r.dials || 0), 1);
    host.innerHTML = `
      <div class="vhead sm"><h2>Last 14 days</h2>
        <span class="vsub">Each day is counted once when it ends, then never recounted.</span></div>
      <div class="vdays">${rows.map((d) => `
        <div class="vd${d.live ? " live" : ""}">
          <span class="dn">${day(d.date)}</span>
          <span class="db"><i style="width:${Math.round((d.dials / max) * 100)}%"></i></span>
          <span class="dv">${d.dials}</span>
          <span class="dc">${d.connects} picked</span>
          <span class="dl">${d.live ? "live" : "frozen"}</span>
        </div>`).join("")}</div>`;
  }

  /* ── companies list ────────────────────────────────────────────────── */
  const FILTERS = { source: "", stage: "", since: "", kpi: "", owner: "" };

  async function companies(host) {
    /* Same allotted list the dashboard uses, so the two cannot disagree about
       which companies exist. The owner filter here is the company's own owner
       in Kylas, which is what "allotted to me" means. */
    const base = await loadCompanies(FILTERS.owner === "all" ? "all" : FILTERS.owner);
    const all = rollup(DATA, base);
    const sources = [...new Set(all.map((c) => c.source).filter(Boolean))].sort();
    const stages = [...new Set(all.map((c) => c.stage).filter(Boolean))]
      .sort((a, b) => (STAGE_RUNG[b] || 0) - (STAGE_RUNG[a] || 0));

    const rows = all.filter((c) =>
      (!FILTERS.source || c.source === FILTERS.source) &&
      (!FILTERS.stage || c.stage === FILTERS.stage) &&
      (!FILTERS.since || (c.lastQualityAt || "") >= FILTERS.since) &&
      (!FILTERS.kpi || c[FILTERS.kpi]))
      .sort((a, b) => (b.rung - a.rung) || String(b.lastQualityAt || "").localeCompare(String(a.lastQualityAt || "")));

    const opt = (list, cur) =>
      [`<option value="">All</option>`,
       ...list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label(v))}</option>`)].join("");

    host.innerHTML = `
      <div class="vhead">
        <h2>Companies</h2>
        <span class="vsub">${rows.length} of ${all.length}</span>
      </div>
      <div class="vfilters">
        <label>Allotted to<select id="fOwner">
          <option value=""${!FILTERS.owner ? " selected" : ""}>Me</option>
          <option value="all"${FILTERS.owner === "all" ? " selected" : ""}>Everyone</option>
          ${CACHE.owners.map((o) => `<option value="${esc(o.id)}"${
            String(FILTERS.owner) === String(o.id) ? " selected" : ""}>${esc(o.name)}</option>`).join("")}
        </select></label>
        <label>Source<select id="fSource">${opt(sources, FILTERS.source)}</select></label>
        <label>Stage<select id="fStage">${opt(stages, FILTERS.stage)}</select></label>
        <label>KPI<select id="fKpi">
          <option value="">All</option>
          ${FUNNEL.map((f) => `<option value="${f.key}"${
            FILTERS.kpi === f.key ? " selected" : ""}>${esc(f.label)}</option>`).join("")}
        </select></label>
        <label>Quality since<input type="date" id="fSince" value="${esc(FILTERS.since)}"></label>
        <button class="gbtn" id="fClear" type="button">Clear</button>
      </div>
      <div class="vtable">
        <div class="vr vh">
          <span class="c1">Company</span><span class="c2">Stage</span>
          <span class="c3">POCs</span><span class="c4">Right POC</span>
          <span class="c5">Discovery</span><span class="c6">Last called</span>
          <span class="c8">Last quality</span><span class="c7">Allotted to</span>
        </div>
        ${rows.length ? rows.map((c) => `
          <div class="vr" data-id="${esc(c.id)}">
            <span class="c1"><b>${esc(c.name)}</b><em>${esc(c.source || "—")}</em></span>
            <span class="c2">${esc(label(c.stage) || "—")}</span>
            <span class="c3">${c.contacts.length}</span>
            <span class="c4">${c.pocs.right.length ? esc(c.pocs.right.join(", ")) : "—"}</span>
            <span class="c5">${c.pocs.discovery.length ? esc(c.pocs.discovery.join(", ")) : "—"}</span>
            <span class="c6">${day(c.lastCalledAt)}</span>
            <span class="c8">${day(c.lastQualityAt)}</span>
            <span class="c7">${esc(c.owner || "—")}${c.batch ? `<em>${esc(c.batch)}</em>` : ""}</span>
          </div>`).join("")
        : `<div class="vempty">Nothing matches those filters.</div>`}
      </div>
      ${CACHE.error ? `<p class="vwarn">Could not reach Kylas — ${esc(CACHE.error)}.
        This is only what the browser holds, not everything allotted to you.</p>` : ""}
      <p class="vnote">Named POCs answer the question a manager actually asks — not how many right
        POCs, but which person. Stage is the highest any POC at that company has reached. A company
        with no POCs yet is one allotted to you that nobody has opened.</p>`;

    const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
    on("fOwner", "change", (e) => { FILTERS.owner = e.target.value; companies(host); });
    on("fSource", "change", (e) => { FILTERS.source = e.target.value; companies(host); });
    on("fStage", "change", (e) => { FILTERS.stage = e.target.value; companies(host); });
    on("fKpi", "change", (e) => { FILTERS.kpi = e.target.value; companies(host); });
    on("fSince", "change", (e) => { FILTERS.since = e.target.value; companies(host); });
    on("fClear", "click", () => { Object.keys(FILTERS).forEach((k) => (FILTERS[k] = "")); companies(host); });

    /* A row is a way into the company, not a dead end. */
    host.querySelectorAll(".vr[data-id]").forEach((r) =>
      r.addEventListener("click", () => global.openCompanyFromView?.(r.dataset.id)));
  }

  global.Views = { rollup, dashboard, companies, FILTERS };
})(window);
