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
  return (built ||= createHandlers({ env, store: storeFor(env), log })
    .catch((e) => { built = null; throw e; }));   /* never cache a failed build */
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin,
                   "Access-Control-Allow-Headers": "content-type",
                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                   "Access-Control-Allow-Credentials": "true",
                   Vary: "Origin" } : {}),
  },
});

export default {
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
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      } : undefined });

    /* FAIL CLOSED. If this is meant to sit behind Access and the assertion is
       not there, something is wrong with the deployment and the right answer
       is to serve nothing — not to serve the CRM and hope. */
    if (String(env.REQUIRE_ACCESS || "") === "1" && !request.headers.get("Cf-Access-Jwt-Assertion"))
      return json({ error: "not authenticated" }, 403, origin);

    let routes;
    try {
      ({ routes } = await handlers(env, log));
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
      return json(await handler(url, parsed), 200, origin);
    } catch (e) {
      const status = e.status || 502;
      log(`! ${url.pathname} ${status} ${e.message}`);
      return json({ error: e.message, problems: e.problems }, status, origin);
    }
  },
};
