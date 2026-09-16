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

  /* One row per company, from every contact the console holds. */
  function rollup(data) {
    const by = new Map();
    for (const c of data) {
      const id = String(c.companyId || "");
      if (!id) continue;
      if (!by.has(id)) by.set(id, {
        id, name: c.company || ("Company " + id), contacts: [],
        source: "", rung: 0, stage: "", lastQualityAt: null,
        pocs: { right: [], discovery: [], sql: [] },
      });
      by.get(id).contacts.push(c);
    }

    for (const co of by.values()) {
      for (const c of co.contacts) {
        if (!co.source && c.source) co.source = c.source;

        /* The company sits at the best rung any of its POCs has reached. */
        const r = STAGE_RUNG[c.stage] || 0;
        if (r > co.rung) { co.rung = r; co.stage = c.stage; }

        /* Last quality date: the most recent stage change across its POCs. A
           second call two hours later moves it; a call that changes nothing
           does not. */
        const at = c.lastStageChangeAt || null;
        if (at && (!co.lastQualityAt || at > co.lastQualityAt)) co.lastQualityAt = at;

        /* Who, by name — "which POC did the discovery happen with" is the
           question a manager actually asks. */
        if (signal(c)) co.pocs.right.push(c.pocName);
        if (complete(c)) co.pocs.discovery.push(c.pocName);
        if (c.stage === "SQL_SALES_QUALIFIED_LEAD") co.pocs.sql.push(c.pocName);
      }
      /* The funnel is cumulative, and each rung implies the one below it. A
         company with a discovery was necessarily reached, so without this the
         rates come out above 100% and the funnel does not read downwards. */
      co.sql = co.pocs.sql.length > 0;
      co.discovery = co.pocs.discovery.length > 0 || co.sql;
      co.right = co.pocs.right.length > 0 || co.discovery;
      co.picked = co.contacts.some(picked) || co.right;
      co.reached = co.contacts.some((c) => c.lastCallAt || c.lastStageChangeAt) || co.picked;
    }
    return [...by.values()];
  }

  /* ── dashboard ─────────────────────────────────────────────────────── */
  const pct = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "—");
  const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");

  function dashboard(host) {
    const cos = rollup(DATA);
    const reached = cos.filter((c) => c.reached);
    const tile = (n, label, sub, k) =>
      `<div class="vt ${k || ""}"><b>${n}</b><span>${label}</span>${sub ? `<i>${sub}</i>` : ""}</div>`;

    /* The funnel is cumulative: a discovery company is also a right POC and was
       also picked up, so the numbers read straight down. */
    host.innerHTML = `
      <div class="vhead">
        <h2>Companies</h2>
        <span class="vsub">Everything below counts companies, not contacts.</span>
      </div>
      <div class="vgrid">
        ${tile(reached.length, "reached", "at least one call logged", "v1")}
        ${tile(cos.filter((c) => c.picked).length, "picked up",
               pct(cos.filter((c) => c.picked).length, reached.length) + " of reached", "v2")}
        ${tile(cos.filter((c) => c.right).length, "right POC",
               pct(cos.filter((c) => c.right).length, reached.length) + " of reached", "v3")}
        ${tile(cos.filter((c) => c.discovery).length, "successful discovery",
               pct(cos.filter((c) => c.discovery).length, reached.length) + " of reached", "v4")}
      </div>
      <p class="vnote">Counted across the ${cos.length} compan${cos.length === 1 ? "y" : "ies"} this
        console holds. Once the Airtable sync is running these come from there instead, and cover
        every company rather than the ones opened in this browser.</p>
      <div id="vdays"></div>`;

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
  const FILTERS = { source: "", stage: "", since: "", kpi: "" };

  function companies(host) {
    const all = rollup(DATA);
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
        <label>Source<select id="fSource">${opt(sources, FILTERS.source)}</select></label>
        <label>Stage<select id="fStage">${opt(stages, FILTERS.stage)}</select></label>
        <label>KPI<select id="fKpi">
          <option value="">All</option>
          <option value="reached"${FILTERS.kpi === "reached" ? " selected" : ""}>Reached</option>
          <option value="picked"${FILTERS.kpi === "picked" ? " selected" : ""}>Picked up</option>
          <option value="right"${FILTERS.kpi === "right" ? " selected" : ""}>Right POC</option>
          <option value="discovery"${FILTERS.kpi === "discovery" ? " selected" : ""}>Discovery</option>
        </select></label>
        <label>Quality since<input type="date" id="fSince" value="${esc(FILTERS.since)}"></label>
        <button class="gbtn" id="fClear" type="button">Clear</button>
      </div>
      <div class="vtable">
        <div class="vr vh">
          <span class="c1">Company</span><span class="c2">Stage</span>
          <span class="c3">POCs</span><span class="c4">Right POC</span>
          <span class="c5">Discovery</span><span class="c6">Last quality</span>
        </div>
        ${rows.length ? rows.map((c) => `
          <div class="vr" data-id="${esc(c.id)}">
            <span class="c1"><b>${esc(c.name)}</b><em>${esc(c.source || "—")}</em></span>
            <span class="c2">${esc(label(c.stage) || "—")}</span>
            <span class="c3">${c.contacts.length}</span>
            <span class="c4">${c.pocs.right.length ? esc(c.pocs.right.join(", ")) : "—"}</span>
            <span class="c5">${c.pocs.discovery.length ? esc(c.pocs.discovery.join(", ")) : "—"}</span>
            <span class="c6">${day(c.lastQualityAt)}</span>
          </div>`).join("")
        : `<div class="vempty">Nothing matches those filters.</div>`}
      </div>
      <p class="vnote">Named POCs answer the question a manager actually asks — not how many right
        POCs, but which person. Stage is the highest any POC at that company has reached.</p>`;

    const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
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
