/* Injects the console into a Kylas page.

   The console lives in an iframe inside a shadow root. That is deliberate: the
   iframe gives it its own document, so Kylas' stylesheets cannot reach the
   console and the console cannot disturb Kylas. The only thing this script
   reads from the host page is the contact id in the URL — no DOM scraping, so
   a Kylas front-end release cannot break it. */
(() => {
  if (window.__enoutConsole) return;
  window.__enoutConsole = true;

  const HOST_ID = "enout-console-host";
  const SRC = chrome.runtime.getURL("console/console.html");

  const host = document.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>
      :host{all:initial}
      .fab{
        position:fixed;right:18px;bottom:18px;z-index:2147483646;
        display:flex;align-items:center;gap:7px;
        background:#2B6CF6;color:#fff;border:0;border-radius:22px;
        padding:10px 16px;cursor:pointer;
        font:600 13px/1 "IBM Plex Sans","Helvetica Neue",Arial,sans-serif;
        box-shadow:0 4px 14px rgba(43,108,246,.32);
      }
      .fab:hover{filter:brightness(1.08)}
      .fab kbd{
        font:500 10px/1 ui-monospace,Menlo,monospace;
        background:rgba(255,255,255,.18);border-radius:3px;padding:2px 4px;
      }
      .scrim{
        position:fixed;inset:0;z-index:2147483646;
        background:rgba(31,42,55,.38);opacity:0;pointer-events:none;
        transition:opacity .16s ease;
      }
      .wrap{
        position:fixed;z-index:2147483647;
        background:#F7F9FC;border-radius:10px;overflow:hidden;
        box-shadow:0 18px 60px rgba(31,42,55,.28);
        opacity:0;pointer-events:none;transform:translateY(6px);
        transition:opacity .16s ease,transform .16s ease;
      }
      .wrap.full{inset:18px}
      .wrap.dock{top:0;right:0;bottom:0;width:min(520px,46vw);border-radius:0}
      :host(.open) .wrap{opacity:1;pointer-events:auto;transform:none}
      :host(.open) .scrim{opacity:1;pointer-events:auto}
      :host(.open) .fab{display:none}
      :host(.dock) .scrim{opacity:0;pointer-events:none}
      iframe{width:100%;height:100%;border:0;display:block;background:#F7F9FC}
      @media (prefers-color-scheme:dark){
        .wrap,iframe{background:#0F141C}
      }
    </style>
    <button class="fab" part="fab" title="Open the call console">
      <span class="lbl">Call console</span> <kbd>⌥⇧E</kbd>
    </button>
    <div class="scrim"></div>
    <div class="wrap full"><iframe title="Enout call console" allow="clipboard-write"></iframe></div>`;

  const fab = root.querySelector(".fab");
  const fabLabel = root.querySelector(".fab .lbl");
  const scrim = root.querySelector(".scrim");
  const wrap = root.querySelector(".wrap");
  const frame = root.querySelector("iframe");

  let open = false, loaded = false;

  /* Real Kylas record urls look like
       app.kylas.io/sales/companies/details/1776620
       app.kylas.io/sales/contacts/details/<id>
     This is the only thing read from the host page. */
  const REC = /\/sales\/(companies|contacts|leads)\/details\/(\d+)/i;
  /* Two Kylas pages are not records but reports, and the console shows its own
     view of them instead of the call form. */
  const VIEWS = [
    [/\/sales\/home\/?$/i, "dashboard"],
    [/\/sales\/companies\/list\/?$/i, "companies"],
  ];
  function currentRecord() {
    const m = location.pathname.match(REC);
    if (m) return { kind: m[1].toLowerCase().replace(/ies$/, "y").replace(/s$/, ""), id: m[2] };
    for (const [re, view] of VIEWS) if (re.test(location.pathname)) return { kind: view, id: view };
    return null;
  }

  /* Display label only — never data. The record id is what everything joins on,
     so a miss here costs a nicer heading and nothing else. */
  function recordLabel() {
    const h = document.querySelector("h1, [class*='entity-name'], [class*='record-title']");
    /* document.title is "Kylas" on its own while the SPA is still rendering, so
       using it as a fallback labelled every company "Kylas" — a plausible-looking
       wrong name, which is worse than none. An empty label lets the console show
       the id it actually knows. */
    const raw = (h && h.textContent) || "";
    const out = raw.replace(/\(#\d+\)/, "").replace(/\s*[|·–-]\s*Kylas.*$/i, "").trim().slice(0, 60);
    return /^kylas$/i.test(out) ? "" : out;
  }

  function send(type, payload) {
    if (!loaded) return;
    frame.contentWindow.postMessage({ source: "enout-host", type, ...payload }, "*");
  }

  function setOpen(next, mode) {
    if (!next && open) {
      const rec = currentRecord();
      dismissedFor = rec ? `${rec.kind}:${rec.id}` : null;
    }
    open = next;
    host.classList.toggle("open", open);
    if (mode) {
      wrap.classList.toggle("full", mode === "full");
      wrap.classList.toggle("dock", mode === "dock");
      host.classList.toggle("dock", mode === "dock");
    }
    if (!open) return;

    if (!loaded) {
      frame.src = SRC;
      frame.addEventListener("load", () => {
        loaded = true;
        handoff();
      }, { once: true });
    } else {
      handoff();
    }
  }

  function handoff() {
    const rec = currentRecord();
    if (rec) send(rec.kind, { kylasId: rec.id, label: recordLabel() });
    send("focus");
    frame.focus();
  }

  /* Kylas is a single-page app, so moving between records never reloads. Follow
     the history so the console retargets instead of going stale. */
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (open) handoff();
  }, 700);

  fab.addEventListener("click", () => setOpen(true));
  scrim.addEventListener("click", () => setOpen(false));

  /* messages back from the console */
  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.source !== "enout") return;
    if (m.type === "close") setOpen(false);
    if (m.type === "mode") setOpen(true, m.mode);
    if (m.type === "dial") dial(String(m.number || ""));
  });

  /* ── hand a number to Kylas' own dialler ───────────────────────────────
     A tel: link from inside the iframe goes to the OS, which on a Mac with no
     softphone registered does nothing at all — the click looks dead. Kylas'
     dialler is a control in THIS page, so the only way to reach it is to find
     it here and click it.

     No selector for it is documented, so match on the number rather than on
     Kylas' markup: their own UI renders the number somewhere, and clicking
     that is clicking their dialler. Compared on the last 10 digits, because
     the page may write it as +91 64645 74899, 064645-74899 or 6464574899.

     This only ever CLICKS something already on the page. It reads no data out
     of Kylas — the console still gets everything through the API. */
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const tail = (s) => digits(s).slice(-10);

  function dialCandidates(want) {
    const out = [];
    /* Kylas' own tel: anchors first — the most explicit statement of intent
       the page can make about a number. */
    for (const a of document.querySelectorAll('a[href^="tel:"]'))
      if (tail(a.getAttribute("href")) === want) out.push({ el: a, why: "tel: link" });

    /* Then anything whose visible text or label is that number, and which is
       actually clickable. Walking every node would be slow on a CRM page, so
       stay with the elements a UI puts a number in. */
    const sel = 'button,[role="button"],a,[class*="dial"],[class*="call"],[class*="phone"],[aria-label]';
    for (const el of document.querySelectorAll(sel)) {
      if (out.some((c) => c.el === el)) continue;
      const hay = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${
        (el.textContent || "").slice(0, 60)}`;
      if (tail(hay) === want) out.push({ el, why: "labelled with the number" });
    }

    /* Last resort: a dial control sitting next to the number rather than on
       it — the icon beside a phone field, which is how Kylas renders it. */
    for (const el of document.querySelectorAll(sel)) {
      if (out.some((c) => c.el === el)) continue;
      const cls = `${el.className || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
      if (!/dial|call/.test(cls)) continue;
      const near = el.closest("tr,li,div,section");
      if (near && tail(near.textContent || "").endsWith(want)) out.push({ el, why: "dial control beside the number" });
    }
    return out;
  }

  function dial(number) {
    const want = tail(number);
    if (!want) return send("dialled", { ok: false, reason: "no number" });
    const hits = dialCandidates(want);
    if (!hits.length) return send("dialled", { ok: false, reason: "no dial control for that number on this page" });
    const { el, why } = hits[0];
    /* A real click, not el.click(), so a framework listening for pointer
       events reacts the way it would to a person. */
    el.scrollIntoView?.({ block: "center" });
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    send("dialled", { ok: true, why });
  }

  /* toolbar button and Alt+Shift+E, relayed by the service worker */
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.source === "enout-bg" && m.type === "toggle") setOpen(!open);
  });

  /* Alt+Shift+E again while the host page has focus. The same chord inside the
     iframe is handled by the browser command, so both sides work. */
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      setOpen(!open);
    }
  });

  /* Open by itself on a record page. Somebody who has just clicked a company
     in Kylas wants the console, not another click — but if they close it, that
     is a decision, so it stays closed until they move to another record. */
  let autoOpenedFor = null, dismissedFor = null;
  setInterval(() => {
    const rec = currentRecord();
    const key = rec ? `${rec.kind}:${rec.id}` : null;
    if (!key) return;
    if (open) { autoOpenedFor = key; return; }
    if (key === dismissedFor || key === autoOpenedFor) return;
    autoOpenedFor = key;
    setOpen(true);
  }, 700);

  /* keep the launcher honest about what it will do */
  setInterval(() => {
    const rec = currentRecord();
    fabLabel.textContent =
      !rec ? "Call console" :
      rec.kind === "dashboard" ? "KPI dashboard" :
      rec.kind === "companies" ? "Company view" :
      rec.kind === "company" ? "Work this company" : "Log a call";
  }, 700);

  (document.body || document.documentElement).appendChild(host);
})();
