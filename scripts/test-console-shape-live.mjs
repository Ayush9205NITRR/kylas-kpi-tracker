#!/usr/bin/env node
/* THE SHAPE OF THE TWO MAIN SCREENS.
 *
 *   xvfb-run -a node scripts/test-console-shape-live.mjs
 *
 * NEEDS the stack and the :8778 host stub exactly as test-views-live.mjs says.
 *
 * Not "does it look nice" — the four structural promises that are easy to
 * break and invisible when broken:
 *   the dashboard is three questions, not one scroll, and the four-tile strip
 *     that CLAUDE.md forbids above the ladder has not crept back;
 *   the ladder HAS DATA on its own tab (ensureReport used to be called only
 *     from reportSection, which now lives on a different tab — the ladder was
 *     left reading a REP nothing ever filled: blank, with no error);
 *   Work today is one line on the Accounts view, with every one-click filter
 *     it had;
 *   the five chip rows are reachable in one click and the drawer opens itself
 *     when a filter inside it is narrowing the list.
 *
 * NOTE ON SELECTORS: `table.ladder` is a shared TABLE STYLE — workedMixHTML
 * uses it too — so the ladder is found by its own heading. Keying on the
 * class passed on the wrong tab.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/pr1-'+Date.now(),{headless:false,viewport:{width:1600,height:1000},
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=ctx.pages()[0]||await ctx.newPage();
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
const errs=[];page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text().slice(0,160));});
try{
await page.goto(`${HOST}/sales/companies/list/`);await W(3500);
await F().evaluate(async b=>{await API.setBase(b)},BASE);await page.reload();await W(6000);
const f=()=>F();

console.log('\n1 · dashboard sub-tabs');
await f().evaluate(()=>window.showConsoleView('dashboard'));await W(7000);
const tabs=await f().locator('.dtabs button').allTextContents();
ok('four tabs, the three questions plus All sections', tabs.length===4, tabs.join('|'));
ok('Today & Ladder is the default',
   (await f().locator('.dtabs button[aria-selected="true"]').first().textContent())?.includes('Today'));
const onToday=await f().evaluate(()=>({ladder:[...document.querySelectorAll('.vhead.sm h2')].some(h=>h.textContent.trim()==='The ladder'),
  report:!!document.querySelector('.vperiod'),score:document.body.innerText.includes('Score-wise')}));
ok('...shows the ladder', onToday.ladder===true, JSON.stringify(onToday));
ok('...and not the trends or portfolio sections', !onToday.report&&!onToday.score, JSON.stringify(onToday));
ok('NO four-tile strip above the ladder', await f().locator('.vhead4').count()===0);
await f().locator('.dtabs button',{hasText:'Trends'}).click();await W(4000);
const onTrends=await f().evaluate(()=>({ladder:[...document.querySelectorAll('.vhead.sm h2')].some(h=>h.textContent.trim()==='The ladder'),report:!!document.querySelector('.vperiod')}));
ok('Trends shows the period report and drops the ladder', onTrends.report&&!onTrends.ladder, JSON.stringify(onTrends));
await f().locator('.dtabs button',{hasText:'Portfolio'}).click();await W(4000);
const onPort=await f().evaluate(()=>({ladder:[...document.querySelectorAll('.vhead.sm h2')].some(h=>h.textContent.trim()==='The ladder'),report:!!document.querySelector('.vperiod')}));
ok('Portfolio drops the ladder and the period report', !onPort.ladder&&!onPort.report, JSON.stringify(onPort));
await f().locator('.dtabs button',{hasText:'All sections'}).click();await W(4000);
const all=await f().evaluate(()=>({ladder:[...document.querySelectorAll('.vhead.sm h2')].some(h=>h.textContent.trim()==='The ladder'),report:!!document.querySelector('.vperiod'),
  score:document.body.innerText.includes('Score-wise')}));
/* score needs slabs, which this fixture has none of — assert on the two
   sections the fixture does populate. */
ok('All sections brings the whole scroll back', all.ladder&&all.report, JSON.stringify(all));
await page.screenshot({path:'/tmp/claude-0/r1-dash.png'});

console.log('\n2 · the Accounts header and filters');
await f().evaluate(()=>window.showConsoleView('companies'));await W(8000);
const txt=await f().evaluate(()=>document.body.innerText);
ok('the duplicate "Companies" heading is gone', await f().locator('.vhead h2').count()===0);
ok('...and the count survives on the filter line', /allotted/.test(txt));
ok('the Work today card is a one-line ribbon', await f().locator('.tdRibbon').count()===1
   && await f().locator('.tdWrap').count()===0);
ok('...keeping its one-click filters', await f().locator('.tdRibbon [data-open]').count()===3
   && await f().locator('.tdRibbon [data-tab]').count()===2);
const h=await f().evaluate(()=>document.querySelector('.tdRibbon')?.getBoundingClientRect().height||0);
ok('...and it is one line tall', h>0&&h<=64, `${Math.round(h)}px`);
ok('one Quick filters bar', await f().locator('.qfbar').count()===1);
ok('...with the five chip rows folded away', await f().locator('.qfdrawer').count()===0
   && await f().locator('.frow').count()===0);
await f().locator('#fDrawer').click();await W(1200);
const rows=await f().locator('.qfdrawer .frow').count();
ok('Filters & chips opens them all, nothing lost', rows>=5, `${rows} rows`);
await f().locator('#fDrawer').click();await W(900);
ok('...and closes again', await f().locator('.qfdrawer').count()===0);
const qf=f().locator('.qfbar .chip.qf').first();
await qf.click();await W(1500);
ok('a quick chip filters and lights up', await qf.getAttribute('aria-pressed')==='true');
ok('...and the drawer opens itself while a filter is on, so nothing hides',
   await f().locator('.qfdrawer').count()===1 || await f().locator('.qfmore.on').count()===1);
await qf.click();await W(1000);
await f().locator('#tdExpand').click();await W(1500);
ok('Expand gives the full card back', await f().locator('.tdWrap').count()===1);
await page.screenshot({path:'/tmp/claude-0/r1-acc.png'});
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
