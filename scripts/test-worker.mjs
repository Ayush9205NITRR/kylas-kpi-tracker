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

/* THESE TESTS MUST OWN THEIR MOCKS.
   A dev stack left running on 9900/9901 does not fail this suite — it QUIETLY
   PASSES FOR IT. The spawned mock dies on EADDRINUSE (silently, because it is
   spawned with stdio:'ignore'), every request then goes to the stale one, and
   whatever that one has been seeded with becomes the fixture. That happened on
   2026-09-29: a stack seeded with 64 companies made §6b's "a base the sync has
   never filled" fail three checks, identically on code from before the change
   being tested — an hour spent reading a product for a fault that was a port.

   So: refuse to start if anything is already listening, and refuse to continue
   if a mock we spawned is not the one answering. */
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    return false;                       /* answered — somebody is there */
  } catch (e) {
    /* A refused connection is what free looks like. A timeout is not: something
       is listening and simply slow, and treating that as free is the bug. */
    return !/timed out|abort/i.test(e.message);
  }
}

async function mocks() {
  for (const port of [9900, 9901]) {
    if (await portFree(port)) continue;
    console.error(`\n! Port ${port} is already in use — these tests spawn their own mocks and
` +
                  `  cannot share one. A stale dev stack here does not fail the suite, it
` +
                  `  silently becomes the fixture.\n` +
                  `      ss -lptn 'sport = :${port}'   # find it\n` +
                  `      kill <pid>                    # then run this again\n`);
    process.exit(2);
  }
  const k = spawnIt(['scripts/mock-kylas.mjs'], { MOCK_MANY: '4' });
  const a = spawnIt(['scripts/mock-airtable.mjs'], {});
  /* A mock that exits during startup is the failure this guards against, so it
     is watched for rather than waited out. */
  let died = null;
  k.on('exit', (c) => { if (c) died = `mock-kylas exited ${c}`; });
  a.on('exit', (c) => { if (c) died = `mock-airtable exited ${c}`; });
  for (let i = 0; i < 50; i++) {
    if (died) { console.error(`\n! ${died} — see the message it printed above.\n`); process.exit(2); }
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
  nextCallDate: '2026-10-02', nextCallTime: '16:00',
  current: [{ rowKey: 'wk-row-1', eventType: 'Offsite', budget: '8L', timeline: 'Aug, week 2', pax: '40', remarks: '' }],
  /* WHAT THE ASSOCIATE TYPED INTO "Notes from the call". It used to reach
     Airtable and never Kylas — the save took the human half of the remarks
     from the Kylas record it had just read, so the note existed only for
     contacts the mirror holds and vanished for every other one. */
  remarks: 'Wants Goa in March, budget approx 8L.',
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

/* THE TWO FIELDS THAT ONLY EVER REACHED KYLAS AS REMARKS TEXT (Ayush,
   2026-09-29). Both are custom fields whose names differ per account, so what
   is asserted is that the resolver found THIS account's names in the live
   field list and sent the right values under them: the call-back as the date
   the associate picked, and "Aug, week 2" as the quarter Jul-Sep, by its
   picklist id. */
const kw = (await (await fetch('http://127.0.0.1:9900/__writes', { headers: { 'api-key': 'x' } })).json()).writes;
const madeContact = kw.find((w) => w.kind === 'create' && /contacts/.test(w.path || 'contacts'));
const cfSent = madeContact?.body?.customFieldValues || {};
console.log(`   custom fields sent: ${JSON.stringify(cfSent)}`);
check('the call-back date was written back to Kylas', cfSent.cfNextCallDate === '2026-10-02',
      JSON.stringify(cfSent));
check('and the offsite quarter, as the picklist id for Jul-Sep',
      JSON.stringify(cfSent.cfOffsiteTimelineBdNew) === '[9103]', JSON.stringify(cfSent));
check('the stage still goes with them', !!cfSent.cfPipelineStageBd, JSON.stringify(cfSent));
/* THE NOTE REACHES KYLAS, above the auto block. Below it is a machine summary
   the save rewrites every time; a note written there would be destroyed on the
   next save, and a note written nowhere is what used to happen. */
const sentRemarks = String(madeContact?.body?.remarks || '');
check('the typed note reaches Kylas, not just Airtable',
      sentRemarks.includes('Wants Goa in March'), JSON.stringify(sentRemarks).slice(0, 160));
check('...ABOVE the auto block, where the next save will not overwrite it',
      sentRemarks.indexOf('Wants Goa in March') < sentRemarks.indexOf('BD CONSOLE (auto'),
      JSON.stringify(sentRemarks).slice(0, 200));

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
/* Straight to the Airtable mock, retried past its 5-a-second limit as the
   real client does — a test that writes behind the server's back must not
   fail on a 429 the server would have waited out. */
const atPost = async (url, init) => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', ...init });
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
};
const coldWorker = async (n) => (await import(`../worker/index.mjs?cold=${n}`)).default;

/* The privacy policy is the one page anyone can open — the Web Store needs its URL. */
{
  const { readFileSync } = await import('node:fs');
  const served = (await import('../worker/privacy.mjs')).default;
  check('worker/privacy.mjs matches PRIVACY.md (run scripts/gen-privacy.mjs)',
        served === readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8'));
  const pr = await (await coldWorker(0)).fetch(new Request('https://bd.enout.website/privacy'), withStore({ ...ENV, AUTH: 'google' }), {});
  const html = await pr.text();
  check('/privacy is public HTML, no sign-in', pr.status === 200 && /<h1>Privacy policy/.test(html) && !/<script/i.test(html), `status ${pr.status}`);
}

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
/* `on`: a worker other than the shared one. The handlers are built once per
   isolate from the env they first saw, so a run that needs different settings
   needs a cold one (coldWorker). */
const fire = async (cron, env = { ...ENV, ...CRONS }, on = worker) => {
  lines.length = 0;
  const waits = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await on.scheduled({ cron, scheduledTime: Date.now() }, withStore(env),
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
/* THE ENRICHMENT ROW GOES IN BEFORE THE COPY IS BUILT, deliberately. Company
   List is copied from ANOTHER base, and the copy is built once and then kept
   up to date by a delta that only runs ten minutes after the last one on a
   table something is reading. Seeding after the build and firing crons until
   it caught up was a test that passed or failed on how the rate limiter felt
   that minute. The row it asserts is read in section 10. */
await atPost('http://127.0.0.1:9901/v0/appRESEARCH/Company%20List', {
  headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
  /* NOT the contact's own company: section 9 posts its own Company List row
     for that one and reads back the FIRST match, so a second row against the
     same id would shadow it. 1778327 is in the mock and nothing else claims
     it. */
  body: JSON.stringify({ records: [{ fields: { 'Kylas Company Id': '1778327',
    'Account Pipeline Stage': 'LinkedIn Outreach Initiated',
    'linkedin - Appollo': 'https://linkedin.com/company/bbb',
    'Boolean Post link - kylas': 'https://example.com/boolean/bbb',
    'Annual Revenue': [12000000], at_priority: 7 } }] }) });
/* RESEARCH_BASE on the maintenance env, as production has it: without it the
   copy of Company List is built from the KPI base, which does not have that
   table, and every enrichment column reads "—" for the fourth of the four
   reasons /enrich-status exists to tell apart. */
const MAINT_ENV = { ...ENV, ...CRONS, CRON_MAINTAIN: MAINT, RESEARCH_BASE: 'appRESEARCH' };
const maintOut = await fire(MAINT, MAINT_ENV);
check('the maintenance cron runs', /-> maintain/.test(maintOut), maintOut.split('\n')[0]);
/* One table rebuild per run, so no run exceeds Cloudflare's per-invocation
   request cap. Fired until every table is in. */
let runs = 1;
for (; runs < 20; runs++) {
  const c = await get(await coldWorker(19 + runs / 1000), '/cache-status', { RESEARCH_BASE: 'appRESEARCH' });
  if (c.body.mirror?.every((t) => t.built && !t.stale)) break;
  await fire(MAINT, MAINT_ENV);
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
/* ── 9a · asking for a sync ─────────────────────────────────────────── */
/* The ladder counts stage changes, and a change made straight in Kylas becomes
   one only once the sync has seen it — so "Sync now" has to exist. It must NOT
   run the crawl inside the request, which is the "Too many subrequests"
   failure §10 counts every other route against. */
console.log('\n9a. sync now');
{
  const w = await coldWorker(41);
  const a = await post(w, '/sync-now', {});
  check('asking for a sync is accepted', a.status === 200 && a.body.queued === true, JSON.stringify(a.body));
  check('and it is answered immediately, not after a crawl', a.ms < 400, `${a.ms.toFixed(0)}ms`);
  const b = await post(w, '/sync-now', {});
  check('asking twice does not queue two crawls', b.body.alreadyQueued === true, JSON.stringify(b.body));
}

/* ── 9a2 · save → dashboard, measured ──────────────────────────────────
   "It writes Airtable directly" is not a latency. The report memo is keyed on
   the mirror's stamp rather than a TTL, so the question is how long after a
   save the stamp moves and the next read rebuilds — measured here rather than
   asserted, because the number is the thing being promised. */
console.log('\n9a2. how long from a save to the dashboard');
{
  const w = await coldWorker(42);
  const get = async (path) => {
    const held = [];
    const r = await w.fetch(new Request(`https://bd.enout.website${path}`, { headers: { Origin: ORIGIN } }),
      withStore(ENV), { waitUntil: (p) => held.push(p) });
    return { body: await r.json(), settle: () => Promise.allSettled(held) };
  };
  const before = (await get('/report?period=day&owner=all')).body;
  const t0 = performance.now();
  const sv = await post(w, '/save', { contact: { ...contact, lid: 'wk-lat', kid: '', pocName: 'Latency Person',
      phones: [{ type: 'MOBILE', cc: '+91', value: '9800007777', primary: true }] },
    call: { at: new Date().toISOString(), outcome: 'Connected', duration: 20,
            durationSource: 'dialed', createdHere: true } });
  await sv.settle();
  const replied = performance.now() - t0;
  let seen = null, calls0 = before.totals?.calls ?? 0;
  for (let i = 0; i < 60; i++) {
    const r = (await get('/report?period=day&owner=all')).body;
    if ((r.totals?.calls ?? 0) > calls0) { seen = performance.now() - t0; break; }
    await sleep(100);
  }
  console.log(`   save answered in ${replied.toFixed(0)}ms · dashboard showed it ` +
              `${seen === null ? 'NOT WITHIN 6s' : `${seen.toFixed(0)}ms after the save began`}`);
  check('the dashboard shows a console save in well under a minute',
        seen !== null && seen < 15000, seen === null ? 'not within 6s' : `${seen.toFixed(0)}ms`);
}

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
await atPost('http://127.0.0.1:9901/v0/appRESEARCH/Company%20List', {
  headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
  body: JSON.stringify({ records: [{ fields: { 'Kylas Company Id': String(contact.companyId),
    'No. of Employees (kylas)': '51-200', 'Total Funding': [8500000], 'Latest Funding Type': [{ name: 'Series A' }] } }] }) });
const readR = await get(await coldWorker(43), `/research?companyId=${contact.companyId}`, { RESEARCH_BASE: 'appRESEARCH' });
check('the card reads the curated Company List row, flattened',
      readR.body.found && readR.body.fields?.['No. of Employees (kylas)'] === '51-200' &&
      readR.body.fields?.['Total Funding'] === '8500000' && readR.body.fields?.['Latest Funding Type'] === 'Series A' &&
      /airtable\.com\/appRESEARCH\//.test(readR.body.url || ''),
      JSON.stringify(readR.body).slice(0, 160));

/* The Company List's own "Offsite Timeline" (Kylas cfOffsiteTimeline, copied
   by the team's field map) reaches the accounts list too. */
await atPost('http://127.0.0.1:9901/v0/appRESEARCH/Company%20List', {
  headers: { Authorization: 'Bearer x', 'content-type': 'application/json' },
  body: JSON.stringify({ records: [{ fields: { 'Kylas Company Id': '903', 'Offsite Timeline': 'Apr - Jun' } }] }) });
const offList = await get(await coldWorker(44), '/companies?owner=all', { RESEARCH_BASE: 'appRESEARCH' });
const shore = (offList.body.companies || []).find((c) => String(c.id) === '903');
check('the accounts list reads Offsite Timeline from the Company List', shore?.offsite?.includes('APR_JUN'),
      JSON.stringify(shore?.offsite));

/* ENRICHMENT ON THE ROW, AND A WAY TO SEE WHY IT IS NOT.
   Every enrichment column read "—" on production for a week and there was no
   way to tell which of four things was wrong: no PAT or no RESEARCH_BASE, the
   copy of Company List not built yet, a column missing from the projection,
   or a join key that does not match. So the two halves are asserted together —
   the value arriving on the row, and the diagnostic that names the fault when
   it does not. The row itself went in before section 8 built the copy. */
const listRows = ((await get(await coldWorker(44.5), '/cache-status', { RESEARCH_BASE: 'appRESEARCH' }))
  .body.mirror || []).find((t) => t.table === 'Company List')?.rows || 0;
check('Company List is copied from the RESEARCH base, not the KPI one', listRows > 0,
      `${listRows} rows — the copy was built from a base with no such table`);
const enList = await get(await coldWorker(45), '/companies?owner=all&fresh=1', { RESEARCH_BASE: 'appRESEARCH' });
const enriched = (enList.body.companies || []).find((c) => String(c.id) === '1778327');
check('Account Pipeline Stage reaches the accounts list',
      enriched?.enrich?.aps === 'LinkedIn Outreach Initiated', JSON.stringify(enriched?.enrich));
check('...and so do the two links the columns render',
      /linkedin\.com/.test(enriched?.enrich?.li || '') && /boolean/.test(enriched?.enrich?.bp || ''),
      JSON.stringify(enriched?.enrich));

const diag = await get(await coldWorker(46), '/enrich-status', { RESEARCH_BASE: 'appRESEARCH' });
check('/enrich-status says where the enrichment came from and how much joined',
      diag.body.ok && diag.body.enriched > 0 && diag.body.filled?.aps > 0 && diag.body.filled?.li > 0,
      JSON.stringify(diag.body).slice(0, 200));
/* The answer that matters when every cell is a dash: nothing is configured,
   said in one line rather than as an empty table. */
const diagOff = await get(await coldWorker(48), '/enrich-status');
check('...and says so plainly when the research base is not configured',
      diagOff.body.ok === false && /RESEARCH_BASE/.test(diagOff.body.reason || ''),
      JSON.stringify(diagOff.body));

/* "Me" is the signed-in person, matched to the Kylas user with that email —
   not the owner of the server's Kylas key. */
{
  const asUser = async (n, email) => {
    const r = await (await coldWorker(n)).fetch(new Request('https://bd.enout.website/health', {
      headers: { Origin: ORIGIN, 'Cf-Access-Jwt-Assertion': 'x', 'Cf-Access-Authenticated-User-Email': email } }),
      withStore({ ...ENV, AUTH: 'access' }), { waitUntil: () => {} });
    return (await r.json()).user || {};
  };
  const priya = await asUser(45, 'Priya@enout.in');
  check('a signed-in associate is "Me", not the key owner', String(priya.id) === '74726' && priya.kylasMatch === true,
        JSON.stringify(priya));
  const stranger = await asUser(46, 'nobody@enout.in');
  check('an email no Kylas user has owns nothing, and says so', !stranger.id && stranger.kylasMatch === false,
        JSON.stringify(stranger));
}

/* The call-back is saved: on the contact (who is due when) and on the call
   (what was promised on it — follow-up TAT is measured against this). */
{
  const held = [];
  const r = await (await coldWorker(47)).fetch(new Request('https://bd.enout.website/save', {
    method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ contact: { ...contact, nextCallDate: '2026-10-01', nextCallTime: '11:30' },
                           call: { ...call1, at: new Date().toISOString() } }),
  }), withStore(ENV), { waitUntil: (p) => held.push(p) });
  await Promise.allSettled(held);
  let w = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch('http://127.0.0.1:9901/__writes', { headers: { Authorization: 'Bearer x' } });
    if (res.status !== 429) { w = (await res.json()).writes || []; break; }
    await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
  }
  check('a save stores the call-back on the contact and on the call', r.status === 200 &&
        w.some((x) => x.table === 'Contacts' && x.fields?.['Next Call Date'] === '2026-10-01' && x.fields?.['Next Call Time'] === '11:30') &&
        w.some((x) => x.table === 'Call Log' && x.fields?.['Next Call Date'] === '2026-10-01'));
}

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

/* ── 11 · a base that IS synced but holds a fraction of the account ────
   THE ONE THAT REACHED AYUSH. "Has the sync ever run" was the whole test, so
   the first real run — which writes what a Worker invocation can and stops —
   flipped /companies from Kylas' 17,925 to the 120 rows the copy had managed,
   and the console called those 120 "allotted". The copy already knew it was
   short; it said so in the log and served them anyway. */
console.log('\n11. a copy that is short of the account is not the account');
{
  /* A sync record that says Kylas holds far more than the copy does. Upserted
     on Key, the way the sync writes it, so this works whether or not §7 has
     already left one. */
  const SM = 'http://127.0.0.1:9901/v0/appMOCK/Schema%20Migrations';
  const AT_H = { Authorization: 'Bearer x', 'content-type': 'application/json' };
  /* The mock rate-limits at five a second like the real thing, and this runs
     straight after a section that has been writing — so wait it out rather
     than reading a 429 as an answer. */
  const at429 = async (fn) => {
    for (let i = 0; i < 12; i++) {
      const r = await fn();
      if (r.status !== 429) return r;
      await sleep(400);
    }
    throw new Error('mock airtable kept rate limiting');
  };
  /* Written by DELETING every last-sync row and posting one, rather than
     upserting: readSyncState takes the FIRST match, and after §7's real sync
     there can be more than one — an upsert that lands on the second is a note
     nothing reads. */
  const putNote = async (note) => {
    const rows = (await (await at429(() => fetch(SM + '?pageSize=100', { headers: AT_H }))).json()).records || [];
    /* Airtable deletes by query string, not by path — records[]=rec… */
    const ids = rows.filter((x) => x.fields?.Key === 'last-sync').map((x) => x.id);
    if (ids.length)
      await at429(() => fetch(`${SM}?${ids.map((i) => `records[]=${i}`).join('&')}`,
        { method: 'DELETE', headers: AT_H }));
    return at429(() => fetch(SM, { method: 'POST', headers: AT_H, body: JSON.stringify({
      typecast: true,
      records: [{ fields: { Key: 'last-sync', 'Applied At': new Date().toISOString(),
                            Note: JSON.stringify(note) } }] }) }));
  };
  const copyHolds = (await (await at429(() => fetch('http://127.0.0.1:9901/v0/appMOCK/Companies?pageSize=100',
    { headers: AT_H }))).json()).records?.length || 0;
  /* THE SYNC RECORD IS READ THROUGH shared(), WHICH KEEPS IT IN THE STORE.
     §7's real sync left one there, and sweeping the key by name proved
     unreliable — best-effort keys() is documented as such in store.mjs. So
     this section gets a store of its own: everything it asks about lives in
     Airtable, and a fresh store simply means nothing is remembered from
     before. The journal and the queue are not involved here. */
  const freshEnv = { ...ENV, DB: fakeD1() };
  await putNote({ at: new Date().toISOString(), companies: { seen: copyHolds, written: copyHolds },
                  kylas: { reportedTotal: 17925, short: 17925 - copyHolds } });

  /* IDs NOT USED ANYWHERE ELSE IN THIS FILE. coldWorker memoises per query
     string and createHandlers memoises per module, so reusing a number gets a
     module another section has already warmed — including its five-minute
     sync-state cache, which is the one thing this section is about. An hour
     went into that. */
  const r = await (await coldWorker(911)).fetch(
    new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }),
    freshEnv, { waitUntil() {} });
  const b = await r.json();
  check('a copy holding a fraction of the account is NOT served as the account',
        b.source !== 'airtable',
        `source=${b.source} companies=${b.companies?.length} reported=${b.reportedTotal}`);

  /* ...and a copy that is merely a little behind still is, or every read goes
     back to Kylas over three rows. Short by a handful, not by thousands —
     which is the second half of the rule: the fraction AND the absolute gap
     both have to be bad. */
  await putNote({ at: new Date().toISOString(), companies: { seen: copyHolds, written: copyHolds },
                  kylas: { reportedTotal: copyHolds + 3, short: 3 } });
  const r2 = await (await coldWorker(912)).fetch(
    new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }),
    { ...ENV, DB: fakeD1() }, { waitUntil() {} });
  const b2 = await r2.json();
  check('...while one that is a few rows behind still is',
        b2.source === 'airtable', `source=${b2.source} companies=${b2.companies?.length}`);

  /* THE LIVE FAILURE, 2026-09-30. The guard above was deployed and the pane
     still read 136 of 17,925, because the hourly contacts-only sync had left
     reportedTotal null: `expected` came out 0 and the whole check fell
     through, so the copy was served as the account exactly when nothing could
     confirm it was one. A total nobody recorded must send the read to Kylas,
     not wave the copy past. */
  await putNote({ at: new Date().toISOString(), companies: { skipped: 'contacts-only run' },
                  kylas: { reportedTotal: null, served: 0, short: 0, truncated: false } });
  const r3 = await (await coldWorker(913)).fetch(
    new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }),
    { ...ENV, DB: fakeD1() }, { waitUntil() {} });
  const b3 = await r3.json();
  check('a copy that CANNOT be checked is not served as the account either',
        b3.source !== 'airtable',
        `source=${b3.source} companies=${b3.companies?.length} reported=${b3.reportedTotal}`);

  /* THE DEADLOCK UNDER ALL OF IT.
     maintain() rebuilds the Kylas crawl only while "companies-read-at" is
     under two hours old, and that key was written inside the Kylas arm of
     /companies — reached only once the Airtable copy had been refused. So the
     moment the copy started answering, the heartbeat stopped, the crawl was
     never rebuilt, and the fallback the console needs had nothing in it. The
     fallback's supply depended on the fallback already being in use.

     A read served FROM AIRTABLE must still say somebody is looking. */
  await putNote({ at: new Date().toISOString(), companies: { seen: copyHolds, written: copyHolds },
                  kylas: { reportedTotal: copyHolds + 3, short: 3 } });
  const beat = fakeD1();
  const envBeat = { ...ENV, DB: beat };
  const r4 = await (await coldWorker(914)).fetch(
    new Request('https://bd.enout.website/companies?owner=all', { headers: { Origin: ORIGIN } }),
    envBeat, { waitUntil: (p) => p });
  const b4 = await r4.json();
  await new Promise((r) => setTimeout(r, 400));          /* the put is in-flight */
  const readAt = await beat.prepare(
    'SELECT v FROM kv WHERE k = ?').bind('companies-read-at').first().catch(() => null);
  check('...and Airtable answering still records that somebody looked',
        b4.source === 'airtable' && !!readAt,
        `source=${b4.source} companies-read-at=${JSON.stringify(readAt)}`);
  /* LAST ON PURPOSE. It rewrites the sync record and spends its share of the
     mock's five-a-second, and both leaked into whatever followed it — one
     section read /__writes and took a 429 for an answer. */
}


/* ── §12 · handing accounts over ──────────────────────────────────────
   The only path in this codebase that writes a COMPANY. test-replace fenced
   that off entirely until today; these are the checks that replaced the
   fence at the HTTP edge, where the console actually reaches it. */
{
  console.log('\n12. re-assigning accounts');
  /* Kylas' mock `me` is crmadmin@enout.in, which is a default admin — so the
     403 case has to name somebody else as the admin. */
  /* A COLD WORKER, because ADMINS is read once when the module is built.
     Passing ADMIN_EMAILS to the shared worker changes nothing and the check
     passes for the wrong reason — which is exactly what it did first time. */
  const assocEnv = { ...ENV, DB: fakeD1(), ADMIN_EMAILS: 'somebody.else@enout.in' };
  const asAssociate = await (await coldWorker(921)).fetch(
    new Request('https://bd.enout.website/reassign', { method: 'POST', headers:
      { Origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ companies: ['903'], ownerId: '99999' }) }),
    assocEnv, { waitUntil() {} });
  check('an associate cannot re-assign anybody\'s accounts', asAssociate.status === 403,
        `status ${asAssociate.status}`);
  /* ...not even the dry run, which would otherwise report how many contacts
     sit on everybody else's accounts. */
  check('...and the reply says why, not just no',
        /admin/i.test((await asAssociate.json()).error || ''), '');

  /* 99999 owns nothing in the mock, so this is a real move rather than the
     no-op that 74726 would be — a dry run that counts 0 proves nothing. */
  const dry = await call('/reassign', { method: 'POST',
    body: { companies: ['903'], ownerId: '99999' }, env: withStore(ENV) });
  const dj = await dry.json();
  check('an admin gets a dry run', dry.status === 200 && dj.dryRun === true,
        `status ${dry.status} ${JSON.stringify(dj).slice(0, 120)}`);
  check('...that counts a real move', dj.moving === 1 && dj.contacts >= 1,
        JSON.stringify({ moving: dj.moving, contacts: dj.contacts }));
  /* THAT IT WRITES NOTHING is asserted where it can be asserted honestly:
     test-reassign §4 runs plan() against a Kylas that records every write and
     checks the record is empty. Diffing the mock's write log across an HTTP
     call here looked equivalent and was not — the probe was unauthenticated
     and came back "Too many requests", so it compared two error messages and
     called that proof. */
  /* The account's own owner is REPORTED and never written — Kylas accepts a
     company PUT carrying ownerId and drops it, so an earlier version of this
     erased one. The dry run must say whose it is and say plainly that it is
     not going to change. */
  check('...and reports the account owner without moving it',
        dj.accounts?.[0]?.accountOwner === '74726' && dj.accountOwnerMoves === false,
        JSON.stringify({ a: dj.accounts?.[0], moves: dj.accountOwnerMoves }));

  const empty = await call('/reassign', { method: 'POST',
    body: { companies: [], ownerId: '99999' }, env: withStore(ENV) });
  check('no accounts is a 400, not a cheerful no-op', empty.status === 400, `status ${empty.status}`);
  const noOwner = await call('/reassign', { method: 'POST',
    body: { companies: ['903'] }, env: withStore(ENV) });
  check('no owner is a 400 too', noOwner.status === 400, `status ${noOwner.status}`);
}

/* ── §13 · the call-back survives a round trip through Kylas ──────────
   Ayush, 2026-10-04: "next call date is getting wiped — if I set it, the next
   time it does not pull up, rather asks me to assign it again."

   It was never wiped. The save wrote it to Kylas every time, and the
   Kylas -> console mapper returned a hardcoded `nextCallDate: ""`, so a
   contact served from KYLAS rather than from the Airtable copy arrived with
   no promise on it. Every test passed because none of them read the contact
   back through that path with a call-back set. This one does. */
{
  console.log('\n13. the call-back comes back');
  /* Put one on the contact in Kylas directly — the state after a save, or
     after the nightly push, without depending on either. */
  /* RETRY THE 429. The mock throttles at about five a second exactly as Kylas
     does, and it throttles the test's own setup calls too — this one came back
     "Too many requests", the field was never set, and the mapper took the
     blame for it. Third time a 429 has misled this session. */
  let put = null;
  for (let t = 0; t < 8; t++) {
    const x = await fetch('http://127.0.0.1:9900/__setcf?id=112936&key=cfNextCallDate&value=2026-10-09',
      { headers: { 'api-key': 'x' } }).catch(() => null);
    if (x && x.status !== 429) { put = await x.json().catch(() => null); break; }
    await new Promise((r) => setTimeout(r, 400 * (t + 1)));
  }
  /* ARRANGE, ASSERTED. The first version swallowed this with .catch(() => null)
     and then spent a while blaming the mapper for a call-back that had never
     been set. A test's setup is as able to be wrong as the code it tests. */
  check('the call-back is in Kylas to begin with',
        put?.customFieldValues?.cfNextCallDate === '2026-10-09', JSON.stringify(put).slice(0, 120));
  /* READ_SOURCE=kylas, and a COLD worker to carry it — the Airtable copy
     answers this id otherwise and the Kylas mapper, which is the thing under
     test, is never reached. The first version of this test passed through
     Airtable and proved nothing. */
  const kylasOnly = { ...ENV, DB: fakeD1(), READ_SOURCE: 'kylas' };
  const r = await (await coldWorker(931)).fetch(
    new Request('https://bd.enout.website/contact?id=112936', { headers: { Origin: ORIGIN } }),
    kylasOnly, { waitUntil() {} });
  const b = await r.json();
  check('the contact is served from Kylas', r.status === 200 && b.source === 'kylas',
        `status ${r.status} source=${b.source}`);
  /* The assertion that was missing. It reads "" without the fix. */
  check('...carrying the call-back Kylas holds, not a blank',
        b.contact?.nextCallDate === '2026-10-09',
        `nextCallDate=${JSON.stringify(b.contact?.nextCallDate)}`);
}

/* ── 14 · REQ-04 · AND SO DOES THE OFFSITE QUARTER ────────────────────
   The same one-way street, found the same way: `offsiteTimeline: ""` was
   hardcoded in the Kylas mapper, so a quarter somebody set in KYLAS — working
   there rather than in the console — never reached the console. It matters
   less than the call-back did, because the console recomputes the quarter from
   the timeline text and that text round-trips through Airtable; nobody lost
   work. What was invisible was a quarter the console never typed.

   The field is a MULTI picklist, so this sets TWO, which is the shape the read
   side drops one on, and checks the order is the console's rather than the one
   Kylas happened to store them in. */
{
  console.log('\n14. the offsite quarter comes back, both of them');
  let put = null;
  for (let t = 0; t < 8; t++) {
    const u = new URL('http://127.0.0.1:9900/__setcf');
    u.searchParams.set('id', '112936');
    u.searchParams.set('key', 'cfOffsiteTimelineBdNew');
    u.searchParams.set('value', JSON.stringify(['9104', '9103']));   /* Oct-Dec, Jul-Sep */
    const x = await fetch(u, { headers: { 'api-key': 'x' } }).catch(() => null);
    if (x && x.status !== 429) { put = await x.json().catch(() => null); break; }
    await new Promise((r) => setTimeout(r, 400 * (t + 1)));
  }
  /* Arrange, asserted — a swallowed 429 here would blame the mapper again. */
  check('the two quarters are in Kylas to begin with',
        Array.isArray(put?.customFieldValues?.cfOffsiteTimelineBdNew) &&
        put.customFieldValues.cfOffsiteTimelineBdNew.length === 2,
        JSON.stringify(put?.customFieldValues?.cfOffsiteTimelineBdNew));
  const kylasOnly = { ...ENV, DB: fakeD1(), READ_SOURCE: 'kylas' };
  const r = await (await coldWorker(932)).fetch(
    new Request('https://bd.enout.website/contact?id=112936', { headers: { Origin: ORIGIN } }),
    kylasOnly, { waitUntil() {} });
  const b = await r.json();
  check('the contact is served from Kylas', r.status === 200 && b.source === 'kylas',
        `status ${r.status} source=${b.source}`);
  /* Reads "" without the fix. */
  check('...carrying the quarter Kylas holds, not a blank',
        b.contact?.offsiteTimeline === 'JUL_SEP',
        `offsiteTimeline=${JSON.stringify(b.contact?.offsiteTimeline)}`);
  /* The card holds one quarter; the second is carried beside it rather than
     thrown away, so the UI half of REQ-04 has something to render. */
  check('...with the second kept, in the console\'s order',
        JSON.stringify(b.contact?.offsiteTimelineAll) === JSON.stringify(['JUL_SEP', 'OCT_DEC']),
        `offsiteTimelineAll=${JSON.stringify(b.contact?.offsiteTimelineAll)}`);
}

/* ── 15 · THE ACCOUNT STAGE COMES FROM ITS CONTACTS ────────────────────
   Ayush, 2026-10-09: "Account stage galat hai... har account ke contact mein
   aao aur usme joh higher status hai usko pick karo... Not Interested vale
   CNC mein dale hue hai."

   The fixture holds his case exactly. Company 1776620's OWN record in Kylas
   says CNC (Could Not Connect), rung 6. Its two contacts are at MQL (rung 14,
   stored as a picklist id) and Discovery Call Booked (rung 19, stored as the
   code — both shapes turn up in the wild). The highest is 19. The board used
   to file it by the company record whenever no contact had been saved through
   the console — which was almost every account. */
{
  console.log('\n15. the account stage comes from the contacts, not the company record');
  /* ARRANGE, ASSERTED: the disagreement has to be IN the fixture, or every
     check below passes for the wrong reason. The first draft of this looked
     at 903, whose company record holds no stage at all. */
  const coRec = await fetch('http://127.0.0.1:9900/v1/companies/1776620', { headers: { 'api-key': 'x' } })
    .then((r) => r.json()).catch(() => null);
  const coOwn = coRec?.customFieldValues?.cfPipelineStageBd;
  const { stageCode: decode } = await import('./kylas.mjs');
  check('the company record itself says CNC', decode(coOwn) === 'CNC_COULD_NOT_CONNECT',
        `company field = ${JSON.stringify(coOwn)} -> ${decode(coOwn)}`);

  /* The index may already exist — the maintenance runs in section 7 build it
     on the first run that does no other big work. So ask the server whether
     it is built, and only fire the cron if it is not. Looking for a log line
     was the first draft, and it missed an index built two sections earlier. */
  const status = async () => (await get(await coldWorker(1500 + Math.random()), '/cache-status',
    { RESEARCH_BASE: 'appRESEARCH' })).body.contactStages;
  let cs = await status();
  for (let i = 0; i < 12 && !cs; i++) { await fire(MAINT, MAINT_ENV); cs = await status(); }
  check('the contact index is built', !!cs, JSON.stringify(cs));
  check('...from every Kylas contact', cs?.contacts > 0, `${cs?.contacts} contacts, ${cs?.accounts} accounts`);

  const r = await get(await coldWorker(1501), '/companies?owner=all', { RESEARCH_BASE: 'appRESEARCH' });
  const list = r.body.companies || [];
  const seats = list.find((c) => String(c.id) === '1776620');
  check('1776620 is on the list', !!seats);
  /* THE ASSERTION. Without the index this reads the company record's CNC. */
  check('1776620 is NOT filed under the company record\'s CNC',
        seats?.acctStage && !/^CNC/.test(seats.acctStage), `acctStage=${JSON.stringify(seats?.acctStage)}`);
  check('...it is the highest of its contacts: Discovery Call Booked, rung 19',
        seats?.acctRung >= 19, `acctStage=${seats?.acctStage} rung=${seats?.acctRung}`);
  /* Counted from the mock rather than written in: earlier sections SAVE
     contacts onto this company, so "two" was true of the fixture and false
     of the suite by the time it gets here. */
  /* RETRY THE 429, and assert the read worked. The first version of this
     took a throttled reply as "Kylas holds 0" — the fourth time a swallowed
     429 has dressed itself up as a finding in this suite. */
  let all = null;
  for (let t = 0; t < 8 && !all; t++) {
    const x = await fetch('http://127.0.0.1:9900/v1/search/contact?page=0&size=200', {
      method: 'POST', headers: { 'api-key': 'x', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: ['id', 'company'], jsonRule: { condition: 'AND', valid: true, rules: [
        { id: 'multi_field', field: 'multi_field', type: 'multi_field', input: 'multi_field', operator: 'multi_field', value: '' }] } }),
    }).catch(() => null);
    if (x && x.ok) all = await x.json().catch(() => null);
    else await new Promise((r) => setTimeout(r, 400 * (t + 1)));
  }
  check('the mock\'s contact list could be read to count against', Array.isArray(all?.content),
        all ? `${all.content?.length} rows` : 'every attempt failed');
  const coOf = (c) => String(c?.company?.id ?? c?.company ?? '');
  const want = (all?.content || []).filter((c) => coOf(c) === '1776620').length;
  check('...worked out from every one of its contacts', want > 0 && seats?.acctN === want,
        `acctN=${seats?.acctN}, Kylas holds ${want}`);

  /* SQL is rung 26. The company-field fallback drew a column reading "SQL
     ... rung 0 of 26" because the company picklist's ids are not the
     contacts'. From the contact, it is 26. */
  const co903 = list.find((c) => String(c.id) === '903');
  check('903, whose contact is SQL, is SQL at rung 26 — not rung 0',
        co903?.acctStage === 'SQL_SALES_QUALIFIED_LEAD' && co903?.acctRung === 26,
        `acctStage=${co903?.acctStage} rung=${co903?.acctRung}`);

  /* An account with no contacts at all gets NO stage — not the company
     record's, which is the fallback that put Not Interested accounts in CNC. */
  const bare = list.filter((c) => c.acctN === 0);
  check('accounts with no contacts are marked as such', bare.length > 0, `${bare.length} of ${list.length}`);
  check('...and none of them is handed a stage', bare.every((c) => !c.acctStage),
        bare.filter((c) => c.acctStage).slice(0, 3).map((c) => `${c.id}=${c.acctStage}`).join(', '));
  /* acctN on every row is the console's cue to stop falling back to the
     company field. */
  check('every row carries acctN', list.length > 0 && list.every((c) => c.acctN != null),
        `${list.filter((c) => c.acctN == null).length} without`);
}

/* ── 15b · THE DAILY FULL CRAWL WAITS FOR THE EVENING ──────────────────
   Ayush, 2026-10-10: "API rate limits are getting hit... (8 users)". The full
   rebuild reads every Kylas contact back to back, and "a day since the last"
   put it in the calling day. It is held to the quiet hours; a stale index in
   the day gets a delta instead. Both windows are set relative to NOW, so the
   test means the same thing whatever hour it runs at. */
{
  console.log('\n15b. the full contact crawl keeps out of calling hours');
  const h = Math.floor((((Date.now() / 60000 + 330) % 1440) + 1440) % 1440 / 60);
  const runWith = async (from, to) => {
    const env = { ...MAINT_ENV, CONTACT_STAGES_FULL_MS: '1', CONTACT_STAGES_DELTA_MS: '0',
                  CONTACT_STAGES_QUIET_FROM: String(from), CONTACT_STAGES_QUIET_TO: String(to) };
    const w = await coldWorker(1520 + Math.random());
    for (let i = 0; i < 6; i++) {
      const out = await fire(MAINT, env, w);
      const m = out.match(/contact stages: (full|delta)/);
      if (m) return m[1];
    }
    return 'never ran';
  };
  const day = await runWith((h + 2) % 24, (h + 3) % 24);
  check('a day-old index in calling hours gets a delta, not a full crawl', day === 'delta', day);
  const night = await runWith(h, (h + 1) % 24);
  check('...and the full crawl runs once it is quiet', night === 'full', night);
}

/* ── 15c · "FRESH" CANNOT ASK FOR A CRAWL A MINUTE ─────────────────────
   Consoles before 1.57 sent ?fresh=1 on every save made with the accounts
   view open, and each one queued a crawl of every company in Kylas for the
   next minute's run. With eight people saving, that was a crawl a minute
   while they called. The server now redoes it at most every ten minutes. */
{
  console.log('\n15c. a burst of "fresh" asks does not crawl Kylas every minute');
  const crawled = (out) => /companies crawl:/.test(out);
  /* LIVE, the list is served from Kylas — the Airtable copy holds 298 of
     17,925 companies, too short to be the account — and that is what keeps
     the crawl going. Here the copy serves, so the store is told what live
     looks like: somebody read the list from Kylas a moment ago, and asked
     for it fresh — which on that path is what ?fresh=1 records. */
  const asLive = async () => {
    await store.put('companies-read-at', String(Date.now()), { ttlSeconds: 3600 });
    await store.put('companies-want-fresh', '1', { ttlSeconds: 3600 });
  };
  await asLive();
  let first = '';
  const w0 = await coldWorker(1560);
  for (let i = 0; i < 4 && !crawled(first); i++) first = await fire(MAINT, { ...MAINT_ENV, COMPANY_FRESH_FLOOR_MS: '0' }, w0);
  check('Refresh still crawls when the list is old enough', crawled(first),
        first.split('\n').filter((l) => /compan/.test(l)).slice(0, 2).join(' | '));
  let again = 0;
  for (let i = 0; i < 3; i++) {
    await asLive();
    if (crawled(await fire(MAINT, MAINT_ENV, await coldWorker(1570 + i)))) again++;
  }
  check('...but three more asks inside ten minutes crawl nothing', again === 0, `${again} crawl(s)`);
}

/* ── 15d · MANY ACCOUNTS ONTO A FOCUS LIST AT ONCE ─────────────────────
   Ayush, 2026-10-10: "bulk focus — every owner can do the same". One request,
   ten rows an Airtable call, and a ceiling on how many one request may carry. */
{
  console.log('\n15d. bulk add to focus');
  const w = await coldWorker(1580);
  const items = [{ companyId: '1776620', companyName: 'seats', ownerName: 'Enout Super Admin' },
                 { companyId: '1778327', companyName: 'bbb', ownerName: 'Enout Super Admin' }];
  const r = await post(w, '/focus', { status: 'focus', items, setBy: 'ayush@enout.in' });
  check('a bulk add answers', r.status === 200 && r.body.ok, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check('...and wrote both', r.body.written === 2, `written ${r.body.written}`);
  const read = await get(await coldWorker(1581), '/focus');
  check('...which read back as on a focus list', ['1776620', '1778327'].every((id) => read.body.focus?.[id]?.status === 'focus'),
        JSON.stringify(Object.keys(read.body.focus || {})));
  const big = await post(w, '/focus', { status: 'focus', items: Array.from({ length: 251 }, (_, i) => ({ companyId: String(9000 + i) })) });
  check('more than the ceiling is refused, not half-written', big.status === 400, `${big.status} ${big.body.error || ''}`);
  const depri = await post(w, '/focus', { status: 'depri', items });
  check('bulk is for adding only — dropping is one at a time, with a reason', depri.status === 400, `${depri.status}`);
}

/* ── 16 · TWO ISOLATES, ONE INDEX ────────────────────────────────────
   Cloudflare runs several isolates, each with its own memory. If a save is
   noted onto the copy an isolate happened to be holding, an isolate that
   loaded the index earlier writes its OLD copy back over every save the
   others noted since. Here: isolate A reads the index, B notes a new contact,
   then A notes another. Both must survive. */
{
  console.log('\n16. two isolates noting saves into one index do not erase each other');
  const A = await coldWorker(1601), B = await coldWorker(1602);
  const countNow = async () => (await get(await coldWorker(1600 + Math.random()), '/companies?owner=all',
    { RESEARCH_BASE: 'appRESEARCH' })).body.companies?.find((c) => String(c.id) === '1776620')?.acctN;
  /* A takes its copy into memory. */
  await get(A, '/companies?owner=all', { RESEARCH_BASE: 'appRESEARCH' });
  const start = await countNow();
  const saveOn = async (w, lid, name, phone) => {
    const r = await post(w, '/save', { contact: { ...contact, kid: '', lid, pocName: name,
      phones: [{ type: 'MOBILE', cc: '+91', value: phone, primary: true }] } });
    await r.settle();
    return r.status;
  };
  const sb = await saveOn(B, 'wk-iso-b', 'Isolate Bee', '9800007701');
  const sa = await saveOn(A, 'wk-iso-a', 'Isolate Ay', '9800007702');
  check('both saves went through', sb === 200 && sa === 200, `B ${sb}, A ${sa}`);
  const end = await countNow();
  /* Without the fresh read, A writes back the copy it loaded before B's save
     and the count rises by one, not two. */
  check('the account gained BOTH new contacts, not just the last isolate\'s',
        end === start + 2, `${start} -> ${end}`);
}

/* ── 17 · WHAT WAS SAID ON EARLIER CALLS ─────────────────────────────
   Ayush, 2026-10-09: "Previous remarks fetch nahi ho rahe hai." The update
   after a call is typed on the call log, in Kylas' dialler or in this console,
   and the strip only ever read the contact's remarks field. /history reads the
   call logs. The fixture has one earlier call on Hema (112936), typed in Kylas
   as HTML. */
{
  console.log('\n17. previous call notes come back from the Kylas call logs');
  const h1 = await get(await coldWorker(1701), '/history?id=112936');
  const items = h1.body.items || [];
  check('/history answers', h1.status === 200, `status ${h1.status} ${h1.body.error || ''}`);
  check('...with the note typed on the earlier call, as text', items.some((x) => /Goa, 2 nights/.test(x.text) && !/<div>/.test(x.text)),
        JSON.stringify(items[0]?.text || null).slice(0, 90));
  check('...dated, so the strip can say when it was said', !!items[0]?.at, items[0]?.at);
  /* Ayush, 2026-10-10: "Previous Notes — pull it from cfRemarks". The card is
     usually served from the Airtable copy, which never had it, so it rides
     here, read from Kylas with the call logs. */
  check('...and the contact\'s Remarks custom field, as text', /budget sits with the CFO/.test(h1.body.remarks || '')
        && !/<p>/.test(h1.body.remarks || ''), JSON.stringify(h1.body.remarks || null).slice(0, 90));

  /* A save writes a new call log with its note; the next /history on the SAME
     instance must include it, not serve the copy cached before the call. */
  const w = await coldWorker(1702);
  await get(w, '/history?id=112936');                         /* cache it */
  const sv = await post(w, '/save', { contact: { ...contact, kid: '112936', lid: 'wk-hist',
    pocName: 'Hema Bharathi', current: [{ rowKey: 'wk-h-row', eventType: 'Offsite', budget: '', timeline: '',
      pax: '', remarks: 'Asked for two venue options' }] },
    call: { ...call1, at: new Date().toISOString(), note: 'Asked for two venue options' } });
  await sv.settle();
  const h2 = await get(w, '/history?id=112936');
  check('a call saved just now is in the next look, not hidden behind the cache',
        (h2.body.items || []).some((x) => /two venue options/.test(x.text)),
        (h2.body.items || []).map((x) => x.text.slice(0, 30)).join(' | '));
  check('...newest first', /two venue options/.test(h2.body.items?.[0]?.text || ''), h2.body.items?.[0]?.text);
  /* A Kylas failure is an empty history, never a failed request. */
  const bad = await get(await coldWorker(1703), '/history?id=999999999');
  check('a contact with no calls is an empty history, not an error', bad.status === 200 && Array.isArray(bad.body.items),
        `status ${bad.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
done();
process.exit(fail ? 1 : 0);
