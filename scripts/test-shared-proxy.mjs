#!/usr/bin/env node
/* One proxy, several associates, and the two things that must not go wrong.
 *
 *   node scripts/mock-kylas.mjs &
 *   node scripts/test-shared-proxy.mjs
 *
 * Ayush, 2026-09-22: "server run on one machine" — one proxy for the team
 * instead of one per laptop.
 *
 * TWO PROPERTIES, and the second is the one that is easy to lose quietly.
 *
 * 1. A proxy other machines can reach must not answer without a credential.
 *    The interlock refuses to bind anywhere but loopback unless per-request
 *    keys are on, and it refuses rather than warns: a warning in a log is not
 *    a defence against publishing a read/write door onto the CRM.
 *
 * 2. Every caller must stay themselves. whoami() decides "Me" on the
 *    dashboard, admin versus associate, and who a focus pick is attributed
 *    to. It used to resolve from the one key the process started with — which
 *    on a shared proxy makes eight associates into one person, silently, and
 *    removes the reason the KPI ladder exists. The identity cache is keyed by
 *    key for exactly this, and the check below is the one that would catch it
 *    being reverted.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n         got: ${JSON.stringify(got)}`}`);
};

/* A Kylas stand-in that answers /users/me differently per key, which is the
   whole point: two keys must come back as two people. */
const PEOPLE = {
  "key-priya": { id: 501, firstName: "Priya", lastName: "Deshmukh", email: "priya@enout.in" },
  "key-rubal": { id: 502, firstName: "Rubal", lastName: "Sansanwal", email: "rubal@enout.in" },
};
const kyl = createServer((req, res) => {
  const key = req.headers["api-key"] || "";
  const me = PEOPLE[key];
  res.writeHead(me ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(me || { message: "bad api key" }));
});
await new Promise((r) => kyl.listen(0, r));
const KYLAS = `http://127.0.0.1:${kyl.address().port}`;

let PORT = 8900;
const start = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/proxy.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ENV_FILE: "/dev/null", PORT: String(++PORT),
           KYLAS_BASE: KYLAS, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const grab = (d) => {
    out += d;
    /* "routes:" is the LAST line of the startup banner, and waiting for it is
       what makes this deterministic. Resolving on "proxy on http" raced the
       two lines printed after it, so the assertion about which key mode the
       proxy is in passed or failed depending on how the writes were chunked. */
    if (/routes:/.test(out)) resolve({ child, out, port: PORT, ok: true });
  };
  child.stdout.on("data", grab);
  child.stderr.on("data", grab);
  child.on("exit", (code) => resolve({ child, out, port: PORT, ok: false, code }));
});
const get = (port, path, key) => fetch(`http://127.0.0.1:${port}${path}`,
  { headers: key ? { "x-kylas-key": key } : {} })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const running = [];
const stopAll = () => running.forEach((c) => { try { c.kill(); } catch { /* gone */ } });

try {
  console.log("— a reachable proxy with no per-request keys —");
  {
    /* THE INTERLOCK. Binding 0.0.0.0 without PROXY_REQUIRE_KEY publishes an
       unauthenticated door onto the CRM, so it must not start at all. */
    const r = await start({ PROXY_BIND: "0.0.0.0", KYLAS_KEY: "key-priya" });
    check("it refuses to start", r.ok, false);
    check("and says which two settings are in conflict", r.out,
          (t) => /PROXY_BIND/.test(t) && /PROXY_REQUIRE_KEY/.test(t));
    check("naming both ways out", r.out,
          (t) => /unset PROXY_BIND/.test(t) && /PROXY_REQUIRE_KEY=1/.test(t));
  }

  console.log("\n— loopback, one key for the process — today's install —");
  {
    const r = await start({ KYLAS_KEY: "key-priya" });
    check("it starts", r.ok, true);
    running.push(r.child);
    check("and says which mode it is in", r.out, (t) => /keys: the process key/.test(t));
    const me = await get(r.port, "/health");
    check("no header needed", me.status, 200);
    check("and it is the process key's person", me.body?.user?.name, "Priya Deshmukh");
  }

  console.log("\n— shared, per-request keys —");
  {
    const r = await start({ PROXY_BIND: "0.0.0.0", PROXY_REQUIRE_KEY: "1", KYLAS_KEY: "key-priya" });
    check("it starts once keys are required", r.ok, true);
    running.push(r.child);
    check("and says so", r.out, (t) => /keys: each caller sends their own/.test(t));

    /* A monitor must be able to ask whether the thing is up without holding a
       CRM credential, so /health is the one route outside the gate — and it
       still answers nothing about anybody. */
    const anon = await get(r.port, "/companies?owner=all");
    check("a caller with no key is refused", anon.status, 401);
    check("and told what to do about it", anon.body?.hint, (h) => /API Keys/.test(h || ""));
    check("with a flag the badge can branch on", anon.body?.needsKey, true);

    /* THE PROPERTY THIS FILE EXISTS FOR. */
    const a = await get(r.port, "/health", "key-priya");
    const b = await get(r.port, "/health", "key-rubal");
    check("Priya is Priya", a.body?.user?.name, "Priya Deshmukh");
    check("Rubal is Rubal", b.body?.user?.name, "Rubal Sansanwal");
    check("they are not the same person", a.body?.user?.id === b.body?.user?.id, false);

    /* Asked again, so the identity cache is exercised rather than a cold read
       each time. One slot would hand the second caller the first one's name
       for the whole TTL. */
    const a2 = await get(r.port, "/health", "key-priya");
    const b2 = await get(r.port, "/health", "key-rubal");
    check("still Priya on the second ask", a2.body?.user?.name, "Priya Deshmukh");
    check("still Rubal on the second ask", b2.body?.user?.name, "Rubal Sansanwal");

    const bad = await get(r.port, "/companies?owner=all", "key-nobody");
    check("a key Kylas does not know is refused", bad.status, (s) => s >= 400);
  }

  console.log("\n— shared, and the process has no key of its own —");
  {
    /* The arrangement worth aiming at: the server holds no Kylas credential at
       all, only the Airtable PAT. Nothing to leak if the box is compromised
       beyond what the associates' own keys already reach. */
    const r = await start({ PROXY_BIND: "0.0.0.0", PROXY_REQUIRE_KEY: "1", KYLAS_KEY: "" });
    check("it starts without KYLAS_KEY", r.ok, true);
    running.push(r.child);
    const me = await get(r.port, "/health", "key-rubal");
    check("and serves the caller as themselves", me.body?.user?.name, "Rubal Sansanwal");
  }
} finally {
  stopAll();
  kyl.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
