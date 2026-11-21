#!/usr/bin/env node
/* BULK WHATSAPP FROM THE CONTACTS TABLE.
 *
 *   xvfb-run -a node scripts/test-wa-bulk-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says.
 *
 * The eight WA columns joined from D1, the row ticks and bulk bar, and the
 * composer opening as a pop-up already loaded with the ticked contacts —
 * plus the three things that are deliberately NOT there any more: saving a
 * template, naming its visibility, and sending at scale without the option
 * of sending one to yourself first.
 *
 * ONE SELECTOR TRAP: `[data-ccol]` is the checkbox, not the label — reading
 * its text gives a row of empty strings and every column assertion fails for
 * the wrong reason. And the popover needs waiting for, not a fixed delay:
 * opening it repaints the whole view.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
await fetch(BASE+'/views',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({name:'WA view',visibility:'team',companies:['903','1776620','1778327','1810449']})}).catch(()=>{});
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/pbk-'+Date.now(),{headless:false,viewport:{width:1700,height:1000},
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

console.log('\n1 · the WA columns');
await f().locator('#cColBtn').click();
/* Wait for the popover rather than guessing at a delay: the whole view
   repaints to open it, and a fixed 600ms read an empty list. */
await f().locator('.msel-opt').first().waitFor({timeout:15000});await W(400);
const opts=await f().evaluate(()=>[...document.querySelectorAll('.msel-opt')].map(n=>n.innerText.trim()));
for(const col of ['WhatsApp status','WA campaign','Last WA sent','Last WA template','WA delivery','WA sends','WA replied at','WA seat','Account stage'])
  ok(`${col} is offered as a column`, opts.includes(col), opts.join('|').slice(0,120));
await f().locator('[data-ccol="waSeat"]').check();await W(900);
ok('ticking one adds it to the table',
   (await f().locator('.ctable .vr.vh span').allTextContents()).includes('WA seat'));
await f().locator('#cColBtn').click();await W(400);

console.log('\n2 · bulk from Contacts');
ok('rows have a WA tick', await f().locator('.ctable [data-cpick]').count()>0);
ok('...and a per-row WA button', await f().locator('.ctable [data-cwa]').count()>0);
const boxes=f().locator('.ctable [data-cpick]:not([disabled])');
const n=Math.min(3,await boxes.count());
for(let i=0;i<n;i++){await boxes.nth(i).check();await W(300);}
ok('ticking shows the bulk bar', await f().locator('.cbulk').count()===1);
ok(`...counting ${n}`, (await f().locator('.cbulk .cbn').innerText()).startsWith(String(n)),
   await f().locator('.cbulk .cbn').innerText());
await f().locator('#conWa').click();await W(4000);
ok('Send WhatsApp opens the composer as a pop-up', await f().locator('.waModal').count()===1);
ok('...pre-loaded with those contacts, past step 1',
   (await f().locator('.waModal .waSteps button[aria-selected="true"]').innerText()).includes('What'),
   await f().locator('.waModal .waSteps button[aria-selected="true"]').innerText());

console.log('\n3 · session-only, campaign, test send');
ok('there is NO save/delete template control',
   await f().locator('.waModal #waSaveTpl').count()===0 && await f().locator('.waModal #waVis').count()===0);
ok('...and it says edits are session-only', await f().locator('.waModal .waSess').count()===1);
ok('a Campaign label can be typed', await f().locator('.waModal #waCamp').count()===1);
await f().locator('.waModal #waCamp').fill('GPTW batch 3');await W(400);
ok('CNC and Warmup are both offered', await f().locator('.waModal [data-wamode]').count()===2);
await f().locator('.waModal [data-wastep="3"]').click();await W(4000);
ok('Send Test sits before the bulk send', await f().locator('.waModal #waTestGo').count()===1);
await f().locator('.waModal #waTestTo').fill('8690022224');
await f().locator('.waModal #waTestGo').click();await W(3000);
ok('...and a test queues', /check that phone/.test(await f().locator('.waModal .waTestN').innerText()),
   await f().locator('.waModal .waTestN').innerText());
const btn=await f().locator('.waModal #waGo').innerText();
ok('the bulk button reads Queue & send at scale (N)', /Queue & send at scale \(\d+\)/.test(btn), btn);
await f().locator('.waModal #waGo').click();await W(4000);
const st=await (await fetch(BASE+'/wa/status')).json();
ok('the kill switch state is reported', typeof st.killSwitch==='boolean');
ok('seat flags are reported', Array.isArray(st.seatFlags), JSON.stringify(st.seatFlags).slice(0,90));
await page.screenshot({path:'/tmp/claude-0/bulk.png'});
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}catch(e){console.log("\n! run failed:",e?.stack||e);fail++;
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
