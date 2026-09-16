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
     console.js already uses Esc to dismiss a sheet or leave a field. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !framed) return;
    if (document.querySelector(".scrim")) return;
    if (document.activeElement && document.activeElement.matches("input,textarea,select")) return;
    post("close");
  });

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
})();
