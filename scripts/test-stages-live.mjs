import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const canon = JSON.parse(readFileSync('/home/user/kylas-kpi-tracker/docs/stages.json','utf8'));
const ctx=await chromium.launchPersistentContext('/tmp/claude-0/pf3',{headless:false,
  viewport:{width:1440,height:900},
  args:['--disable-extensions-except=/tmp/claude-0/exttest','--load-extension=/tmp/claude-0/exttest']});
const page=await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/CERT|404/.test(m.text()))errors.push(m.text());});
await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');
await page.waitForTimeout(700);
await page.locator('#enout-console-host').evaluate(h=>h.shadowRoot.querySelector('.fab').click());
await page.waitForTimeout(1600);
const F=()=>page.frames().find(f=>f.url().startsWith('chrome-extension'));

const live = await F().evaluate(() => ({
  stages: STAGES, ids: STAGE_ID, rungs: STAGE_RUNG, labels: LABEL,
  inverse: STAGES.every(c => STAGE_RUNG[c] + STAGE_PRIORITY[c] === 25),
}));
let bad = 0;
for (const s of canon.stages) {
  if (live.ids[s.code] !== s.id) { console.log(`✗ id  ${s.code}: ${live.ids[s.code]} != ${s.id}`); bad++; }
  if (live.rungs[s.code] !== s.rung) { console.log(`✗ rung ${s.code}: ${live.rungs[s.code]} != ${s.rung}`); bad++; }
  if (live.labels[s.code] !== s.label) { console.log(`✗ label ${s.code}: ${live.labels[s.code]} != ${s.label}`); bad++; }
}
console.log(`browser tables vs docs/stages.json : ${bad ? bad + ' mismatches' : 'all 24 match ✓'}`);
console.log(`rung + callOrder === 25            : ${live.inverse}`);
console.log(`stage dropdown                     : ${(await F().locator('#f-stage option').count())} options`);
console.log(`  first three                      : ${(await F().locator('#f-stage option').allTextContents()).slice(0,3).join(' | ')}`);
console.log(`company rung                       : ${(await F().locator('.kpi').textContent()).trim()}`);
// outcome keys still map correctly
await F().locator('.qi').first().click(); await page.waitForTimeout(250);
for (const [k,want] of [['3','MQL_MARKETING_QUALIFIED_LEAD'],['4','DISCOVERY_CALL_BOOKED'],['2','DISQUALIFIED_WRONG_POC']]) {
  await page.keyboard.press(k); await page.waitForTimeout(220);
  const got = await F().evaluate(()=>rec().stage);
  console.log(`key ${k}  -> ${got} ${got===want?'✓':'✗'}`);
}
const walk=[]; for(let i=0;i<4;i++){ await page.keyboard.press('1'); await page.waitForTimeout(220); walk.push(await F().evaluate(()=>rec().stage)); }
console.log('CNC walk ->', walk.join(' -> '));
console.log(errors.length?'ERRORS: '+errors.join('; '):'no page errors');
await ctx.close();
