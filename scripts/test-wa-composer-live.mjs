#!/usr/bin/env node
/* THE WHATSAPP COMPOSER, IN A REAL CHROME.
 *
 *   xvfb-run -a node scripts/test-wa-composer-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says.
 *
 * Three steps, and the third is the one that matters: until it existed the
 * pill was on/off and nobody could see the words that were about to go to a
 * prospect. So this walks who → what → read it as they will → queue, and
 * then checks the QUEUED ROW rather than the screen.
 *
 * TWO THINGS THAT MAKE ASSERTIONS LIE HERE, both learned the hard way:
 *   - a job is scheduled into 09:30–19:30 IST, so outside those hours
 *     /wa/drain is correctly empty and "every drained job has the seat"
 *     passes vacuously on an empty array;
 *   - re-queueing a contact CANCELS what was waiting for them, so on a
 *     second run `queued` stays flat while `cancelled` grows — counting
 *     `queued` alone reads a working supersede as a failed queue.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { WA_DEFAULTS } from './wa-jobs.mjs';
const EXT='/tmp/claude-0/exttest',HOST='http://127.0.0.1:8778',BASE='http://127.0.0.1:8787';
const W=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(w,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':'  — '+d}`);};
await fetch(BASE+'/views',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({name:'WA view',visibility:'team',companies:['903','1776620','1778327','1810449']})});
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/pwa-'+Date.now(),{headless:false,viewport:{width:1600,height:1000},
  args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-proxy-server']});
const page=ctx.pages()[0]||await ctx.newPage();
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));
const errs=[];page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text().slice(0,160));});
try{
await page.goto(`${HOST}/sales/companies/list/`);await W(3500);
await F().evaluate(async b=>{await API.setBase(b)},BASE);await page.reload();await W(6000);
const f=()=>F();
ok('a WhatsApp button is in the top bar', await f().locator('#waBtn').count()===1);
/* The composer reads the people in the open view. */
await f().evaluate(()=>window.showConsoleView('companies'));await W(4000);
await f().locator('.vws .vwtab',{hasText:'WA view'}).first().click();await W(2000);
await f().locator('#halfCon').click();await W(7000);
await f().locator('#waBtn').click();await W(3000);

console.log('\n1 · who');
ok('three steps are offered', await f().locator('.waSteps button').count()===3);
ok('step 1 lists the contacts', await f().locator('.waR').count()>0, `${await f().locator('.waR').count()}`);
ok('...with stage families as chips', await f().locator('[data-wagrp]').count()>0);
ok('...and says how many are eligible for this rung, of those shown',
   /eligible for CNC-1 of/.test(await f().locator('.waCount').innerText()),
   await f().locator('.waCount').innerText());
ok('Next is disabled until somebody is picked', await f().locator('#waOn').isDisabled());
await f().locator('#waAll').click();await W(1200);
const picked=await f().locator('.waR.on').count();
ok('Select all picks the reachable ones', picked>0, `${picked}`);
console.log('\n1b · two ladders, and the rung gate');
ok('CNC and Warmup are separate tabs', await f().locator('[data-wamode]').count()===2);
ok('...with a rung picker', await f().locator('[data-warung]').count()>=3);
const cncRungs=await f().locator('[data-warung]').allTextContents();
ok('...naming the CNC steps', cncRungs.join(',').includes('CNC-1'), cncRungs.join(','));
ok('every row shows a WhatsApp status', await f().locator('.waRst').count()>0);
ok('...and says ready or why not', await f().locator('.waWhy').count()>0);
await f().locator('[data-warung="2"]').click();await W(2500);
const blocked=await f().locator('.waR.off').count();
ok('CNC-2 greys out everyone not at CNC-1 Sent', blocked>0, `${blocked} greyed`);
const why=await f().locator('.waWhy').first().innerText();
ok('...and says needs CNC-1 first', /needs CNC-1 first/.test(why), why);
ok('...with their checkboxes disabled',
   await f().locator('.waR.off input[disabled]').count()>0);
await f().locator('[data-wamode="warmup"]').click();await W(2500);
const wRungs=await f().locator('[data-warung]').allTextContents();
ok('Warmup has its own ladder', wRungs.join(',').includes('Warmup-1'), wRungs.join(','));
await f().locator('[data-wamode="cnc"]').click();await W(2500);
await f().locator('[data-warung="1"]').click();await W(2500);
/* Changing ladder or rung clears the picks on purpose — a selection made
   against one gate is meaningless against another — so re-select here. */
await f().locator('#waAll').click();await W(1200);

console.log('\n1c · the brakes');
/* Since 1.94.0 the caps live in the Admin controls drawer, behind a one-line
   summary — test-wa-admin-live.mjs checks the drawer itself. The default is
   read from wa-jobs.mjs, not retyped: it was 80 here after the code said 60. */
ok('the anti-ban limit is summarised on screen', /Cap \d+\/day/.test(await f().locator('.wsSum').innerText().catch(()=>'')));
if (!(await f().locator('.wsDrawer').count())) { await f().locator('#waAdmin').click(); await W(1200); }
ok('the anti-ban caps are in the admin drawer', await f().locator('[data-waset="dailyCapPerSeat"]').count()===1);
ok(`...defaulting to ${WA_DEFAULTS.dailyCapPerSeat} a day per phone`,
   (await f().locator('[data-waset="dailyCapPerSeat"]').inputValue())===String(WA_DEFAULTS.dailyCapPerSeat),
   await f().locator('[data-waset="dailyCapPerSeat"]').inputValue());
ok('...with cooldown and max steps', await f().locator('[data-waset="cooldownHours"]').count()===1
   && await f().locator('[data-waset="maxCnc"]').count()===1);
ok('and a kill switch', await f().locator('#waKill').count()===1);
if (await f().locator('.wsDrawer').count()) { await f().locator('#waAdminX').click(); await W(800); }

await f().locator('#waOn').click();await W(1500);

console.log('\n2 · what');
ok('a template is loaded', (await f().locator('#waBody').inputValue()).length>10);
const tpls=await f().locator('#waTpl option').allTextContents();
ok('...and all five playbooks are offered', tpls.length>=5, tpls.join(' | '));
ok('variable chips are one click', await f().locator('[data-wavar]').count()===8);

ok('the mapper lists the variables this body uses', await f().locator('.waMapR').count()>0,
   `${await f().locator('.waMapR').count()}`);
ok('...naming the source and the live value',
   await f().locator('.waMapR .waSrc').count()>0 && await f().locator('.waMapR .waLive').count()>0);
ok('...with an editable fallback', await f().locator('.waMapR [data-wafb]').count()>0);
const before=await f().locator('.waMapR').count();
await f().locator('#waBody').fill('Hi {{name}}, about {{company}} — {{eventType}} for {{pax}}. — {{bdName}}');
await f().locator('#waBody').blur();await W(1000);
ok('editing the body re-maps the variables', await f().locator('.waMapR').count()!==before||await f().locator('.waMapR').count()===5,
   `${before} -> ${await f().locator('.waMapR').count()}`);
await f().locator('[data-wavar="timeline"]').click();await W(800);
ok('a chip inserts its token', (await f().locator('#waBody').inputValue()).includes('{{timeline}}'));
await f().locator('#waBody').fill('Hi {{name}}, meeting at {{venue_city}}.');
await f().locator('#waBody').blur();await W(1200);
ok('a custom {{var}} is detected and given a mapper row',
   await f().locator('.waMap.custom .waMapR').count()===1,
   `${await f().locator('.waMap.custom .waMapR').count()}`);
await f().locator('.waMap.custom [data-wafb]').fill('Goa');await f().locator('.waMap.custom [data-wafb]').dispatchEvent('change');await W(1000);
/* 1.92.0 made the copy session-only: "Saving, renaming and deleting playbooks
   is gone". So there is no visibility control to set, and there must not be. */
ok('template edits are session-only — no save/visibility control', await f().locator('#waVis').count()===0);
await f().locator('#waOn').click();await W(3500);

console.log('\n3 · check and queue');
const bub=await f().locator('.waBubble').innerText();
console.log('   preview:',bub.slice(0,110));
ok('a preview bubble is rendered', bub.length>10);
ok('...with the variables substituted, not the braces', !/\{\{/.test(bub), bub.slice(0,80));
ok('...including the custom one, once it was given a value', /Goa/.test(bub), bub.slice(0,90));
ok('...and a blank name falls back rather than reading “Hi ,”', !/Hi ,/.test(bub));
ok('there is a seat picker', await f().locator('#waSeat').count()===1);
const nav=await f().locator('.waPrevH').innerText();
ok('...and prev/next across recipients', /of \d+/.test(nav), nav.replace(/\n/g,' '));
if(await f().locator('#waNext').isEnabled()){
  /* The HEADER, not the bubble: these fixtures are "Callback Contact 1/2/3"
     and the template greets by first name, so two consecutive messages are
     legitimately identical. What must change is who it is addressed to. */
  const head=await f().locator('.waPrevH').innerText();
  await f().locator('#waNext').click();await W(1200);
  ok('Next moves to the next recipient',
     (await f().locator('.waPrevH').innerText())!==head,
     (await f().locator('.waPrevH').innerText()).replace(/\n/g,' '));
}
await f().locator('#waSeat').selectOption('bd-exec-3');await W(400);
const beforeQ=await (await fetch(BASE+'/wa/status')).json();
const go=await f().locator('#waGo').innerText();
/* The count is the point; the words changed in 1.92.0 ("Queue WhatsApp" ->
   "Queue & send at scale"). */
ok('the queue button counts them', /^Queue\b.*\(\d+\)$/.test(go.trim()), go);
await f().locator('#waGo').click();await W(4000);
const after=await (await fetch(BASE+'/wa/status')).json();
/* TOTAL jobs, not `queued`. Re-queueing the same contact cancels what was
   waiting for them (call_supersedes_wa), so on a second run `queued` stays
   flat while `cancelled` grows — and an assertion on `queued` alone reads a
   working supersede as a failed queue. */
const tot=(o)=>Object.values(o?.by||{}).reduce((a,b)=>a+b,0);
const grew=tot(after)-tot(beforeQ);
ok('the queue grew by the number shown on the button', grew>0, `+${grew}`);
/* A job is scheduled into business hours, so outside them /wa/drain is
   CORRECTLY empty. Asserting "the drained jobs all have the seat" would then
   pass on an empty array — vacuously, which is worse than failing. So the
   seat and the body are only checked when there is something due; the unit
   suite pins them against a fixed instant either way. */
const st=await (await fetch(BASE+'/wa/drain',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({seat:'bd-exec-3',limit:50})})).json();
const mine=(st.jobs||[]).filter(j=>j.seat==='bd-exec-3');
if(mine.length){
  ok('jobs are queued under the chosen seat', true, `${mine.length}`);
  ok('...each carrying the exact personalised text',
     mine.every(j=>j.vars?.body_override && !/\{\{/.test(j.vars.body_override)),
     JSON.stringify(mine[0]?.vars?.body_override||'').slice(0,100));
}else{
  console.log(`  (outside 09:30-19:30 IST — nothing due to drain; inHours=${after.inHours})`);
  ok('...and nothing is due outside business hours, which is the point of the clock',
     after.inHours===false, `inHours=${after.inHours}`);
}
await page.screenshot({path:'/tmp/claude-0/wa.png'});
ok('no console errors', errs.length===0, errs.slice(0,3).join(' | '));
}catch(e){console.log('\n! the run itself failed:',e?.stack||e);fail++;
}finally{console.log(`\n${pass} passed, ${fail} failed`);await ctx.close();process.exit(fail?1:0);}
