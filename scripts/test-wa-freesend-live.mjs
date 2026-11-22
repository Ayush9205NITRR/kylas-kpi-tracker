#!/usr/bin/env node
/* CONTACT vs ACCOUNT STAGE, FREE SEND, AND THE WARMUP CSV.
 *
 *   xvfb-run -a node scripts/test-wa-freesend-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says.
 * Writes its own CSV fixture, so it needs no file beside it.
 *
 * The free-send assertion is a COMPARISON, not a count: it checks that the
 * number of greyed-out rows FALLS when the ladder is switched off. A fixed
 * number would pass on an empty table.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
await fetch(BASE+'/views',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({name:'WA view',visibility:'team',companies:['903','1776620','1778327','1810449']})}).catch(()=>{});
fs.writeFileSync('/tmp/claude-0/warm.csv',
 'Name,Phone,Company,Venue City,Notes\nAsha Rao,98739 15513,Zomato,Goa,met at GPTW\nRavi K,+91 9811122233,Swiggy,Pune,\nNo Number,,Acme,Delhi,\n');
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/p93-'+Date.now(),{headless:false,viewport:{width:1700,height:1000},
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

console.log('\n1 · contact vs account stage');
ok('a stage-basis toggle is offered', await f().locator('#waBasisC').count()===1 && await f().locator('#waBasisA').count()===1);
ok('...defaulting to contact stage', (await f().locator('#waBasisC').getAttribute('aria-pressed'))==='true');
await f().locator('#waBasisA').click();await W(2500);
ok('...and switches to account stage', (await f().locator('#waBasisA').getAttribute('aria-pressed'))==='true');
await f().locator('#waBasisC').click();await W(2000);

console.log('\n2 · free send');
ok('Free send is offered', await f().locator('#waFree').count()===1);
await f().locator('[data-warung="3"]').click();await W(2500);
const gatedOff=await f().locator('.waR.off').count();
ok('CNC-3 gates almost everybody out', gatedOff>0, `${gatedOff}`);
await f().locator('#waFree').click();await W(3000);
ok('Free send opens them up again', await f().locator('.waR.off').count()<gatedOff,
   `${await f().locator('.waR.off').count()} vs ${gatedOff}`);
await f().locator('#waFree').click();await W(2000);
await f().locator('[data-warung="1"]').click();await W(2000);

console.log('\n3 · warmup CSV');
await f().locator('[data-wamode="warmup"]').click();await W(2500);
ok('Upload CSV appears on the Warmup tab', await f().locator('#waCsv').count()===1);
await f().locator('#waCsvIn').setInputFiles('/tmp/claude-0/warm.csv');await W(2000);
ok('the file is parsed', await f().locator('.waCsvBox').count()===1);
const h=await f().locator('.waCsvH').innerText();
ok('...3 rows, 2 with usable numbers', /3 rows/.test(h)&&/2 with a usable number/.test(h), h.replace(/\n/g,' '));
ok('...and the extra columns become custom variables',
   /\{\{venue_city\}\}/.test(h)&&/\{\{notes\}\}/.test(h), h.replace(/\n/g,' '));
await f().locator('[data-wastep="3"]').click();await W(4000);
const prev=await f().locator('.waPrevH').innerText();
ok('the CSV rows are recipients', /of [2-9]/.test(prev), prev.replace(/\n/g,' '));
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
