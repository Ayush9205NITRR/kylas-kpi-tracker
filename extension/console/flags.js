/* THE ADMIN'S QUEUE OF POSSIBLE DUPLICATES.
 *
 * A new contact saved while somebody else already held its phone number or email
 * leaves a row in Airtable's Duplicate Flags table (scripts/dedupe.mjs). This is
 * where an admin reads those and says what they were:
 *
 *   Not a duplicate     two real people (a shared landline, two with one name)
 *   Handled in Kylas    merged, deleted or corrected there
 *   Acknowledged        looked at, leaving it as it is
 *
 * ONE CARD PER CONTACT, not per flag. A contact saved over somebody else's phone
 * AND email has two flags and one question — "is this person a duplicate?" — so
 * the answer is given once and applies to every open flag on the card. Resolved
 * flags stay in the table for good (the admin's decision is part of the record),
 * and can be reopened.
 *
 * ADMIN ONLY, and the server is what enforces it: /dupe-flags answers 403 to
 * anybody else. The Flags button is hidden for them so they are not offered a
 * screen that says no.
 *
 * Layout follows the other two views (dashboard, accounts): one column in
 * #viewport, a header, and rows — no new colour. Amber is the flag colour here
 * for the same reason it is on the RCA strip.
 */
(function (global) {
  const KIND = {
    "phone-conflict": "Phone is on someone else",
    "email-conflict": "Email is on someone else",
    "other-company": "Same person, other company",
    "other-bd": "Sits with another BD",
    "unverified": "Could not be checked",
    "overridden": "Saved over a duplicate",
  };
  const RESOLUTIONS = [
    ["Not a duplicate", "Two different people"],
    ["Handled in Kylas", "Merged, deleted or fixed there"],
    ["Acknowledged", "Looked at, leaving it"],
  ];
  const KYLAS = "https://app.kylas.io/sales/contacts/details/";

  let tab = "Open", counts = { Open: null, Resolved: null }, listeners = new Set();

  /* The Flags button asks for the open count without opening the screen. */
  const tell = () => listeners.forEach((fn) => { try { fn(counts.Open || 0); } catch { /* a view gone */ } });
  async function refreshCount() {
    try {
      const r = await API.dupeFlags("Open");
      counts.Open = new Set((r.flags || []).map((f) => f.kid || f.key)).size;
      tell();
    } catch { /* not an admin, or offline: the button simply keeps its last count */ }
  }

  const ago = (iso) => {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} d ago`;
  };

  /* Flags -> one entry per contact, newest first. */
  function group(flags) {
    const by = new Map();
    for (const f of flags) {
      const id = f.kid || f.key;
      if (!by.has(id)) by.set(id, { kid: f.kid, contact: f.contact, owner: f.owner, createdAt: f.createdAt, flags: [] });
      const g = by.get(id);
      g.flags.push(f);
      if (String(f.createdAt) > String(g.createdAt)) g.createdAt = f.createdAt;
    }
    return [...by.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  const flagLine = (f) => `<li>
      <span class="flk">${esc(KIND[f.kind] || f.kind)}</span>
      <span class="flw">${esc(f.why)}${f.otherKid
        ? ` <a class="fllink" href="${KYLAS}${encodeURIComponent(f.otherKid)}" target="_blank" rel="noopener">their record</a>` : ""}</span>
    </li>`;

  function card(g, resolved) {
    const open = g.flags.filter((f) => f.status !== "Resolved");
    const done = g.flags.filter((f) => f.status === "Resolved");
    const keys = (resolved ? done : open).map((f) => f.key);
    const head = `<div class="flhead">
        <b>${esc(g.contact || "(no name)")}</b>
        <em>${esc(g.owner ? `added under ${g.owner}` : "")}${g.createdAt ? ` · ${esc(ago(g.createdAt))}` : ""}${
          g.kid ? ` · <a class="fllink" href="${KYLAS}${encodeURIComponent(g.kid)}" target="_blank" rel="noopener">Kylas ${esc(g.kid)}</a>` : ""}</em>
      </div>`;
    if (resolved) {
      const r = done[0] || {};
      return `<section class="flcard done" data-kid="${esc(g.kid)}">${head}
        <ul class="fllist">${done.map(flagLine).join("")}</ul>
        <div class="flfoot">
          <span class="flres"><b>${esc(r.resolution || "Resolved")}</b> · ${esc(r.resolvedBy || "an admin")}${
            r.resolvedAt ? ` · ${esc(ago(r.resolvedAt))}` : ""}${r.note ? ` · “${esc(r.note)}”` : ""}</span>
          <button type="button" class="gbtn sm" data-reopen="${esc(keys.join("\n"))}">Reopen</button>
        </div></section>`;
    }
    return `<section class="flcard" data-kid="${esc(g.kid)}">${head}
      <ul class="fllist">${open.map(flagLine).join("")}</ul>
      <div class="flfoot">
        <div class="flacts" role="group" aria-label="Resolve">${RESOLUTIONS.map(([k, hint]) =>
          `<button type="button" class="rchip" data-resolve="${esc(k)}" data-keys="${esc(keys.join("\n"))}" title="${esc(hint)}">${esc(k)}</button>`).join("")}</div>
        <input type="text" class="flnote" maxlength="300" placeholder="Note (optional)" aria-label="Note" />
      </div></section>`;
  }

  async function view(host) {
    const paint = async () => {
      host.innerHTML = `<p class="vnote">Loading…</p>`;
      let r;
      try { r = await API.dupeFlags(tab); }
      catch (e) {
        host.innerHTML = /403|admin/i.test(e.message)
          ? `<p class="vwarn">Resolving duplicate flags is an admin action.</p>`
          : `<p class="vwarn">Could not read the flags — ${esc(e.message)}</p>`;
        return;
      }
      const groups = group(r.flags || []);
      counts[tab] = groups.length;
      if (tab === "Open") tell();
      const tabBtn = (k) => `<button type="button" class="fltab" data-tab="${k}" aria-pressed="${tab === k}">${k}${
        counts[k] != null ? ` <i>${counts[k]}</i>` : ""}</button>`;
      host.innerHTML = `
        <div class="vhead"><h2>Possible duplicates</h2>
          <span class="vsub">Contacts saved while somebody else already held their phone number or email. Say what each one was; the answer applies to every flag on the card.</span></div>
        <div class="fltabs" role="tablist">${tabBtn("Open")}${tabBtn("Resolved")}</div>
        ${r.missingTable ? `<p class="vwarn">${esc(r.note)}</p>` : ""}
        ${groups.length ? `<div class="flgrid">${groups.map((g) => card(g, tab === "Resolved")).join("")}</div>`
          : r.missingTable ? "" : `<p class="vnote flempty">${tab === "Open"
              ? "Nothing to review. Every flag has been resolved." : "Nothing has been resolved yet."}</p>`}`;
      wire();
    };

    const send = async (fn, btn) => {
      const cardEl = btn.closest(".flcard");
      cardEl.classList.add("busy");
      cardEl.querySelectorAll("button,input").forEach((n) => { n.disabled = true; });
      try { await fn(); await paint(); refreshCount(); }
      catch (e) {
        cardEl.classList.remove("busy");
        cardEl.querySelectorAll("button,input").forEach((n) => { n.disabled = false; });
        let m = cardEl.querySelector(".flerr");
        if (!m) { m = document.createElement("p"); m.className = "vwarn flerr"; cardEl.appendChild(m); }
        m.textContent = `Not saved — ${e.message}`;
      }
    };

    const wire = () => {
      host.querySelectorAll(".fltab").forEach((b) => { b.onclick = () => { tab = b.dataset.tab; paint(); }; });
      host.querySelectorAll("[data-resolve]").forEach((b) => {
        b.onclick = () => send(() => API.resolveDupeFlags(b.dataset.keys.split("\n"), b.dataset.resolve,
          b.closest(".flcard").querySelector(".flnote")?.value || ""), b);
      });
      host.querySelectorAll("[data-reopen]").forEach((b) => {
        b.onclick = () => send(() => API.reopenDupeFlags(b.dataset.reopen.split("\n")), b);
      });
    };

    await paint();
  }

  global.Flags = { view, refreshCount, onCount: (fn) => { listeners.add(fn); if (counts.Open != null) fn(counts.Open); } };
})(window);
