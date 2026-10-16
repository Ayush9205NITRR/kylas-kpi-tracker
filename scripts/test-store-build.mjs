#!/usr/bin/env node
/* THE PACKAGED BUILD STILL REACHES THE SERVER WITHOUT HOST PERMISSIONS.
 *
 *   xvfb-run -a node scripts/test-store-build.mjs
 *
 * Ayush, 2026-10-16, from the Chrome Web Store listing form:
 *   "Due to the Host Permission, your extension may require an in-depth review
 *    which will delay publishing."
 *
 * That is the whole reason the store build drops `host_permissions`. The claim
 * underneath it is a behavioural one and too expensive to be wrong about — if
 * it is false, the published extension cannot talk to its server at all and
 * every associate's console is dead on open — so it is proved here rather than
 * reasoned about:
 *
 *   A host permission does not GRANT the fetch. It BYPASSES CORS. An extension
 *   page is an ordinary document with an ordinary origin
 *   (chrome-extension://<id>), so a cross-origin fetch from it obeys CORS like
 *   any other, and a server that answers with the right headers is reachable
 *   with no host permission at all.
 *
 * The Worker already answers that way: ALLOWED_ORIGIN names the extension
 * origins and cors() sends Allow-Origin, Allow-Headers (content-type,
 * authorization, if-none-match) and Allow-Credentials. So the packaged build
 * needs nothing extra — which this starts a real Chrome to demonstrate.
 *
 * It also pins the two facts that make it safe to drop each entry:
 *   bd.enout.website — every network call in this extension is made from
 *                      console/api.js, inside the console's own iframe. There
 *                      is NO fetch in background.js or content/inject.js, so
 *                      no call is ever made from the page's origin, where CORS
 *                      would be judged against app.kylas.io instead.
 *   app.kylas.io     — the content script is injected by content_scripts
 *                      .matches, which is a separate grant. Nothing fetches
 *                      app.kylas.io, so the host_permissions entry was only
 *                      ever redundant.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const PORT = 9987;
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${d}` : ""}`); };

/* ── the source manifest still has the dev hosts, the package must not ── */
const SRC = new URL("../extension/manifest.json", import.meta.url).pathname;
const src = JSON.parse(readFileSync(SRC, "utf8"));
console.log("\n1 · what each build declares");
{
  ok("the source keeps the dev hosts, so Load unpacked still works",
     (src.host_permissions || []).some((h) => /127\.0\.0\.1|localhost/.test(h)),
     JSON.stringify(src.host_permissions));
  /* What package-extension.sh actually ships. Run it rather than re-deriving
     the rule here: a second copy of the rule is a second thing to drift. */
  execFileSync("bash", [new URL("./package-extension.sh", import.meta.url).pathname],
               { stdio: "ignore" });
  const zip = execFileSync("sh", ["-c",
    `unzip -p "$(ls -t ${new URL("../dist", import.meta.url).pathname}/*.zip | head -1)" manifest.json`],
    { encoding: "utf8" });
  const pkg = JSON.parse(zip);
  ok("the package drops the loopback hosts", !(pkg.host_permissions || []).some((h) => /127\.0\.0\.1|localhost/.test(h)),
     JSON.stringify(pkg.host_permissions));
  ok("...and app.kylas.io, which content_scripts.matches already grants",
     !(pkg.host_permissions || []).some((h) => /app\.kylas\.io/.test(h)));
  ok("...but KEEPS bd.enout.website as the fallback if ALLOWED_ORIGIN is wrong",
     (pkg.host_permissions || []).some((h) => /bd\.enout\.website/.test(h)));
  ok("...and still injects into Kylas, which is a host grant of its own",
     (pkg.content_scripts?.[0]?.matches || []).includes("https://app.kylas.io/*"));
}

/* ── build the package the way package-extension.sh does ──────────────── */
const dir = mkdtempSync(join(tmpdir(), "storeext-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
cpSync(new URL("../extension", import.meta.url).pathname, dir, { recursive: true });
const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
/* THE PACKAGED SHAPE: no host permissions at all. */
delete m.host_permissions;
/* NOTHING IS ADDED TO content_scripts.matches, AND THAT IS THE POINT.
   The first version of this test put the stub there so the content script had
   somewhere to run — and every assertion passed for the wrong reason: Chrome
   counts a content-script match pattern AS A HOST PERMISSION. The fetch went
   out with no Origin header and no preflight, and even the no-CORS control
   succeeded, because the extension had been granted that host after all.

   So the stub is reached only from the console page, which is served from the
   extension's own origin and needs no match pattern. 127.0.0.1 then appears
   NOWHERE in the manifest, which is the only way to ask the question honestly. */
writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
console.log(`  built a package-shaped copy with host_permissions removed`);

/* ── a server that answers like the Worker does ───────────────────────── */
const seen = [];
const server = createServer((req, res) => {
  const origin = req.headers.origin || "";
  seen.push({ url: req.url, method: req.method, origin, auth: req.headers.authorization || "" });
  /* Exactly the Worker's shape — see cors() in worker/index.mjs. An extension
     origin is echoed back, which is what makes a credentialed, header-bearing
     fetch legal without any host permission. */
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type, authorization, if-none-match",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>stub</title><p>stub");
  }
  res.writeHead(200, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify({ ok: true, saw: origin }));
});
await new Promise((r) => server.listen(PORT, r));

/* ── a real Chrome, with that package loaded ──────────────────────────── */
console.log("\n2 · a real Chrome with the packaged build");
const profile = mkdtempSync(join(tmpdir(), "storeprof-"));
process.on("exit", () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* gone */ } });
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--no-sandbox"],
});
try {
  /* The service worker's URL carries the extension id. */
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(sw.url()).host;
  ok("the packaged build loads in Chrome at all", !!id, `chrome-extension://${id}`);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/console/console.html`, { waitUntil: "domcontentloaded" });
  ok("...and its console page opens", page.url().startsWith(`chrome-extension://${id}`));

  /* THE QUESTION. A cross-origin fetch, carrying an Authorization header so it
     is non-simple and must survive a preflight, from a build with NO host
     permission for that host. */
  const got = await page.evaluate(async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/report`, {
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      });
      return { ok: r.ok, status: r.status, body: await r.json() };
    } catch (e) { return { ok: false, error: String(e) }; }
  }, PORT);
  ok("a cross-origin fetch SUCCEEDS with no host permission",
     got.ok === true && got.body?.ok === true, JSON.stringify(got).slice(0, 180));
  ok("...and the server saw the extension's own origin",
     String(got.body?.saw || "").startsWith("chrome-extension://"), got.body?.saw || "(none)");
  ok("...after a preflight, so the Authorization header really was sent",
     seen.some((s) => s.method === "OPTIONS") && seen.some((s) => s.auth === "Bearer test-token"),
     JSON.stringify(seen.map((s) => `${s.method} ${s.url}`)));

  /* And the negative control: without the server's CORS headers the same fetch
     must FAIL, or the test above proves nothing about CORS. */
  console.log("\n3 · the control — it is CORS doing the work, not nothing");
  const blocked = await page.evaluate(async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/page`);   /* no CORS headers on this one */
      return { ok: r.ok };
    } catch (e) { return { ok: false, error: String(e).slice(0, 90) }; }
  }, PORT);
  ok("a response WITHOUT Allow-Origin is refused by the browser",
     blocked.ok === false, JSON.stringify(blocked));
} finally {
  await ctx.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
