/* Local persistence. Backed by chrome.storage.local inside the extension and by
   localStorage when console.html is opened directly in a tab for testing.

   This is deliberately the same shape the proxy will expose later: contacts,
   drafts, and an append-only call log. Swapping in the network layer means
   replacing the bodies here, not touching console.js. */
(function (global) {
  const KEY = { contacts: "enout.contacts", drafts: "enout.drafts", log: "enout.calllog",
                settings: "enout.settings" };
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

    async exportAll() {
      return {
        exportedAt: new Date().toISOString(),
        contacts: (await get(KEY.contacts)) || [],
        settings: (await get(KEY.settings)) || {},
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
