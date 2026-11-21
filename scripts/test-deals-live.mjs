#!/usr/bin/env node
/* THE DEALS SCREEN, IN A REAL CHROME.
 *
 *   xvfb-run -a node scripts/test-deals-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says, AND at
 * least one deal — save a contact onto ACTIVE_REQUIREMENT_CALL_BOOKED first,
 * which is what creates one. The node-only suites (test-deals.mjs,
 * test-handoff.mjs) cover the rules and the hand-off; this covers the only
 * things that exist on screen: that the radar is FIRST and split by court,
 * that both clocks reach the row, and that pushing a date cannot happen
 * without a reason — which is the mechanism that keeps a Planning Team delay
 * off a BD's number, and is worth nothing if the UI quietly defaults it.
 *
 * The store is file-backed, so deals and their slips accumulate across runs.
 * That is deliberate: the assertions are about shape, not counts.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/pdl-'+Date.now(),{headless:false,viewport:{width:1600,height:1000},
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=ctx.pages()[0]||await ctx.newPage();
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
const errs=[];page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text().slice(0,160));});
try{
await page.goto(`${HOST}/sales/companies/list/`);await W(3500);
await F().evaluate(async b=>{await API.setBase(b)},BASE);await page.reload();await W(6000);
const f=()=>F();
ok('a Deals button is in the top bar', await f().locator('#dealsBtn').count()===1);
await f().locator('#dealsBtn').click();
/* loadDeals is async and the first paint is deliberately empty — wait for
   a deal row rather than a fixed delay. */
await f().locator('.dCard').first().waitFor({timeout:20000});await W(800);
ok('the Pre-SQL bottleneck radar is first', await f().locator('.rdr').count()===1);
const courts=await f().locator('.rdrC .rdrL').allTextContents();
ok('...split by all four courts', courts.length===4, courts.join('|'));
const vals=await f().locator('.rdrC .rdrV').allTextContents();
ok('...counted in deals and in rupees', vals.some(v=>v.includes('₹')), vals.join('|'));
ok('deals are listed under it', await f().locator('.dCard').count()>0,
   `${await f().locator('.dCard').count()}`);
await f().locator('.dHead').first().click();await W(1200);
const items=await f().locator('.dItem').count();
ok('opening a deal shows its action items', items>0, `${items}`);
ok('...each with its court and a countdown',
   await f().locator('.dItem .dCourt').count()===items && await f().locator('.dItem .dDue').count()===items);
ok('...and the quick push chips', await f().locator('.dItem .dPush button').count()>=6);
await f().locator('.dItem .dPush button').first().click();await W(1000);
ok('pushing asks for a reason instead of guessing', await f().locator('.dAsk').count()===1);
const chips=await f().locator('.dAskChips button').allTextContents();
ok('...offering the floor’s own words', chips.some(c=>/didn.t pick/i.test(c))&&chips.some(c=>/DMM/i.test(c)), chips.join('|'));
await f().locator('.dAskChips button',{hasText:'DMM'}).first().click();await W(2500);
ok('after a Planning Team reason the item is marked slipped', await f().locator('.dSlip').count()>0);
const after=await f().evaluate(()=>[...document.querySelectorAll('.rdrC')].map(c=>({
  court:c.dataset.court,n:c.querySelector('b')?.textContent})));
ok('...and the radar moved it into the Planning Team court',
   after.find(c=>c.court==='planning_team')?.n!=='0', JSON.stringify(after));
await page.screenshot({path:'/tmp/claude-0/deals.png'});
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
