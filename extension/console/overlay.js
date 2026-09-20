/* Overlay-only wiring: talking to the host page, and the Data sheet.
   Loaded after console.js, so it can lean on el(), esc() and toast(). */
(function () {
  const framed = window.parent !== window;
  if (framed) document.body.classList.add("framed");

  const post = (type, payload) => framed && parent.postMessage({ source: "enout", type, ...payload }, "*");

  /* I AM HERE. The host page opens this in an iframe and has no other way to
     know it arrived: a chrome-extension URL belonging to a reloaded extension
     still fires `load`, because Chrome serves an error page into the frame. So
     the host cannot ask "did it load" — it has to be told, and told by code
     that only runs when the console is genuinely running. Sent immediately,
     before any fetch, so a dead proxy never looks like a dead console. */
  post("ready");

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

    /* "focuslist", not "focus" — the host already sends a bare "focus" from
       handoff() meaning "put the keyboard in the iframe", and a view answering
       to the same name would swallow it on every open. */
    if (m.type === "dashboard" || m.type === "companies" || m.type === "focuslist") { showView(m.type); return; }
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
    ({ dashboard: Views.dashboard, companies: Views.companies, focuslist: Views.focusList }[which])(wrap)
      .catch((e) => { wrap.innerHTML = `<p class="vwarn">Could not build this view — ${e.message}</p>`; });
  }

  /* Clicking a company in the list should take you into it. */
  /* `label` comes from the row that was clicked. Without it the name had to be
     found among the contacts already held — and the whole point of the
     companies list is that it shows companies NOBODY has contacts for yet, so
     the one case that needs a name is the one case that had none. The account
     opened as "Company 500009" while the row the associate clicked said
     "working-co-01". */
  window.openCompanyFromView = (id, label) => {
    showView(null);
    const co = DATA.find((a) => String(a.companyId) === String(id));
    openCompany(String(id), label || co?.company);
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

    /* PAINT WHAT WE ALREADY KNOW, THEN GO ASK.
       Ayush, 2026-09-19: "when I click an account, there seems to be a lag
       while the account and its specific information load... even when the
       account shows I have already reached out and the KPI status is Discovery,
       the specific call information is not visible immediately."

       That was the whole of it: this awaited a live round trip with nothing on
       screen. But the roster of a company opened before is already in DATA —
       merged, with its notes and event rows — so there is something to show
       instantly on every account except a genuinely new one. The fetch still
       runs and still merges; it just stops being the thing the associate waits
       behind. Same rule as the report and the RCA list. */
    const held = DATA.filter((a) => String(a.companyId) === String(id) && a.kid).length;
    if (held) {
      setLink("busy", `${held} contact${held === 1 ? "" : "s"} from your last visit — refreshing`);
      render();
    } else {
      setLink("busy", "Loading from Kylas…");
    }

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

  /* Held already? Then show it now — an associate should never wait on the
     network to read a record the console is already holding. Not held returns
     false and paints NOTHING: the card stays on whatever was last on screen
     until the fetch lands. A blank card stamped with the id was worse than the
     wait it saved — it reads as a contact with no name and no number, and it
     is the one thing on screen a person could start typing into. */
  function showContact(id) {
    const i = DATA.findIndex((a) => String(a.kid) === String(id));
    if (i < 0) return false;
    cur = i; isNew = false;
    const a = DATA[i];
    /* ONE CONTACT, not their whole company. Opening a contact page used to
       flip the queue into company mode, so clicking one person put their
       four colleagues on screen and the record you asked for was merely
       the selected row. The company is still remembered — the call bar
       shows it, and the Company tab is one click away — but the console
       opens on the contact you clicked. */
    scope = a.companyId ? { id: String(a.companyId), name: a.company } : null;
    mode = "session";
    renderFilters();
    stopTimer(); secs = 0; render(); resetScroll();
    return true;
  }

  async function openContact(id) {
    wanted = String(id);
    const had = showContact(id);
    setLink("busy", "Loading from Kylas…");

    let res;
    try {
      res = await API.contact(id);
    } catch (e) {
      if (wanted !== String(id)) return;
      setLink("off", `Kylas unreachable — ${e.message}`);
      /* Nothing was painted for this contact, so there is nothing to take
         back. The card still holds the last record — which is why the toast
         has to say that this is not it. */
      if (!had) toast("Could not reach Kylas — still showing the last contact");
      return;
    }

    if (wanted !== String(id)) return;      /* moved on; this answer is stale */

    const fetched = res?.contact;
    if (!fetched?.kid) {
      setLink("on", `Kylas · ${API.state.user?.name || "connected"}`);
      if (!had) toast(`Kylas returned nothing for contact ${id}`);
      return;
    }

    /* Kylas owns the contact fields, the overlay keeps its own — the same
       merge the company fetch uses, so a refetch never wipes a note typed a
       moment ago and not yet synced. */
    const at = DATA.findIndex((a) => String(a.kid) === String(fetched.kid));
    if (at > -1) DATA[at] = API.merge(DATA[at], fetched);
    else { DATA.unshift(fetched); filter = "all"; }
    cur = at > -1 ? at : 0;
    isNew = false;

    /* Only when the record on screen is about to change. The card was held
       through the fetch, so an associate who hit dial during it has a timer
       running on the record they are actually looking at. */
    if (!had) { stopTimer(); secs = 0; }

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
    /* A connected-but-stale proxy outranks "on": the link is up, and that is
       exactly what makes it misleading. Every answer on screen is being served
       by code that is not the code in front of you. */
    const k = kind === "on" && API.staleProxy ? "stale" : kind;
    linkEl.className = "link " + k;
    linkEl.textContent = k === "on" ? "Kylas"
      : k === "stale" ? "old proxy"
      : k === "busy" ? "…" : "offline";
    linkEl.title = k === "stale" ? API.staleNote : (title || "");
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

  /* ── the account's own decisions ─────────── */
  /* Two things about a company that Kylas does not hold and never will: whether
     a BD has put it on their list, and what they found out before calling. Both
     live in Airtable, both are keyed on the Kylas company id, and both belong
     on the company page because that is where the person deciding is standing.

     The focus row is Views' cache, not a second one — see the note on the
     Views export. The research row is fetched per company, because the whole
     table is fifteen columns wide and nobody needs another account's. */
  const ACC = {
    research: null,      /* companyId -> values, null until read */
    fields: null,        /* the field list, served with the data */
    researchError: "",
    researchOpen: false, /* the strip's disclosure, remembered across accounts */
    dropping: false,     /* the reason form is open */
    draft: { reason: "", note: "" },
    busy: false,
  };

  /* Who did it. The proxy already told us on /whoami, so the identity gap the
     README flags is only open where there is no proxy — an empty string, which
     Airtable stores as blank rather than as a guess. */
  const who = () => API.state.user?.email || API.state.user?.name || "";

  const focusOf = (id) => Views.FOCUS.rows?.[String(id)] || null;
  const statusOf = (id) => focusOf(id)?.status || "normal";

  const STATUSES = [
    { k: "focus", label: "★ Focus", title: "Put this account on the focus list" },
    { k: "normal", label: "Not picked", title: "Neither picked nor dropped — the default" },
    { k: "depri", label: "Deprioritize", title: "Take it off the list, with a reason" },
  ];

  function paintAccount() {
    const w = document.getElementById("qacct");
    if (!w) return;
    if (!scope?.id) { w.hidden = true; w.innerHTML = ""; ACC.dropping = false; return; }
    w.hidden = false;

    /* DO NOT REDRAW UNDER SOMEBODY'S CURSOR. This repaints on every render(),
       and render() runs whenever the stage changes or a callback date button
       is pressed — either of which a person can do while half-way through
       typing a reason. Rebuilding the strip then would take the focus out of
       the field mid-sentence, the same hazard console.js calls out where it
       chose validate() over render() on keystrokes. The strip is stale for as
       long as the form is being used and correct the moment it is not.

       Both halves are load-bearing. Scoped to the form and not to the strip,
       because the click that OPENS the form leaves the focus on the
       Deprioritize button, which is in the strip — guarding the whole band
       meant the form never appeared. And conditioned on the form still being
       wanted, because after a save the focus is on the Save button inside a
       form that is now supposed to go away: without ACC.dropping the repaint
       that removes it is the one repaint this skips, and the strip sits there
       showing the old state with the form still open. */
    if (ACC.dropping && document.getElementById("accDrop")?.contains(document.activeElement)) return;

    const id = String(scope.id);
    const f = focusOf(id);
    const now = statusOf(id);
    /* Primed on the first company opened, not at boot: a console nobody scopes
       to an account never needs the table, and this runs on every render, so
       the guard is the whole of the rate limiting. */
    if (ACC.research === null && !ACC.researchLoading) {
      ACC.researchLoading = true;
      loadResearch().then(paintAccount, (e) => {
        /* Latch the failure. Leaving it null would retry on the next render,
           and render runs on every keystroke that validates — a dead proxy
           would become a fetch storm. The sheet retries when it is opened. */
        ACC.research = {};
        ACC.researchError = `Could not read the research table — ${e.message}`;
        paintAccount();
      }).finally(() => { ACC.researchLoading = false; });
    }

    const r = ACC.research?.[id];
    const filled = r ? (ACC.fields || []).filter((x) => String(r[x.k] || "").trim()).length : 0;

    /* WHO AND WHEN, not just what. A dropped account is a decision somebody
       made; the strip that reports it has to say whose, or the next BD to open
       it has an unexplained state and no one to ask. */
    const stamp = f?.setAt
      ? `${f.status === "depri" ? "Dropped" : "Picked"} ${when(f.setAt)}${
          f.setByEmail ? ` by ${esc(f.setByEmail)}` : ""}`
      : "";

    w.innerHTML = `
      <div class="aseg" role="group" aria-label="Focus">
        ${STATUSES.map((s) => `<button type="button" data-fs="${s.k}" title="${esc(s.title)}"
          aria-pressed="${now === s.k ? "true" : "false"}"${ACC.busy ? " disabled" : ""}
          >${s.label}</button>`).join("")}
      </div>
      <button class="gbtn sm" id="accRes" type="button"
        title="What we know about this company before we call it">Research${
        ACC.research ? ` <i>${filled}/${(ACC.fields || []).length}</i>` : ""}</button>
      ${Views.FOCUS.error ? `<span class="awarn">${esc(Views.FOCUS.error)}</span>`
        : stamp ? `<span class="astamp">${stamp}</span>` : ""}
      ${f?.reason ? `<span class="areason" title="${esc(f.note || "")}">${esc(f.reason)}${
        f.note ? ` — ${esc(f.note)}` : ""}</span>` : ""}
      ${researchStripHTML(id)}
      ${ACC.dropping ? `
      <!-- novalidate deliberately: with the required attribute the browser
           blocks submit before onsubmit runs, so the message explaining WHY a
           reason matters never appeared and a native bubble said "Please
           select an item" instead. The check below is that check, with the
           sentence. -->
      <form class="adrop" id="accDrop" novalidate>
        <select id="accReason" aria-label="Reason for dropping this account">
          <option value="">Why are we dropping it?</option>
          ${(Views.FOCUS.reasons || []).map((x) =>
            `<option${x === ACC.draft.reason ? " selected" : ""}>${esc(x)}</option>`).join("")}
        </select>
        <input id="accNote" placeholder="Anything worth remembering — optional"
               value="${esc(ACC.draft.note)}" aria-label="Note">
        <button class="pbtn sm" type="submit"${ACC.busy ? " disabled" : ""}>Save</button>
        <button class="gbtn sm" type="button" id="accCancel">Cancel</button>
      </form>` : ""}`;

    w.querySelectorAll("[data-fs]").forEach((b) => b.onclick = () => {
      const to = b.dataset.fs;
      if (to === now && !(to === "depri" && !ACC.dropping)) return;
      /* A reason is the point of dropping one. Picking or un-picking is a
         click; dropping opens the form and writes nothing until it is filled. */
      if (to === "depri") {
        ACC.dropping = true;
        ACC.draft = { reason: f?.reason || "", note: f?.note || "" };
        paintAccount();
        document.getElementById("accReason")?.focus();
        return;
      }
      ACC.dropping = false;
      writeFocus(to, "", "");
    });

    const rb = document.getElementById("accRes");
    if (rb) rb.onclick = openResearch;

    /* Remembered for the session, not per company: somebody who wants the
       research open wants it open on the next account too. */
    const rt = document.getElementById("accResToggle");
    if (rt) rt.onclick = () => { ACC.researchOpen = !ACC.researchOpen; paintAccount(); };

    const form = document.getElementById("accDrop");
    if (form) {
      const sel = document.getElementById("accReason");
      const note = document.getElementById("accNote");
      sel.onchange = () => { ACC.draft.reason = sel.value; };
      note.oninput = () => { ACC.draft.note = note.value; };
      document.getElementById("accCancel").onclick = () => { ACC.dropping = false; paintAccount(); };
      form.onsubmit = (e) => {
        e.preventDefault();
        if (!sel.value) { toast("Pick a reason — that is the part nobody can reconstruct later"); sel.focus(); return; }
        writeFocus("depri", sel.value, note.value.trim());
      };
    }
  }

  /* One write path for all three buttons and for the Focus lists view's
     Restore, so the history reads the same whichever screen it came from. */
  async function writeFocus(status, reason, note) {
    const id = String(scope.id);
    const was = focusOf(id);
    ACC.busy = true; paintAccount();
    try {
      await API.setFocus({
        companyId: id, companyName: scope.name || "", status, reason, note,
        ownerName: was?.ownerName || DATA.find((a) => String(a.companyId) === id)?.owner || "",
        setBy: who(), previous: was?.status || "normal",
      });
      Views.FOCUS.rows = Views.FOCUS.rows || {};
      if (status === "normal") delete Views.FOCUS.rows[id];
      else Views.FOCUS.rows[id] = {
        companyId: id, companyName: scope.name || "", status, reason, note,
        ownerName: was?.ownerName || "", setByEmail: who(), setAt: new Date().toISOString(),
      };
      ACC.dropping = false;
      toast(status === "focus" ? `${scope.name} is on the focus list`
          : status === "depri" ? `${scope.name} dropped — ${reason}`
          : `${scope.name} is back to normal`);
    } catch (e) {
      toast(`Could not record that — ${e.message}`);
    } finally {
      ACC.busy = false; paintAccount();
    }
  }

  /* WHAT WE KNOW, ON THE PAGE, NOT BEHIND A BUTTON. Ayush, 2026-09-20: "when I
     go into a company there should be a section of research where I can show
     that this company has raised funding, so that they're able to see that."

     A research form reachable in one click is not the same as research an
     associate reads without asking for it. Somebody about to dial wants the
     funding round and the event season in front of them while the number is
     ringing; a button labelled Research is something they open once, on the
     first call, and never again.

     So the facts come to the strip and the form stays where it is. Which
     facts: the ones that change how the call opens. Funding, a recent trigger,
     who decides and when the season is — an opener each. Industry, HQ and
     headcount are context, not an opener, and are left to the form. Research
     notes too: it is a paragraph, and a paragraph here would push the queue
     off the screen. */
  const STRIP_FIELDS = ["funding", "trigger", "season", "decides", "events", "vendor"];

  function researchStripHTML(id) {
    const r = ACC.research?.[id];
    if (!r) return "";                    /* not read yet — say nothing, not "none" */
    const facts = STRIP_FIELDS
      .map((k) => [ACC.fields?.find((f) => f.k === k), String(r[k] || "").trim()])
      .filter(([f, v]) => f && v);
    if (!facts.length) return "";
    /* Collapsed by default ONLY when there is a lot of it. One fact is a line;
       six are a wall in a 380px column, and the associate came here to call. */
    const many = facts.length > 3;
    const show = ACC.researchOpen || !many;
    return `<div class="ares${show ? " on" : ""}">
      <button type="button" id="accResToggle" aria-expanded="${show}"
        title="${show ? "Hide" : "Show"} what we know about this company">
        <span class="k">Research</span>
        ${show ? "" : `<span class="peek">${esc(facts[0][1])}</span>`}
        <span class="n">${facts.length}</span>
      </button>
      ${show ? `<dl>${facts.map(([f, v]) =>
        `<div><dt>${esc(f.l)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    </div>`;
  }

  /* ── research ────────────────────────────── */
  /* The fifteen fields come from the proxy with the values, so this file never
     restates them: a field added in airtable.mjs appears here on the next
     fetch, and one that does not exist in the base cannot be typed into. */
  /* Read for EVERY company at once, once. Asking per company looks cheaper and
     is not: the proxy reads the whole Research table either way and throws away
     every row but one, so fifteen accounts opened in an afternoon is fifteen
     full reads of the same table. */
  async function loadResearch(force) {
    if (ACC.research && !force) return;
    const r = await API.research();
    ACC.fields = r.fields || [];
    ACC.research = r.research || {};
    ACC.researchError = r.configured === false
      ? "Airtable is not configured, so nothing can be saved yet." : "";
  }

  async function openResearch() {
    const id = String(scope.id);
    const name = scope.name || ("Company " + id);

    const s = el("div", "scrim");
    s.innerHTML = `<div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="rh">
      <div class="h"><h3 id="rh">Research</h3>
        <span class="sub">${esc(name)}</span>
        <button class="gbtn" id="rx" type="button">Close</button></div>
      <div class="b" id="rbody"><p class="dnote">Loading…</p></div></div>`;
    document.body.appendChild(s);
    const close = () => s.remove();
    s.onclick = (e) => { if (e.target === s) close(); };
    document.getElementById("rx").onclick = close;

    try {
      /* ACC.fields is set only by a load that worked, so this retries exactly
         the case the latch above swallowed. */
      await loadResearch(!ACC.fields);
    } catch (e) {
      document.getElementById("rbody").innerHTML =
        `<p class="dnote warn">Could not read it — ${esc(e.message)}</p>`;
      return;
    }
    if (!s.isConnected) return;   /* closed while we were fetching */

    const vals = { ...(ACC.research[id] || {}) };
    delete vals.updatedAt; delete vals.updatedByEmail;
    const body = document.getElementById("rbody");

    const field = (f) => {
      const v = esc(vals[f.k] || "");
      const cls = f.long ? "rf long" : f.half ? "rf half" : "rf";
      /* A VALUE THE LIST DOES NOT OFFER IS STILL THE VALUE. Airtable holds
         whatever was typed into it before this form existed — "501-1,000" with
         a hyphen where the list has an en dash is enough — and a <select> with
         no matching <option> renders as blank and posts "" on the next save.
         That is silent data loss: the field looks empty, somebody saves an
         unrelated change, and the answer is gone. So an unrecognised value is
         added to its own list and marked. */
      const opts = f.o || [];
      const held = String(vals[f.k] || "");
      const odd = f.o && held && !opts.includes(held);
      const input = f.o
        ? `<select data-k="${f.k}">${
            (odd ? [held, ...opts] : opts).map((o) =>
              `<option${held === o ? " selected" : ""}>${esc(o)}</option>`).join("")
          }</select>${odd ? `<i class="rodd">not one of the listed values — kept as it is</i>` : ""}`
        : f.long
          ? `<textarea data-k="${f.k}" rows="3" placeholder="${esc(f.ph || "")}">${v}</textarea>`
          : `<input data-k="${f.k}" value="${v}" placeholder="${esc(f.ph || "")}">`;
      return `<label class="${cls}"><span>${esc(f.l)}</span>${input}</label>`;
    };

    const paintBody = () => {
      const r = ACC.research?.[id] || {};
      body.innerHTML = `
        ${ACC.researchError ? `<p class="dnote warn">${esc(ACC.researchError)}</p>` : ""}
        <div class="rform">${(ACC.fields || []).map(field).join("")}</div>
        <div class="dactions">
          <button class="pbtn" id="rsave" type="button">Save research</button>
          <span class="rstamp">${r.updatedAt
            ? `Last saved ${when(r.updatedAt)}${r.updatedByEmail ? ` by ${esc(r.updatedByEmail)}` : ""}`
            : "Never saved"}</span>
        </div>
        <p class="dnote">This is ours, not Kylas'. It is keyed on the Kylas company id,
          so it follows the account everywhere the console shows it — and nothing here
          is ever written back to Kylas.</p>`;

      body.querySelectorAll("[data-k]").forEach((i) =>
        i.addEventListener("input", () => { vals[i.dataset.k] = i.value; }));
      body.querySelectorAll("select[data-k]").forEach((i) =>
        i.addEventListener("change", () => { vals[i.dataset.k] = i.value; }));

      document.getElementById("rsave").onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = "Saving…";
        try {
          const res = await API.saveResearch({
            companyId: id, companyName: name, values: vals, updatedBy: who(),
          });
          ACC.research[id] = { ...vals, updatedAt: new Date().toISOString(), updatedByEmail: who() };
          /* A column the base does not have is not a save that worked. The
             proxy names them rather than failing the whole write, so the rest
             lands — but saying nothing would let somebody type into a field
             that is quietly thrown away every time. */
          if (res.dropped?.length)
            toast(`Saved, but this base has no ${res.dropped.join(", ")} — run repair-base.mjs`);
          else toast("Research saved");
          close();
          paintAccount();
        } catch (err) {
          e.target.disabled = false; e.target.textContent = "Save research";
          toast(`Could not save it — ${err.message}`);
        }
      };
    };
    paintBody();
    body.querySelector("[data-k]")?.focus();
  }

  /* "3 days ago", not an ISO string. Whoever reads this strip is deciding
     whether the decision is still current, and a date they have to subtract
     from today does not answer that. */
  function when(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const days = Math.floor((Date.now() - t) / 864e5);
    return days <= 0 ? "today" : days === 1 ? "yesterday"
      : days < 30 ? `${days} days ago`
      : days < 60 ? "last month" : `${Math.round(days / 30)} months ago`;
  }

  /* Repainted with everything else. console.js calls render() from a dozen
     places — every save, every queue move, and the × that leaves the company
     — and the account strip has to agree with the company the card is showing
     at all of them. Wrapping is what gets all dozen without touching any:
     console.js is a classic script, so its `render` IS this property. */
  const coreRender = window.render;
  window.render = function () { coreRender.apply(this, arguments); paintAccount(); };

  /* And read the lists once, so the strip is right the first time it is seen
     rather than after the first click. A failure here is recorded in the cache
     and shown in the strip; it must not take the console down with it. */
  Views.loadFocus().then(paintAccount, () => {});

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
