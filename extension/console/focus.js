/* FOCUS LISTS — which accounts a BD has picked to work (★ Focus), and which
   they have dropped, with the reason (Deprioritize). One status per company,
   held in Airtable's Focus table; every change is also appended to Focus
   History by the server, so "who dropped this, and why" survives a restore.
   The same table the BD Ladder app reads, so the two never disagree.

   Shared by the call card (console.js) and the Accounts view (views.js):
   one copy of the map, and anyone showing it is told when it changes. */
(function (global) {
  const REASONS = ["No event budget this year", "Too small / not a fit", "Events handled in-house",
                   "Locked in with another agency", "Can't reach the right POC",
                   "Timing — revisit next quarter", "Other"];
  let map = {}, at = 0, ok = false, loading = null, error = "", tat = {}, today = "", fails = 0;
  const listeners = new Set();
  const tell = () => listeners.forEach((fn) => { try { fn(); } catch { /* a view gone */ } });

  const Focus = {
    REASONS,
    /* { companyId: { status: "focus"|"depri", reason, note, ownerName, setAt, ... } } */
    get map() { return map; },
    /* Per BD: open / overdue / due today / no call-back / done, median days
       open, median pick→SQL, follow-ups on time. From the server. */
    get tat() { return tat; },
    get today() { return today; },
    get error() { return error; },
    get loaded() { return ok || !!error; },
    of(id) { return map[String(id)]?.status || "normal"; },
    entry(id) { return map[String(id)] || null; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /* Read at most once a minute; a change made here updates the map at once. */
    load(fresh = false) {
      if (!global.API?.focusAll) return Promise.resolve(map);
      if (!fresh && at && Date.now() - at < 60000) return Promise.resolve(map);
      return (loading ||= API.focusAll().then((r) => {
        map = r?.focus || {}; tat = r?.tat || {}; today = r?.today || ""; ok = true;
        error = r?.configured === false ? "Airtable is not configured on the server, so focus lists cannot be kept." : "";
        fails = 0;
      }).catch((e) => {
        error = e.message || String(e);
        /* The first ask can land before the console has connected: try again
           shortly, a few times, rather than showing nothing for a minute. */
        if (++fails <= 5) setTimeout(() => Focus.load(true), 5000);
      })
        /* Stamped on failure too: a refused read is retried in a minute, not
           on the redraw its own failure triggers. */
        .finally(() => { at = Date.now(); loading = null; tell(); }).then(() => map));
    },

    /* status: "focus" | "normal" | "depri". Optimistic: the map changes now
       and goes back if the server refuses. */
    async set(id, { status, companyName = "", reason = "", note = "", ownerName = "", setBy = "" }) {
      id = String(id);
      const before = map[id] || null;
      const previous = before?.status || "normal";
      if (status === "normal") delete map[id];
      else map[id] = { companyId: id, companyName, status, reason: status === "depri" ? reason : "",
                       note, ownerName, setByEmail: setBy, setAt: new Date().toISOString() };
      tell();
      try {
        await API.setFocus({ companyId: id, companyName, status, reason, note, ownerName, setBy, previous });
      } catch (e) {
        if (before) map[id] = before; else delete map[id];
        tell();
        throw e;
      }
      /* The server knows where the account stands (stage, next call, TAT);
         read it back so the reminder pane is right at once. */
      Focus.load(true);
    },
    /* Many at once (the accounts list's "Add to Focus"). Optimistic like
       set(): the stars appear now, and go back if the server refuses. An
       account already on the list, or deprioritized, is left as it is —
       un-dropping one is a decision for its own row, with its reason in view. */
    async addMany(list, { setBy = "" } = {}) {
      const items = list.map((c) => ({ companyId: String(c.id), companyName: c.name || "",
                                       ownerName: c.owner || "", previous: map[String(c.id)]?.status || "normal" }))
        .filter((x) => x.previous === "normal");
      if (!items.length) return { written: 0, skipped: list.length };
      const before = { ...map };
      const at = new Date().toISOString();
      for (const x of items)
        map[x.companyId] = { companyId: x.companyId, companyName: x.companyName, status: "focus",
                             reason: "", note: "", ownerName: x.ownerName, setByEmail: setBy, setAt: at };
      tell();
      try {
        const r = await API.addFocusMany(items, setBy);
        Focus.load(true);
        return { written: r?.written ?? items.length, skipped: list.length - items.length };
      } catch (e) {
        map = before; tell();
        throw e;
      }
    },
  };
  global.Focus = Focus;
})(window);
