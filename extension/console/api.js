/* Talks to the local proxy, which holds the Kylas key.

   Nothing here knows the key, and nothing here calls Kylas directly. If the
   proxy is not running the console keeps working on whatever it already holds,
   so a dead proxy degrades to offline rather than to a blank screen. */
(function (global) {
/* THE DEFAULT IS THE SERVER, NOT A LAPTOP, and that is a product decision
   rather than a convenience. While this was 127.0.0.1 every fresh install, and
   anything that cleared extension storage, silently pointed the console at a
   proxy that was not running — and the symptom was not "you have not set an
   address", it was "Could not reach Kylas", which reads as the CRM being down.
   That cost most of a day to find, on a machine where everything else was
   right. It also does not scale to a team: eight people each typing a URL into
   a prompt is eight chances for one of them to be quietly offline all week.

   A localhost proxy is still fully supported — set the address and it is used
   exactly as before. It is simply no longer what you get by accident. */
  const DEFAULT_BASE = "https://bd.enout.website";
  let base = DEFAULT_BASE;
  let state = { online: false, reason: "not checked yet", user: null, role: "admin" };
  const listeners = new Set();

  const announce = () => listeners.forEach((fn) => fn(state));

  /* This console's own build. Guarded: the page is also opened as a plain tab
     during testing, where there is no chrome.runtime and an unguarded call
     throws before the first health check runs. No version means no comparison,
     which is the right answer rather than a false alarm. */
  const myVersion = () => {
    try { return chrome?.runtime?.getManifest?.().version || ""; }
    catch { return ""; }
  };

  /* ── proving who is calling ───────────────────────────────────────────
     A proxy on 127.0.0.1 needs no login: nothing but this machine can reach
     it, and asking an associate to sign in to their own laptop would be
     ceremony. A proxy on the internet holds a Kylas key and needs one on every
     request.

     So the rule is the address, not a setting: anything not on localhost is
     asked to prove itself. That way the local path keeps working exactly as it
     always has, with no Google involved, and nobody can accidentally point the
     console at a public server without the sign-in coming with it. */
  const isLocal = () => /^https?:\/\/(127\.0\.0\.1|localhost)\b/i.test(base);

  /* A token for the next request. `interactive` is passed by exactly ONE
     caller — signIn(), which runs because a person clicked. Every data request
     is silent: it gets the token held, or one silent refresh, or "not signed
     in". See the rules at the top of background.js; the short version is that
     a data request which could open a window turned six requests into six
     windows, one after another. */
  async function token({ interactive = false } = {}) {
    if (isLocal()) return "";
    const res = await chrome.runtime.sendMessage({ type: "enout-token", interactive })
      .catch((e) => ({ ok: false, code: "error", error: `the extension's background did not answer (${e?.message || e})` }));
    if (!res?.ok) {
      const err = new Error(res?.error || "not signed in");
      err.status = 401;
      err.needsSignIn = true;
      err.code = res?.code || "";
      throw err;
    }
    signedInAs = res.email || "";
    return res.token;
  }
  let signedInAs = "";

  /* No `interactive` option, and its absence is the point: nothing that loads
     data can open a sign-in window. */
  async function req(path, { timeout = 12000, method = "GET", body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const jwt = await token();
      const res = await fetch(base + path, {
        signal: ctl.signal, method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      /* A 401 means the token was refused, not that the request was wrong.
         The commonest cause is the mundane one — it expired while the console
         sat open — so throw the held one away and try ONE silent refresh.
         Silent: this used to ask interactively, which put a Google window in
         front of an associate in the middle of a call because a token had
         quietly aged out. If the refresh cannot be done silently, the answer
         is "not signed in" and the "sign in" badge, not a surprise. */
      if (res.status === 401 && !isLocal() && !path.startsWith("/__retry")) {
        await chrome.runtime.sendMessage({ type: "enout-token", forget: true }).catch(() => {});
        const fresh = await token();
        const again = await fetch(base + path, {
          signal: ctl.signal, method,
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(fresh ? { authorization: `Bearer ${fresh}` } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const p = await again.json().catch(() => null);
        if (!again.ok) {
          const err = new Error(p?.error || `proxy returned ${again.status}`);
          err.status = again.status;
          err.needsSignIn = again.status === 401;
          throw err;
        }
        if (!state.online) { state = { ...state, online: true, reason: "" }; announce(); }
        return p;
      }
      /* Deliberately not named `body` — that is the request payload above, and
         shadowing it here throws before the fetch ever runs. */
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(payload?.error || `proxy returned ${res.status}`);
        err.status = res.status;
        err.problems = payload?.problems || null;
        throw err;
      }
      if (!state.online || state.needsSignIn) {
        state = { ...state, online: true, reason: "", needsSignIn: false, signInCode: "" }; announce();
      }
      return payload;
    } catch (e0) {
      /* "signal is aborted without reason" is the browser's text for our own
         timeout, and it reached the Dashboard verbatim. A slow answer is not a
         dead server either, so it does not flip the badge to offline. */
      if (e0.name === "AbortError") {
        throw Object.assign(new Error("the server took too long to answer — it may still be " +
          "building this; try again in a minute"), { timedOut: true });
      }
      const e = e0;
      const reason = e.message;
      /* needsSignIn is what lets the badge say "sign in" and mean it, instead
         of "offline" and a prompt for a server address that was never wrong. */
      const needsSignIn = !!e.needsSignIn;
      if (state.online || state.reason !== reason || state.needsSignIn !== needsSignIn) {
        state = { ...state, online: false, reason, needsSignIn, signInCode: e.code || "" };
        announce();
      }
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
        /* Silent, like every other request. When there is no token, the
           badge says "sign in" and the person clicks it — see signIn(). */
        const r = await req("/health", { timeout: 4000 });
        /* The proxy holds one Kylas key and Kylas says whose it is. That is the
           identity the views scope to — an associate sees their own numbers,
           an admin can switch to the team. */
        /* THE PROXY IS A SEPARATE, LONG-LIVED PROCESS. Reloading the extension
           does not restart it, so after a `git pull` the two halves can be
           different builds — and a stale proxy is not broken, it just answers
           from old code. That cost a day: a verdict sentence deleted from the
           tree kept appearing on screen because the proxy had been up for 17
           hours. Both halves take their version from the same manifest, so a
           mismatch here means exactly one thing: restart the proxy. */
        const mine = myVersion();
        const theirs = r.version || "";
        /* NO version at all is the case that actually bit. Every build from
           here on reports one, so a proxy that reports none is necessarily
           older than this check — which is precisely the proxy that has been
           up since before the last pull. Treat absence as stale, or the
           handshake would stay silent on the very instance that motivated it.
           "unknown" is different: that is a build which reported, from outside
           a checkout, and there is nothing to compare. */
        const stale = mine ? (!theirs || (theirs !== "unknown" && theirs !== mine)) : false;
        state = { online: true, reason: "", user: r.user || null, role: r.role || "admin",
                  version: theirs, staleProxy: stale,
                  staleNote: !stale ? ""
                    : theirs
                      ? `The proxy is running build ${theirs}, this console is ${mine}. ` +
                        `Restart it: stop node scripts/proxy.mjs, then start it again.`
                      : `The proxy predates this console (${mine}) — it is old enough not to ` +
                        `report its build. Restart it: stop node scripts/proxy.mjs, then start it again.` };
        announce();
        return r;
      } catch { return null; }
    },
    /* Who Google says is using this console. Empty on localhost, where there
       is no sign-in to speak of. */
    get signedInAs() { return signedInAs; },
    /* THE ONLY PLACE A SIGN-IN WINDOW IS ASKED FOR, and it runs because
       somebody clicked. The held token is dropped first so that clicking is
       also how you switch Google accounts. Returns the health answer on
       success and null on failure, with the reason in API.state. */
    get needsSignIn() { return !!state.needsSignIn; },
    async signIn() {
      if (isLocal()) return API.health();
      await chrome.runtime.sendMessage({ type: "enout-token", forget: true }).catch(() => {});
      try {
        await token({ interactive: true });
      } catch (e) {
        state = { ...state, online: false, reason: e.message, needsSignIn: true, signInCode: e.code || "" };
        announce();
        return null;
      }
      return API.health();
    },
    get role() { return state.role || "admin"; },
    get isAdmin() { return (state.role || "admin") === "admin"; },
    get staleProxy() { return !!state.staleProxy; },
    get staleNote() { return state.staleNote || ""; },

    company: (id) => req(`/company?id=${encodeURIComponent(id)}`),
    queue: (owner) => req(`/queue${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`),
    /* The authoritative list of companies allotted to someone — their OWN owner
       field in Kylas. Pass "all" for the team view. Slower than the others
       because it can be 200 rows, so the views cache it. */
    companies: (owner, fresh) => req(
      `/companies?owner=${encodeURIComponent(owner || "")}${fresh ? "&fresh=1" : ""}`,
      { timeout: 150000 }),
    /* The same numbers by day, week or month, with each period's change on the
       one before. */
    report: (period = "week", owner = "", from = "", to = "") => req(
      `/report?period=${encodeURIComponent(period)}` +
      (owner ? `&owner=${encodeURIComponent(owner)}` : "") +
      (from ? `&from=${encodeURIComponent(from)}` : "") +
      (to ? `&to=${encodeURIComponent(to)}` : ""), { timeout: 150000 }),
    /* Why the company join found nothing. Only asked for when it did, because
       it reads every Companies row in the base. */
    kpiDebug: () => req("/kpi-debug", { timeout: 30000 }),
    /* Frozen daily rows from Airtable, for the trend chart. */
    snapshots: (days = 60) => req(`/snapshots?days=${encodeURIComponent(days)}`, { timeout: 20000 }),
    contact: (id) => req(`/contact?id=${encodeURIComponent(id)}`),
    /* Which accounts owe an explanation, and the reasons on offer. The proxy
       decides both — the rule is a management policy and the console is told
       what it is, so six browsers cannot hold six versions of it. */
    rca: (owner) => req(`/rca${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`, { timeout: 30000 }),
    rcaAnswer: (answer) => req("/rca-answer", { method: "POST", body: answer, timeout: 20000 }),
    /* Who the funnel counts, and every name it could count. */
    team: () => req("/team", { timeout: 20000 }),
    teamSave: (team) => req("/team-save", { method: "POST", body: { team }, timeout: 20000 }),
    /* queue: true — "answer once it is safe, I will ask how it went". The
       server stores the save and replies at once; Kylas and Airtable get it
       behind the reply (scripts/save-queue.mjs). A server without a queue
       ignores the flag and answers with the finished save, as before. */
    save: (contact, call) => req("/save", { method: "POST", body: { contact, call, queue: true }, timeout: 20000 }),
    /* How queued saves went: { jobs: { id: { state, result, error, retryAt } } }. */
    saveStatus: (ids) => req(`/save-status?ids=${encodeURIComponent(ids.join(","))}`, { timeout: 15000 }),
  };

  /* ── outbox ──────────────────────────────────────────────────────────
     A save must never be lost to a proxy that happens to be down. Failed
     writes queue here and drain on the next save or when the link returns, so
     an associate can keep dialling through an outage. */
  let draining = false;

  API.queueSave = async function (contact, call) {
    const job = { id: `${Date.now()}-${contact.kid || contact.pocName}`,
                  lid: contact.lid || "", contact, call,
                  at: new Date().toISOString(), tries: 0 };
    try {
      const res = await API.save(contact, call);
      return { ok: true, ...res };
    } catch (e) {
      /* The outbox is for an outage, not for a value Kylas will never accept.
         A 4xx is a verdict on the data — queueing it means retrying the same
         rejection forever and hiding the one thing the associate could fix. */
      if (e.status >= 400 && e.status < 500)
        return { ok: false, queued: false, rejected: true, error: e.message, problems: e.problems };
      const box = await Store.getSetting("outbox") || [];
      box.push(job);
      await Store.setSetting("outbox", box);
      return { ok: false, queued: true, error: e.message };
    }
  };

  API.outboxSize = async () => ((await Store.getSetting("outbox")) || []).length;

  /* onEach(job, res)   told about every job that left the queue, sent or
                        rejected, so the caller can write the new kid back onto
                        the live record and clear its error.
     resolveKid(lid)    asked, for a job that still has no Kylas id, whether one
                        has been learned since it was queued. */
  API.drain = async function (onEach, resolveKid) {
    if (draining) return 0;
    draining = true;
    let sent = 0;
    try {
      let box = (await Store.getSetting("outbox")) || [];
      /* Ids learned DURING this drain. Two queued saves of one new contact hold
         two copies of a record with no kid; sending both as-is POSTs twice and
         Kylas keeps both. The first send returns the id, and from then on the
         same local contact is an UPDATE. */
      const learned = new Map();
      while (box.length) {
        const job = box[0];
        let contact = job.contact;
        const lid = job.lid || contact.lid || "";
        if (!contact.kid && lid) {
          const kid = learned.get(lid) || (resolveKid ? resolveKid(lid) : "") || "";
          if (kid) contact = { ...contact, kid: String(kid), pendingCreate: false };
        }
        try {
          const res = await API.save(contact, job.call);
          /* Any id, not only a create's — the proxy answers a recognised retry
             with the id it made the first time and created:false. */
          if (res?.kid && lid) learned.set(lid, String(res.kid));
          box.shift();
          sent++;
          onEach?.(job, res);
        } catch (e) {
          /* Same verdict as above: a rejected value blocks the whole queue
             behind it, so drop it and tell the caller why rather than
             retrying it on every save for the rest of the day. */
          if (e.status >= 400 && e.status < 500) {
            box.shift();
            onEach?.(job, { ok: false, rejected: true, error: e.message, problems: e.problems });
            await Store.setSetting("outbox", box);
            continue;
          }
          job.tries = (job.tries || 0) + 1;
          break;              /* still down — stop, keep the rest queued */
        }
        await Store.setSetting("outbox", box);
      }
      await Store.setSetting("outbox", box);
    } finally {
      draining = false;
    }
    return sent;
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
