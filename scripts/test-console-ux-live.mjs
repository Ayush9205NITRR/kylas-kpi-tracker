/* THE FIVE THINGS AYUSH NOTED ON 2026-10-10, driven in a real Chrome.
 *
 *   xvfb-run -a node scripts/test-console-ux-live.mjs          # 1600px
 *   W=1920 xvfb-run -a node scripts/test-console-ux-live.mjs
 *
 *   1  the next call date is asked for on exactly his 14 stages
 *   2  two phone numbers: each box readable, nothing under LinkedIn
 *   3  a held company refreshing from Kylas does not scroll you to the top
 *   4  the accounts search keeps its caret and letters across pauses and the
 *      list arriving; Enter/1 there do not act on the hidden record; Dock and
 *      close-reopen keep the view
 *   5  CNC 3 saves without a date, and the console is still open after
 *
 * NEEDS the stack and the :8778 host stub exactly as test-ui-live.mjs says
 * (its header), with stub pages at /sales/companies/details/903/ and
 * /sales/companies/list/, and a patched extension copy at EXT_DIR. Kylas
 * should be slow for 3 to mean anything — MOCK_LATENCY_MS=1200 on mock-kylas;
 * the console's /company request is also held back 4s in the browser.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const W=Number(process.env.W||1600);
const EXT=process.env.EXT_DIR||'/tmp/claude-0/exttest';
const SHOTS=process.env.S||'/tmp';
const ctx=await chromium.launchPersistentContext((process.env.PROFILE_DIR||'/tmp/claude-0/pux-')+Date.now(),{headless:false,viewport:{width:W,height:900},
 args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('PAGEERROR '+e.message));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${d?'  — '+d:''}`);};
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');await page.waitForTimeout(4000);
await F().evaluate(async()=>{await API.setBase('http://127.0.0.1:8787')});
await page.reload();await page.waitForTimeout(9000);
const f=F();
const send=(type,extra={})=>page.evaluate(([type,extra])=>document.getElementById('enout-console-host').shadowRoot.querySelector('iframe').contentWindow.postMessage({source:'enout-host',type,...extra},'*'),[type,extra]);
const hostOpen=()=>page.evaluate(()=>document.getElementById('enout-console-host').classList.contains('open'));
const viewOpen=()=>f.evaluate(()=>!document.getElementById('viewport').hidden);

console.log(`\n(width ${W})\n1 · next call date, by stage`);
const need=async(stage)=>f.evaluate((st)=>{const a=rec();a.stage=st;a.nextCallDate='';a.phones=a.phones.length?a.phones:[{type:'MOBILE',cc:'+91',value:'9811122233',primary:true}];
  const m=missing().filter(([,anc])=>anc==='f-next').map(x=>x[0]);return m.join(',')||'-';},stage);
const want={CONNECT_LATER:'A day to call back',CNC_COULD_NOT_CONNECT:'A day to call back',CNC_COULD_NOT_CONNECT_2:'A day to call back',
  CNC_COULD_NOT_CONNECT_3:'-',FOLLOWUP_CNC:'A day to call back',MQL_MARKETING_QUALIFIED_LEAD:'A day to call back',ACTIVATION:'A day to call back',
  FOLLOW_UP_1:'A day to call back',DISCOVERY_CALL_BOOKED:'Meeting date',GHOSTED:'Meeting date',DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS:'Meeting date',
  ACTIVE_REQUIREMENT_CALL_BOOKED:'Meeting date',ACTIVE_REQUIREMENT_CALL_NO_SHOW:'Meeting date',
  'ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS':'-',SQL_SALES_QUALIFIED_LEAD:'-',NOT_INTERESTED:'-',OFFSITE_DELAYED:'-',CLOSING_LOOPS_LOW_VALUE:'-'};
let bad=[];for(const [st,w] of Object.entries(want)){const got=await need(st);if(got!==w)bad.push(`${st}: ${got} (want ${w})`);}
ok('every stage asks for the date exactly as listed', !bad.length, bad.join('; '));

console.log('\n2 · two phones');
const geo=await f.evaluate(()=>{const a=rec();a.phones=[{type:'MOBILE',cc:'+91',value:'7428995453',primary:false},{type:'MOBILE',cc:'+91',value:'9811122233',primary:true}];render();
  const fld=document.getElementById('f-ph').closest('.f');
  const nums=[...fld.querySelectorAll('.vl2')].map(n=>Math.round(n.getBoundingClientRect().width));
  const li=document.getElementById('f-li').getBoundingClientRect();
  const hit=[...fld.querySelectorAll('.dialbtn,.vl2,.del')].some(n=>{const r=n.getBoundingClientRect();return !(r.right<=li.left||r.left>=li.right||r.bottom<=li.top||r.top>=li.bottom);});
  const out=[...fld.querySelectorAll('.entry > *')].some(n=>n.getBoundingClientRect().right>fld.getBoundingClientRect().right+1);
  return {nums,hit,out};});
ok('each number box is wide enough to read', geo.nums.every(w=>w>=120), JSON.stringify(geo.nums));
ok('nothing in the phone rows sits under LinkedIn', !geo.hit);
ok('nothing spills out of the phone field', !geo.out);
await f.locator('#f-ph').scrollIntoViewIfNeeded(); await page.screenshot({path:SHOTS+`/ux2-phones-${W}.png`});

console.log('\n3 · a company finishing loading does not move you');
/* HELD first: open it, move away, come back — the case where the card is
   painted from memory and Kylas answers a few seconds later. */
await send('company',{kylasId:'1776620',label:'Seats Aero'});await page.waitForTimeout(9000);
await send('company',{kylasId:'903',label:'Shorehouse'});await page.waitForTimeout(9000);
/* Real Kylas answers in seconds, the local proxy from cache in milliseconds —
   so the answer is held back here, or it lands before anybody could scroll. */
let delayed=0;
await page.route(/127\.0\.0\.1:8787\/company\?/, async (route)=>{delayed++;await new Promise(r=>setTimeout(r,4000));await route.continue();});
await send('company',{kylasId:'1776620',label:'Seats Aero'});
await page.waitForTimeout(150);
ok('the held roster is on screen before Kylas answers', (await f.evaluate(()=>String(rec()?.companyId)))==='1776620');
await f.evaluate(()=>{document.getElementById('scrollR').scrollTop=150;});
const t0=await f.evaluate(()=>document.getElementById('scrollR').scrollTop);
await page.waitForTimeout(7000);
const t1=await f.evaluate(()=>document.getElementById('scrollR').scrollTop);
ok('the events pane stays where it was scrolled', t0>0 && t1===t0, `${t0} -> ${t1}`);
ok('...and the delayed answer did arrive meanwhile', delayed>0, `${delayed} delayed`);
await page.unroute(/127\.0\.0\.1:8787\/company\?/);

console.log('\n4 · accounts search (on the Kylas companies list page)');
await page.goto('http://127.0.0.1:8778/sales/companies/list/');await page.waitForTimeout(5000);
let g=F();
await g.locator('#accQ').waitFor({timeout:20000});
await g.locator('#accQ').click();
await g.locator('#accQ').type('callback',{delay:120});
await page.waitForTimeout(9000);   /* the list lands somewhere in here */
const st=await g.evaluate(()=>({id:document.activeElement?.id,val:document.getElementById('accQ')?.value}));
ok('the search box still has the caret after the list arrived', st.id==='accQ', JSON.stringify(st));
await g.locator('#accQ').type(' co',{delay:80});await page.waitForTimeout(900);
ok('...and keeps every letter typed, across pauses', (await g.evaluate(()=>document.getElementById('accQ').value))==='callback co');
ok('...with the caret still in it', (await g.evaluate(()=>document.activeElement?.id))==='accQ');
const before=await g.evaluate(()=>DATA.filter(a=>a.done).length);
await g.evaluate(()=>document.activeElement.blur());
await page.keyboard.press('Enter');await page.keyboard.press('1');await page.waitForTimeout(800);
const vOpen=()=>g.evaluate(()=>!document.getElementById('viewport').hidden);
ok('Enter and 1 while the view is open do not touch the record behind it',
   (await g.evaluate(()=>DATA.filter(a=>a.done).length))===before && await vOpen());
await g.locator('#dockBtn').click();await page.waitForTimeout(1500);
ok('Dock keeps the accounts view open', await vOpen());
await g.locator('#dockBtn').click();await page.waitForTimeout(1500);
await page.evaluate(()=>document.getElementById('enout-console-host').shadowRoot.querySelector('.scrim').click());
await page.waitForTimeout(500);
await page.evaluate(()=>document.getElementById('enout-console-host').shadowRoot.querySelector('.fab').click());
await page.waitForTimeout(3000);
ok('closing and reopening on the same page keeps the view', await hostOpen() && await vOpen());
ok('...and the search', (await g.evaluate(()=>document.getElementById('accQ')?.value))==='callback co');

console.log('\n5 · saving');
await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');await page.waitForTimeout(9000);
const h=F();
const r=await h.evaluate(()=>{const v=document.getElementById('viewport');if(!v.hidden)return 'view still open';
  const a=rec();a.phones=a.phones.length?a.phones:[{type:'MOBILE',cc:'+91',value:'9920477103',primary:true}];
  a.stage='CNC_COULD_NOT_CONNECT_3';a.nextCallDate='';const m=missing();if(m.length)return 'missing '+m.map(x=>x[0]);saveNext();return 'saved';});
await page.waitForTimeout(4000);
ok('a CNC 3 saves with no call-back date', r==='saved', r);
ok('the console is still open after the save', await hostOpen());
console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
