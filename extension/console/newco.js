/* THE NEW-COMPANY FORM (Ayush, 2026-11-13).
 *
 *   NewCompany.open({ name, onDone(company) })
 *
 * Opened from the Accounts view's "+ New company" button and from the card's
 * company search ("+ Create company"). Required: name, owner, Source of Data,
 * LinkedIn page, employee size. Optional: industry, city, and the numbers the
 * score is computed from (revenue, funding). What a BD enters here wins over
 * Apollo and Claude in Company List's Final columns, so the score is right the
 * moment the company exists.
 *
 * At 18,000 accounts nothing here is a long list to scroll: the name is
 * checked against every company as it is typed, industry is a grouped search
 * (16 industries, ~40 sub-industries, the common ones first), and city is a
 * type-ahead over one spelling per city. */
(function (global) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let META = null;
  const meta = async () => (META ||= await API.companyForm());

  /* A small search box over a fixed list: type, pick. `allowNew` lets a value
     that is not in the list be used (city), otherwise it is pick-only. */
  function typeahead(input, list, { allowNew = false, label = (x) => x.label, onPick }) {
    const box = document.createElement("div");
    box.className = "cobox-list"; box.hidden = true;
    input.parentElement.appendChild(box);
    let rows = [], at = -1;
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      rows = (q ? list.filter((x) => label(x).toLowerCase().includes(q) || (x.alias || []).some((a) => a.includes(q))) : list).slice(0, 12);
      const exact = rows.some((x) => label(x).toLowerCase() === q);
      box.innerHTML = rows.map((x, i) => `<button type="button" class="cobox-opt${i === at ? " on" : ""}" data-i="${i}">
          <span class="n">${esc(label(x))}</span>${x.n ? `<span class="o">${esc(x.n)}</span>` : ""}</button>`).join("")
        + (allowNew && q && !exact ? `<button type="button" class="cobox-opt cobox-new" data-new="1">+ Use “${esc(input.value.trim())}”</button>` : "")
        + (!rows.length && !allowNew ? `<p class="cobox-msg">Nothing matches — pick from the list.</p>` : "");
      box.hidden = false;
    };
    input.addEventListener("focus", () => { at = -1; paint(); });
    input.addEventListener("input", () => { at = -1; onPick(null); paint(); });
    input.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(rows.length - 1, at + 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(0, at - 1); paint(); }
      else if (e.key === "Enter" && at >= 0) { e.preventDefault(); e.stopPropagation(); pick(rows[at]); }
      else if (e.key === "Escape") { e.stopPropagation(); box.hidden = true; }
    });
    const pick = (x) => { input.value = label(x); onPick(x); box.hidden = true; };
    box.addEventListener("mousedown", (e) => {
      const b = e.target.closest("button"); if (!b) return; e.preventDefault();
      if (b.dataset.new) { const v = input.value.trim(); onPick({ label: v, value: v }); box.hidden = true; }
      else pick(rows[Number(b.dataset.i)]);
    });
    input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 120));
  }

  async function open({ name = "", onDone } = {}) {
    const s = document.createElement("div");
    s.className = "scrim";
    s.innerHTML = `<div class="sheet wide newco"><div class="h"><h3>New company</h3>
      <button class="gbtn" id="ncX" type="button">Close</button></div><div class="b"><p class="dnote">Loading…</p></div></div>`;
    document.body.appendChild(s);
    const close = () => s.remove();
    s.querySelector("#ncX").onclick = close;
    s.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    let m;
    try { m = await meta(); }
    catch (e) { s.querySelector(".b").innerHTML = `<p class="vwarn">${esc(e.message || "Could not load the form")}</p>`; return; }

    /* Industry options: "Group › Sub", counted by how many accounts already
       carry the group so the common ones come first. */
    const counts = new Map();
    for (const c of (global.CACHE?.companies || [])) { const g = c?.enrich?.ind; if (g) counts.set(g, (counts.get(g) || 0) + 1); }
    const indList = Object.entries(m.industries || {})
      .sort((a, b) => (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0) || a[0].localeCompare(b[0]))
      .flatMap(([g, subs]) => subs.map((sub) => ({ g, sub, label: `${g} › ${sub}`, n: counts.get(g) ? `${counts.get(g)} accounts` : "" })));
    const cityList = (m.cityList || (m.cities || []).map((c) => ({ label: c }))).map((c) => ({ ...c, value: c.label }));

    const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(l)}</option>`;
    const req = '<b class="rq" aria-hidden="true">*</b>';
    s.querySelector(".b").innerHTML = `
      <div class="ncgrid">
        <label class="f wide"><span>Company name ${req}</span>
          <input class="in" id="ncName" autocomplete="off" value="${esc(name)}" placeholder="As the company writes it">
          <span class="ncmsg" id="ncNameMsg"></span></label>
        <label class="f"><span>Owner ${req}</span>
          <select class="in" id="ncOwner">${(m.people || []).map((p) => opt(p.id, p.name, String(p.id) === String(m.me?.id))).join("")}
            ${m.me && !(m.people || []).some((p) => String(p.id) === String(m.me.id)) ? opt(m.me.id, m.me.name + " (me)", true) : ""}</select></label>
        <label class="f"><span>Source of Data ${req}</span>
          <select class="in" id="ncSource"><option value="">Choose</option>${(m.sources || []).map((o) => opt(o.code, o.label)).join("")}</select></label>
        <label class="f wide"><span>LinkedIn page ${req}</span>
          <input class="in" id="ncLi" placeholder="linkedin.com/company/…" autocomplete="off"></label>
        <label class="f"><span>Employee size ${req}</span>
          <select class="in" id="ncEmp"><option value="">Choose</option>${(m.bands || []).map((b) => opt(b.band, b.band)).join("")}</select></label>
        <label class="f">Industry
          <span class="cobox"><input class="in" id="ncInd" placeholder="Type: fin, pharma, saas…" autocomplete="off"></span></label>
        <label class="f">City
          <span class="cobox"><input class="in" id="ncCity" placeholder="Type: Ben, Gur, Mum…" autocomplete="off"></span></label>
      </div>
      <details class="ncmore"><summary>Score details (optional) — revenue and funding</summary>
        <div class="ncgrid">
          <label class="f">Annual revenue (USD)<input class="in" id="ncRev" inputmode="numeric" placeholder="e.g. 25000000"></label>
          <label class="f">Funding type<select class="in" id="ncFType"><option value="">—</option>${(m.fundingTypes || []).map((t) => opt(t, t)).join("")}</select></label>
          <label class="f">Latest round amount (USD)<input class="in" id="ncFAmt" inputmode="numeric"></label>
          <label class="f">Total funding (USD)<input class="in" id="ncFTot" inputmode="numeric"></label>
          <label class="f">Last raised<input class="in" id="ncFDate" type="month"></label>
        </div></details>
      <p class="ncmsg" id="ncErr"></p>
      <div class="ncfoot"><button class="gbtn" id="ncCancel" type="button">Cancel</button>
        <button class="pbtn" id="ncGo" type="button" disabled>Create company</button></div>`;
    const $ = (id) => s.querySelector("#" + id);
    let ind = null, city = null, nameState = "empty", seq = 0, timer = 0;
    typeahead($("ncInd"), indList, { onPick: (x) => { ind = x; check(); } });
    typeahead($("ncCity"), cityList, { allowNew: true, onPick: (x) => { city = x; check(); } });

    const liOk = (v) => /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/[^\s/?#]+/i.test(v.trim());
    function check() {
      const missing = [];
      if (nameState !== "ok") missing.push(nameState === "exists" ? "a name that is not taken" : "the name");
      if (!$("ncOwner").value) missing.push("owner");
      if (!$("ncSource").value) missing.push("Source of Data");
      if (!liOk($("ncLi").value)) missing.push("a LinkedIn company page");
      if (!$("ncEmp").value) missing.push("employee size");
      if ($("ncInd").value.trim() && !ind) missing.push("an industry from the list");
      const fundNums = $("ncFAmt").value || $("ncFTot").value || $("ncFDate").value;
      if (fundNums && !$("ncFType").value) missing.push("the funding type");
      $("ncGo").disabled = missing.length > 0;
      $("ncErr").textContent = missing.length ? `Still needed: ${missing.join(", ")}` : "";
      return !missing.length;
    }
    /* The name, checked against every company as it is typed. */
    const nameMsg = (html, cls) => { const n = $("ncNameMsg"); n.className = "ncmsg " + (cls || ""); n.innerHTML = html; };
    const checkName = () => {
      const q = $("ncName").value.trim(); clearTimeout(timer);
      if (q.replace(/[^a-z0-9]/gi, "").length < 2) { nameState = "empty"; nameMsg(""); check(); return; }
      nameState = "checking"; nameMsg("Checking…"); check();
      const my = ++seq;
      timer = setTimeout(async () => {
        try {
          const r = await API.searchCompanies(q); if (my !== seq) return;
          const same = (r.companies || []).filter((c) => c.exact);
          if (same.length) {
            nameState = "exists";
            nameMsg(`Already exists: <b>${esc(same[0].name)}</b>${same[0].owner ? ` (${esc(same[0].owner)})` : ""} — use that account instead.`, "bad");
          } else {
            nameState = "ok";
            const close = (r.companies || []).slice(0, 3).map((c) => esc(c.name)).join(", ");
            nameMsg(close ? `New. Similar names already in Kylas: ${close}` : "New — no company by this name yet.", close ? "warn" : "ok");
          }
        } catch (e) { if (my === seq) { nameState = "ok"; nameMsg("Could not check the name — the server will check it again."); } }
        check();
      }, 300);
    };
    $("ncName").addEventListener("input", checkName);
    for (const id of ["ncOwner", "ncSource", "ncLi", "ncEmp", "ncFType", "ncFAmt", "ncFTot", "ncFDate"])
      $(id).addEventListener("input", check);
    $("ncCancel").onclick = close;
    if (name) checkName(); else check();
    setTimeout(() => $("ncName").focus(), 30);

    $("ncGo").onclick = async () => {
      if (!check()) return;
      $("ncGo").disabled = true; $("ncGo").textContent = "Creating…";
      const body = {
        name: $("ncName").value.trim(), ownerId: $("ncOwner").value, source: $("ncSource").value,
        linkedin: $("ncLi").value.trim(), empBand: $("ncEmp").value,
        ...(ind ? { industry: ind.g, subIndustry: ind.sub } : {}),
        ...(city?.value ? { city: city.value } : $("ncCity").value.trim() ? { city: $("ncCity").value.trim() } : {}),
        revenue: $("ncRev").value, fundingType: $("ncFType").value,
        fundingAmount: $("ncFAmt").value, totalFunding: $("ncFTot").value, lastRaised: $("ncFDate").value,
      };
      try {
        const r = await API.createCompany(body);
        if (r.ok && r.company) {
          close();
          global.toast?.(`Created ${r.company.name}${r.score != null ? ` · score ${r.score}` : ""}`);
          onDone?.(r.company, r);
          return;
        }
        nameState = "exists";
        nameMsg(`Already exists: <b>${esc(r.exists?.[0]?.name || body.name)}</b> — use that account instead.`, "bad");
      } catch (e) { $("ncErr").textContent = e.message || "Could not create the company"; }
      $("ncGo").textContent = "Create company"; check();
    };
  }
  global.NewCompany = { open };
})(window);
