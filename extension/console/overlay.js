/* Overlay-only wiring: talking to the host page, and the Data sheet.
   Loaded after console.js, so it can lean on el(), esc() and toast(). */
(function () {
  const framed = window.parent !== window;
  if (framed) document.body.classList.add("framed");

  const post = (type, payload) => framed && parent.postMessage({ source: "enout", type, ...payload }, "*");

  /* ── host page → console ─────────────────── */
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.source !== "enout-host") return;

    /* Opened on a Kylas company page: scope the queue to that company and show
       the rolled-up view. The contacts are where the data is entered; the
       company strip is derived from them and moves as calls are saved. */
    if (m.type === "company" && m.kylasId) {
      const roster = DATA.filter((a) => String(a.companyId) === String(m.kylasId));
      scope = { id: String(m.kylasId), name: m.label || roster[0]?.company || ("Company " + m.kylasId) };
      if (roster.length) {
        const next = roster.find((a) => !a.done) || roster[0];
        cur = DATA.indexOf(next);
        isNew = false;
      } else {
        /* Nothing held for this company yet — start the first POC on it. */
        const b = Object.assign(blank(), { company: scope.name, companyId: scope.id });
        DATA = [b, ...DATA];
        cur = 0; isNew = true;
      }
      filter = "all"; renderFilters();
      stopTimer(); secs = 0; render(); resetScroll();
      return;
    }

    if (m.type === "contact" && m.kylasId) {
      /* Opened from a Kylas contact page. Select that record if we hold it,
         otherwise start a new one stamped with the id so the save can join
         back on it later. */
      const i = DATA.findIndex((a) => String(a.kid) === String(m.kylasId));
      if (i >= 0) {
        cur = i; isNew = false;
        const a = DATA[i];
        scope = a.companyId ? { id: String(a.companyId), name: a.company } : null;
        renderFilters();
      } else {
        DATA = [Object.assign(blank(), { kid: String(m.kylasId) }), ...DATA];
        cur = 0; isNew = true; filter = "all"; renderFilters();
      }
      stopTimer(); secs = 0; render(); resetScroll();
    }

    if (m.type === "focus") {
      const q = document.getElementById("q");
      if (q) q.blur();
      window.focus();
    }
  });

  /* ── console → host page ─────────────────── */
  document.getElementById("closeBtn").onclick = () => post("close");

  let mode = "full";
  document.getElementById("dockBtn").onclick = (e) => {
    mode = mode === "full" ? "dock" : "full";
    e.target.textContent = mode === "full" ? "Dock" : "Expand";
    post("mode", { mode });
  };

  /* Esc closes the overlay, but only when it would otherwise do nothing —
     console.js already uses Esc to dismiss a sheet or leave a field.

     Capture phase matters: console.js listens on the bubble phase and removes
     the sheet there, so checking for one afterwards always finds nothing and
     the overlay would close along with the sheet. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !framed) return;
    if (document.querySelector(".scrim")) return;
    if (document.activeElement && document.activeElement.matches("input,textarea,select")) return;
    post("close");
  }, true);

  /* ── data sheet ──────────────────────────── */
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (iso) => { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const mmss = (s) => pad(Math.floor((s || 0) / 60)) + ":" + pad((s || 0) % 60);

  async function openData() {
    const dump = await Store.exportAll();
    const log = dump.callLog;
    const today = new Date().toISOString().slice(0, 10);
    const todays = log.filter((e) => (e.at || "").slice(0, 10) === today);
    const connected = todays.filter((e) => e.outcome && e.outcome !== "No answer").length;
    const secs = todays.reduce((n, e) => n + (e.duration || 0), 0);
    const drafts = Object.keys(dump.drafts).length;

    const s = el("div", "scrim");
    s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dh">
      <div class="h"><h3 id="dh">Captured data</h3><button class="gbtn" id="dx" type="button">Close</button></div>
      <div class="b">
        <div class="dgrid">
          <div class="dcard"><b>${todays.length}</b><span>calls logged today</span></div>
          <div class="dcard"><b>${connected}</b><span>connected today</span></div>
          <div class="dcard"><b>${mmss(secs)}</b><span>time on calls today</span></div>
          <div class="dcard"><b>${dump.contacts.length}</b><span>contacts held</span></div>
        </div>
        <div class="dactions">
          <button class="pbtn" id="dexp" type="button">Export JSON</button>
          <button class="gbtn" id="dcopy" type="button">Copy</button>
          <button class="gbtn" id="dwipe" type="button">Clear all</button>
        </div>
        <p class="dnote">${log.length} call${log.length === 1 ? "" : "s"} and ${drafts} draft${drafts === 1 ? "" : "s"} held locally.
          Nothing has been sent anywhere yet — export this to check the shape before the
          Airtable and Kylas writes get wired in.</p>
        ${log.length ? `<div class="dlog">${log.slice(-40).reverse().map((e) => `
          <div><span class="t">${clock(e.at)}</span>
               <span class="w">${esc(e.pocName || "—")}</span>
               <span class="o">${esc(e.outcome || "—")}</span>
               <span class="t">${mmss(e.duration)}</span></div>`).join("")}</div>` : ""}
      </div></div>`;
    document.body.appendChild(s);
    s.onclick = (e) => { if (e.target === s) s.remove(); };
    document.getElementById("dx").onclick = () => s.remove();

    const name = `enout-capture-${today}.json`;
    const json = JSON.stringify(dump, null, 2);

    document.getElementById("dexp").onclick = () => {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    document.getElementById("dcopy").onclick = () =>
      navigator.clipboard.writeText(json).then(
        () => toast("Copied " + log.length + " calls"),
        () => toast("Clipboard blocked — use Export"),
      );
    document.getElementById("dwipe").onclick = async () => {
      if (!confirm("Delete every locally captured contact, draft and call? This cannot be undone.")) return;
      await Store.wipe();
      s.remove();
      toast("Local data cleared — reload to start over");
    };
  }

  document.getElementById("dataBtn").onclick = openData;

  /* ── dashboard ───────────────────────────── */
  /* Days that are over are read from the freeze; today is counted live and
     labelled, so nobody mistakes a day in progress for a finished one. */
  const RANGES = [
    { k: "day", label: "Today", days: 1 },
    { k: "week", label: "This week", days: 7 },
    { k: "month", label: "This month", days: 30 },
  ];
  let range = "day";

  const pct = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "—");
  const dayName = (iso) =>
    new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  async function openDash() {
    await Store.freezeDays();
    const s = el("div", "scrim");
    s.innerHTML = `<div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="gh">
      <div class="h"><h3 id="gh">Dashboard</h3><button class="gbtn" id="gx" type="button">Close</button></div>
      <div class="b"><div class="rtabs" id="rtabs"></div><div id="gbody"></div></div></div>`;
    document.body.appendChild(s);
    s.onclick = (e) => { if (e.target === s) s.remove(); };
    document.getElementById("gx").onclick = () => s.remove();

    const tabs = document.getElementById("rtabs");
    RANGES.forEach((r) => {
      const b = el("button", "rt", r.label);
      b.type = "button";
      b.setAttribute("aria-pressed", range === r.k ? "true" : "false");
      b.onclick = () => { range = r.k; paint(); };
      tabs.appendChild(b);
    });

    async function paint() {
      tabs.querySelectorAll(".rt").forEach((b, i) =>
        b.setAttribute("aria-pressed", RANGES[i].k === range ? "true" : "false"));

      const r = RANGES.find((x) => x.k === range);
      const rows = await Store.series(r.days);
      const sum = (f) => rows.reduce((n, d) => n + (d[f] || 0), 0);
      const dials = sum("dials"), connects = sum("connects");
      const liveDays = rows.filter((d) => d.live && d.dials).length;
      const mm = Math.floor(sum("talkSeconds") / 60);

      const tile = (n, l, sub, k) =>
        `<div class="gt ${k}"><b>${n}</b><span>${l}</span>${sub ? `<i>${sub}</i>` : ""}</div>`;

      document.getElementById("gbody").innerHTML = `
        <div class="ggrid">
          ${tile(dials, "dials", null, "g1")}
          ${tile(connects, "connected", pct(connects, dials) + " connect rate", "g2")}
          ${tile(sum("rightPOC"), "right POC", pct(sum("rightPOC"), connects) + " of connects", "g3")}
          ${tile(sum("discovery"), "discovery", pct(sum("discovery"), connects) + " of connects", "g4")}
          ${tile(sum("companies"), "companies touched", null, "g5")}
          ${tile(mm + "m", "talk time", "measured dials only", "g6")}
        </div>
        ${rows.length > 1 ? `<div class="gdays">${rows.map((d) => {
          const w = dials ? Math.round((d.dials / Math.max(...rows.map((x) => x.dials || 0), 1)) * 100) : 0;
          return `<div class="gd${d.live ? " live" : ""}">
            <span class="dn">${dayName(d.date)}</span>
            <span class="db"><i style="width:${w}%"></i></span>
            <span class="dv">${d.dials}</span>
            <span class="dl">${d.live ? "live" : "frozen"}</span>
          </div>`;
        }).join("")}</div>` : ""}
        <p class="dnote">${liveDays
          ? "Today is still running, so its numbers can still move. Every earlier day is frozen — counted once when the day ended and never recounted, so a report reads the same tomorrow as it does now."
          : "All days shown are frozen."}</p>`;
    }
    paint();
  }

  document.getElementById("dashBtn").onclick = openDash;

  /* Catch up on any days that ended while the console was closed. */
  Store.freezeDays();
})();
