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
      .wrap.full{inset:10px}
      .wrap.dock{top:0;right:0;bottom:0;width:min(520px,46vw);border-radius:0}
      /* MOVED BY HAND. Once the console has been dragged it stops being
         "the whole screen inset by a hair" and becomes a rectangle at a
         remembered place, so the geometry has to be explicit. */
      .wrap.free{inset:auto;transition:none}
      /* While a drag is running this sits over everything, including the
         iframe. Without it the pointer crosses into the iframe on the first
         movement and the host page stops hearing mousemove at all — the
         console would follow the cursor for three pixels and then stop. */
      .dragcatch{position:fixed;inset:0;z-index:2147483647;cursor:grabbing;display:none}
      :host(.dragging) .dragcatch{display:block}
      /* RESIZING. Eight grips on the console's own edge, on the host's side of
         the iframe — the iframe swallows the pointer, so a grip drawn inside
         the console could be grabbed but never dragged. 6px is the smallest
         strip a mouse finds reliably; the corners are 12px because a corner
         is aimed at rather than swept into. They sit over the iframe's edge
         rather than outside it, so the console does not grow a border. */
      .rsz{position:absolute;z-index:4}
      .rsz.n{top:0;left:12px;right:12px;height:6px;cursor:ns-resize}
      .rsz.s{bottom:0;left:12px;right:12px;height:6px;cursor:ns-resize}
      .rsz.w{left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
      .rsz.e{right:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
      .rsz.nw{top:0;left:0;width:12px;height:12px;cursor:nwse-resize}
      .rsz.se{bottom:0;right:0;width:12px;height:12px;cursor:nwse-resize}
      .rsz.ne{top:0;right:0;width:12px;height:12px;cursor:nesw-resize}
      .rsz.sw{bottom:0;left:0;width:12px;height:12px;cursor:nesw-resize}
      /* The catcher's grabbing cursor is right for a move and wrong for a
         resize — it would say "you are moving this" for the whole drag. */
      :host(.rs-ns) .dragcatch{cursor:ns-resize}
      :host(.rs-ew) .dragcatch{cursor:ew-resize}
      :host(.rs-nwse) .dragcatch{cursor:nwse-resize}
      :host(.rs-nesw) .dragcatch{cursor:nesw-resize}
      :host(.open) .wrap{opacity:1;pointer-events:auto;transform:none}
      :host(.open) .scrim{opacity:1;pointer-events:auto}
      :host(.open) .fab{display:none}
      :host(.dock) .scrim{opacity:0;pointer-events:none}
      iframe{width:100%;height:100%;border:0;display:block;background:#F7F9FC}
      /* Shown only when this page is holding a console the browser has thrown
         away. Covers the dead iframe rather than sitting beside it, because
         the thing it is explaining is a blank rectangle. */
      .stale{
        position:absolute;inset:0;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:10px;text-align:center;
        padding:24px;background:#F7F9FC;color:#1F2A37;
        font:400 14px/1.5 "IBM Plex Sans","Helvetica Neue",Arial,sans-serif;
      }
      .stale b{font-size:15px;font-weight:600}
      .stale span{color:#5A6472;max-width:34ch}
      .stale button{
        margin-top:4px;background:#2B6CF6;color:#fff;border:0;border-radius:8px;
        padding:9px 18px;font:600 13px/1 inherit;cursor:pointer;
      }
      @media (prefers-color-scheme:dark){
        .stale{background:#0F141C;color:#E6E9EF}
        .stale span{color:#98A2B3}
      }
      @media (prefers-color-scheme:dark){
        .wrap,iframe{background:#0F141C}
      }
    </style>
    <button class="fab" part="fab" title="Open the call console">
      <span class="lbl">Call console</span> <kbd>⌥⇧E</kbd>
    </button>
    <div class="scrim"></div>
    <div class="wrap full"><iframe title="Enout call console" allow="clipboard-write"></iframe>
      <i class="rsz n"></i><i class="rsz s"></i><i class="rsz w"></i><i class="rsz e"></i>
      <i class="rsz nw"></i><i class="rsz ne"></i><i class="rsz sw"></i><i class="rsz se"></i></div>
    <div class="dragcatch"></div>`;

  const fab = root.querySelector(".fab");
  const fabLabel = root.querySelector(".fab .lbl");
  const scrim = root.querySelector(".scrim");
  const wrap = root.querySelector(".wrap");
  const frame = root.querySelector("iframe");

  let open = false, loaded = false, ready = false, deadline = null;

  /* ── MOVING THE CONSOLE ──────────────────────────────────────────────
     It used to be nailed to the screen: full, or docked right, and nothing
     else. On a real desk that is wrong often enough to matter — the Kylas
     record underneath is sometimes the thing you need to read while you
     type, and "close it, look, open it again" costs the call.

     Dragging starts on the console's own header, which is INSIDE the iframe,
     so the console tells the host page a drag has begun (overlay.js posts
     "dragstart") and the host does the rest. The host has to own the move:
     the wrap is its element, and once the pointer is over the iframe the
     host stops seeing mousemove — hence .dragcatch above. */
  const POS_KEY = "enout.console.pos";
  let drag = null, resize = null;
  const catcher = root.querySelector(".dragcatch");

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function place(left, top, width, height) {
    /* Always leave a strip of the header reachable. A window dragged off the
       top edge is a window that cannot be dragged back. */
    const w = clamp(width, 360, innerWidth);
    const h = clamp(height, 260, innerHeight);
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    wrap.style.left = `${clamp(left, 40 - w, innerWidth - 40)}px`;
    wrap.style.top = `${clamp(top, 0, innerHeight - 40)}px`;
  }
  function savePos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: parseFloat(wrap.style.left), top: parseFloat(wrap.style.top),
        width: parseFloat(wrap.style.width), height: parseFloat(wrap.style.height),
      }));
    } catch { /* a browser with no storage still moves it, it just forgets */ }
  }
  function restorePos() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch { /* ignore */ }
    if (!p || ![p.left, p.top, p.width, p.height].every(Number.isFinite)) return false;
    wrap.classList.remove("full", "dock");
    wrap.classList.add("free");
    place(p.left, p.top, p.width, p.height);
    return true;
  }
  /* Whatever mode it was in, from here on it is a rectangle we own. */
  function goFree() {
    if (wrap.classList.contains("free")) return;
    const r = wrap.getBoundingClientRect();
    wrap.classList.remove("full", "dock");
    host.classList.remove("dock");
    wrap.classList.add("free");
    place(r.left, r.top, r.width, r.height);
  }
  function startDrag(grabX, grabY) {
    goFree();
    drag = { grabX, grabY };
    host.classList.add("dragging");
  }
  /* A resize is the opposite of a move: the edges you did NOT grab stay put.
     So the fixed edges are recorded once, and each move recomputes the box
     from them — dragging the left edge past the right one then pins at the
     minimum width instead of turning the console inside out. */
  const CURSOR = { n: "ns", s: "ns", w: "ew", e: "ew", nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw" };
  function startResize(dir, e) {
    goFree();
    const r = wrap.getBoundingClientRect();
    resize = { dir, x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
    host.classList.add("dragging", `rs-${CURSOR[dir]}`);
  }
  const onMove = (e) => {
    if (resize) {
      const { dir, x, y, left, top, width, height } = resize;
      const dx = e.clientX - x, dy = e.clientY - y;
      /* place() clamps width and height; the left/top for a west or north
         grab is derived from the RIGHT/BOTTOM edge afterwards so the clamp
         cannot drag the fixed edge along with it. */
      const w = dir.includes("w") ? width - dx : dir.includes("e") ? width + dx : width;
      const h = dir.includes("n") ? height - dy : dir.includes("s") ? height + dy : height;
      place(dir.includes("w") ? left + width - clamp(w, 360, innerWidth) : left,
            dir.includes("n") ? top + height - clamp(h, 260, innerHeight) : top, w, h);
      return;
    }
    if (!drag) return;
    place(e.clientX - drag.grabX, e.clientY - drag.grabY,
          parseFloat(wrap.style.width), parseFloat(wrap.style.height));
  };
  const endDrag = () => {
    if (!drag && !resize) return;
    drag = resize = null;
    host.classList.remove("dragging", "rs-ns", "rs-ew", "rs-nwse", "rs-nesw");
    savePos();
  };
  for (const grip of root.querySelectorAll(".rsz"))
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startResize([...grip.classList].find((c) => c !== "rsz"), e);
    });
  catcher.addEventListener("mousemove", onMove);
  catcher.addEventListener("mouseup", endDrag);
  /* The pointer can leave the window mid-drag (over the browser chrome, or
     off the screen entirely). Ending it there beats leaving the console
     stuck to a cursor that is no longer reporting. */
  addEventListener("mouseup", endDrag, true);
  addEventListener("blur", endDrag);
  addEventListener("resize", () => {
    if (!wrap.classList.contains("free")) return;
    place(parseFloat(wrap.style.left), parseFloat(wrap.style.top),
          parseFloat(wrap.style.width), parseFloat(wrap.style.height));
  });
  function resetPos() {
    drag = resize = null;
    host.classList.remove("dragging", "rs-ns", "rs-ew", "rs-nwse", "rs-nesw");
    wrap.classList.remove("free", "dock");
    host.classList.remove("dock");
    wrap.removeAttribute("style");
    wrap.classList.add("full");
    try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
  }

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
      /* Full and Dock are a deliberate choice, so they win over a remembered
         position — otherwise clicking Dock on a console you had moved would
         appear to do nothing. */
      wrap.removeAttribute("style");
      wrap.classList.remove("free");
      wrap.classList.toggle("full", mode === "full");
      wrap.classList.toggle("dock", mode === "dock");
      host.classList.toggle("dock", mode === "dock");
      if (mode === "full") try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
    } else if (open && !wrap.classList.contains("dock")) {
      /* Opened with no mode asked for: put it back where it was left. */
      restorePos();
    }
    if (!open) return;

    /* THE EXTENSION MAY HAVE BEEN RELOADED UNDER THIS PAGE.
       Updating the extension — or hitting Reload on chrome://extensions after a
       git pull — destroys the context this script was injected from, but leaves
       the script itself running. SRC is a chrome-extension:// URL captured at
       injection, and it no longer resolves, so the iframe navigates to nothing
       and the panel opens as a blank white rectangle with no error anywhere:
       not in the page console, not in the extension's. It looks exactly like
       the console failing to render, and it cost Ayush an evening.

       chrome.runtime.id is undefined once the context is gone, and on some
       builds touching it throws, so both are treated the same. */
    if (!alive()) { showStale(); return; }

    if (!loaded) {
      frame.src = SRC;
      /* NOT `load` — that fires anyway. Chrome serves an error document into
         the frame when the URL belongs to an extension that has been reloaded,
         and an error document loads perfectly well. The only proof the console
         is really there is the console saying so, so this waits for its
         "ready" and treats silence as death. */
      deadline = setTimeout(() => { if (!ready) showStale(); }, 5000);
      frame.addEventListener("load", () => {
        loaded = true;
        handoff();
      }, { once: true });
    } else {
      handoff();
    }
  }

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  /* Replaces the blank panel with the one instruction that fixes it. Plain DOM
     rather than innerHTML on the shadow root, so the styles and the iframe
     above are left alone and a second call cannot stack two notices. */
  function showStale() {
    if (root.querySelector(".stale")) return;
    const d = document.createElement("div");
    d.className = "stale";
    d.innerHTML = `<b>The call console was updated.</b>
      <span>This tab is still running the old one. Reload the page to reconnect.</span>
      <button type="button">Reload</button>`;
    d.querySelector("button").addEventListener("click", () => location.reload());
    wrap.appendChild(d);
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
    if (m.type === "ready") { ready = true; clearTimeout(deadline); }
    if (m.type === "close") setOpen(false);
    if (m.type === "mode") setOpen(true, m.mode);
    if (m.type === "dial") dial(String(m.number || ""));
    /* The grab point arrives in the IFRAME's coordinates. The iframe fills
       the wrap, so they are the wrap's too — no conversion needed, and none
       that could be got wrong. */
    if (m.type === "dragstart") startDrag(Number(m.x) || 0, Number(m.y) || 0);
    if (m.type === "dragreset") resetPos();
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

  /* A bare tel: anchor is NOT a dialler — following it is the same OS handoff
     that already does nothing, except from the top-level page Chrome answers it
     with "This content is blocked". Clicking one can only reproduce the
     original failure more loudly, so such anchors are excluded outright. Only a
     real in-page control counts. */
  const isTelAnchor = (el) =>
    el.tagName === "A" && /^tel:/i.test(el.getAttribute("href") || "");

  function dialCandidates(want) {
    const out = [];
    /* Anything whose visible text or label is that number, and which is
       actually clickable. Walking every node would be slow on a CRM page, so
       stay with the elements a UI puts a number in. */
    const sel = 'button,[role="button"],a,[class*="dial"],[class*="call"],[class*="phone"],[aria-label]';
    for (const el of document.querySelectorAll(sel)) {
      if (out.some((c) => c.el === el) || isTelAnchor(el)) continue;
      const hay = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${
        (el.textContent || "").slice(0, 60)}`;
      if (tail(hay) === want) out.push({ el, why: "labelled with the number" });
    }

    /* Last resort: a dial control sitting next to the number rather than on
       it — the icon beside a phone field, which is how Kylas renders it. */
    for (const el of document.querySelectorAll(sel)) {
      if (out.some((c) => c.el === el) || isTelAnchor(el)) continue;
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
