import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pv2b', {
  headless:false, viewport:{width:1600,height:1000},
  args:['--disable-extensions-except=/tmp/claude-0/exttest','--load-extension=/tmp/claude-0/exttest'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: '+e.message));
page.on('console', m => { if (m.type()==='error' && !/CERT|404|ERR_CONNECTION|fonts/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));

await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(4000);
let f = F();

console.log('account rollup :', (await f.locator('#acct').textContent()).replace(/\s+/g,' ').trim());
console.log('top bar rows   :', await f.locator('.bar').evaluate(n => Math.round(n.getBoundingClientRect().height)) + 'px');

// the rollup must use the event rules, not the stage
await F().evaluate(() => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  a.current = [{eventType:'Employee offsites',budget:'9L',timeline:'Q4',pax:'80',remarks:''}];
  render();
});
await page.waitForTimeout(400); f = F();
console.log('after full row :', (await f.locator('#acct').textContent()).replace(/\s+/g,' ').trim());

// linkedin open
console.log('linkedin ↗     :', await f.locator('.withIcon .go').count(), 'button, disabled=', await f.locator('.withIcon .go').first().isDisabled());

// event chips drive the cards
await f.locator('.tc', { hasText: 'Product launch' }).click();
await page.waitForTimeout(400); f = F();
console.log('after chip tap :', await f.locator('.ev').count(), 'event card(s)');
console.log('sentence blanks:', await f.locator('.ev .bl input').count());
console.log('past/now seg   :', (await f.locator('.ev .seg button').allTextContents()).join('/'));

// keyboard outcome still works and walks CNC
await f.locator('body').click({ position: { x: 5, y: 5 } });
const walk = [];
for (let i=0;i<3;i++){ await page.keyboard.press('1'); await page.waitForTimeout(250); walk.push(await F().evaluate(()=>rec().stage)); }
console.log('CNC walk       :', walk.join(' -> '));

// dashboard sheet
await F().locator('#dashBtn').click(); await page.waitForTimeout(700); f = F();
console.log('dashboard sheet:', await f.locator('.sheet.wide').count(), '| tiles', await f.locator('.gt').count(), '| data link', await f.locator('#gdata').count());
await page.keyboard.press('Escape'); await page.waitForTimeout(300);

await page.screenshot({ path:'/tmp/claude-0/v2b.png' });
console.log(errors.length ? '\nERRORS:\n  '+errors.slice(0,6).join('\n  ') : '\nno page errors');
await ctx.close();
