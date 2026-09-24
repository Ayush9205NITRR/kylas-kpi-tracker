#!/usr/bin/env node
/* Does the proxy still work when there is no Node underneath it?
 *
 *   node scripts/test-worker.mjs
 *
 * Starts its own mock Kylas and mock Airtable, then drives worker/index.mjs
 * the way Cloudflare does: `fetch(new Request(...), env, ctx)`, with the
 * configuration in an env object and the durable state in a store that is not
 * a file. Nothing here touches the filesystem or process.env.
 *
 * WHAT IT IS REALLY CHECKING
 * The handlers used to read process.env and the disk as the module loaded,
 * which welded them to one runtime. They are a factory now, and this is the
 * proof that the seam is real rather than merely tidy: if anything below
 * handlers.mjs reaches for a Node API again, this suite is where it shows up —
 * before a deploy, rather than as a 500 on a hostname the team is already
 * using.
 *
 * It is NOT a test of Cloudflare. It cannot catch a wrong binding name or a
 * missing DNS record; wrangler and a real deploy do that. It catches the thing
 * that is expensive to find late: code that cannot run there at all.
 */
import { spawn } from 'node:child_process';
import worker from '../worker/index.mjs';
import { memoryStore } from './store.mjs';

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const spawnIt = (args, env) => {
  const p = spawn('node', args, { cwd: REPO, env: { ...process.env, ...env }, stdio: 'ignore' });
  kids.push(p);
  return p;
};

async function mocks() {
  spawnIt(['scripts/mock-kylas.mjs'], { MOCK_MANY: '4' });
  spawnIt(['scripts/mock-airtable.mjs'], {});
  for (let i = 0; i < 50; i++) {
    try {
      await fetch('http://127.0.0.1:9901/v0/appMOCK/Contacts', { headers: { Authorization: 'Bearer x' } });
      await fetch('http://127.0.0.1:9900/__writes', { headers: { 'api-key': 'x' } });
      return;
    } catch { await sleep(300); }
  }
  throw new Error('mocks never came up');
}
const done = () => kids.forEach((p) => { try { p.kill('SIGKILL'); } catch {} });

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/* The bindings, exactly as Cloudflare would pass them — plain data, no
   process.env anywhere. The store stands in for the D1 binding; what is being
   tested is that the handlers accept one, not that D1 works. */
const store = memoryStore();
const ENV = {
  KYLAS_KEY: 'x', KYLAS_BASE: 'http://127.0.0.1:9900',
  AIRTABLE_PAT: 'pat_mock', AIRTABLE_BASE: 'appMOCK',
  AIRTABLE_BASE_URL: 'http://127.0.0.1:9901',
  VERSION: '1.5.0-worker',
  ALLOWED_ORIGIN: ORIGIN,
  /* Explicit, because an unset AUTH now refuses to serve — see section 3. */
  AUTH: 'none',
};
/* storeFor() insists on a real binding, and rightly — a journal with nowhere
   to live is how a lost reply duplicates a contact. The test supplies one by
   standing in for D1 rather than by weakening that rule. */
const withStore = (env) => ({ ...env, DB: null, KV: {
  get: (k) => store.get(k),
  put: (k, v, o) => store.put(k, v, o && o.expirationTtl ? { ttlSeconds: o.expirationTtl } : undefined),
  delete: (k) => store.delete(k),
  list: async () => ({ keys: (await store.keys()).map((name) => ({ name })) }),
} });

const call = (path, { method = 'GET', body, origin = ORIGIN, env = ENV, headers = {} } = {}) =>
  worker.fetch(new Request(`https://bd.enout.website${path}`, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), withStore(env), {});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '  PASS' : '! FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

await mocks();

/* ── 1 · it runs at all ──────────────────────────────────────────────── */
console.log('\n1. the handlers run with no Node underneath them');
const h = await call('/health');
const hj = await h.json();
check('/health answers 200', h.status === 200, `got ${h.status}`);
check('it reached Kylas and knows who it is', hj.user?.name === 'Enout Super Admin', JSON.stringify(hj.user));
check('the build number comes from the bindings, not a file on disk',
      hj.version === '1.5.0-worker', hj.version);

/* ── 2 · CORS is an allow-list, not an echo ──────────────────────────── */
/* The Node shell reflects any Origin because nothing but the machine it runs
   on can reach it. This one is on the internet holding a Kylas key, and an
   echo there would let any page call it with the browser's credentials. */
console.log('\n2. CORS');
check('the extension is allowed',
      h.headers.get('Access-Control-Allow-Origin') === ORIGIN,
      h.headers.get('Access-Control-Allow-Origin') || '(none)');
const eve = await call('/health', { origin: 'https://evil.example' });
check('any other origin gets NO allow header at all',
      !eve.headers.get('Access-Control-Allow-Origin'),
      eve.headers.get('Access-Control-Allow-Origin') || '(none)');
const pre = await call('/save', { method: 'OPTIONS' });
check('the preflight is answered for the extension', pre.status === 204, `got ${pre.status}`);
/* THE ASSERTION THAT WAS MISSING, and its absence shipped a console that
   could not reach the server at all. Sending Authorization makes every
   request non-simple, so the browser preflights and then refuses to send the
   real request unless the preflight names that header. Nothing 401s, nothing
   logs, and fetch rejects with "Failed to fetch". */
check('and the preflight allows the Authorization header',
      /authorization/i.test(pre.headers.get('Access-Control-Allow-Headers') || ''),
      pre.headers.get('Access-Control-Allow-Headers') || '(none)');
check('and content-type, which a POST body needs',
      /content-type/i.test(pre.headers.get('Access-Control-Allow-Headers') || ''));
check('and it is cached, so this is not a round trip per request',
      Number(pre.headers.get('Access-Control-Max-Age') || 0) > 0,
      pre.headers.get('Access-Control-Max-Age') || '(none)');
const preEvil = await call('/save', { method: 'OPTIONS', origin: 'https://evil.example' });
check('and refused for anyone else', preEvil.status === 403, `got ${preEvil.status}`);

/* ── 3 · it fails CLOSED ─────────────────────────────────────────────── */
/* A server holding a Kylas key must never be one forgotten variable away from
   being open, so there is no default: AUTH unset serves nothing at all. The
   per-mode checking itself is tested in test-google-auth.mjs, which mints its
   own keys and actually attempts the forgeries. */
console.log('\n3. the login gate');
const noAuth = await call('/health', { env: { ...ENV, AUTH: '' } });
check('AUTH unset refuses to serve', noAuth.status === 500,
      (await noAuth.json()).error?.slice(0, 40));
const shut = await call('/health', { env: { ...ENV, AUTH: 'access' } });
check('AUTH=access with no assertion is a 403', shut.status === 403, `got ${shut.status}`);
const open = await call('/health', { env: { ...ENV, AUTH: 'access' },
                                     headers: { 'Cf-Access-Jwt-Assertion': 'stub' } });
check('with one, the request is served', open.status === 200, `got ${open.status}`);
const noBearer = await call('/health', { env: { ...ENV, AUTH: 'google',
                                                GOOGLE_CLIENT_ID: 'x', ALLOWED_EMAIL_DOMAIN: 'enout.in' } });
check('AUTH=google with no token is a 401', noBearer.status === 401, `got ${noBearer.status}`);
const junk = await call('/health', { env: { ...ENV, AUTH: 'google',
                                            GOOGLE_CLIENT_ID: 'x', ALLOWED_EMAIL_DOMAIN: 'enout.in' },
                                     headers: { Authorization: 'Bearer not-a-token' } });
const junkBody = await junk.json();
check('a junk token is a 401', junk.status === 401, `got ${junk.status}`);
/* WHICH check a token tripped is useful to whoever is debugging and is a hint
   to whoever is probing. It belongs in the log, not in the response. */
check('and the reason is NOT handed to the caller',
      !/JWT|alg|signature|kid|expired|issuer/i.test(junkBody.error || ''),
      JSON.stringify(junkBody));

/* ── 4 · a save, end to end, through the Worker ──────────────────────── */
console.log('\n4. a save');
const contact = {
  lid: 'wk-1', kid: '', pendingCreate: true, pocName: 'Worker Test',
  companyId: '1776620', company: 'seats', owner: 'Enout Super Admin', ownerId: 74725,
  phones: [{ type: 'MOBILE', cc: '+91', value: '9800004321', primary: true }], emails: [],
  stage: 'MQL_MARKETING_QUALIFIED_LEAD', past: [],
  current: [{ rowKey: 'wk-row-1', eventType: 'Offsite', budget: '8L', timeline: 'Q3', pax: '40', remarks: '' }],
};
const call1 = { at: '2026-09-23T10:00:00.000Z', outcome: 'Connected', duration: 40, durationSource: 'dialed', createdHere: true };
const s1 = await call('/save', { method: 'POST', body: { contact, call: call1 } });
const s1j = await s1.json();
console.log(`   ${s1.status}  kid=${s1j.kid} created=${s1j.created} wrote=${JSON.stringify(s1j.wrote)}`);
check('the save went through', s1.status === 200 && !!s1j.kid, s1j.error || '');
check('and it created the contact', s1j.created === true);

/* THE JOURNAL IS THE REASON D1 IS IN THE PLAN. The same save again must not
   make a second contact — and here the journal is not a file, which is the
   whole point of the exercise. */
const s2 = await call('/save', { method: 'POST', body: { contact, call: call1 } });
const s2j = await s2.json();
console.log(`   retry: kid=${s2j.kid} created=${s2j.created} deduped=${!!s2j.deduped}`);
check('a retry did NOT create a second contact', s2j.created === false && s2j.kid === s1j.kid,
      `created=${s2j.created} kid=${s2j.kid}`);
check('the journal wrote itself into the store, not onto a disk',
      (await store.keys()).some((k) => k.startsWith('j:')),
      (await store.keys()).join(', ') || '(empty)');

/* ── 5 · the errors a shell is responsible for ───────────────────────── */
console.log('\n5. errors');
const nf = await call('/nope');
check('an unknown route is a 404', nf.status === 404, `got ${nf.status}`);
const bad = await worker.fetch(new Request('https://bd.enout.website/save', {
  method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: 'not json',
}), withStore(ENV), {});
check('a malformed body is a 400, not a 502', bad.status === 400, `got ${bad.status}`);
/* A FRESH MODULE, because the Worker caches its handlers per isolate — which
   is correct, since one Worker is deployed with one configuration for the life
   of the isolate. Reusing this module would reuse the good build from the
   tests above and prove nothing. A query string gives Node a separate registry
   entry, which is the closest thing to a cold isolate available here. */
const coldWorker = async (n) => (await import(`../worker/index.mjs?cold=${n}`)).default;

const noKey = await (await coldWorker(1)).fetch(
  new Request('https://bd.enout.website/health', { headers: { Origin: ORIGIN } }),
  withStore({ ...ENV, KYLAS_KEY: '' }), {});
check('a missing key is a 500 that names it',
      noKey.status === 500 && /KYLAS_KEY/.test((await noKey.clone().json()).error || ''),
      (await noKey.json()).error?.slice(0, 48));

/* ── 6 · no journal binding is refused, loudly ───────────────────────── */
/* Falling back to memory here would look like it worked and would lose the
   record of every contact created, which is the one thing that must survive. */
console.log('\n6. a deployment with nowhere to keep the journal');
const nostore = await (await coldWorker(2)).fetch(
  new Request('https://bd.enout.website/health', { headers: { Origin: ORIGIN } }),
  { ...ENV }, {});
const nostoreBody = await nostore.json();
check('it refuses to start rather than keeping the journal in memory',
      nostore.status === 500 && /journal/i.test(nostoreBody.error || ''),
      nostoreBody.error?.slice(0, 60));

/* ── 7 · the nightly jobs ────────────────────────────────────────────── */
/* The whole reason for moving off a laptop. Fired the way Cloudflare fires
   them: a cron expression and nothing else, which is why the strings in
   wrangler.toml are the only thing telling the three jobs apart. */
console.log('\n7. the scheduled jobs');
const CRONS = { CRON_SYNC: '30 20 * * *', CRON_SNAPSHOT: '45 18 * * *', CRON_ROLLUP: '0 21 * * 0' };
const lines = [];
const origLog = console.log;
const fire = async (cron, env = { ...ENV, ...CRONS }) => {
  lines.length = 0;
  const waits = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await worker.scheduled({ cron, scheduledTime: Date.now() }, withStore(env),
                            { waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
  } finally { console.log = origLog; }
  return lines.join('\n');
};

const syncOut = await fire(CRONS.CRON_SYNC);
check('the sync cron runs the sync', /cron .* -> sync/.test(syncOut),
      syncOut.split('\n')[0] || '(silent)');
check('and it actually reached Kylas and Airtable',
      /companies \d+\/\d+, contacts/.test(syncOut) || /sync finished/.test(syncOut),
      syncOut.replace(/\n/g, ' | ').slice(-240));

const snapOut = await fire(CRONS.CRON_SNAPSHOT);
check('the snapshot cron runs the snapshot', /cron .* -> snapshot/.test(snapOut),
      snapOut.split('\n')[0] || '(silent)');

const rollOut = await fire(CRONS.CRON_ROLLUP);
check('the rollup cron runs the rollup', /cron .* -> rollup/.test(rollOut),
      rollOut.split('\n')[0] || '(silent)');

/* THE FAILURE THIS GUARDS AGAINST: a schedule edited in wrangler.toml's
   [triggers] and not in the vars beside it. Nothing errors — the job simply
   never happens, for months, and the dashboard shows a healthy Worker. */
const orphan = await fire('0 3 * * *');
check('a cron matching no job says so loudly', /matches no job/.test(orphan),
      (orphan.match(/! cron.*/) || ['(said nothing)'])[0].slice(0, 80));
check('and names what the config actually has', /CRON_SYNC=30 20/.test(orphan));

const unconfigured = await fire(CRONS.CRON_SYNC, { ...ENV });
check('so does a cron fired with no CRON_* set at all',
      /matches no job/.test(unconfigured));

console.log(`\n${pass} passed, ${fail} failed`);
done();
process.exit(fail ? 1 : 0);
