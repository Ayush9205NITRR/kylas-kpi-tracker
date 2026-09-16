/* Local persistence. Backed by chrome.storage.local inside the extension and by
   localStorage when console.html is opened directly in a tab for testing.

   This is deliberately the same shape the proxy will expose later: contacts,
   drafts, and an append-only call log. Swapping in the network layer means
   replacing the bodies here, not touching console.js. */
(function (global) {
  const KEY = { contacts: "enout.contacts", drafts: "enout.drafts", log: "enout.calllog",
                settings: "enout.settings", snaps: "enout.snapshots" };
  const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  const get = (k) =>
    hasChrome
      ? new Promise((res) => chrome.storage.local.get(k, (o) => res(o[k])))
      : Promise.resolve(JSON.parse(localStorage.getItem(k) || "null"));

  const set = (k, v) =>
    hasChrome
      ? new Promise((res) => chrome.storage.local.set({ [k]: v }, res))
      : Promise.resolve(localStorage.setItem(k, JSON.stringify(v)));

  let writing = null, pending = null;
  /* Collapse bursts of keystrokes into one write, and never let two writes race. */
  function queue(k, v) {
    pending = { k, v };
    if (writing) return writing;
    writing = (async () => {
      while (pending) {
        const { k, v } = pending;
        pending = null;
        await set(k, v);
      }
      writing = null;
    })();
    return writing;
  }

  const Store = {
    async loadContacts() { return (await get(KEY.contacts)) || null; },
    saveContacts(list) { return queue(KEY.contacts, list); },

    async loadDrafts() { return (await get(KEY.drafts)) || {}; },
    async saveDraft(kid, record) {
      if (!kid) return;
      const d = await this.loadDrafts();
      d[kid] = { record, at: new Date().toISOString() };
      return set(KEY.drafts, d);
    },
    async clearDraft(kid) {
      const d = await this.loadDrafts();
      delete d[kid];
      return set(KEY.drafts, d);
    },

    /* Append-only, one entry per save — including saves where nothing changed.
       This is the local stand-in for the Call Log table in kpi-spec.md §2. */
    async appendCall(entry) {
      const log = (await get(KEY.log)) || [];
      log.push({ ...entry, at: entry.at || new Date().toISOString() });
      await set(KEY.log, log);
      return log.length;
    },
    async loadLog() { return (await get(KEY.log)) || []; },

    async getSetting(k) { return ((await get(KEY.settings)) || {})[k]; },
    async setSetting(k, v) {
      const o = (await get(KEY.settings)) || {};
      o[k] = v;
      return set(KEY.settings, o);
    },

    /* ── daily freeze ────────────────────────────────────────────────────
       A day's numbers are counted once, after the day is over, and then never
       recounted. Without this, "last Tuesday" quietly changes every time
       somebody edits an old record, and two people reading the same report on
       different days see different numbers.

       Only activity counts are frozen here — they come from the call log, which
       is an event log, so a day can always be recounted identically from it.
       Standing totals (how many companies sit at each rung) need record state
       over time, which belongs in Airtable, not in this browser. */
    dayOf(entry) { return (entry.at || "").slice(0, 10); },

    countDay(log, date) {
      const rows = log.filter((e) => (e.at || "").slice(0, 10) === date);
      const uniq = (f) => new Set(rows.map(f).filter(Boolean)).size;
      const connected = rows.filter((e) => e.outcome && e.outcome !== "No answer");
      return {
        date,
        dials: rows.length,
        connects: connected.length,
        noAnswer: rows.filter((e) => e.outcome === "No answer").length,
        wrongPOC: rows.filter((e) => e.outcome === "Wrong POC").length,
        rightPOC: rows.filter((e) => e.outcome === "Right POC").length,
        discovery: rows.filter((e) => e.outcome === "Discovery").length,
        added: rows.filter((e) => e.createdHere).length,
        contacts: uniq((e) => e.kid || e.pocName),
        companies: uniq((e) => e.company),
        /* Only measured durations. Estimates would make this look precise when
           it is not — see durationSource in the README. */
        talkSeconds: rows.reduce((n, e) => n + (e.durationSource === "dialed" ? (e.duration || 0) : 0), 0),
      };
    },

    async loadSnapshots() { return (await get(KEY.snaps)) || {}; },

    /* Freeze every day that is over and not yet frozen. Today is never frozen —
       it is still happening, so the dashboard shows it live and says so. */
    async freezeDays() {
      const log = (await get(KEY.log)) || [];
      if (!log.length) return 0;
      const snaps = await this.loadSnapshots();
      const today = new Date().toISOString().slice(0, 10);
      const days = [...new Set(log.map((e) => this.dayOf(e)).filter(Boolean))];
      let frozen = 0;
      for (const d of days) {
        if (d >= today || snaps[d]) continue;
        snaps[d] = { ...this.countDay(log, d), frozenAt: new Date().toISOString() };
        frozen++;
      }
      if (frozen) await set(KEY.snaps, snaps);
      return frozen;
    },

    /* Frozen days as they were counted, plus today computed live. */
    async series(days) {
      const log = (await get(KEY.log)) || [];
      const snaps = await this.loadSnapshots();
      const today = new Date().toISOString().slice(0, 10);
      const out = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        if (d === today) out.push({ ...this.countDay(log, d), live: true });
        else if (snaps[d]) out.push({ ...snaps[d], live: false });
        else out.push({ ...this.countDay(log, d), live: false, unfrozen: true });
      }
      return out;
    },

    async exportAll() {
      return {
        exportedAt: new Date().toISOString(),
        contacts: (await get(KEY.contacts)) || [],
        settings: (await get(KEY.settings)) || {},
        snapshots: (await get(KEY.snaps)) || {},
        drafts: (await get(KEY.drafts)) || {},
        callLog: (await get(KEY.log)) || [],
      };
    },
    async wipe() {
      for (const k of Object.values(KEY)) {
        if (hasChrome) await new Promise((r) => chrome.storage.local.remove(k, r));
        else localStorage.removeItem(k);
      }
    },
  };

  global.Store = Store;
})(window);
