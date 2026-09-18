/* Overlay-only wiring: talking to the host page, and the Data sheet.
   Loaded after console.js, so it can lean on el(), esc() and toast(). */
(function () {
  const framed = window.parent !== window;
  if (framed) document.body.classList.add("framed");

  const post = (type, payload) => framed && parent.postMessage({ source: "enout", type, ...payload }, "*");

  /* Kept so the clipboard fallback knows which number failed. */
  let lastDialled = "";
  window.requestDial = (number) => {
    lastDialled = number;
    if (!framed) { copyNumber(number); return; }   /* open in a tab, no host page */
    post("dial", { number });
  };

  /* ── host page → console ─────────────────── */
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.source !== "enout-host") return;

    /* Opened on a Kylas company page: scope the queue to that company and show
       the rolled-up view. The contacts are where the data is entered; the
       company strip is derived from them and moves as calls are saved. */
    /* The host page reports what it did with a dial request. */
    if (m.type === "dialled") {
      if (m.ok) toast("Dialling through Kylas — " + (m.why || "dialler clicked"));
      else { toast("No Kylas dialler on this page — copying the number instead"); copyNumber(lastDialled); }
      return;
    }

    if (m.type === "dashboard" || m.type === "companies") { showView(m.type); return; }
    if (m.type === "company" && m.kylasId) {
      showView(null);
      openCompany(String(m.kylasId), m.label);
      return;
    }

    if (m.type === "contact" && m.kylasId) {
      showView(null);
      openContact(String(m.kylasId));
      return;
    }

    if (m.type === "focus") {
      const q = document.getElementById("q");
      if (q) q.blur();
      window.focus();
    }
  });

  /* ── the report views ────────────────────── */
  /* These cover the call console rather than replacing it, so the record the
     associate was on is still there when they navigate back. */
  let view = null;
  function showView(which) {
    const port = document.getElementById("viewport");
    const wrap = document.getElementById("vwrap");
    if (!port) return;
    view = which;
    if (!which) { port.hidden = true; wrap.innerHTML = ""; return; }
    port.hidden = false;
    /* Both views fetch the allotted-companies list, so both are async now. A
       rejection here must show as a message rather than an empty panel and an
       unhandled rejection in the console. */
    wrap.innerHTML = `<p class="vnote">Loading…</p>`;
    (which === "dashboard" ? Views.dashboard : Views.companies)(wrap)
      .catch((e) => { wrap.innerHTML = `<p class="vwarn">Could not build this view — ${e.message}</p>`; });
  }

  /* Clicking a company in the list should take you into it. */
  window.openCompanyFromView = (id) => {
    showView(null);
    const co = DATA.find((a) => String(a.companyId) === String(id));
    openCompany(String(id), co?.company);
  };

  /* ── loading a company ───────────────────── */
  /* Show whatever is already held straight away, then fetch. An associate
     should never watch a spinner before they can start reading a record. */
  function showCompany(id, label) {
    const roster = DATA.filter((a) => String(a.companyId) === String(id));
    scope = { id, name: label || roster[0]?.company || ("Company " + id) };
    mode = "company";
    if (roster.length) {
      cur = DATA.indexOf(roster.find((a) => !a.done) || roster[0]);
      isNew = false;
    } else {
      /* companyId only — NOT scope.name. Before the fetch returns that name can
         be "Company <id>", and airtable.mjs writes `Name: c.company` on the
         company row, so a placeholder here would be saved into Airtable as the
         company's actual name. The id is what everything joins on; the name is
         filled in once Kylas answers. */
      DATA = [Object.assign(blank(), { companyId: scope.id }), ...DATA];
      cur = 0; isNew = true;
    }
    filter = "all"; renderFilters();
    stopTimer(); secs = 0; render(); resetScroll();
    return roster.length;
  }

  async function openCompany(id, label) {
    const had = showCompany(id, label);
    const before = DATA[cur];
    setLink("busy", "Loading from Kylas…");

    let res;
    try {
      res = await API.company(id);
    } catch (e) {
      /* Offline is survivable: the console keeps whatever it already holds. */
      setLink("off", `Kylas unreachable — ${e.message}`);
      /* But the placeholder showCompany made must not survive. It is named after
         the company, so an empty roster renders as a contact that looks real,
         and it carries pendingCreate — on the next drain it would be CREATED in
         Kylas, duplicating a POC that was there all along. We do not know what
         this company holds until the fetch succeeds, so claim nothing. */
      if (!had) {
        const ph = DATA[cur];
        if (ph && !ph.kid && !ph.pocName.trim() && String(ph.companyId) === String(id)) {
          DATA.splice(cur, 1);
          cur = Math.max(0, Math.min(cur, DATA.length - 1));
          isNew = false;
          persist();
        }
      }
      /* A toast fades; this has to stay on screen, or an empty roster reads as
         "this company has no contacts" when it means "we never asked". */
      scope.offline = true;
      render();
      if (!had) toast("Could not reach Kylas — start the proxy to load contacts");
      return;
    }
    scope.offline = false;

    /* Kylas owns the contact fields; the overlay keeps its own. Merging by id
       rather than replacing is what stops a refetch wiping notes typed a moment
       earlier but not yet synced. */
    const byId = new Map(DATA.map((a, i) => [String(a.kid), i]));
    for (const fetched of res.contacts) {
      const at = byId.get(String(fetched.kid));
      if (at === undefined) DATA.push(fetched);
      else DATA[at] = API.merge(DATA[at], fetched);
    }

    /* Owners come back with the contacts. Without this the dropdown keeps the
       three names it was born with and a fetched owner reads as "Choose". */
    adoptPicklists(res.picklists);
    if (res.owners?.length) {
      addOwners(res.owners.map((o) => o.name));
      Store.setSetting("owners", OWNERS.filter(Boolean));
      if (!ME && API.state.user?.name) { ME = API.state.user.name; addOwners([ME]); }
    }

    if (res.company?.name) {
      scope.name = res.company.name;
      /* And on every record at this company. showCompany() has to name the
         scope before the fetch returns, and with no label from the page that
         name is "Company <id>" — which it then stamps onto the placeholder
         contact. Updating only scope.name left the record itself reading
         "Company 1810449" in the queue and on the card, which is what Ayush
         kept seeing. Anything a person actually typed is left alone. */
      for (const a of DATA)
        if (String(a.companyId) === String(id) &&
            (!a.company || /^Company \d+$/.test(a.company))) a.company = res.company.name;
    }
    scope.kylas = res.company || null;

    /* A placeholder made because nothing was held is pointless once real
       contacts have arrived. */
    if (!had && res.contacts.length && before && !before.kid && !before.pocName.trim()) {
      const ph = DATA.indexOf(before);
      if (ph > -1) DATA.splice(ph, 1);
    }

    const roster = DATA.filter((a) => String(a.companyId) === String(id));
    const keep = DATA.indexOf(before);
    cur = keep > -1 && String(DATA[keep].companyId) === String(id)
      ? keep
      : (roster.length ? DATA.indexOf(roster.find((a) => !a.done) || roster[0]) : 0);
    isNew = !DATA[cur]?.kid;

    persist();
    setLink("on", `Kylas · ${API.state.user?.name || "connected"}`);
    render(); resetScroll();
  }

  /* ── loading one contact ─────────────────── */
  /* The same two steps as a company: show what is already held, then ask
     Kylas. Selecting the row and stopping there is the bug this fixes — a
     contact the console had never fetched carried nothing but its id, so the
     name, phone, company and stage visible on the Kylas page behind the
     console were all blank inside it. API.contact() existed and the proxy
     served /contact; nothing called either.

     Guarded by the id being asked for, because Kylas is a single-page app:
     clicking through three contacts fires three fetches, and the first to
     come back must not land on top of the third. */
  let wanted = "";

  function showContact(id) {
    const i = DATA.findIndex((a) => String(a.kid) === String(id));
    if (i >= 0) {
      cur = i; isNew = false;
      const a = DATA[i];
      /* ONE CONTACT, not their whole company. Opening a contact page used to
         flip the queue into company mode, so clicking one person put their
         four colleagues on screen and the record you asked for was merely
         the selected row. The company is still remembered — the call bar
         shows it, and the Company tab is one click away — but the console
         opens on the contact you clicked. */
      scope = a.companyId ? { id: String(a.companyId), name: a.company } : null;
    } else {
      /* The id and nothing else. Not the page heading: recordLabel() reads an
         h1 that may still say something else while the SPA renders, and a
         name invented here is a name the first save writes into Kylas. The
         id is what the fetch joins on; the rest arrives with it.

         isNew stays FALSE. This record exists in Kylas — we are standing on
         its page. Calling it new set pendingCreate on the first save, which
         shows a "new" badge on a contact that is not new and logs the call
         with createdHere: true, putting a contact nobody created into the
         KPI counts. */
      DATA = [Object.assign(blank(), { kid: String(id) }), ...DATA];
      cur = 0; isNew = false; filter = "all"; scope = null;
    }
    mode = "session";
    renderFilters();
    stopTimer(); secs = 0; render(); resetScroll();
    return i >= 0;
  }

  async function openContact(id) {
    wanted = String(id);
    const had = showContact(id);
    const before = DATA[cur];
    setLink("busy", "Loading from Kylas…");

    let res;
    try {
      res = await API.contact(id);
    } catch (e) {
      if (wanted !== String(id)) return;
      setLink("off", `Kylas unreachable — ${e.message}`);
      /* A card holding nothing but an id is worse than no card: it reads as a
         contact with no name and no number, and a save from it would write
         those blanks over the real record. If it was invented for a fetch
         that failed, take it back. */
      if (!had && before && !before.pocName.trim() && String(before.kid) === String(id)) {
        const at = DATA.indexOf(before);
        if (at > -1) {
          DATA.splice(at, 1);
          cur = Math.max(0, Math.min(cur, DATA.length - 1));
          isNew = false;
          persist();
        }
      }
      render();
      if (!had) toast("Could not reach Kylas — start the proxy to load this contact");
      return;
    }

    if (wanted !== String(id)) return;      /* moved on; this answer is stale */

    const fetched = res?.contact;
    if (!fetched?.kid) {
      setLink("on", `Kylas · ${API.state.user?.name || "connected"}`);
      return;
    }

    /* Kylas owns the contact fields, the overlay keeps its own — the same
       merge the company fetch uses, so a refetch never wipes a note typed a
       moment ago and not yet synced. */
    const at = DATA.findIndex((a) => String(a.kid) === String(fetched.kid));
    if (at > -1) DATA[at] = API.merge(DATA[at], fetched);
    else DATA.unshift(fetched);
    cur = at > -1 ? at : 0;
    isNew = false;

    /* The company is remembered, not opened: the call bar and the Company tab
       need it, the queue stays on this one person. scope.name may fall back to
       "Company <id>" — that string is never written onto the record itself,
       because airtable.mjs saves the record's own company as the name. */
    const a = DATA[cur];
    scope = a.companyId
      ? { id: String(a.companyId), name: a.company || ("Company " + a.companyId) }
      : null;
    mode = "session";

    persist();
    setLink("on", `Kylas · ${API.state.user?.name || "connected"}`);
    renderFilters(); render(); resetScroll();
  }

  /* ── proxy link indicator ────────────────── */
  const linkEl = document.getElementById("linkState");
  function setLink(kind, title) {
    if (!linkEl) return;
    linkEl.className = "link " + kind;
    linkEl.textContent = kind === "on" ? "Kylas" : kind === "busy" ? "…" : "offline";
    linkEl.title = title || "";
  }
  if (linkEl) linkEl.onclick = async () => {
    if (API.state.online) return;
    const next = prompt("Proxy address\n\nRun it with:  KYLAS_KEY=... node scripts/proxy.mjs", API.base);
    if (next === null) return;
    setLink("busy", "Checking…");
    const ok = await API.setBase(next.trim());
    setLink(ok ? "on" : "off", ok ? `Kylas · ${ok.user?.name || ""}` : API.state.reason);
  };

  API.onChange((st) => setLink(st.online ? "on" : "off",
    st.online ? `Kylas · ${st.user?.name || "connected"}`
              : `Proxy unreachable — ${st.reason}. Click to change the address.`));

  (async () => {
    await API.configure();
    const ok = await API.health();
    setLink(ok ? "on" : "off", ok ? `Kylas · ${ok.user?.name || ""}`
      : `Proxy unreachable — ${API.state.reason}. Click to change the address.`);
  })();

  /* ── console → host page ─────────────────── */
  document.getElementById("closeBtn").onclick = () => post("close");

  /* `pane`, NOT `mode`. console.js has a script-scope `mode` — "company" or
     "session", which queue the associate is looking at — and a `let mode` in
     this IIFE shadows it for the whole file. Every `mode = "company"` and
     `mode = "session"` above was therefore setting the dock state and leaving
     the queue exactly as it was: opening one contact still listed everybody
     at their company, with the contact merely selected. */
  let pane = "full";
  document.getElementById("dockBtn").onclick = (e) => {
    pane = pane === "full" ? "dock" : "full";
    e.target.textContent = pane === "full" ? "Dock" : "Expand";
    post("mode", { mode: pane });
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

  /* The Data sheet is now reached from the Dashboard rather than its own
     button — the top bar was already carrying the account rollup. */
  const dataBtn = document.getElementById("dataBtn");
  if (dataBtn) dataBtn.onclick = openData;

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
        <div class="dactions"><button class="gbtn" id="gdata" type="button">Captured data &amp; export</button></div>
        <p class="dnote">${liveDays
          ? "Today is still running, so its numbers can still move. Every earlier day is frozen — counted once when the day ended and never recounted, so a report reads the same tomorrow as it does now."
          : "All days shown are frozen."}</p>`;
      const gd = document.getElementById("gdata");
      if (gd) gd.onclick = () => { s.remove(); openData(); };
    }
    paint();
  }

  const dashBtn = document.getElementById("dashBtn");
  if (dashBtn) dashBtn.onclick = openDash;

  /* Catch up on any days that ended while the console was closed. */
  Store.freezeDays();
})();
