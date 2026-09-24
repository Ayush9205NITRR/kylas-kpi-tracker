/* The proxy, as a thing Cloudflare runs. The other half of scripts/proxy.mjs.
 *
 * Same four jobs as the Node shell, answered differently:
 *
 *   configuration    the `env` bindings object, not process.env
 *   durable state    D1, not a file
 *   request -> body  a fetch Request, not a node:http stream
 *   a fatal error    a 500 naming it, because there is no process to exit
 *
 * Every route is in ../scripts/handlers.mjs and is shared verbatim.
 *
 * ── WHAT IS DIFFERENT HERE AND IS NOT A DETAIL ───────────────────────────
 *
 * CORS IS AN ALLOW-LIST, NOT AN ECHO. The Node shell reflects whatever Origin
 * it is sent, which is fine for something bound to 127.0.0.1 that nothing else
 * can reach. This is on the public internet holding a Kylas key and an Airtable
 * token, and echoing the origin there would let any page on any site call it
 * with the browser's credentials. ALLOWED_ORIGIN is the extension, and nothing
 * else is answered.
 *
 * THE LOGIN IS IN FRONT, NOT IN HERE. Cloudflare Access authenticates before a
 * request reaches this code — that is the point of it, and it is why there is
 * no session handling below. Access hands through a signed assertion in
 * Cf-Access-Jwt-Assertion; REQUIRE_ACCESS makes its absence a 403, so that a
 * misconfigured route or a DNS record pointing somewhere unprotected fails
 * closed instead of quietly serving the CRM to the open internet.
 *
 * Verifying that assertion's SIGNATURE is still to do. Until it is, this check
 * is a guard against misconfiguration, not against a determined attacker who
 * can reach the origin directly — so the Worker must not be published on a
 * hostname that bypasses Access.
 *
 * ONE INSTANCE, MANY REQUESTS. Cloudflare keeps an isolate warm and reuses it,
 * so the handlers are built once and cached — which is also what makes the
 * in-process caches inside them worth anything. It is a cache, not a
 * guarantee: an isolate can be discarded at any time, which is exactly why the
 * save journal lives in D1 rather than in memory.
 */
import { createHandlers } from "../scripts/handlers.mjs";
import { d1Store, kvStore } from "../scripts/store.mjs";
import { createGoogleAuth } from "../scripts/google-auth.mjs";
import { createMirror } from "../scripts/mirror.mjs";

/* Built per isolate, keyed on nothing: one Worker serves one account. The
   promise itself is cached, not the result, so ten requests arriving at a cold
   isolate share one construction instead of racing five. */
let built = null;

function storeFor(env) {
  /* D1 FIRST, AND THE ORDER IS NOT A PREFERENCE. The save journal is what
     stops a lost reply creating a contact twice, and KV can answer "absent"
     for a key written a second ago elsewhere — which produces the exact
     duplicate the journal exists to prevent. KV is accepted only when there is
     no database at all, and says so. */
  if (env.DB) return d1Store(env.DB);
  if (env.KV) return kvStore(env.KV);
  throw new Error("No DB (D1) or KV binding — the save journal has nowhere to live. See wrangler.toml.");
}

function handlers(env, log) {
  /* cache: the same store, for the finished report. Built once from about a
     hundred pages of Airtable and read by every isolate and every associate,
     rather than rebuilt — and abandoned half-way — on each cold one. */
  /* mirror: the D1 copy of the Airtable tables the console reads, so a read
     is a query next door instead of pages of Airtable (scripts/mirror.mjs). */
  return (built ||= createHandlers({ env, store: storeFor(env), cache: storeFor(env), log, db: env.DB || null,
                                     mirror: env.DB ? createMirror({ db: env.DB, log }) : null })
    .catch((e) => { built = null; throw e; }));   /* never cache a failed build */
}

/* ── WHO IS ALLOWED TO CALL THIS ─────────────────────────────────────────
   AUTH says how a caller proves who they are, and there is no default. A
   server holding a Kylas key and an Airtable token must never be one
   forgotten environment variable away from being open, and "safe unless
   misconfigured" is the shape of every breach — so an unset AUTH refuses to
   start rather than quietly serving everyone.

     google   the extension signs in with Google and sends the ID token.
              Verified here against Google's published keys — see
              scripts/google-auth.mjs, and the suite beside it.
     access   Cloudflare Access is in front and has already authenticated the
              caller. This only checks the assertion is PRESENT, which catches
              a DNS record pointing past the login; it does not verify the
              signature, so it is only sound while nothing can reach the
              origin directly.
     none     no check at all. For a local `wrangler dev` and nothing else.
              It says so in the log on every single request, because the one
              way this ends badly is somebody setting it "just to test" and
              leaving it. */
let auth = null;
function googleAuth(env, log) {
  return (auth ||= createGoogleAuth({
    clientId: env.GOOGLE_CLIENT_ID,
    allowedDomain: env.ALLOWED_EMAIL_DOMAIN || "",
    allowedEmails: String(env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),
    log,
  }));
}

/* Returns the caller's identity, or throws something with a status. */
async function authenticate(request, env, log) {
  const mode = String(env.AUTH || "").toLowerCase();

  if (mode === "google") {
    const header = request.headers.get("Authorization") || "";
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] || "";
    if (!token) throw Object.assign(new Error("not signed in"), { status: 401 });
    /* The REASON is logged and the CALLER is told only that it failed: which
       check a token tripped is useful to whoever is debugging and is a hint to
       whoever is probing. */
    try {
      return await googleAuth(env, log).verify(token);
    } catch (e) {
      log(`! auth refused: ${e.message}`);
      throw Object.assign(new Error("not signed in"), { status: 401 });
    }
  }

  if (mode === "access") {
    if (!request.headers.get("Cf-Access-Jwt-Assertion"))
      throw Object.assign(new Error("not authenticated"), { status: 403 });
    return { email: request.headers.get("Cf-Access-Authenticated-User-Email") || "", via: "access" };
  }

  if (mode === "none") {
    log("! AUTH=none — this request was NOT authenticated");
    return { email: "", via: "none" };
  }

  throw Object.assign(
    new Error("AUTH is not set — refusing to serve. Set it to google, access, or none in wrangler.toml."),
    { status: 500 });
}

/* AUTHORIZATION HAS TO BE IN Allow-Headers. Sending that header is what makes
   a request non-simple, so the browser sends a preflight first and refuses to
   send the real one unless the preflight names every header it is about to
   use. Leaving it out does not produce a 401 or a CORS message in the
   response — the request never leaves the browser at all, and `fetch` rejects
   with the maximally unhelpful "Failed to fetch". Which is exactly how this
   shipped. */
const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin,
                   "Access-Control-Allow-Headers": "content-type, authorization",
                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                   "Access-Control-Allow-Credentials": "true",
                   Vary: "Origin" } : {}),
  },
});

/* ── the nightly jobs ────────────────────────────────────────────────────
   The whole point of moving off a laptop: these used to need a machine that
   was awake at 2am, so the sync depended on somebody not shutting their lid.

   ONE CRON PER JOB, told apart by the schedule that fired it. Cloudflare gives
   the cron expression and nothing else, so it is the only thing to switch on —
   which means the strings here and in wrangler.toml have to match exactly, and
   a mismatch is a job that silently never runs. Hence the log line naming what
   was matched, and the complaint when nothing was.

   IMPORTED LAZILY. A scheduled Worker and a fetch Worker are the same bundle,
   so a top-level import of the sync would be parsed on the path of every save
   an associate makes. */
/* The sync and the rollup rewrite tables behind this server's back — and the
   sync can change company rollups a delta cannot see — so each is followed by a
   rebuild of the copies it touched. */
const JOBS = {
  sync: async (env, log) => {
    const out = await (await import("../scripts/sync-kylas.mjs")).run({ env, log, apply: true });
    return { ...out, after: await (await handlers(env, log)).maintain({ rebuild: true }) };
  },
  rollup: async (env, log) => {
    const out = await (await import("../scripts/rollup-calls.mjs")).run({
      env, log, apply: true, retainDays: Number(env.CALL_RETAIN_DAYS || 30) });
    return { ...out, after: await (await handlers(env, log)).maintain({
      rebuild: true, only: ["Call Log", "Call Rollup"] }) };
  },
  /* Every few minutes. Idle, it asks nothing of Airtable or Kylas. */
  maintain: async (env, log) => (await handlers(env, log)).maintain(),
  snapshot: async (env, log) =>
    (await import("../scripts/snapshot.mjs")).run({ env, log }),
};

export default {
  async scheduled(event, env, ctx) {
    const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
    const byCron = new Map([
      [String(env.CRON_SYNC || ""), "sync"],
      [String(env.CRON_ROLLUP || ""), "rollup"],
      [String(env.CRON_SNAPSHOT || ""), "snapshot"],
      [String(env.CRON_MAINTAIN || ""), "maintain"],
    ].filter(([cron]) => cron));
    const which = byCron.get(event.cron) || "";

    if (!which || !JOBS[which]) {
      /* Naming both sides, because the failure this guards against is a
         schedule edited in one place and not the other, and its symptom is a
         job that simply never happens. */
      log(`! cron "${event.cron}" matches no job. wrangler.toml has ` +
          `CRON_SYNC=${env.CRON_SYNC || "(unset)"} CRON_ROLLUP=${env.CRON_ROLLUP || "(unset)"} ` +
          `CRON_SNAPSHOT=${env.CRON_SNAPSHOT || "(unset)"} CRON_MAINTAIN=${env.CRON_MAINTAIN || "(unset)"}`);
      return;
    }

    const started = Date.now();
    log(`cron ${event.cron} -> ${which}`);
    /* waitUntil, so the run is not cut short when this function returns. The
       jobs are mostly SLEEPING — both APIs are rate limited and every request
       waits its turn — and wall time is not CPU time. */
    ctx.waitUntil((async () => {
      try {
        const out = await JOBS[which](env, log);
        log(`${which} finished in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
            `${JSON.stringify(out || {}).slice(0, 200)}`);
      } catch (e) {
        /* Rethrown after logging: Cloudflare counts a thrown scheduled event
           as a failed run, and a failed run is visible in the dashboard.
           Swallowing it here would make a broken sync look like a healthy one
           that found nothing to do. */
        log(`! ${which} FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message}`);
        throw e;
      }
    })());
  },

  async fetch(request, env, ctx) {
    /* Cloudflare's log is the console, and a line without a timestamp is
       useless in a tail. Matching the Node shell's format so the two are
       readable the same way. */
    const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
    const url = new URL(request.url);

    /* Answered only for the origin we expect. An unexpected origin gets no
       CORS headers at all, so the browser refuses it — which is the correct
       outcome and not something to spend a friendly error on. */
    const from = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = allowed.includes(from) ? from : "";

    if (request.method === "OPTIONS")
      return new Response(null, { status: origin ? 204 : 403, headers: origin ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      } : undefined });

    /* BEFORE ANYTHING ELSE. Not after the route lookup, and not inside the
       handlers: an unauthenticated request must not reach code that holds a
       Kylas key, even code that would only have 404ed. */
    let caller;
    try {
      caller = await authenticate(request, env, log);
    } catch (e) {
      return json({ error: e.message }, e.status || 401, origin);
    }

    let routes, building;
    try {
      ({ routes, building } = await handlers(env, log));
    } catch (e) {
      log(`! could not start: ${e.message}`);
      return json({ error: e.message }, 500, origin);
    }

    const handler = routes[url.pathname];
    if (!handler) return json({ error: "not found", routes: Object.keys(routes) }, 404, origin);

    try {
      let parsed = {};
      if (request.method !== "GET") {
        const raw = await request.text();
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch { throw Object.assign(new Error("the request body is not valid JSON"), { status: 400 }); }
        }
      }
      /* A request whose client stopped waiting is cancelled by Cloudflare,
         and the report build inside it with it. Registered here, the work
         runs on (Cloudflare allows it a further thirty seconds) and a finished
         report is kept for the next request instead of thrown away. */
      const pending = handler(url, parsed);
      ctx?.waitUntil?.(pending.catch(() => {}));
      /* EVERYTHING LEFT RUNNING, UNTIL THERE IS NOTHING LEFT — including work
         that other background work starts later (a queued save starts its
         Airtable writes, which start the read-back of two records). Work not
         covered here is cancelled when the request ends, and on this runtime a
         cancelled request's half-finished fetch is never settled: anything
         queued behind it on the same client waits for ever. That jammed the
         whole instance's Airtable access the first time it happened. */
      ctx?.waitUntil?.((async () => {
        await pending.catch(() => {});
        for (let i = 0; i < 20; i++) {
          const left = building?.() || [];
          if (!left.length) break;
          await Promise.allSettled(left);
        }
      })());
      return json(await pending, 200, origin);
    } catch (e) {
      const status = e.status || 502;
      log(`! ${url.pathname} ${status} ${e.message}`);
      return json({ error: e.message, problems: e.problems, ...(e.building ? { building: true } : {}) }, status, origin);
    }
  },
};
