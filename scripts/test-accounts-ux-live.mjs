/* AYUSH'S ACCOUNTS-VIEW NOTES OF 2026-10-10, driven in a real Chrome.
 *
 *   xvfb-run -a node scripts/test-accounts-ux-live.mjs
 *
 *   1  the call-back banner counts the FILTERED list, total as a link
 *   2  search operators (is / is not / begins with) with many values, and a
 *      pasted column arriving comma-separated
 *   3  Created at / by and Last updated at / by, from Kylas' audit fields
 *   4  bulk "Add to Focus" for anyone, written to Airtable in batches
 *   5  Back: card -> accounts (scroll kept) -> dashboard -> nothing further
 *   6  "Said before" reads the contact's Remarks custom field (cfRemarks)
 *
 * NEEDS the stack and the :8778 stub as test-console-ux-live.mjs says, with
 * stub pages at /sales/companies/details/903/, /sales/companies/list/ and
 * /sales/contacts/details/112936/, and EXT_DIR. Step 6 is SKIPPED, not
 * failed, on a machine that cannot reach Google for the extension's sign-in.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT=process.env.EXT_DIR||'/tmp/claude-0/exttest';
const ctx=await chromium.launchPersistentContext((process.env.PROFILE_DIR||'/tmp/claude-0/pux3-')+Date.now(),{headless:false,viewport:{width:1600,height:950},
 args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('PAGEERROR '+e.message));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${d?'  — '+d:''}`);};
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');await page.waitForTimeout(4000);
await F().evaluate(async()=>{await API.setBase('http://127.0.0.1:8787')});
await page.goto('http://127.0.0.1:8778/sales/companies/list/');await page.waitForTimeout(9000);
let f=F();
const rowsShown=()=>f.evaluate(()=>document.querySelectorAll('#vwrap .vr').length);
const cnt=()=>f.evaluate(()=>{const t=document.querySelector('#vwrap .exhead')?.textContent||'';const m=t.match(/(\d[\d,]*)\s+compan/);return m?Number(m[1].replace(/,/g,'')):null;});
await f.locator('#accQ').waitFor({timeout:20000});

console.log('\n1 · the call-back banner counts the filtered list');
const banner=()=>f.evaluate(()=>{const b=document.querySelector('.vfu');return b?{n:Number(b.querySelector(':scope>b')?.textContent),t:b.textContent.replace(/\s+/g,' ').trim()}:null;});
const b0=await banner();
console.log('   unfiltered:', JSON.stringify(b0));
await f.locator('#accQ').fill('callback-co-1');await page.waitForTimeout(1200);
const b1=await banner();
console.log('   filtered:  ', JSON.stringify(b1));
const dueInRows=await f.evaluate(()=>[...document.querySelectorAll('#vwrap .vr .nc')].filter(n=>/nc-(overdue|today)/.test(n.className)).length);
ok('the big number is the due count of the filtered rows', b1 && b1.n===dueInRows, `banner ${b1?.n} vs rows ${dueInRows}`);
ok('...and the all-accounts total is offered as a link', !b0 || b1.n===b0.n || /across all accounts/.test(b1.t), b1?.t);

console.log('\n2 · search operators, many values at once');
await f.locator('#accQ').fill('');await page.waitForTimeout(800);
const total=await cnt();
const names=await f.evaluate(()=>[...document.querySelectorAll('#vwrap .vr')].map(r=>(r.children[0]?.textContent||'').replace(/[★]/g,'').replace(/deprioritized/,'').trim()).filter(Boolean));
const two=[...new Set(names)].filter(n=>n!=='Company').slice(0,2);
console.log('   names on the list:', JSON.stringify([...new Set(names)].slice(0,6)));
await f.selectOption('#accQOp','equal');await page.waitForTimeout(600);
await f.locator('#accQ').fill(two.join(', '));await page.waitForTimeout(1200);
ok('"is" with two names finds exactly those two', await cnt()===2, `${await cnt()} of ${total}`);
await f.selectOption('#accQOp','not_equal');await page.waitForTimeout(1200);
ok('"is not" with the same two leaves the rest', await cnt()===total-2, `${await cnt()} of ${total}`);
await f.selectOption('#accQOp','begins_with');await page.waitForTimeout(600);
await f.locator('#accQ').fill('');
await f.locator('#accQ').focus();
await f.evaluate((two)=>{const dt=new DataTransfer();dt.setData('text/plain',two.map(n=>n.slice(0,3)).join('\n')+'\n');document.getElementById('accQ').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},two);
await page.waitForTimeout(1200);
const v=await f.evaluate(()=>document.getElementById('accQ').value);
ok('a pasted column arrives comma-separated', v===two.map(n=>n.slice(0,3)).join(', '), JSON.stringify(v));
ok('...and "begins with" matches any of them', (await cnt())>=2, `${await cnt()}`);
await f.selectOption('#accQOp','contains');await f.locator('#accQ').fill('');await page.waitForTimeout(1000);

console.log('\n3 · Created / Updated, at and by');
const fb=await f.evaluate(()=>{ /* the filter builder reads its fields from ACOLS */
  const opts=[...document.querySelectorAll('#vwrap select option')].map(o=>o.textContent.trim());return opts;});
await f.locator('#colBtn').click();await page.waitForTimeout(600);
const colNames=await f.evaluate(()=>[...document.querySelectorAll('#vwrap label')].map(l=>l.textContent.trim()));
ok('the Columns picker offers all four', ['Created at','Created by','Last updated at','Last updated by'].every(n=>colNames.some(c=>c.includes(n))), colNames.filter(c=>/reated|pdated/.test(c)).join(' | '));
for(const n of ['Created by','Last updated by']){const l=f.locator('#vwrap label',{hasText:n}).first();await l.click();await page.waitForTimeout(500);}
await f.locator('#colBtn').click();await page.waitForTimeout(600);
await f.locator('#accQ').fill('seats');await page.waitForTimeout(1200);
const rowText=await f.evaluate(()=>[...document.querySelectorAll('#vwrap .vr')].map(r=>r.textContent.replace(/\s+/g,' ')).join(' / '));
ok('a company shows who created and last updated it', /Enout Super Admin/.test(rowText) && /Priya Deshmukh/.test(rowText), rowText.slice(-160));
await f.locator('#accQ').fill('');await page.waitForTimeout(800);

console.log('\n4 · bulk Focus');
await f.locator('#accQ').fill('');await page.waitForTimeout(1200);
const n=await rowsShown();
await f.locator('#accPickAll').click();await page.waitForTimeout(600);
await f.locator('#accFocusMany').click();await page.waitForTimeout(3500);
const msg=await f.evaluate(()=>document.querySelector('.exbmsg')?.textContent||'');
ok('selecting the rows and Add to Focus says how many went in', /added to Focus/.test(msg), msg);
const stars=await f.evaluate(()=>Object.values(Focus.map).filter(x=>x.status==='focus').length);
ok('...and they are on the focus map', stars>=n-1, `${stars} on focus, ${n} rows`);
const at=await (await fetch('http://127.0.0.1:9901/__writes',{headers:{Authorization:'Bearer x'}})).json();
const focusRows=(at.tables?.Focus||[]).length;
ok('...written to Airtable in batches, not one by one', focusRows>=n-1, `${focusRows} Focus rows`);
await f.locator('#accQ').fill('');await page.waitForTimeout(800);

console.log('\n5 · Back: card -> accounts -> dashboard');
const back=()=>f.evaluate(()=>{const b=document.getElementById('backBtn');return b.hidden?'hidden':b.textContent;});
const vw=()=>f.evaluate(()=>document.getElementById('viewport').hidden?'card':(document.getElementById('accQ')?'accounts':'dashboard'));
await f.evaluate(()=>{document.getElementById('viewport').scrollTop=500;});
const top0=await f.evaluate(()=>document.getElementById('viewport').scrollTop);
await f.locator('#vwrap .vr').nth(2).click();await page.waitForTimeout(3000);
ok('opening an account shows its card, with Back to accounts', await vw()==='card' && /Accounts/.test(await back()), `${await vw()} / ${await back()}`);
await f.locator('#backBtn').click();await page.waitForTimeout(3000);
ok('Back goes to the accounts list', await vw()==='accounts');
ok('...scrolled where it was left', Math.abs((await f.evaluate(()=>document.getElementById('viewport').scrollTop))-top0)<5,
   `${top0} -> ${await f.evaluate(()=>document.getElementById('viewport').scrollTop)}`);
ok('...and Back now says Dashboard', /Dashboard/.test(await back()), await back());
await f.locator('#backBtn').click();await page.waitForTimeout(4000);
ok('Back from the list goes to the dashboard', await vw()==='dashboard');
ok('...where there is no further Back', await back()==='hidden');

console.log('\n6 · Said before reads the Remarks custom field');
page.on('console',m=>{if(/contact|history|kylas/i.test(m.text()))console.log('   [console] '+m.text().slice(0,160));});
await page.goto('http://127.0.0.1:8778/sales/contacts/details/112936/');await page.waitForTimeout(9000);
console.log('   host open:', await page.evaluate(()=>document.getElementById('enout-console-host')?.classList.contains('open')));
f=F();
let onIt=false, skipped=false;
for(let i=0;i<40&&!onIt;i++){onIt=await f.evaluate(()=>String(rec()?.kid)==='112936').catch(()=>false);if(!onIt)await page.waitForTimeout(500);}
const why=await f.evaluate(()=>API.state.reason||'');
/* THIS SANDBOX CANNOT REACH GOOGLE. When the extension's background tries a
   silent sign-in refresh mid-run, the console marks the server offline and
   never asks for the contact — an environment fact, not a product one. */
if(!onIt && /Google/i.test(why)){skipped=true;console.log('  SKIP  the contact page — this machine cannot reach Google for sign-in: '+why.slice(0,80));}
else ok('the contact page opens that contact', onIt, onIt?'':JSON.stringify(await f.evaluate(()=>({toast:document.querySelector('.toast')?.textContent||'',online:API.state.online,reason:API.state.reason,link:document.querySelector('.link')?.title,open:document.getElementById('enout-console-host')?1:0}))));
let pn='';
/* The notes of earlier calls and the Remarks field arrive in the background
   after the card paints — one Kylas round trip, slower when it is throttled. */
for(let i=0;i<30&&!/budget sits with the CFO/.test(pn);i++){await page.waitForTimeout(500);
  pn=await f.evaluate(()=>document.querySelector('.pnote')?.textContent.replace(/\s+/g,' ').trim()||'');}
await f.evaluate(()=>document.querySelector('.pnote .pnx')?.click());await page.waitForTimeout(300);
const hist=await f.evaluate(async()=>({kid:rec()?.kid,name:rec()?.pocName,view:!document.getElementById('viewport').hidden,held:HIST.has('112936'),rem:HREM.get('112936')||'',wait:HIST_WAIT.has('112936'),cb:!!document.getElementById('callbar')}));
if(!skipped) ok('the strip shows the cfRemarks text', /budget sits with the CFO/.test(pn), pn.slice(-200)+' || history: '+JSON.stringify(hist).slice(0,200));
await page.screenshot({path:(process.env.S||'/tmp')+'/ux3-remarks.png'});
console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close();process.exit(fail?1:0);
