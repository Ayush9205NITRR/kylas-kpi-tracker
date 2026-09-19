#!/usr/bin/env node
/* What happens when the Airtable base is one repair-base behind the code.
 *
 *   node scripts/test-behind-base.mjs
 *
 * Starts its own mock Kylas, mock Airtable and proxy on 9900/9901/8787, so it
 * needs no key and touches nothing real. Exits non-zero on the first failure.
 *
 * TWO FAILURES, ONE CAUSE — a column the writer knows about and the base does
 * not.
 *
 *   1. THE SAVE. Airtable rejects a whole record for one unrecognised field
 *      name, so the day `Phones` was added to syncContact, every save against
 *      an un-repaired base threw at step 3 — the contact — and never reached
 *      the event rows, the call log or the stage transition. An afternoon of
 *      dialling went into the outbox as a 422, which the outbox correctly
 *      refuses to retry. Ayush lost exactly this and reported it as "why is
 *      previous logged info not available here".
 *
 *   2. THE FUNNEL. First Worked At and First Picked At only started being
 *      written recently, and they are written ONCE, on a save — so every
 *      contact worked before then has no date and the ladder's bottom two
 *      rungs read zero under a Right POC count that does not. That is
 *      migrate-first-worked.mjs, exercised here end to end against seeded
 *      history.
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/* The journal outlives the process on purpose — it is what stops a lost reply
   creating a contact twice. It also outlives a TEST run, so a second run would
   recognise these lids and try to UPDATE contacts a restarted mock Kylas has
   never heard of. Start from nothing. */
if (existsSync(REPO + '/.save-journal.json')) unlinkSync(REPO + '/.save-journal.json');
const AT = 'http://127.0.0.1:9901';
const ENV = { KYLAS_BASE:'http://127.0.0.1:9900', KYLAS_KEY:'x',
  AIRTABLE_BASE_URL:AT, AIRTABLE_PAT:'pat_mock', AIRTABLE_BASE:'appMOCK', PORT:'8787' };

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const kids = [];
const spawnIt = (args, env) => { const p = spawn('node',args,{cwd:REPO,env:{...process.env,...env},stdio:'ignore'}); kids.push(p); return p; };

let proxy = null, mockAt = null, mockKy = null;
async function upMocks(nofield) {
  mockKy = spawnIt(['scripts/mock-kylas.mjs'], { MOCK_MANY:'4' });
  /* The missing column is configured on the MOCK, because that is where a
     base's schema lives in this stack. Restarting it is how the column comes
     back — which is also what running repair-base does. */
  mockAt = spawnIt(['scripts/mock-airtable.mjs'], nofield ? { MOCK_AIRTABLE_NOFIELD:nofield } : {});
  for(let i=0;i<50;i++){ try{ await fetch(`${AT}/v0/appMOCK/Contacts`,{headers:{Authorization:'Bearer x'}}); break; }catch{} await sleep(300); }
  for(let i=0;i<50;i++){ try{ await fetch('http://127.0.0.1:9900/__writes',{headers:{'api-key':'x'}}); return; }catch{} await sleep(300); }
  throw new Error('mocks never came up');
}
async function upProxy() {
  proxy = spawnIt(['scripts/proxy.mjs'], ENV);
  for(let i=0;i<50;i++){ try{ if((await fetch('http://127.0.0.1:8787/health')).ok) return; }catch{} await sleep(300); }
  throw new Error('proxy never came up');
}
const kill = (p)=>{ try{ p?.kill('SIGKILL'); }catch{} };
async function downAll(){ [proxy,mockAt,mockKy].forEach(kill); proxy=mockAt=mockKy=null; await sleep(600); }

/* The mock 429s above 5 req/s and the inspection hook is not exempt, so ask
   again rather than reading `undefined` as "the table is empty" — which is the
   429-as-end-of-data mistake in its smallest form. */
const tables = async () => {
  for (let i=0;i<10;i++){
    const j = await (await fetch(`${AT}/__writes`,{headers:{Authorization:'Bearer x'}})).json();
    if (j.tables) return j.tables;
    await sleep(400);
  }
  throw new Error('the mock never returned its tables');
};
const rows = async (t) => (await tables())[t] || [];

const save = (contact, call) =>
  fetch('http://127.0.0.1:8787/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({contact,call})})
    .then(async r=>{ const j=await r.json(); if(!r.ok) throw Object.assign(new Error(j.error||r.status),{status:r.status}); return j; });

const contact = (name, lid, phone) => ({
  lid, kid:'', pendingCreate:true, pocName:name, companyId:'1776620', company:'seats',
  owner:'Enout Super Admin', ownerId:74725, designation:'Ops',
  phones:[{type:'MOBILE',cc:'+91',value:phone,primary:true}], emails:[],
  stage:'MQL_MARKETING_QUALIFIED_LEAD',
  past:[], current:[{ rowKey:`row-${lid}`, eventType:'Offsite', budget:'approx 8L', timeline:'Q3', pax:'40', remarks:'' }],
});
const callOf = (t) => ({at:t, outcome:'Connected', duration:40, durationSource:'dialed', createdHere:true});

let pass = 0, fail = 0;
const check = (name, ok, detail='') => { (ok?pass++:fail++); console.log(`${ok?'  PASS':'! FAIL'}  ${name}${detail?'  — '+detail:''}`); };

/* ── 1 · a save against a base missing a column the writer writes ─────── */
console.log('\n1. the base has no Contacts.Phones and no Contacts.First Worked At');
await upMocks('Contacts.Phones,Contacts.First Worked At');
await upProxy();

let r1 = null, threw = '';
try { r1 = await save(contact('Asha Rao','bb-asha','9800000001'), callOf('2026-09-19T10:00:00.000Z')); }
catch (e) { threw = `${e.status} ${e.message}`; }
console.log(`   save: ${threw ? 'THREW ' + threw : 'ok, kid=' + r1.kid}`);
check('the save did not fail', !threw, threw);
check('the contact still landed', (await rows('Contacts')).length === 1,
      `${(await rows('Contacts')).length} contact row(s)`);
check('and so did the event row it carried', (await rows('Event Rows')).length === 1,
      `${(await rows('Event Rows')).length} event row(s)`);
check('and the call log', (await rows('Call Log')).length === 1,
      `${(await rows('Call Log')).length} call row(s)`);
check('and the stage transition', (await rows('Stage Transitions')).length === 1,
      `${(await rows('Stage Transitions')).length} transition(s)`);
console.log(`   proxy reported missing: ${JSON.stringify(r1?.airtable?.missing || [])}`);
check('it named BOTH columns it had to give up',
      (r1?.airtable?.missing||[]).includes('Contacts.Phones') &&
      (r1?.airtable?.missing||[]).includes('Contacts.First Worked At'),
      JSON.stringify(r1?.airtable?.missing));
const c1 = (await rows('Contacts'))[0]?.fields || {};
check('the columns that DO exist were written', c1.Name === 'Asha Rao' && !!c1['First Picked At'],
      `First Picked At=${c1['First Picked At'] || '(none)'}`);
check('the missing one was not smuggled in', !('Phones' in c1));

/* ── 2 · the same save once the column is there ──────────────────────── */
/* The tolerance must be a RECOVERY, not a permanent amputation: the moment
   repair-base adds the column, the next save has to start filling it. */
console.log('\n2. repair-base runs, and the very next save fills the column');
await downAll();
await upMocks('');                      /* the column is back */
await upProxy();
const r2 = await save(contact('Bela Nair','bb-bela','9800000002'), callOf('2026-09-19T11:00:00.000Z'));
const c2 = (await rows('Contacts')).find(r=>r.fields.Name==='Bela Nair')?.fields || {};
check('nothing was dropped this time', !(r2?.airtable?.missing||[]).length,
      JSON.stringify(r2?.airtable?.missing||[]));
check('Phones is written', !!c2.Phones, c2.Phones || '(none)');
check('First Worked At is written', !!c2['First Worked At'], c2['First Worked At'] || '(none)');
check('dated from the CALL, not from now', String(c2['First Worked At']).slice(0,10) === '2026-09-19');

/* ── 3 · the backfill ────────────────────────────────────────────────── */
/* Contacts as they exist on Ayush's base: worked long ago, carrying call and
   rank history, with neither milestone date — the state that makes the ladder
   read "Right POC 2" above "Companies worked 0". */
console.log('\n3. contacts written before the two columns existed');
const ago = (d)=>new Date(Date.now()-d*86400000).toISOString();
/* Retries the 429. The mock rate-limits above 5 req/s and it is not only this
   test using it — the save in step 2 leaves the proxy rebuilding its report
   cache in the background, which is exactly the contention this seeding would
   hit in real life. A 429 carries no `records`, so a helper that does not
   retry seeds nothing and the assertions below then fail for the wrong
   reason. */
async function put(table, records) {
  for (let i=0;i<8;i++){
    const r = await fetch(`${AT}/v0/appMOCK/${encodeURIComponent(table)}`,
      { method:'POST', headers:{Authorization:'Bearer x','Content-Type':'application/json'},
        body:JSON.stringify({records:records.map(fields=>({fields})),typecast:true}) });
    if (r.ok) return r.json();
    if (r.status !== 429) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0,140)}`);
    await sleep(700);
  }
  throw new Error(`${table}: still rate limited after eight tries`);
}

const old = await put('Contacts', [
  /* a call log survives for this one, so its first call is knowable exactly */
  { 'Kylas Contact ID':'90001', Name:'Old Worked', Owner:'Enout Super Admin',
    'Current Stage':'CNC_COULD_NOT_CONNECT', 'KPI Rank':6, 'First Call At':ago(200), 'Last Call At':ago(12) },
  /* picked up: Ever Picked is set, and a transition says when */
  { 'Kylas Contact ID':'90002', Name:'Old Picked', Owner:'Enout Super Admin',
    'Current Stage':'MQL_MARKETING_QUALIFIED_LEAD', 'Ever Picked':true, 'KPI Rank':14,
    'KPI Rank At':ago(150), 'First Call At':ago(180), 'Last Call At':ago(30) },
  /* no call rows left at all — the rollup compacted them. Only the rank date
     remains, and that is a floor worth having. */
  { 'Kylas Contact ID':'90003', Name:'Compacted', Owner:'Enout Super Admin',
    'Current Stage':'MQL_MARKETING_QUALIFIED_LEAD', 'Ever Picked':true, 'KPI Rank':14,
    'KPI Rank At':ago(90) },
  /* never dialled. Must stay out of the funnel entirely. */
  { 'Kylas Contact ID':'90004', Name:'Never Touched', Owner:'Enout Super Admin',
    'Current Stage':'NOT_TOUCHED_YET', 'KPI Rank':0 },
]);
await sleep(300);
check('the fixtures seeded', (old.records||[]).length === 4, `${(old.records||[]).length} row(s)`);
const recOf = (name) => (old.records||[]).find(r=>r.fields.Name===name)?.id;
await put('Stage Transitions', [
  { Key:'t-90002-a', 'From Stage':'CNC_COULD_NOT_CONNECT', 'To Stage':'CNC_COULD_NOT_CONNECT',
    'Changed At':ago(179), Contact:[recOf('Old Picked')] },
  { Key:'t-90002-b', 'From Stage':'CNC_COULD_NOT_CONNECT', 'To Stage':'MQL_MARKETING_QUALIFIED_LEAD',
    'Changed At':ago(160), Contact:[recOf('Old Picked')] },
]);
await sleep(300);

const run = (args=[]) => new Promise((resolve)=>{
  const p = spawn('node',['scripts/migrate-first-worked.mjs',...args],
    {cwd:REPO,env:{...process.env,AIRTABLE_BASE_URL:AT,AIRTABLE_PAT:'pat_mock',AIRTABLE_BASE:'appMOCK'}});
  let out=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
  p.on('exit',code=>resolve({code,out}));
});

const dry = await run();
console.log(dry.out.split('\n').filter(l=>/get First|already|never worked|DRY/.test(l)).map(l=>'   '+l.trim()).join('\n'));
check('the dry run writes nothing',
      !(await rows('Contacts')).some(r=>r.fields.Name==='Old Worked' && r.fields['First Worked At']));

const applied = await run(['--apply']);
console.log(`   ${(applied.out.match(/backfilled .*/)||['(no backfill line)'])[0]}`);
const by = Object.fromEntries((await rows('Contacts')).map(r=>[r.fields.Name, r.fields]));

check('the contact with surviving calls is dated from its first call',
      String(by['Old Worked']?.['First Worked At']||'').slice(0,10) === ago(200).slice(0,10),
      by['Old Worked']?.['First Worked At'] || '(none)');
check('a contact that never picked up gets no picked date', !by['Old Worked']?.['First Picked At']);
check('the one that picked up is dated from its first connected transition',
      String(by['Old Picked']?.['First Picked At']||'').slice(0,10) === ago(160).slice(0,10),
      by['Old Picked']?.['First Picked At'] || '(none)');
check('picked is never before worked',
      String(by['Old Picked']?.['First Picked At']) >= String(by['Old Picked']?.['First Worked At']));
check('a compacted contact falls back to its rank date',
      String(by['Compacted']?.['First Worked At']||'').slice(0,10) === ago(90).slice(0,10),
      by['Compacted']?.['First Worked At'] || '(none)');
check('a contact nobody ever dialled stays out of the funnel',
      !by['Never Touched']?.['First Worked At'] && !by['Never Touched']?.['First Picked At']);

/* ── 4 · run it twice ────────────────────────────────────────────────── */
/* Write-once is the invariant these two columns exist to hold: a date that
   moves moves a company between reporting periods retrospectively. */
console.log('\n4. running the backfill a second time');
const before = JSON.stringify(Object.fromEntries(Object.entries(by)
  .map(([k,v])=>[k,[v['First Worked At']||'',v['First Picked At']||'']])));
const again = await run(['--apply']);
const after = Object.fromEntries((await rows('Contacts')).map(r=>[r.fields.Name,r.fields]));
const afterS = JSON.stringify(Object.fromEntries(Object.entries(after)
  .filter(([k])=>k in by).map(([k,v])=>[k,[v['First Worked At']||'',v['First Picked At']||'']])));
check('it found nothing left to do', /Nothing to backfill/.test(again.out),
      (again.out.match(/ {2}\d+ contact\(s\) get.*/)||[''])[0].trim());
check('and moved no date it had already written', before === afterS);

/* ── 5 · the backfill against a base that has neither column ─────────── */
console.log('\n5. the backfill on a base repair-base has never touched');
await downAll();
await upMocks('Contacts.First Worked At,Contacts.First Picked At');
await upProxy();
await put('Contacts', [{ 'Kylas Contact ID':'90009', Name:'Bare Base', Owner:'Enout Super Admin',
  'Current Stage':'CNC_COULD_NOT_CONNECT', 'KPI Rank':6, 'First Call At':ago(50) }]);
await sleep(300);
const bare = await run(['--apply']);
console.log(bare.out.split('\n').filter(l=>/repair-base|column/.test(l)).map(l=>'   '+l.trim()).join('\n'));
/* repair-base.mjs, with the extension: listTolerant says "Run repair-base." on
   every read of a base that is behind, so matching the bare word would pass on
   a script that then died with a raw 422 — which is the thing being tested. */
check('it names the script to run rather than failing with a raw 422',
      /repair-base\.mjs/.test(bare.out) && bare.code === 1, `exit ${bare.code}`);
check('and it does not claim to have backfilled anything', !/^backfilled/m.test(bare.out));

console.log(`\n${pass} passed, ${fail} failed`);
await downAll();
process.exit(fail ? 1 : 0);
