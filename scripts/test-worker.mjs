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
import { d1Store } from './store.mjs';
import { fakeD1 } from './d1-fake.mjs';

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
   process.env anywhere. DB is real SQLite behind D1's interface (d1-fake.mjs),
   so the journal and the D1 copy of Airtable run their actual SQL here. */
const db = fakeD1();
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
   to live is how a lost reply duplicates a contact. */
const withStore = (env) => ({ ...env, DB: db });
const store = d1Store(db);

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

/* ── 6b · a base the sync never filled ───────────────────────────────── */
/* The console writes a company into Airtable on its first save there, so an
   unsynced base is never quite empty — and "not empty" used to be enough for
   its handful of rows to be served as the whole company list. */
console.log('\n6b. a base the Kylas sync has never filled');
const unsynced = await (await coldWorker(3)).fetch(
  new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }),
  withStore(ENV), { waitUntil() {} });
const unsyncedBody = await unsynced.json();
/* The crawl is never run inside a request — past Kylas' result window it is
   over a hundred requests, which Cloudflare's Free plan refuses in one
   invocation ("Too many subrequests"). The first answer says it is building. */
check('does not crawl Kylas inside the request; says the list is being built',
      unsynced.status === 200 && unsyncedBody.building === true && unsyncedBody.source !== 'airtable',
      `${unsynced.status} building=${unsyncedBody.building} companies=${unsyncedBody.companies?.length}`);
check('and says the background job has not run yet, so the console can say why',
      unsyncedBody.lastRunSecondsAgo === null && unsyncedBody.crawlError === null,
      `lastRun=${unsyncedBody.lastRunSecondsAgo} error=${JSON.stringify(unsyncedBody.crawlError)}`);
const CR = { CRON_SYNC: '30 20 * * *', CRON_SNAPSHOT: '45 18 * * *', CRON_ROLLUP: '0 21 * * 0', CRON_MAINTAIN: '*/5 * * * *' };
const firstRun = [];
await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, withStore({ ...ENV, ...CR }),
  { waitUntil: (p) => firstRun.push(p) });
await Promise.allSettled(firstRun);
for (let i = 0; i < 100; i++) {           /* the crawl runs in waitUntil; wait for it to land */
  const r = await (await coldWorker(4 + i / 1000)).fetch(
    new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }), withStore(ENV), { waitUntil() {} });
  const b = await r.json();
  if (!b.building) {
    check('the next maintenance run builds it, and the list comes from Kylas',
          b.source !== 'airtable' && b.companies.length > 1, `source=${b.source || 'kylas'} companies=${b.companies.length}`);
    break;
  }
  if (i === 99) check('the next maintenance run builds it', false, 'still building');
  await sleep(200);
}

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

/* ── 8 · reads that never wait on Airtable ───────────────────────────── */
/* Every screen is computed from whole Airtable tables, and on Cloudflare every
   request can land on a fresh instance holding nothing — so "open the
   dashboard" re-read those tables page by page, or (1.14) waited for whoever
   rebuilt a cached copy. The tables live in D1 now, kept current by the
   maintenance cron and by every write this server makes. */
console.log('\n8. the D1 copy of Airtable');
/* The mock rate-limits like Airtable, so the counter is asked until it answers. */
const reads = async () => {
  for (let i = 0; i < 20; i++) {
    const r = await fetch('http://127.0.0.1:9901/__reads', { headers: { Authorization: 'Bearer x' } });
    if (r.ok) return (await r.json()).reads;
    await sleep(250);
  }
  throw new Error('the mock never reported its read count');
};
const get = async (w, path, extra = {}) => {
  const held = [];
  const r = await w.fetch(new Request(`https://bd.enout.website${path}`, { headers: { Origin: ORIGIN } }),
                          withStore({ ...ENV, ...extra }), { waitUntil: (p) => held.push(p) });
  const body = await r.json();
  await Promise.allSettled(held);
  return { status: r.status, body };
};
const MAINT = '*/5 * * * *';
const maintOut = await fire(MAINT, { ...ENV, ...CRONS, CRON_MAINTAIN: MAINT });
check('the maintenance cron runs', /-> maintain/.test(maintOut), maintOut.split('\n')[0]);
/* One table rebuild per run, so no run exceeds Cloudflare's per-invocation
   request cap. Fired until every table is in. */
let runs = 1;
for (; runs < 20; runs++) {
  const c = await get(await coldWorker(19 + runs / 1000), '/cache-status');
  if (c.body.mirror?.every((t) => t.built && !t.stale)) break;
  await fire(MAINT, { ...ENV, ...CRONS, CRON_MAINTAIN: MAINT });
}
check('tables are copied one per run, not all at once', runs >= 5 && runs < 20, `${runs} runs`);
const cs = await get(await coldWorker(20), '/cache-status');
check('every mirrored table is in D1', cs.status === 200 && cs.body.mirror.every((t) => t.built),
      JSON.stringify(cs.body.mirror?.filter((t) => !t.built).map((t) => t.table)));
check('and the sync that ran in section 7 is on record', !!cs.body.syncedAt, cs.body.syncedAt);

const REPORT = '/report?period=week&owner=all';
let r0 = await reads();
const rep1 = await get(await coldWorker(21), REPORT);
check('a cold instance computes the dashboard with NO Airtable read',
      rep1.status === 200 && (await reads()) === r0, `${rep1.status}, ${(await reads()) - r0} reads`);
const rep2 = await get(await coldWorker(22), REPORT);
check('so does the next one, with the same numbers',
      (await reads()) === r0 && JSON.stringify(rep2.body.totals) === JSON.stringify(rep1.body.totals));

const held = [];
const saved = await (await coldWorker(23)).fetch(new Request('https://bd.enout.website/save', {
  method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify({ contact, call: { ...call1, at: new Date().toISOString() } }),
}), withStore(ENV), { waitUntil: (p) => held.push(p) });
await Promise.allSettled(held);
check('a save answers', saved.status === 200, `${saved.status}`);
r0 = await reads();
const rep3 = await get(await coldWorker(24), REPORT);
check('the call saved on one instance is in the next report from ANOTHER',
      rep3.body.totals?.calls === rep1.body.totals?.calls + 1,
      `${rep1.body.totals?.calls} -> ${rep3.body.totals?.calls}`);
check('and that report still read nothing from Airtable', (await reads()) === r0, `${(await reads()) - r0} reads`);

const synced = await get(await coldWorker(25), '/companies?owner=all');
check('once the sync has run, the company list comes from the copy',
      synced.body.source === 'airtable' && (await reads()) === r0,
      `source=${synced.body.source}, ${(await reads()) - r0} reads`);

/* ── 9 · saves answered before Kylas and Airtable have them ──────────── */
/* A save waits its turn at two rate-limited APIs — about 3.5 s live. A
   console that asks for it ({queue: true}) is answered once the save is in
   D1, and the rest runs behind the reply. */
console.log('\n9. queued saves');
const kylasWrites = async () =>
  (await (await fetch('http://127.0.0.1:9900/__writes', { headers: { 'api-key': 'x' } })).json()).writes;
const post = async (w, path, body) => {
  const heldQ = [];
  const t = performance.now();
  const r = await w.fetch(new Request(`https://bd.enout.website${path}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), withStore(ENV), { waitUntil: (p) => heldQ.push(p) });
  const ms = performance.now() - t;
  return { status: r.status, body: await r.json(), ms, settle: () => Promise.allSettled(heldQ) };
};
const qContact = { ...contact, lid: 'wk-q1', pocName: 'Queued Person',
  phones: [{ type: 'MOBILE', cc: '+91', value: '9800009991', primary: true }],
  current: [{ rowKey: 'wk-q-row', eventType: 'Offsite', budget: '5L', timeline: '', pax: '', remarks: '' }] };
const before9 = (await kylasWrites()).length;
/* Two saves of the same brand-new contact, on two instances, back to back —
   the case that duplicates a contact if the queue does not keep them in order. */
const qa = await post(await coldWorker(30), '/save', { contact: qContact, call: { ...call1, at: new Date().toISOString() }, queue: true });
const qb = await post(await coldWorker(31), '/save', { contact: qContact, call: { ...call1, at: new Date(Date.now() + 1000).toISOString() }, queue: true });
check('a queued save is answered without waiting for Kylas', qa.status === 200 && qa.body.queued && !!qa.body.job,
      `${qa.status} ${Math.round(qa.ms)}ms ${JSON.stringify(qa.body).slice(0, 80)}`);
await Promise.all([qa.settle(), qb.settle()]);
/* The second may have been held behind the first; the maintenance run is what
   picks up anything a reply's background time did not finish. */
await fire(MAINT, { ...ENV, ...CRONS, CRON_MAINTAIN: MAINT });
const st9 = await get(await coldWorker(32), `/save-status?ids=${qa.body.job},${qb.body.job}`);
const ja = st9.body.jobs?.[qa.body.job], jb = st9.body.jobs?.[qb.body.job];
check('both saves are done', ja?.state === 'done' && jb?.state === 'done', JSON.stringify(st9.body).slice(0, 200));
check('the status carries the Kylas id a direct save would have returned', !!ja?.result?.kid, ja?.result?.kid);
const creates = (await kylasWrites()).slice(before9).filter((w) => w.kind === 'create' &&
  JSON.stringify(w.body).includes('Queued'));
check('the contact was created in Kylas exactly once', creates.length === 1 && jb?.result?.kid === ja?.result?.kid,
      `${creates.length} create(s), kids ${ja?.result?.kid} / ${jb?.result?.kid}`);
const refused = await post(await coldWorker(33), '/save', { contact: { ...qContact, lid: 'wk-q2', kid: '', phones: [] }, queue: true });
check('a save Kylas would refuse is refused now, not queued', refused.status === 422 && !refused.body.queued,
      `${refused.status} ${refused.body.error?.slice(0, 60)}`);
const legacy = await post(await coldWorker(34), '/save', { contact: { ...qContact, lid: 'wk-q3', pocName: 'Legacy Person',
  phones: [{ type: 'MOBILE', cc: '+91', value: '9800009993', primary: true }] }, call: { ...call1, at: new Date().toISOString() } });
check('an older console (no queue flag) still gets the finished save', legacy.status === 200 && !legacy.body.queued && !!legacy.body.kid,
      JSON.stringify(legacy.body).slice(0, 80));

/* ── 9b · offsite timeline, derived from the event rows ─────────────── */
/* Nobody types it. The contact's offsite row says "Q3", so the company's
   offsite timeline is Jul–Sep — read out of Event Rows, not a column of its
   own that a base behind on repair-base would refuse. */
console.log('\n9b. offsite timeline, derived');
const heldO = [];
const offRes = await (await coldWorker(36)).fetch(new Request('https://bd.enout.website/save', {
  method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify({ contact, call: { ...call1, at: new Date().toISOString() } }),
}), withStore(ENV), { waitUntil: (p) => heldO.push(p) });
await Promise.allSettled(heldO);
const atWrites = (await (await fetch('http://127.0.0.1:9901/__writes', { headers: { Authorization: 'Bearer x' } })).json()).writes;
check('a save writes no Offsite Timeline column', offRes.status === 200 &&
      !atWrites.some((w) => w.fields && 'Offsite Timeline' in w.fields));
const offCos = await get(await coldWorker(37), '/companies?owner=all');
const seats = (offCos.body.companies || []).find((c) => String(c.id) === String(contact.companyId));
check('the accounts list derives Jul–Sep from the row\'s "Q3"', seats?.offsite?.includes('JUL_SEP'),
      JSON.stringify(seats?.offsite));

/* ── 9c · focus lists and research, read and written ─────────────────── */
console.log('\n9c. focus lists and research');
const setF = await post(await coldWorker(38), '/focus', { companyId: String(contact.companyId), companyName: 'Seats',
  status: 'depri', reason: 'Too small / not a fit', note: 'one office', ownerName: 'Shreya', setBy: 'test' });
check('a BD can deprioritize an account, with a reason', setF.status === 200 && setF.body.ok, JSON.stringify(setF.body).slice(0, 80));
const readF = await get(await coldWorker(39), '/focus');
const fe = readF.body.focus?.[String(contact.companyId)];
check('and the console reads it back', fe?.status === 'depri' && fe?.reason === 'Too small / not a fit', JSON.stringify(fe));
await post(await coldWorker(40), '/focus', { companyId: String(contact.companyId), status: 'normal', previous: 'depri' });
const readF2 = await get(await coldWorker(41), '/focus');
check('Restore takes it off the list', !readF2.body.focus?.[String(contact.companyId)], JSON.stringify(readF2.body.focus));
/* Research is the team's curated Company List (another base), read-only. */
await fetch('http://127.0.0.1:9901/v0/appRESEARCH/Company%20List', { method: 'POST',
  headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
  body: JSON.stringify({ records: [{ fields: { 'Kylas Company Id': String(contact.companyId),
    'No. of Employees (kylas)': '51-200', 'Total Funding': [8500000], 'Latest Funding Type': [{ name: 'Series A' }] } }] }) });
const readR = await get(await coldWorker(43), `/research?companyId=${contact.companyId}`, { RESEARCH_BASE: 'appRESEARCH' });
check('the card reads the curated Company List row, flattened',
      readR.body.found && readR.body.fields?.['No. of Employees (kylas)'] === '51-200' &&
      readR.body.fields?.['Total Funding'] === '8500000' && readR.body.fields?.['Latest Funding Type'] === 'Series A' &&
      /airtable\.com\/appRESEARCH\//.test(readR.body.url || ''),
      JSON.stringify(readR.body).slice(0, 160));

/* ── 10 · every request stays inside Cloudflare's per-invocation cap ───── */
/* Cloudflare counts every outside request AND every database query an
   invocation makes, and refuses past a cap: 50 on the Free plan. The Kylas
   company crawl inside /companies passed it on a real account ("Too many
   subrequests by single Worker invocation"). Each console request, on a cold
   instance, is counted here and held under the Free cap — so the console works
   whatever the plan, and the heavy work is the scheduled job's alone. */
console.log('\n10. requests per invocation (Cloudflare Free plan allows 50)');
const realFetch = globalThis.fetch;
let outside = 0;
globalThis.fetch = (u, ...a) => { if (/127\.0\.0\.1:99/.test(String(u))) outside++; return realFetch(u, ...a); };
const cost = async (n, method, path, body) => {
  const w = await coldWorker(40 + n);
  const heldC = [];
  const q0 = db.queries(), o0 = outside;
  const r = await w.fetch(new Request(`https://bd.enout.website${path}`, {
    method, headers: { Origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined }), withStore(ENV), { waitUntil: (p) => heldC.push(p) });
  await r.text();
  await Promise.allSettled(heldC);
  return { status: r.status, n: (db.queries() - q0) + (outside - o0), d1: db.queries() - q0, out: outside - o0 };
};
const ROUTES = [
  ['GET', '/health'], ['GET', '/meta'], ['GET', '/companies?owner=all'], ['GET', '/companies?owner=all&fresh=1'],
  ['GET', '/report?period=month&owner=all'], ['GET', '/report?period=week&owner=74725'],
  ['GET', '/queue?owner=74725'], ['GET', '/company?id=1776620'], ['GET', '/rca'], ['GET', '/team'],
  ['GET', '/snapshots?days=60'], ['GET', '/cache-status'], ['GET', '/users'],
  ['POST', '/save', { contact: { ...qContact, lid: 'wk-cost', pocName: 'Cost Person',
    phones: [{ type: 'MOBILE', cc: '+91', value: '9800009995', primary: true }] },
    call: { ...call1, at: new Date().toISOString() }, queue: true }],
];
let worst = { n: 0 };
for (let i = 0; i < ROUTES.length; i++) {
  const [m, p, b] = ROUTES[i];
  const c = await cost(i, m, p, b);
  if (c.n > worst.n) worst = { ...c, path: p };
  check(`${m} ${p.split('?')[0]}${p.includes('fresh') ? ' (Refresh)' : ''} — ${c.n} (${c.out} outside, ${c.d1} database)`,
        c.status === 200 && c.n <= 50, `status ${c.status}`);
}
const q0m = db.queries(), o0m = outside;
await fire(MAINT, { ...ENV, ...CRONS, CRON_MAINTAIN: MAINT });
console.log(`   worst request: ${worst.path} at ${worst.n}; one maintenance run: ${(db.queries() - q0m) + (outside - o0m)}`);
globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
done();
process.exit(fail ? 1 : 0);
