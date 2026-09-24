#!/usr/bin/env node
/* The proxy, as a program you run on your own machine.
 *
 *   KYLAS_KEY=... node scripts/proxy.mjs
 *   KYLAS_KEY=... PORT=8787 node scripts/proxy.mjs
 *
 * Runs on your machine; the extension talks to it at http://127.0.0.1:8787.
 * The API key lives here, in one process, rather than in every associate's
 * browser.
 *
 * THIS FILE IS THE SHELL, NOT THE PROXY. Every route lives in handlers.mjs and
 * knows nothing about Node. What is left here is the four things that are
 * genuinely node-specific:
 *
 *   where the configuration comes from   process.env
 *   where the durable state lives        a file beside the repo
 *   how a request becomes (url, body)    a node:http stream
 *   what a fatal error means             printing something useful and exiting
 *
 * worker/index.mjs is those same four things for a hosted runtime. If something
 * has to be added to both, it probably belongs in handlers.mjs instead.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHandlers } from "./handlers.mjs";
import { fileStore } from "./store.mjs";

const PORT = Number(process.env.PORT || 8787);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* WHICH BUILD IS THIS PROCESS RUNNING?
   The proxy is a long-lived process an associate starts by hand, and the
   extension is reloaded separately. So `git pull` updates neither: Ayush spent
   a day looking at a verdict sentence that had been deleted from the tree,
   because the proxy he was talking to had been up for 17 hours. Nothing on
   screen could have told him — a stale proxy answers every request happily and
   correctly, just from yesterday's code.

   One version for both halves, read from the extension manifest so there is no
   second number to forget to bump. Read HERE rather than in the handlers,
   because a hosted runtime has no repo to read it from and is told instead. */
let VERSION = "unknown";
try {
  VERSION = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")).version
            || "unknown";
} catch { /* running outside the repo: the handshake degrades to "unknown" */ }

/* The save journal and the company-shape hint. A file is the right store for
   one process that owns its own disk; see store.mjs for what a hosted runtime
   uses instead, and why the difference matters for the journal.

   THE FILE NAME IS THE OLD JOURNAL'S, deliberately: the entries inside it are
   the record of which contacts have already been created, and pointing at a
   fresh file would throw that away — which on the first run after an upgrade
   is exactly the state in which a retry duplicates a contact. */
const store = fileStore(new URL("../.save-journal.json", import.meta.url), { log });

let routes, maintain;
try {
  ({ routes, maintain } = await createHandlers({ env: { ...process.env, VERSION }, store, log }));
} catch (e) {
  /* A misconfiguration, not a crash — say which one, and nothing else. The
     handlers throw rather than exit precisely so this can be one sentence
     instead of a stack trace. */
  console.error(e.message);
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b || "{}"));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  /* A localhost dev proxy with no secrets in its responses; the extension's
     origin is a generated id, so echoing is simpler than allow-listing. */
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  /* authorization is not sent to a localhost proxy, but the two shells
     answering differently is a difference somebody has to rediscover. */
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", routes: Object.keys(routes) }));
  }

  try {
    /* Parsed HERE, so no handler ever has to know what a request looks like in
       this runtime. A malformed body then fails as a 400 naming the body,
       rather than as an exception from somewhere deep inside a route. */
    let parsed = {};
    if (req.method !== "GET") {
      const raw = await readBody(req);
      try { parsed = JSON.parse(raw); }
      catch { throw Object.assign(new Error("the request body is not valid JSON"), { status: 400 }); }
    }
    const body = await handler(url, parsed);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (e) {
    const status = e.status || 502;
    log(`! ${url.pathname} ${status} ${e.message}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message, problems: e.problems }));
  }
});

/* A port clash is the most common thing that happens when restarting this, and
   an unhandled 'error' event dumps a Node stack trace that names neither the
   cause nor the fix. Worse: the OLD process keeps serving, so the console still
   works — on stale code, with whatever key that process started with. That is
   how an expired key looked like a broken key for half an hour. */
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`\nPort ${PORT} is already taken — an older proxy is still running.`);
  console.error(`It will keep answering the extension with the code and key it started with,`);
  console.error(`so the console may look broken in ways that have nothing to do with your setup.\n`);
  console.error(`Stop it and start again:`);
  console.error(`  kill $(lsof -t -iTCP:${PORT} -sTCP:LISTEN)`);
  console.error(`  source .env.local && node scripts/proxy.mjs\n`);
  console.error(`Or run this one somewhere else:`);
  console.error(`  PORT=${PORT + 1} node scripts/proxy.mjs`);
  console.error(`then click the offline badge in the console and point it at that address.\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`proxy on http://127.0.0.1:${PORT} — build ${VERSION}`);
  log(`routes: ${Object.keys(routes).join("  ")}`);
});

/* The Worker's once-a-minute cron, locally. /companies never crawls Kylas
   inline any more; without this the list here would say "building" forever. */
let maintaining = false;
const tick = async () => {
  if (maintaining || !maintain) return;
  maintaining = true;
  try { await maintain(); } catch (e) { log(`! maintain: ${e.message}`); }
  finally { maintaining = false; }
};
setTimeout(tick, 1000);
setInterval(tick, 60_000).unref();
