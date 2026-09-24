#!/usr/bin/env node
/* Does the console sign in once, and only when somebody asks it to?
 *
 *   node scripts/test-extension-auth.mjs
 *
 * Runs the extension's real background.js and console/api.js — the files that
 * ship, loaded unchanged — against stand-ins for the three things they talk to:
 *
 *   Chrome    launchWebAuthFlow, with the rule that caused a week of failures:
 *             one flow at a time per extension, and "Only one web auth flow is
 *             allowed at a time" for anything that starts while one is open.
 *             Service workers that can be stopped and restarted, with
 *             storage.session surviving the restart.
 *   Google    consent given or not, the redirect URI registered or not, and a
 *             person who approves, closes the window, or walks away.
 *   Server    accepts a bearer token that is unexpired and @enout.in.
 *
 * WHY THIS FILE EXISTS. Versions 1.8 to 1.11 were each a guess, sent out and
 * reported back as "still the same". Every one of those failures is a scenario
 * below, and each was reproducible in a second here — the console's burst of
 * six requests on load, a data request that escalated to a window, a token
 * that died with the service worker, a window left open by a previous worker.
 * The extension's sign-in is not testable in a real browser from here (Google
 * is out of reach), which is exactly why it needs a stand-in that is as strict
 * as Chrome is.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BG_SRC = readFileSync(`${REPO}/extension/background.js`, 'utf8');
const API_SRC = readFileSync(`${REPO}/extension/console/api.js`, 'utf8');

const EXT_ID = 'abgnfhfbhiafcdakdgdmagjnilkiifgk';
const REDIRECT = `https://${EXT_ID}.chromiumapp.org/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };

/* ── Google, and the person at the keyboard ─────────────────────────────── */
const google = {
  consented: false,          // has this account granted consent to the app?
  registered: true,          // is REDIRECT in the OAuth client's redirect URIs?
  email: 'ayush@enout.in',
  person: 'approve',         // approve | close | away   — what they do with a window
  delay: 15,
  lifetime: 3600,            // seconds a minted token is valid for
  wrongNonce: false,
  unreachable: false,        // the sign-in page cannot be loaded at all
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (nonce) => `${b64({ alg: 'RS256', kid: 'k' })}.` +
  `${b64({ iss: 'https://accounts.google.com', email: google.email, email_verified: true,
           nonce: google.wrongNonce ? 'not-the-nonce' : nonce,
           exp: Math.floor(Date.now() / 1000) + google.lifetime })}.sig`;

/* ── Chrome's launchWebAuthFlow, as strict as the real one ──────────────── */
const stats = {};
const resetStats = () => Object.assign(stats, { flows: 0, windows: 0, silent: 0, inFlight: 0,
                                                maxConcurrent: 0, refused: 0 });
resetStats();
let foreignWindow = false;       // a window left open by a previous service worker
const openWindows = [];          // windows waiting on the person

async function launchWebAuthFlow(opts) {
  /* THE RULE. One flow per extension, whoever started it. */
  if (stats.inFlight > 0 || foreignWindow) {
    stats.refused++;
    throw new Error('Only one web auth flow is allowed at a time.');
  }
  stats.flows++; stats.inFlight++;
  stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
  try {
    if (google.unreachable) { await sleep(5); throw new Error('Authorization page could not be loaded.'); }
    const u = new URL(opts.url);
    const nonce = u.searchParams.get('nonce');
    const registered = google.registered && u.searchParams.get('redirect_uri') === REDIRECT;
    if (!opts.interactive) {
      stats.silent++;
      await sleep(5);
      /* An unregistered redirect URI makes Google show an error PAGE instead of
         redirecting; abortOnLoad then ends the flow with this message. */
      if (!registered) throw new Error('User interaction required. Try setting `abortOnLoadForNonInteractive` ' +
        'and `timeoutMsForNonInteractive` if multiple navigations are required, or if code is used for ' +
        'redirects in the authorization page after it\'s loaded.');
      if (!google.consented) return `${REDIRECT}#error=interaction_required`;
      return `${REDIRECT}#id_token=${mint(nonce)}`;
    }
    stats.windows++;
    return await new Promise((resolve, reject) => {
      const act = (what) => {
        if (what === 'close' || !registered) return reject(new Error('The user did not approve access.'));
        google.consented = true;
        resolve(`${REDIRECT}#id_token=${mint(nonce)}`);
      };
      /* A window showing Google's error page, or one nobody attends to, stays
         open until somebody closes it. */
      if (!registered || google.person === 'away') { openWindows.push(act); return; }
      setTimeout(() => act(google.person), google.delay);
    });
  } finally { stats.inFlight--; }
}
const closeWindows = () => { while (openWindows.length) openWindows.shift()('close'); };

/* ── the service worker: background.js, restartable ──────────────────────── */
const session = new Map();       // chrome.storage.session: survives a worker, not the browser
function startWorker() {
  const listeners = [];
  const chrome = {
    identity: { launchWebAuthFlow, getRedirectURL: () => REDIRECT },
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
    storage: { session: {
      get: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, structuredClone(v)); },
      remove: async (k) => { session.delete(k); },
    } },
    tabs: { sendMessage: () => Promise.resolve() },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
  };
  vm.runInContext(BG_SRC, vm.createContext({ chrome, crypto: webcrypto, atob, URL, URLSearchParams,
    console: quiet, setTimeout, clearTimeout, Promise, Date, JSON, Number, Object, Error, String }),
    { filename: 'background.js' });
  return (msg) => new Promise((resolve) => {
    if (listeners[0](msg, {}, resolve) !== true) resolve(undefined);
  });
}
const worker = { send: startWorker() };
const restartWorker = () => { worker.send = startWorker(); };

/* ── the server ──────────────────────────────────────────────────────────── */
const server = { calls: 0, refuseAll: false };
async function serverFetch(url, opts = {}) {
  server.calls++;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url);
  let ok = local;
  if (!local && !server.refuseAll) {
    try {
      const tok = String(opts.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
      ok = p.exp * 1000 > Date.now() && /@enout\.in$/.test(p.email);
    } catch { ok = false; }
  }
  const body = ok ? { ok: true, user: { name: 'Ayush' }, role: 'admin', version: '1.17.1',
                      companies: [], periods: [], contacts: [], due: [] }
                  : { error: 'not signed in' };
  return { status: ok ? 200 : 401, ok, json: async () => body };
}

/* ── the console frame: api.js ───────────────────────────────────────────── */
async function openConsole(base = 'https://bd.enout.website') {
  const settings = new Map([['proxy', base]]);
  const Store = { getSetting: async (k) => settings.get(k), setSetting: async (k, v) => settings.set(k, v) };
  const chrome = { runtime: { sendMessage: (m) => worker.send(m), getManifest: () => ({ version: '1.17.1' }) } };
  const window = {};
  vm.runInContext(API_SRC, vm.createContext({ window, Store, chrome, fetch: serverFetch, AbortController,
    setTimeout, clearTimeout, console: quiet, Promise, JSON, URL, encodeURIComponent, Error, Set, Map, Date }),
    { filename: 'api.js' });
  await window.API.configure();
  return window.API;
}
/* What the console does on load: health, and every panel asking at once. */
const burst = (API) => Promise.allSettled([
  API.health(), API.companies('all'), API.report('week'), API.contact('1'), API.queue(), API.rca(),
]);
const failures = (results) => results.filter((r) => r.status === 'rejected').map((r) => r.reason);
const values = (results) => results.filter((r) => r.status === 'fulfilled').map((r) => r.value);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '  PASS' : '! FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const noCollisions = (label) => check(`${label}: never two flows at once`,
  stats.maxConcurrent <= 1 && stats.refused === 0,
  `max concurrent ${stats.maxConcurrent}, refused ${stats.refused}`);

/* ═══════════════════════════════════════════════════════════════════════ */
console.log('\n1. a browser that has never signed in opens the console');
resetStats();
let API = await openConsole();
let r = await burst(API);
check('no Google window opens by itself', stats.windows === 0, `${stats.windows} window(s)`);
check('the six requests share ONE silent attempt', stats.silent === 1, `${stats.silent} silent`);
noCollisions('opening');
check('health reports failure rather than throwing', r[0].status === 'fulfilled' && r[0].value === null);
check('every data request says it needs a sign-in', failures(r).length === 5 &&
  failures(r).every((e) => e.needsSignIn), failures(r).map((e) => e.code).join(','));
check('the badge knows it is a sign-in, not an outage', API.state.needsSignIn === true);
check('and says what to do, in words', /sign in/i.test(API.state.reason) && !/abortOnLoad/.test(API.state.reason),
  API.state.reason);

console.log('\n2. they click "sign in"');
resetStats();
let who = await API.signIn();
check('exactly one window', stats.windows === 1, `${stats.windows}`);
check('and it worked', !!who && API.state.online === true && API.needsSignIn === false);
check('the token was kept where a new worker can find it', session.has('enoutToken'));
noCollisions('signing in');

console.log('\n3. the console reloads and asks for everything again');
resetStats();
API = await openConsole();
r = await burst(API);
check('all six succeed', values(r).filter(Boolean).length === 6, `${values(r).filter(Boolean).length}/6`);
check('without a single flow', stats.flows === 0, `${stats.flows} flow(s)`);

console.log('\n4. Chrome stops the idle service worker; the next click wakes a new one');
restartWorker();
resetStats();
r = await burst(API);
check('the new worker already has the token', values(r).filter(Boolean).length === 6 && stats.flows === 0,
  `${values(r).filter(Boolean).length}/6, ${stats.flows} flow(s)`);

console.log('\n5. the token runs out while the console is open');
{ const t = session.get('enoutToken'); t.exp = Date.now() - 1000; session.set('enoutToken', t); }
restartWorker();
resetStats();
r = await burst(API);
check('everyone gets a fresh one', values(r).filter(Boolean).length === 6, `${values(r).filter(Boolean).length}/6`);
check('from ONE silent refresh, shared', stats.silent === 1 && stats.windows === 0,
  `${stats.silent} silent, ${stats.windows} window(s)`);
noCollisions('refreshing');

console.log('\n6. a window left open by a previous service worker');
/* The state that produced "Only one web auth flow is allowed at a time" over
   and over: the worker restarted, its queue with it, and a Google window it had
   opened was still sitting on screen. */
session.clear(); restartWorker(); foreignWindow = true; resetStats();
API = await openConsole();
r = await burst(API);
check('the console says a window is open and where to look', failures(r).length === 5 &&
  failures(r).every((e) => /window is already open/.test(e.message)), failures(r)[0]?.message);
check('it tries once, not once per request', stats.refused === 1, `${stats.refused} refused`);
check('no window of its own', stats.windows === 0);
foreignWindow = false; google.consented = true; resetStats();
r = await burst(API);
check('once that window is gone, it recovers silently', values(r).filter(Boolean).length === 6 &&
  stats.windows === 0, `${values(r).filter(Boolean).length}/6`);

console.log('\n7. the redirect URI is not registered — what actually happened');
session.clear(); restartWorker(); google.registered = false; google.consented = false; resetStats();
API = await openConsole();
r = await burst(API);
check('opening the console opens no window', stats.windows === 0, `${stats.windows}`);
check('and never collides', stats.refused === 0, `${stats.refused} refused`);
resetStats();
const clicked = API.signIn();
await sleep(20);
check('clicking "sign in" opens one window, which shows Google\'s error', stats.windows === 1 && openWindows.length === 1);
const t0 = Date.now();
r = await burst(API);
check('while it is open, data requests answer at once instead of hanging', Date.now() - t0 < 500,
  `${Date.now() - t0}ms`);
check('and say a window is open', failures(r).every((e) => /window is already open/.test(e.message)));
const second = API.signIn();
await sleep(20);
check('a second click joins that window rather than opening another', stats.windows === 1, `${stats.windows}`);
closeWindows();
const [a, b] = await Promise.all([clicked, second]);
check('closing it ends both clicks, as not signed in', a === null && b === null && API.needsSignIn);
check('saying it was not finished', /not finished/.test(API.state.reason), API.state.reason);
noCollisions('the failed sign-in');

console.log('\n8. the URI gets registered, and they click again');
google.registered = true; resetStats();
who = await API.signIn();
check('one window, and in', !!who && stats.windows === 1, `${stats.windows} window(s)`);

console.log('\n9. the server refuses a token it had accepted');
server.refuseAll = true; resetStats();
r = await burst(API);
check('no window opens mid-call', stats.windows === 0, `${stats.windows}`);
check('each 401 tries at most one silent refresh', stats.silent <= 6, `${stats.silent} silent`);
noCollisions('the refusal');
server.refuseAll = false;

console.log('\n10. a reply that does not match the request');
session.clear(); restartWorker(); google.wrongNonce = true; resetStats();
API = await openConsole();
who = await API.signIn();
check('is refused, and not kept', who === null && !session.has('enoutToken'), API.state.reason);
google.wrongNonce = false;

console.log('\n11. Google cannot be reached at all');
session.clear(); restartWorker(); google.unreachable = true; resetStats();
API = await openConsole();
who = await API.signIn();
check('says to check the connection, not something about the extension', who === null &&
  /check the internet connection/.test(API.state.reason), API.state.reason);
check('and still asks for a sign-in rather than an address', API.needsSignIn === true);
google.unreachable = false;

console.log('\n12. a proxy on this machine');
resetStats();
const local = await openConsole('http://127.0.0.1:8787');
r = await burst(local);
check('asks Google for nothing at all', stats.flows === 0 && values(r).filter(Boolean).length === 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
