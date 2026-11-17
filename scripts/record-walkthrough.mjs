#!/usr/bin/env node
/* THE 1.84.2 WALKTHROUGH, FILMED — for Ayush to approve the UI from.
 *
 *   node --env-file=.env.local scripts/record-walkthrough.mjs     # the real account
 *   LIVE=0 node scripts/record-walkthrough.mjs                    # invented data
 *
 * Everything it needs it starts, and stops again: a proxy, a stub host page on
 * :8778 (docs/STATE.md §2 — nothing ships one, every live test makes its own),
 * a patched copy of extension/ whose manifest lets Chrome load the console
 * there, and with LIVE=0 the two mocks as well. Chrome is HEADED under xvfb,
 * because extensions do not load headless — never set headless: true here.
 *
 * TWO PASSES, and the difference matters.
 *   live   the screens that only READ: the Accounts list, a contact card, the
 *          account-owner line. Against the real account, so it looks like the
 *          thing he uses. Nothing is created, changed or deleted.
 *   mock   the three steps that WRITE: changing an account's owner, and the
 *          duplicate pill's "Move it here" and "Give it to me". Those move
 *          records, so they are shown on invented data, captioned as such.
 * With LIVE=0 both passes run on the mock and the captions say so.
 *
 * MASKING IS CHECKED, NOT PROMISED. Before anything is recorded a script is
 * injected that rewrites every POC name, phone, email and LinkedIn URL in the
 * page to a stable stand-in — the same person reads as the same invented
 * person throughout. Company names stay: they are what make the screens his.
 * Then, at every step, the frame's text is read back and scanned for anything
 * that still looks like a phone, an email or a real person's name. One hit and
 * the run fails and the recording is DELETED. A video that cannot prove it is
 * masked is not worth the risk of sending.
 *
 * The mask lives here and only here. Nothing in extension/ knows about it, so
 * filming cannot change what ships.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LIVE = process.env.LIVE !== "0";
const MASK = process.env.MASK !== "0";          /* MASK=0 is the check's own test */
const OUT = process.env.OUT || join(REPO, "walkthrough");
const WORK = join(process.env.TMPDIR || "/tmp", `wt-${Date.now()}`);
const W = Number(process.env.W || 1600), H = Number(process.env.H || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);

if (LIVE && !process.env.KYLAS_KEY) {
  console.error(`No KYLAS_KEY in the environment.

  The live pass reads the real account, so it needs the keys you already have:

      node --env-file=.env.local scripts/record-walkthrough.mjs

  Or film the whole thing on invented data instead, which needs no keys:

      LIVE=0 node scripts/record-walkthrough.mjs`);
  process.exit(1);
}

/* ── the things we start, and are responsible for stopping ─────────────── */
const procs = [];
let server = null;
const start = (file, env = {}) => procs.push(spawn("node", [file], {
  cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" }));
const wait = async (url, tries = 80) => {
  for (let i = 0; i < tries; i++) { try { await fetch(url); return true; } catch { await sleep(300); } }
  throw new Error(`${url} never came up`);
};
const stopAll = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  try { server?.close(); } catch { /* not started */ }
};
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

/* ── a patched copy of the extension ───────────────────────────────────
   The manifest needs the stub host in BOTH content_scripts.matches and
   web_accessible_resources.matches; without the second Chrome refuses to load
   console.html and there is no frame at all, which reads as a broken console
   rather than a missing permission (docs/STATE.md §2). */
const EXT = join(WORK, "ext");
mkdirSync(WORK, { recursive: true });
cpSync(join(REPO, "extension"), EXT, { recursive: true });
{
  const p = join(EXT, "manifest.json"), m = JSON.parse(readFileSync(p, "utf8"));
  const HOST = "http://127.0.0.1:8778/*";
  for (const cs of m.content_scripts || []) if (!cs.matches.includes(HOST)) cs.matches.push(HOST);
  for (const r of m.web_accessible_resources || []) if (!r.matches.includes(HOST)) r.matches.push(HOST);
  writeFileSync(p, JSON.stringify(m, null, 2));
  say(`extension ${m.version} copied and patched`);
}

/* ── the stub host: app.kylas.io's URL shapes, and nothing else ────────── */
server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Kylas (stand-in)</title>
    <body style="margin:0;font:14px system-ui;background:#eceaf3">
    <div style="padding:14px 18px;color:#6b6a80">CRM page (stand-in) · ${req.url}</div>`);
});
await new Promise((r) => server.listen(8778, "127.0.0.1", r));

/* ── the stack ─────────────────────────────────────────────────────────── */
const MOCK = { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock",
  AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH" };

start("scripts/mock-kylas.mjs", { ...MOCK, PORT: "9900", MOCK_USER_LIST: "1", MOCK_MANY: "40" });
start("scripts/mock-airtable.mjs", { ...MOCK, PORT: "9901" });
await wait("http://127.0.0.1:9901/v0/appMOCK/Companies");
start("scripts/proxy.mjs", { ...MOCK, PORT: "8788" });            /* the mock proxy */
await wait("http://127.0.0.1:8788/health");
if (LIVE) {
  start("scripts/proxy.mjs", { ...process.env, PORT: "8787" });   /* the real one */
  await wait("http://127.0.0.1:8787/health");
}
const LIVE_BASE = "http://127.0.0.1:8787", MOCK_BASE = "http://127.0.0.1:8788";
say(`stack up · live=${LIVE}`);

/* ── the mask ──────────────────────────────────────────────────────────
   Injected into every frame before it is shown. It rewrites text nodes and
   the values of inputs, and keeps a map so one real person is always the same
   invented one. It runs again on every mutation, because the console repaints
   constantly and a pane that arrives late is a pane nobody masked. */
const MASK_JS = `(() => {
  if (window.__masked) return; window.__masked = true;
  const FIRST = ["Asha","Nina","Omar","Leela","Ravi","Maya","Kiran","Dev","Tara","Arun",
                 "Isha","Vikram","Neha","Rohit","Priya","Karan","Meera","Sana","Jay","Rhea"];
  const LAST  = ["Demo","Sample","Example","Placeholder","Stand-in"];
  const seen = new Map();
  const fakes = new Set();
  window.__maskFakes = fakes;
  let n = 0;
  const keep = (v) => { fakes.add(v); return v; };
  const invent = (real) => {
    const k = String(real).toLowerCase().trim();
    if (fakes.has(String(real).trim())) return String(real).trim();   /* never mask a mask */
    if (!seen.has(k)) { seen.set(k, keep(FIRST[n % FIRST.length] + " " + LAST[Math.floor(n / FIRST.length) % LAST.length])); n++; }
    return seen.get(k);
  };
  const digitsFor = (real) => {
    const k = "tel:" + String(real).replace(/\\D/g, "");
    if (!seen.has(k)) { seen.set(k, keep("90000" + String(10000 + (seen.size * 7) % 89999))); }
    return seen.get(k);
  };
  /* SEPARATORS COUNT. The call bar prints "+91 98739 15513", so a digits-only
     pattern walked straight past the biggest number on the screen — it was in
     the first recording, and the check missed it for having the same blind
     spot. Allow a space or a hyphen between any two digits. */
  const RE_TEL = /(?:\\+?91[\\s-]?)?\\b[6-9](?:[\\s-]?\\d){9}\\b/g;
  const RE_MAIL = /\\b[\\w.+-]+@[\\w-]+\\.[\\w.]{2,}\\b/g;
  const RE_LI = /(?:https?:\\/\\/)?(?:www\\.)?linkedin\\.com\\/in\\/[\\w%-]+/gi;
  /* People's names, learned from the console's own owner list and the records
     on screen — a surname with no pattern cannot be found by a regex. */
  const NAMES = () => (window.__maskNames || []).filter((x) => String(x).trim().length > 2);
  const scrub = (s) => {
    if (!s) return s;
    /* IDEMPOTENT, OR THE TAB DIES. The mask's own output matches its own
       patterns — "asha.demo@example.com" is an email, "9000010007" is a phone
       — so the first cut rewrote its stand-ins to new stand-ins on every pass,
       the observer fired on every rewrite, and the renderer looped until
       Chrome killed it ("Target crashed"). Anything already invented is left
       exactly as it is. */
    const isFake = (m) => {
      const t = String(m).trim();
      if (fakes.has(t)) return true;
      const d = t.replace(/\\D/g, "");
      return d.length >= 10 && fakes.has(d);
    };
    let out = String(s)
      .replace(RE_LI, (m) => isFake(m) ? m : keep("linkedin.com/in/" + invent(m).toLowerCase().replace(/\\s+/g, "-")))
      .replace(RE_MAIL, (m) => isFake(m) ? m : keep(invent(m).toLowerCase().replace(/\\s+/g, ".") + "@example.com"))
      .replace(RE_TEL, (m) => isFake(m) ? m : (m.trim().startsWith("+91") ? "+91 " : "") + digitsFor(m));
    for (const real of NAMES()) {
      if (!real || fakes.has(String(real).trim())) continue;
      out = out.split(real).join(invent(real));
    }
    return out;
  };
  const walk = (root) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const todo = [];
    for (let t = it.nextNode(); t; t = it.nextNode()) todo.push(t);
    for (const t of todo) { const v = scrub(t.nodeValue); if (v !== t.nodeValue) t.nodeValue = v; }
    for (const el of root.querySelectorAll?.("input,textarea") || []) {
      const v = scrub(el.value); if (v !== el.value) el.value = v;
      const p = scrub(el.placeholder); if (p !== el.placeholder) el.placeholder = p;
    }
    for (const el of root.querySelectorAll?.("[title],[aria-label],a[href]") || []) {
      for (const a of ["title", "aria-label", "href"]) {
        const cur = el.getAttribute(a); if (!cur) continue;
        const v = scrub(cur); if (v !== cur) el.setAttribute(a, v);
      }
    }
  };
  window.__maskNow = () => { try { if (document.body) walk(document.body); } catch (e) { /* mid-repaint */ } };
  /* An init script runs before the document exists, so observe() threw and
     the mask never started — and the only sign was a page error nobody was
     reading. Arm it once there is something to observe, and never let this
     throw: a mask that fails silently is worse than no mask. */
  /* THROTTLED. The first cut walked every text node on every mutation and
     again every 300ms; the console repaints constantly and the tab crashed.
     Once per 250ms at most, and the recorder also calls __maskNow() itself
     before each checkpoint, so nothing is filmed unmasked. */
  let pending = 0;
  const soon = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = 0; window.__maskNow(); }, 250);
  };
  const arm = () => {
    if (!document.documentElement) return setTimeout(arm, 20);
    try {
      new MutationObserver(soon).observe(document.documentElement,
        { childList: true, subtree: true, characterData: true });
      window.__maskArmed = true;
    } catch (e) { window.__maskArmed = false; }
    window.__maskNow();
  };
  arm();
})();`;

/* What the check hunts for afterwards. Kept next to the mask on purpose: if
   one grows a case the other must too. */
const LEAK = [
  [/(?:\+?91[\s-]?)?\b[6-9](?:[\s-]?\d){9}\b/, "a phone number"],
  [/\b[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]{2,}\b/, "an email address"],
];

const { chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs");
mkdirSync(OUT, { recursive: true });
const VID = join(WORK, "video");
const ctx = await chromium.launchPersistentContext(join(WORK, "profile"), {
  headless: false, viewport: { width: W, height: H }, deviceScaleFactor: 1,
  recordVideo: { dir: VID, size: { width: W, height: H } },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-proxy-server"],
});
const page = ctx.pages()[0] || await ctx.newPage();
if (MASK) await page.addInitScript(MASK_JS);
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));

const F = () => page.frames().find((f) => f.url().startsWith("chrome-extension"));
const leaks = [];
/* Every caption is also a checkpoint: the frame's text is read back here, so a
   leak is caught at the step that caused it and named in the report. */
async function step(text, ms = 2600) {
  await page.evaluate((t) => {
    let c = document.getElementById("__cap");
    if (!c) {
      c = document.createElement("div"); c.id = "__cap";
      c.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;"
        + "background:#1C1B2E;color:#fff;font:600 17px/1.5 system-ui,sans-serif;padding:14px 22px;"
        + "letter-spacing:.01em";
      document.documentElement.appendChild(c);
    }
    c.textContent = t;
  }, text);
  say(`  · ${text}`);
  await sleep(ms);
  if (!MASK) return;
  const f = F(); if (!f) return;
  await learnNames();
  await f.evaluate(() => window.__maskNow?.()).catch(() => {});
  const seen = await f.evaluate(() => document.body.innerText).catch(() => "");
  /* Scan what is LEFT once the stand-ins are taken out: "9000010007" matches
     a phone and "Asha Demo" is a name, and both of those are the mask working. */
  const fakes = await f.evaluate(() => [...(window.__maskFakes || [])]).catch(() => []);
  let rest = seen;
  for (const fk of fakes) rest = rest.split(fk).join(" ");
  /* the stand-in phone is printed spaced too ("90000 10014") */
  for (const fk of fakes) {
    const d = String(fk).replace(/\D/g, "");
    if (d.length >= 10) rest = rest.replace(new RegExp(d.split("").join("[\\s-]?"), "g"), " ");
  }
  for (const [re, what] of LEAK) {
    for (const hay of [rest, rest.replace(/[\s-]/g, "")]) {
      const hit = hay.match(re);
      if (hit) { leaks.push(`${what} (“${hit[0]}”) was still on screen at: ${text}`); break; }
    }
  }
  const names = await f.evaluate(() => window.__maskNames || []).catch(() => []);
  for (const real of names) if (real && rest.includes(real)) leaks.push(`the name “${real}” was still on screen at: ${text}`);
  /* A mask that learned nothing finds nothing and looks clean. On the real
     account that is the dangerous case, so it is a failure, not a pass. */
  if (LIVE && seen.trim() && !names.length) leaks.push(`no real names could be learned, so none were hidden, at: ${text}`);
  const armed = await f.evaluate(() => window.__maskArmed === true).catch(() => false);
  if (!armed && seen.trim()) leaks.push(`the mask was not running at: ${text}`);
}

/* Point the console at a proxy, and tell the mask which real names to hide —
   the owner list is where the console itself learns them. */
async function useBase(base) {
  const f = F();
  await f.evaluate(async (b) => { await API.setBase(b); }, base);
  await page.reload(); await sleep(7000);
  await learnNames();
}

/* WHO TO HIDE. Reachable by bare name because console.js is a classic script
   — `let OWNERS` is in scope but is not a property of window, which is how
   the first cut learned nothing and then reported a clean run. The DOM is
   read as well, so a name that is on screen without being in either list is
   still covered. */
async function learnNames() {
  const f = F(); if (!f) return [];
  const names = await f.evaluate(() => {
    const out = [];
    const push = (v) => { const s = String(v || "").trim(); if (s.length > 2) out.push(s); };
    try { for (const o of OWNERS) push(typeof o === "string" ? o : o?.name); } catch { /* not loaded yet */ }
    try { for (const a of DATA) { push(a?.pocName); push(a?.owner); } } catch { /* not loaded yet */ }
    try { push(API.state?.user?.name); } catch { /* no user */ }
    /* and whatever is on screen: the queue rows, the owner picker, the card */
    const fake = window.__maskFakes || new Set();
    for (const el of document.querySelectorAll("#qlist .qi .n, #qlist b, #f-ow option, .vr .c7, #f-poc")) {
      const v = String(el.value || el.textContent || "").trim();
      if (!fake.has(v)) push(v);
    }
    window.__maskNames = [...new Set([...(window.__maskNames || []), ...out])];
    window.__maskNow?.();
    return window.__maskNames;
  }).catch(() => []);
  return names;
}

/* A beat that has to be on screen. Returns the locator; throws by name when it
   is not there, so a missing element stops the run instead of being narrated. */
function must(sel, what) {
  const loc = F().locator(sel).first();
  return new Proxy(loc, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== "function") return v;
      return async (...a) => {
        if (!await t.count()) throw new Error(`${what} (${sel}) was not on screen`);
        return v.apply(t, a);
      };
    },
  });
}

/* Wait for something that arrives late — the duplicate pill waits on a debounce
   and a server round trip. must() cannot do this: it checks count() first, so
   must(...).waitFor() threw before any waiting happened. */
async function appears(sel, what, ms = 12000) {
  for (let i = 0; i < Math.ceil(ms / 400); i++) {
    if (await F().locator(sel).count()) return F().locator(sel).first();
    await sleep(400);
  }
  throw new Error(`${what} (${sel}) never appeared`);
}

/* Open an account and wait until the card really is showing it — company mode,
   with the scope band the owner line lives in. */
async function openAccount(id, name) {
  await F().evaluate((c) => window.openCompanyFromView(c.id, c.name), { id: String(id), name: name || "" });
  for (let i = 0; i < 30; i++) {
    const ok = await F().evaluate(() => {
      const w = document.getElementById("qscope");
      return !!w && !w.hidden && !!w.querySelector(".cn");
    }).catch(() => false);
    if (ok) { await sleep(1500); return; }
    await sleep(500);
  }
  throw new Error(`the card never opened on account ${id}`);
}

let failed = null;
try {
  await page.goto("http://127.0.0.1:8778/sales/companies/list/"); await sleep(3500);
  await useBase(LIVE ? LIVE_BASE : MOCK_BASE);

  /* ── pass 1 · the screens that only read ───────────────────────────── */
  await step(LIVE
    ? "The real account. Names, numbers and emails are replaced on screen — nothing here is written."
    : "Invented data throughout — no real account is touched.", 3400);

  const f = () => F();
  await f().evaluate(() => window.showConsoleView("companies"));
  /* The list is crawled, not held, so it can take a while — and filming an
     empty table captioned "ticking a row" is worse than filming nothing. */
  let rows = f().locator(".acctable .vr[data-id]");
  for (let i = 0; i < 40 && await rows.count() === 0; i++) { await sleep(1000); rows = F().locator(".acctable .vr[data-id]"); }
  const nRows = await rows.count();
  say(`  (accounts loaded: ${nRows})`);
  if (!nRows) throw new Error("the Accounts list never filled — nothing to film for step 1");
  await sleep(1500);
  await step("1 · Accounts. Ticking a row used to open the account under your finger.", 2400);
  for (const i of [1, 2]) {
    await rows.nth(i).locator(".cpick").click().catch(() => {});
    await sleep(900);
  }
  await step("Two ticked, the list stayed put. The bar counts them.", 2600);

  const q = f().locator("#accq, .exsearch input, input[type=search]").first();
  if (await q.count()) { await q.type("a"); await sleep(1100); await q.press("Backspace"); await sleep(1400); }
  await rows.nth(3).locator(".cpick").click().catch(() => {});
  await step("And still right after the list redraws — that was the actual bug.", 2800);

  /* OPEN AN ACCOUNT, AND PROVE IT OPENED. The first cut swallowed every
     failure with .catch(() => {}), so a caption that said "hand the account
     to another BD" played over a card with no such link on it. A video that
     narrates something the screen is not doing is worse than no video, so the
     beats that carry the point now have to be there. */
  /* Read the row BEFORE closing the view — showConsoleView(null) takes the
     table away, and querying it afterwards found nothing every time. */
  const firstCo = await f().evaluate(() => {
    const r = document.querySelector(".acctable .vr[data-id]");
    return r ? { id: r.dataset.id, name: r.querySelector(".co")?.textContent?.trim() || "" } : null;
  }).catch(() => null);
  if (!firstCo?.id) throw new Error("no account to open for step 2");
  await f().evaluate(() => window.showConsoleView(null)); await sleep(1200);
  await openAccount(firstCo.id, firstCo.name);
  await step("2 · A contact card. The left rail is the contact list now — nothing else.", 3000);
  await step("The ★ Focus summary and the overdue box that sat here are gone. Today moved to the header.", 3200);
  await step("3 · And the account's owner is on the card, where it never was. You had to open Kylas for it.", 3400);

  /* ── pass 2 · the steps that write ─────────────────────────────────── */
  if (LIVE) {
    await step("The next three steps WRITE, so they switch to invented data. Your account is left alone.", 3600);
    await useBase(MOCK_BASE);
  }
  /* Always this account, on both paths: step 4 needs a person who sits under
     ANOTHER one, and "whichever row came first" is not a guarantee of that. */
  await openAccount("1776620", "Acme Seating");
  await step("Change — hand the account to another BD.", 2200);
  await must("#qscope .clink", "the account-owner Change link").click(); await sleep(3500);
  await appears(".rdPanel", "the re-assign panel");
  await step("Every contact on the account goes with it, and the count is shown before you agree.", 3400);
  await f().locator(".rdPanel #rdX").click(); await sleep(1200);

  await must("#qNewBtn", "the + New contact button").click(); await sleep(1000);
  await must("#f-poc", "the name box").fill("Leela Demo");
  await must("#f-ph", "the phone box").fill("9000000003");
  await f().locator("#f-poc").click();
  await sleep(1500);
  await appears(".dupe", "the duplicate pill", 20000);   /* debounce + a server round trip */
  await step("4 · Adding someone who already sits under another account.", 2600);
  await step("Before: it said so and sent you to Kylas. Now: open it, move it here, or take it.", 3600);
  const give = f().locator(".dupe button", { hasText: "Give it to me" });
  if (!await give.count()) throw new Error('the pill offered no "Give it to me" — nothing to film for step 4');
  await give.click(); await sleep(5200);
  await step("Taken — in Kylas too, with their history intact. Nothing was typed twice.", 3400);

  await step("1.84.2 · pushed, not deployed. Comment and it goes live.", 3000);
  if (errs.length) say(`\n! page errors during the run: ${errs.slice(0, 3).join(" | ")}`);
} catch (e) {
  failed = e;
} finally {
  const v = page.video();
  await ctx.close();                       /* the video is only written on close */
  const raw = v ? await v.path() : null;

  if (failed) say(`\nThe run stopped: ${failed.message}`);

  if (leaks.length) {
    say(`\nMASKING FAILED — the recording has been deleted.\n`);
    for (const l of [...new Set(leaks)].slice(0, 12)) say(`  ! ${l}`);
    say(`\nNothing was sent anywhere. Re-run once the mask covers those.`);
    try { if (raw) rmSync(raw, { force: true }); } catch { /* already gone */ }
    rmSync(WORK, { recursive: true, force: true });
    process.exit(2);
  }

  const bytes = raw && existsSync(raw) ? statSync(raw).size : 0;
  if (raw && bytes < 50_000) {
    say(`\nNo usable video: the recording is ${bytes} bytes.`
      + (failed ? "" : " Chrome most likely crashed before it was written."));
    try { rmSync(raw, { force: true }); } catch { /* already gone */ }
    rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
  }
  if (raw && existsSync(raw)) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
    const webm = join(OUT, `console-1.84.2-${stamp}.webm`);
    cpSync(raw, webm);
    let out = webm;
    const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", webm,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      webm.replace(/\.webm$/, ".mp4")]);
    if (!ff.error && ff.status === 0) { out = webm.replace(/\.webm$/, ".mp4"); rmSync(webm, { force: true }); }
    else say("(ffmpeg not available — leaving the .webm, which plays in any browser)");
    say(`\nVideo: ${out}`);
    say(MASK
      ? `Masked: every POC name, phone, email and LinkedIn URL. Company names kept.\nChecked: ${leaks.length === 0 ? "no phone, email or known name survived any step" : "see above"}.`
      : `NOT MASKED (MASK=0) — this one is for testing the check, do not send it.`);
  } else {
    say("\nNo video was produced.");
  }
  rmSync(WORK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);   /* a stray child kept the process up for 7 min */
}
