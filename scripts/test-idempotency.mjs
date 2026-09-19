#!/usr/bin/env node
/* Does a save whose reply never arrived create the contact twice?
 *
 *   node scripts/test-idempotency.mjs
 *
 * Starts its own mock Kylas, mock Airtable and proxy on 9900/9901/8787, so it
 * needs no key and touches nothing real. Exits non-zero on the first failure.
 *
 * The case worth the trouble is 3. A create that succeeded and whose REPLY was
 * lost is indistinguishable, from the browser, from one that never arrived —
 * and Kylas has no idempotency header and no unique constraint on a contact, so
 * the retry the outbox is built to make is exactly the thing that duplicates a
 * record. Reproduced here for real: the mock creates the contact and then never
 * answers, the proxy is killed while it waits, and the retry has to recognise
 * what it already did.
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const JOURNAL = REPO + '/.save-journal.json';
const ENV = { KYLAS_BASE:'http://127.0.0.1:9900', KYLAS_KEY:'x',
  AIRTABLE_BASE_URL:'http://127.0.0.1:9901', AIRTABLE_PAT:'pat_mock',
  AIRTABLE_BASE:'appMOCK', PORT:'8787' };

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
let proc = null;
async function up(extra = {}) {
  proc = spawn('node',['scripts/proxy.mjs'],{cwd:REPO,env:{...process.env,...ENV,...extra},stdio:'ignore'});
  for(let i=0;i<50;i++){ try{ if((await fetch('http://127.0.0.1:8787/health')).ok) return; }catch{} await sleep(300); }
  throw new Error('proxy never came up');
}
/* Kill the child we spawned rather than shelling out to lsof: execSync blocks
   waiting on a pipe that the inherited stdio keeps open. */
async function down(){ try{ proc?.kill('SIGKILL'); }catch{} proc=null; await sleep(800); }
/* ONE mock process for the whole run. Restarting it would empty the contacts
   it holds, and step 3 turns on exactly whether a contact Kylas kept can be
   found again. */
async function mock() {
  try{ execSync('lsof -t -iTCP:9900 | xargs -r kill'); }catch{}
  await sleep(400);
  spawn('node',['scripts/mock-kylas.mjs'],{cwd:REPO,env:{...process.env,MOCK_MANY:'4'},stdio:'ignore'});
  for(let i=0;i<50;i++){ try{ await fetch('http://127.0.0.1:9900/__writes',{headers:{'api-key':'x'}}); return; }catch{} await sleep(300); }
  throw new Error('mock never came up');
}
/* Airtable too: the save writes both sides, and an Airtable that is not
   listening turns every save into a half-failure that muddies what is being
   measured here. */
let atProc = null;
async function airtable() {
  atProc = spawn('node',['scripts/mock-airtable.mjs'],{cwd:REPO,stdio:'ignore'});
  for(let i=0;i<50;i++){ try{ await fetch('http://127.0.0.1:9901/v0/appMOCK/Contacts'); return; }catch{} await sleep(300); }
  throw new Error('mock airtable never came up');
}

const hang = (on) => fetch(`http://127.0.0.1:9900/__hang?on=${on?1:0}`,{headers:{'api-key':'x'}});
const refuse = (name) => fetch(`http://127.0.0.1:9900/__refuse?name=${encodeURIComponent(name)}`,{headers:{'api-key':'x'}});

const save = (contact, call, ms = 15000) => {
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), ms);
  return fetch('http://127.0.0.1:8787/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({contact,call}),signal:ac.signal})
    .then(async r=>{ const j=await r.json(); if(!r.ok) throw Object.assign(new Error(j.error||r.status),{status:r.status}); return j; })
    .finally(()=>clearTimeout(t));
};
/* The mock 429s above 4 req/s and the test hook is not exempt, so ask again
   rather than reading `undefined` as "nothing was written". */
const writes = async () => {
  for (let i=0;i<10;i++){
    const j = await (await fetch('http://127.0.0.1:9900/__writes',{headers:{'api-key':'x'}})).json();
    if (Array.isArray(j.writes)) return j.writes;
    await sleep(400);
  }
  throw new Error('the mock never returned its write log');
};
const creates = async (name) => (await writes()).filter(w=>w.kind==='create'
  && `${w.body.firstName||''} ${w.body.lastName||''}`.trim()===name);

const contact = (name, lid, phone) => ({
  lid, kid:'', pendingCreate:true, pocName:name, companyId:'1776620', company:'seats',
  owner:'Enout Super Admin', ownerId:74725, designation:'Ops',
  phones:[{type:'MOBILE',cc:'+91',value:phone,primary:true}], emails:[],
  stage:'MQL_MARKETING_QUALIFIED_LEAD', past:[], current:[],
});
const callOf = (t) => ({at:t, outcome:'Connected', duration:40, durationSource:'dialed', createdHere:true});

if (existsSync(JOURNAL)) unlinkSync(JOURNAL);
await mock();
await airtable();
await up();
let pass = 0, fail = 0;
const check = (name, ok, detail='') => { (ok?pass++:fail++); console.log(`${ok?'  PASS':'! FAIL'}  ${name}${detail?'  — '+detail:''}`); };

/* ── 1 · the plain retry: same lid twice, reply received both times ───── */
console.log('\n1. a retry of a save the proxy already carried out');
const r1 = await save(contact('Asha Rao','lid-asha','9800000001'), callOf('2026-09-19T10:00:00.000Z'));
const r2 = await save(contact('Asha Rao','lid-asha','9800000001'), callOf('2026-09-19T10:00:00.000Z'));
console.log(`   first : created=${r1.created} kid=${r1.kid}`);
console.log(`   retry : created=${r2.created} kid=${r2.kid} deduped=${!!r2.deduped}`);
check('one contact in Kylas, not two', (await creates('Asha Rao')).length === 1,
      `${(await creates('Asha Rao')).length} create(s)`);
check('the retry gets the same id back', r2.kid === r1.kid && !!r2.kid);

/* ── 2 · the journal survives the proxy ──────────────────────────────── */
console.log('\n2. the same retry after a proxy restart');
await down(); await up();
const r3 = await save(contact('Asha Rao','lid-asha','9800000001'), callOf('2026-09-19T10:05:00.000Z'));
console.log(`   after restart: created=${r3.created} kid=${r3.kid} deduped=${!!r3.deduped}`);
check('still one contact', (await creates('Asha Rao')).length === 1,
      `${(await creates('Asha Rao')).length} create(s)`);
check('still the same id', r3.kid === r1.kid);

/* ── 3 · THE REAL GAP: created, reply lost, proxy killed mid-flight ──── */
console.log('\n3. the contact is created and the reply never arrives');
await down();
await hang(true);
await up();
const hung = save(contact('Bela Nair','lid-bela','9800000002'), callOf('2026-09-19T10:10:00.000Z'), 6000)
  .then(()=>'answered').catch(e=>e.name==='AbortError'?'timed out':'error: '+e.message);
await sleep(3500);
console.log('   killing the proxy while it waits for a reply that will never come');
await down();
console.log(`   the console saw: ${await hung}`);
const madeAnyway = await creates('Bela Nair');
console.log(`   Kylas made the contact anyway: ${madeAnyway.length} (id ${madeAnyway[0]?.id})`);
const j = JSON.parse(readFileSync(JOURNAL,'utf8'));
console.log(`   journal says lid-bela: ${JSON.stringify(j.entries['lid:lid-bela'])}`);
check('the interrupted attempt was written down before the POST',
      j.entries['lid:lid-bela'] && !j.entries['lid:lid-bela'].kid);

console.log('\n   ...the outbox now retries it, exactly as it would in the morning');
await hang(false);                  /* Kylas is answering again, and still holds Bela */
await up();
const r4 = await save(contact('Bela Nair','lid-bela','9800000002'), callOf('2026-09-19T10:10:00.000Z'));
console.log(`   retry : created=${r4.created} kid=${r4.kid} deduped=${!!r4.deduped}`);
check('the retry did NOT create a second contact', (await creates('Bela Nair')).length === 1,
      `${(await creates('Bela Nair')).length} create(s) in total`);
check('it adopted an existing id instead', !!r4.kid && !r4.created);

/* ── 4 · a create Kylas refuses frees the key ────────────────────────── */
console.log('\n4. a create Kylas refuses');
await refuse('Cyrus');
await save(contact('Cyrus Bad','lid-cyrus','9800000009'), callOf('2026-09-19T10:15:00.000Z'))
  .then(()=>console.log('   (Kylas accepted it after all)'))
  .catch(e=>console.log(`   the save failed with ${e.status}`));
await refuse('');
const j2 = JSON.parse(readFileSync(JOURNAL,'utf8'));
console.log(`   journal says lid-cyrus: ${JSON.stringify(j2.entries['lid:lid-cyrus'])}`);
check('a refused create left no unfinished entry behind', !j2.entries['lid:lid-cyrus']);
/* and the retry after the refusal creates it exactly once, not never */
const r5 = await save(contact('Cyrus Bad','lid-cyrus','9800000009'), callOf('2026-09-19T10:16:00.000Z'));
check('a retry after the refusal creates it', r5.created === true && !!r5.kid, `kid=${r5.kid}`);
check('exactly once', (await creates('Cyrus Bad')).length === 1,
      `${(await creates('Cyrus Bad')).length} create(s)`);

/* ── 5 · two at once ─────────────────────────────────────────────────── */
console.log('\n5. the same save twice at the same moment');
const both = await Promise.all([
  save(contact('Devi Menon','lid-devi','9800000003'), callOf('2026-09-19T10:20:00.000Z')),
  save(contact('Devi Menon','lid-devi','9800000003'), callOf('2026-09-19T10:20:00.000Z')),
]);
console.log(`   ${both.map(r=>`created=${r.created} kid=${r.kid}`).join('  |  ')}`);
check('only one of them created anything', (await creates('Devi Menon')).length === 1,
      `${(await creates('Devi Menon')).length} create(s)`);
check('both got the same id', both[0].kid === both[1].kid);

/* ── 6 · a normal new contact is unaffected ──────────────────────────── */
console.log('\n6. an ordinary new contact still gets created');
const r6 = await save(contact('Esha Pillai','lid-esha','9800000004'), callOf('2026-09-19T10:30:00.000Z'));
check('created, with an id', r6.created === true && !!r6.kid, `kid=${r6.kid}`);

console.log(`\n${pass} passed, ${fail} failed`);
await down();
try{ execSync('lsof -t -iTCP:9900 | xargs -r kill'); }catch{}
try{ atProc?.kill('SIGKILL'); }catch{}
process.exit(fail ? 1 : 0);
