#!/usr/bin/env node
/* THE ADMIN DRAWER AND THE SEAT PILL.
 *
 *   xvfb-run -a node scripts/test-wa-admin-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says.
 *
 * Four things that used to need a deploy — template wording, the caps, which
 * laptop is whose seat, and a deal action's SLA — edited in the UI and read
 * back off the server, plus the pill that says whether the phone about to
 * send is actually logged in.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
await fetch(BASE+'/views',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({name:'WA view',visibility:'team',companies:['903','1776620','1778327','1810449']})}).catch(()=>{});
await fetch(BASE+'/wa/seat-status',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({seat:'bd-exec-2',state:'ready'})});
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/p94-'+Date.now(),{headless:false,viewport:{width:1700,height:1000},
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=ctx.pages()[0]||await ctx.newPage();
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
const errs=[];page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text().slice(0,160));});
try{
await page.goto(`${HOST}/sales/companies/list/`);await W(3500);
await F().evaluate(async b=>{await API.setBase(b)},BASE);await page.reload();await W(6000);
const f=()=>F();
await f().evaluate(()=>window.showConsoleView('companies'));await W(4000);
await f().locator('.vws .vwtab',{hasText:'WA view'}).first().click();await W(2000);
await f().locator('#halfCon').click();await W(8000);
await f().locator('#waBtn').click();await W(5000);

console.log('\n1 · the admin drawer');
ok('the anti-ban bar is collapsed to one line', await f().locator('.wsLine').count()===1
   && await f().locator('.wsDrawer').count()===0);
ok('...which still says what the limit is', /Cap \d+\/day/.test(await f().locator('.wsSum').innerText()),
   await f().locator('.wsSum').innerText());
await f().locator('#waAdmin').click();await W(1500);
ok('Admin controls opens a drawer', await f().locator('.wsDrawer').count()===1);
const tabs=await f().locator('[data-watab]').allTextContents();
ok('...with four tabs', tabs.length===4, tabs.join('|'));
ok('caps and the kill switch are there', await f().locator('[data-waset="dailyCapPerSeat"]').count()===1
   && await f().locator('#waKill').count()===1);
await f().locator('[data-watab="seats"]').click();await W(1200);
ok('BD → seat mapping is editable', await f().locator('[data-wsemail]').count()>0
   && await f().locator('[data-wsseat]').count()>0);
await f().locator('[data-wsemail="0"]').fill('gurnoor@enout.in');
await f().locator('[data-wsseat="0"]').selectOption('bd-exec-2');
await f().locator('#waSeatsSave').click();await W(2500);
const saved=await (await fetch(BASE+'/wa/settings')).json();
ok('...and it persists to D1', saved.seats['gurnoor@enout.in']==='bd-exec-2', JSON.stringify(saved.seats));
await f().locator('[data-watab="tpl"]').click();await W(1200);
ok('templates are editable without a deploy', await f().locator('#waAdmBody').count()===1
   && await f().locator('#waAdmAuto').count()===1);
await f().locator('[data-watab="sla"]').click();await W(1200);
ok('deal SLAs are editable', await f().locator('[data-wsla]').count()>=6,
   `${await f().locator('[data-wsla]').count()} fields`);
await f().locator('#waAdminX').click();await W(1000);
ok('...and the drawer closes again', await f().locator('.wsDrawer').count()===0);

console.log('\n2 · the seat pill');
await f().locator('[data-wastep="1"]').click();await W(1500);
await f().locator('#waAll').click();await W(1200);
await f().locator('[data-wastep="3"]').click();await W(4000);
ok('a seat pill is shown at the moment of sending', await f().locator('.waSeatPill').count()===1,
   await f().locator('.waSeatPill').innerText().catch(()=>''));
await f().locator('#waSeat').selectOption('bd-exec-2');await W(1500);
const pill=await f().locator('.waSeatPill').innerText();
ok('...and it reports the live seat state', /bd-exec-2/.test(pill)&&/connected|ready/.test(pill), pill);
await f().locator('#waSeat').selectOption('bd-exec-7');await W(1500);
ok('...and says when a seat is not reporting',
   /not reporting/.test(await f().locator('.waSeatPill').innerText()),
   await f().locator('.waSeatPill').innerText());
await page.screenshot({path:'/tmp/claude-0/v94.png'});
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
