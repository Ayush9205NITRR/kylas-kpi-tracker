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
   holding a Kylas key, so every request has to carry proof of who is making
   it. That proof is a Google ID token — a signed statement of an email
   address, which the server checks against Google's own published keys. See
   scripts/google-auth.mjs.

   AN ID TOKEN, NOT AN ACCESS TOKEN, and that is why this uses
   launchWebAuthFlow rather than the simpler getAuthToken: getAuthToken hands
   back an opaque access token, which a server can only check by asking Google
   on every single request. */
const CLIENT_ID = "669836874556-44qeevcfed96d839lo86jp2quusm1m7d.apps.googleusercontent.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/* Held in memory only. A service worker is torn down when idle, so this is a
   cache for a burst of calls rather than a session — and that is the right
   lifetime for a credential. Losing it costs one silent refresh. */
let cached = null;                       /* { token, exp, email } */

/* The expiry is read from the token so the refresh happens before a request
   fails rather than because one did. NOT a security check: nothing here is
   trusted, the server verifies the signature. This is only scheduling. */
function readExp(token) {
  try {
    const body = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    return { exp: (claims.exp || 0) * 1000, email: claims.email || "", nonce: claims.nonce || "" };
  } catch { return { exp: 0, email: "", nonce: "" }; }
}

async function fetchToken(interactive) {
  const nonce = crypto.randomUUID();
  const url = `${AUTH_URL}?` + new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "id_token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "openid email profile",
    nonce,
    /* prompt=none is what makes a silent refresh silent: Google either answers
       from the existing session or refuses, rather than showing a window the
       associate did not ask for in the middle of a call. */
    ...(interactive ? { prompt: "select_account" } : { prompt: "none" }),
  });

  const redirected = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!redirected) throw new Error("sign-in was dismissed");

  /* The token comes back in the URL FRAGMENT, not the query string — that is
     the point of the implicit flow: it never reaches a server's logs. */
  const hash = new URL(redirected).hash.slice(1);
  const params = new URLSearchParams(hash);
  const err = params.get("error");
  if (err) throw new Error(err);
  const token = params.get("id_token");
  if (!token) throw new Error("Google returned no token");

  const { exp, email, nonce: got } = readExp(token);
  /* The nonce we generated must come back in the token. It stops a token
     obtained elsewhere being fed into this flow. The server cannot check this
     — it never saw the nonce — so it is checked here or nowhere. */
  if (got !== nonce) throw new Error("the reply did not match the request");

  cached = { token, exp, email };
  return cached;
}

/* Silent first, interactive only if that fails. An associate signs in once and
   then, for as long as their Google session lasts, never sees a window again. */
/* Chrome's way of saying "this cannot be done silently": the account is not
   signed in to Google in this profile, or consent has not been given yet.
   It is not a failure to report — it is a request for the window. */
const wantsAWindow = (e) => /user interaction required|not signed|consent|interaction_required/i
  .test(e?.message || "");

async function attempt({ interactive }) {
  /* Re-checked INSIDE the queue: callers that queued behind a flow which has
     since succeeded want its token, not another flow. This is what turns a
     burst of requests into one sign-in. */
  if (cached && cached.exp - 120_000 > Date.now()) return cached;
  try {
    return await fetchToken(false);
  } catch (e) {
    /* ESCALATE WHEN CHROME ASKS FOR IT, not only when the caller happened to
       say it was willing. Only /health asked interactively, so on a profile
       that had never signed in, every OTHER request reported "User
       interaction required" verbatim and no window was ever opened — a dead
       console quoting an instruction meant for the programmer.

       The rate limit is what keeps this honest: a window at most every 30
       seconds, so the first request of a session opens one and a burst behind
       it does not. */
    /* NO RATE LIMIT HERE, and removing one is the fix rather than a risk. It
       was added to stop a window per request, but the chain above already
       guarantees one flow at a time — so all the limit did was suppress the
       escalation for the next thirty seconds, leaving every request in that
       window reporting Chrome's silent-mode error instead of asking. Which is
       what a reload looked like: the same unreadable message, again. */
    if (!(interactive || wantsAWindow(e))) throw e;
    return fetchToken(true);
  }
}

/* ONE AT A TIME, ALWAYS. Chrome allows exactly one web auth flow per
   extension, and refuses the rest with "Only one web auth flow is allowed at
   a time" — which surfaces in the console as a failure to reach the server,
   naming neither Google nor sign-in.

   Opening the console fires several requests at once (health, the company,
   the contact), and each one asks for a token. Without this queue each of
   them starts its own flow, the first wins and the rest are refused, so the
   console stays offline no matter how correct everything else is. That is
   exactly how it shipped.

   A CHAIN, not "wait for the one I found": three at once must run one after
   another, and two of them each waiting on the same first one would still
   overlap with each other. The same shape as journal.mjs's once() and the
   Kylas client's request queue — this file was the one place it was missing. */
let chain = Promise.resolve();
function getToken({ interactive = false } = {}) {
  const run = chain.then(() => attempt({ interactive }), () => attempt({ interactive }));
  /* The chain keeps only the timing, never the outcome: a rejected promise
     left in it would make every later call fail with the same stale error. */
  chain = run.then(() => {}, () => {});
  return run;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "enout-token") return false;
  if (msg.forget) { cached = null; reply({ ok: true }); return true; }
  getToken({ interactive: !!msg.interactive })
    .then((c) => reply({ ok: true, token: c.token, email: c.email, exp: c.exp }))
    /* The reason is worth carrying back: "sign-in was dismissed" and "you are
       not signed into Google" need different things from the person reading
       it, and a bare failure tells them neither. */
    /* TRANSLATED, because what Chrome and Google say here is written for
       whoever wrote the extension. "User interaction required. Try setting
       `abortOnLoadForNonInteractive`…" was shown to an associate in place of
       their contacts. The raw text still goes to the log for whoever is
       debugging; what comes back is a sentence about signing in. */
    .catch((e) => {
      const raw = e?.message || String(e);
      console.log("sign-in failed:", raw);
      const friendly =
        /redirect_uri_mismatch/i.test(raw) ? "this browser's copy of the extension is not registered with Google"
        : /user interaction required|interaction_required/i.test(raw) ? "sign in to continue"
        : /dismissed|closed by the user|canceled|cancelled/i.test(raw) ? "sign-in was cancelled"
        : /access_denied|not allowed|unauthorized/i.test(raw) ? "this Google account is not allowed"
        : raw;
      reply({ ok: false, error: friendly, raw });
    });
  return true;                            /* the reply is async */
});
