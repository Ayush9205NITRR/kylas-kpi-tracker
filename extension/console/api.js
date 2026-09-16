/* Talks to the local proxy, which holds the Kylas key.

   Nothing here knows the key, and nothing here calls Kylas directly. If the
   proxy is not running the console keeps working on whatever it already holds,
   so a dead proxy degrades to offline rather than to a blank screen. */
(function (global) {
  const DEFAULT_BASE = "http://127.0.0.1:8787";
  let base = DEFAULT_BASE;
  let state = { online: false, reason: "not checked yet", user: null };
  const listeners = new Set();

  const announce = () => listeners.forEach((fn) => fn(state));

  async function req(path, { timeout = 12000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(base + path, { signal: ctl.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `proxy returned ${res.status}`);
      if (!state.online) { state = { ...state, online: true, reason: "" }; announce(); }
      return body;
    } catch (e) {
      const reason = e.name === "AbortError" ? "proxy timed out" : e.message;
      if (state.online || state.reason !== reason) { state = { ...state, online: false, reason }; announce(); }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const API = {
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async configure() {
      try { base = (await Store.getSetting("proxy")) || DEFAULT_BASE; } catch { base = DEFAULT_BASE; }
      return base;
    },
    get base() { return base; },
    async setBase(v) {
      base = v || DEFAULT_BASE;
      await Store.setSetting("proxy", base);
      return API.health();
    },

    async health() {
      try {
        const r = await req("/health", { timeout: 4000 });
        state = { online: true, reason: "", user: r.user || null };
        announce();
        return r;
      } catch { return null; }
    },

    company: (id) => req(`/company?id=${encodeURIComponent(id)}`),
    queue: (owner) => req(`/queue${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`),
    contact: (id) => req(`/contact?id=${encodeURIComponent(id)}`),
  };

  /* Fields the overlay owns. Kylas has no opinion on them, so a refetch must
     never clear what an associate typed. */
  const OVERLAY_OWNED = ["past", "current", "vendorInfo", "serviceOffering", "modeOfMeeting",
                         "nextCallDate", "nextCallTime", "offsiteTimeline", "flagged",
                         "done", "lastCallAt", "exitReason", "pendingCreate"];

  /* Merge a fetched contact over the local copy: Kylas wins on the fields it
     owns, the overlay keeps its own. Returns the merged record. */
  API.merge = function (local, fetched) {
    if (!local) return fetched;
    const out = { ...local };
    for (const [k, v] of Object.entries(fetched)) {
      if (OVERLAY_OWNED.includes(k)) continue;
      /* A blank from Kylas should not wipe a value the associate just typed and
         has not synced yet. */
      if (v === "" && out[k]) continue;
      if (Array.isArray(v) && !v.length && Array.isArray(out[k]) && out[k].length) continue;
      out[k] = v;
    }
    return out;
  };

  API.OVERLAY_OWNED = OVERLAY_OWNED;
  global.API = API;
})(window);
