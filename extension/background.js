/* Turns the toolbar button and Alt+Shift+E into a message the content script
   acts on — and, since the console moved to a server, signs the associate in.

   WHY SIGN-IN LIVES HERE AND NOT IN THE CONSOLE. The console is an iframe
   inside a Kylas page. chrome.identity wants an extension context it can open
   a window from, and a framed page is the awkward case. The service worker is
   the unambiguous one, so the console asks it for a token and never touches
   the sign-in flow itself. */
const toggle = (tabId) => chrome.tabs.sendMessage(tabId, { source: "enout-bg", type: "toggle" }).catch(() => {
  /* No content script on this tab — it isn't a Kylas page. */
});

chrome.action.onClicked.addListener((tab) => tab.id && toggle(tab.id));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-console" && tab && tab.id) toggle(tab.id);
});

/* ── who is using this console ────────────────────────────────────────────
   The proxy used to be on 127.0.0.1, where "who is calling" could not be
   asked: nothing but this machine could reach it. It is on the internet now,
   holding a Kylas key, so every request carries a Google ID token — a signed
   statement of an email address, which the server checks against Google's own
   published keys. See scripts/google-auth.mjs.

   An ID token rather than an access token, which is why this is
   launchWebAuthFlow and not getAuthToken: an access token can only be checked
   by asking Google about it on every request.

   ── THE RULES, and each one is here because breaking it shipped ──────────

   1. ONLY A PERSON OPENS A WINDOW. A sign-in window opens when somebody clicks
      "sign in", and at no other time. Data requests are silent: they use the
      token held, or try one silent refresh, and otherwise report "not signed
      in". Versions 1.9–1.11 let a failing data request escalate to a window,
      and the console makes six requests on load — so each became a window in
      turn, one appearing as the last was closed.

   2. ONE FLOW AT A TIME, AND NOBODY WAITS ON A PERSON. Chrome allows one
      launchWebAuthFlow per extension and refuses the rest with "Only one web
      auth flow is allowed at a time". A silent attempt ends in seconds, so
      requests arriving during one share its outcome. An interactive window can
      stay open for minutes, so data requests arriving during one are told so
      at once rather than hanging behind it.

   3. THE TOKEN OUTLIVES THE SERVICE WORKER. Chrome stops an idle service worker
      after about thirty seconds. Held only in memory, the token died with it,
      and the next request started a flow — possibly while a window from the
      previous worker was still open, which is exactly the refusal above.
      chrome.storage.session survives the worker and is cleared when the browser
      closes, which is the right lifetime for a credential.

   4. EVERY FAILURE IS A SENTENCE A PERSON CAN ACT ON. What Chrome and Google
      say here is written for whoever wrote the extension. The raw text goes to
      this worker's log; what reaches the console says what to do. */
const CLIENT_ID = "669836874556-44qeevcfed96d839lo86jp2quusm1m7d.apps.googleusercontent.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const KEY = "enoutToken";
/* Refreshed two minutes before it runs out, so a request is not made with a
   token that expires in flight. Scheduling only — the server does the checking. */
const MARGIN_MS = 120_000;

let cached = null;                       /* { token, exp, email } */
const fresh = (c) => !!c && Number(c.exp) - MARGIN_MS > Date.now();

/* Rule 3. Everything waits on this, so a request that wakes a new worker sees
   the token the previous worker obtained instead of starting a flow for it. */
const restored = (async () => {
  try {
    const got = await chrome.storage.session.get(KEY);
    if (fresh(got?.[KEY])) cached = got[KEY];
  } catch { /* no session storage: memory only, as before */ }
})();

async function remember(entry) {
  cached = entry;
  try { await chrome.storage.session.set({ [KEY]: entry }); } catch { /* memory still holds it */ }
}
async function forget() {
  cached = null;
  try { await chrome.storage.session.remove(KEY); } catch { /* nothing to remove */ }
}

/* Read for scheduling and for the nonce check. NOT a security check: nothing
   here is trusted, the server verifies the signature. */
function claimsOf(token) {
  try {
    const body = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const c = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    return { exp: (c.exp || 0) * 1000, email: c.email || "", nonce: c.nonce || "" };
  } catch { return { exp: 0, email: "", nonce: "" }; }
}

/* Rule 4. No trailing full stops: the console puts these after a dash, inside
   a sentence of its own. */
const SAY = {
  sign_in_needed: "not signed in: click “sign in” at the top of the console",
  window_open: "a Google sign-in window is already open: finish signing in there, " +
               "or close it and click “sign in” again (it may be behind this window)",
  cancelled: "sign-in was not finished: click “sign in” to try again",
  not_registered: "this copy of the extension is not registered with Google " +
                  "(its redirect URI is missing from the OAuth client)",
  denied: "Google refused this account",
  bad_reply: "Google's reply did not match the request: click “sign in” to try again",
};
const failure = (code, raw) => Object.assign(new Error(SAY[code] || raw), { code, raw: raw || SAY[code] });

function classify(e) {
  if (e?.code) return e;
  const raw = e?.message || String(e);
  if (/only one web auth flow/i.test(raw)) return failure("window_open", raw);
  if (/redirect_uri_mismatch/i.test(raw)) return failure("not_registered", raw);
  if (/user interaction required|interaction_required|login_required|consent_required|account_selection_required/i.test(raw))
    return failure("sign_in_needed", raw);
  if (/did not approve|cancel|closed|dismissed/i.test(raw)) return failure("cancelled", raw);
  if (/access_denied/i.test(raw)) return failure("denied", raw);
  return Object.assign(new Error(raw), { code: "error", raw });
}

async function runFlow(interactive) {
  const nonce = crypto.randomUUID();
  const url = `${AUTH_URL}?` + new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "id_token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "openid email profile",
    nonce,
    /* none: Google answers from the existing session or refuses, rather than
       showing anything. select_account: the person picks which account, which
       matters on a browser signed in to more than one. */
    prompt: interactive ? "select_account" : "none",
  });

  let redirected;
  try {
    redirected = await chrome.identity.launchWebAuthFlow(interactive
      ? { url, interactive: true }
      /* A silent attempt gives up as soon as Google shows a page instead of
         redirecting, and within four seconds regardless, so it can never hold
         the one flow Chrome allows for long. */
      : { url, interactive: false, abortOnLoadForNonInteractive: true, timeoutMsForNonInteractive: 4000 });
  } catch (e) {
    throw classify(e);
  }
  if (!redirected) throw failure("cancelled");

  /* In the FRAGMENT, not the query string: that is the point of the implicit
     flow — the token never reaches anybody's server logs. */
  const params = new URLSearchParams(new URL(redirected).hash.slice(1));
  if (params.get("error")) throw classify(new Error(params.get("error")));
  const token = params.get("id_token");
  if (!token) throw Object.assign(new Error("Google returned no token"), { code: "error" });

  const c = claimsOf(token);
  /* The nonce generated above must come back inside the token, which stops a
     token obtained elsewhere being fed into this flow. The server never saw
     the nonce, so this is checked here or nowhere. */
  if (c.nonce !== nonce) throw failure("bad_reply");

  const entry = { token, exp: c.exp, email: c.email };
  await remember(entry);
  return entry;
}

/* Rule 2. The flow in progress, if any. Set synchronously in start(), so two
   requests arriving in the same tick cannot both find it empty. */
let current = null;                      /* { interactive, promise } */
function start(interactive) {
  const promise = runFlow(interactive)
    .finally(() => { if (current && current.promise === promise) current = null; });
  current = { interactive, promise };
  return promise;
}

async function getToken({ interactive = false } = {}) {
  await restored;
  if (fresh(cached)) return cached;
  if (current) {
    if (current.interactive) {
      /* A second click joins the window that is already open. A data request
         does NOT wait on it: a person may take minutes, or have walked away. */
      if (interactive) return current.promise;
      throw failure("window_open", "a sign-in window opened by this console is waiting for a person");
    }
    /* A silent attempt is running and will end within seconds. */
    if (!interactive) return current.promise;          /* share its outcome, success or failure */
    try { await current.promise; } catch { /* it failed; the click still wants a window */ }
    if (fresh(cached)) return cached;
    if (current) return current.interactive ? current.promise : getToken({ interactive });
  }
  return start(interactive);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "enout-token") return false;
  (async () => {
    await restored;
    if (msg.forget) { await forget(); return { ok: true }; }
    try {
      const c = await getToken({ interactive: !!msg.interactive });
      return { ok: true, token: c.token, email: c.email, exp: c.exp };
    } catch (e) {
      const err = classify(e);
      console.log(`sign-in ${msg.interactive ? "(clicked)" : "(silent)"}: ${err.code} — ${err.raw}`);
      return { ok: false, code: err.code, error: err.message, raw: err.raw };
    }
  })().then(reply, (e) => reply({ ok: false, code: "error", error: String(e?.message || e) }));
  return true;                            /* the reply is async */
});
