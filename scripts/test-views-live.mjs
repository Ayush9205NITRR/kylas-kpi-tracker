import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* channel:'chromium' deliberately — Playwright's own bundled build does not
   load MV3 extensions, and the symptom is not an error: the content script
   never injects and every locator times out waiting for a frame that was
   never going to exist. HEADLESS=1 to run it where there is no display. */
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pviews', {
  channel: 'chromium', headless: process.env.HEADLESS === '1', viewport: { width: 1500, height: 950 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest','--load-extension=/tmp/claude-0/exttest'] });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/CERT|404|ERR_CONNECTION/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));

// seed a couple of companies with data
await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(3500);
await F().evaluate(() => {
  const set = (name, o) => { const a = DATA.find(x => x.pocName === name); if (a) Object.assign(a, o); };
  set('Hema Bharathi', { current:[{eventType:'Employee offsites',budget:'9L',timeline:'Q4',pax:'80',remarks:''}],
                         lastStageChangeAt:new Date().toISOString(), lastCallAt:new Date().toISOString() });
  set('Shipra Gupta',  { current:[{eventType:'',budget:'',timeline:'Q3',pax:'',remarks:''}],
                         lastStageChangeAt:new Date(Date.now()-3*864e5).toISOString(), lastCallAt:new Date().toISOString() });
  persist();
});
await page.waitForTimeout(500);

// ── the conditional rule, exactly as specified ──
const rule = await F().evaluate(() => {
  const t = (past, current) => ({ rightPOC: hasSignal({past,current}), discovery: isComplete({past,current}) });
  return {
    'event type only':        t([], [{eventType:'Employee offsites',budget:'',timeline:'',pax:''}]),
    'remarks only':           t([], [{eventType:'',budget:'',timeline:'',pax:'',remarks:'call Monday'}]),
    'past budget only':       t([{eventType:'',budget:'40L',timeline:'',pax:''}], []),
    'current timeline only':  t([], [{eventType:'',budget:'',timeline:'Q4',pax:''}]),
    'current pax only':       t([], [{eventType:'',budget:'',timeline:'',pax:'80'}]),
    'past full row':          t([{eventType:'',budget:'40L',timeline:'Q1',pax:'300'}], []),
    'split across rows':      t([{budget:'40L'}], [{timeline:'Q4'},{pax:'80'}]),
  };
});
console.log('— Right POC / Discovery rule —');
for (const [k,v] of Object.entries(rule))
  console.log(`  ${k.padEnd(22)} rightPOC=${String(v.rightPOC).padEnd(5)} discovery=${v.discovery}`);

// ── dashboard ──
await page.evaluate(() => history.pushState({}, '', '/sales/home'));
await page.waitForTimeout(2200);
let f = F();
console.log('\n— dashboard at /sales/home —');
console.log('  visible :', await f.locator('#viewport').isVisible());
for (const t of await f.locator('.vt').allTextContents()) console.log('   ', t.replace(/\s+/g,' ').trim());
console.log('  frozen days rows :', await f.locator('.vd').count());
await page.screenshot({ path: '/tmp/claude-0/view-dash.png' });

// ── companies list ──
await page.evaluate(() => history.pushState({}, '', '/sales/companies/list'));
await page.waitForTimeout(2200);
f = F();
console.log('\n— companies list at /sales/companies/list —');
console.log('  rows :', await f.locator('.vr[data-id]').count());
for (const r of await f.locator('.vr[data-id]').allTextContents()) console.log('   ', r.replace(/\s+/g,' ').trim());
console.log('  filters :', (await f.locator('.vfilters label').allTextContents()).map(s=>s.split('\n')[0]).join(' | '));
/* #fKpi, #fSource and #fStage are the multi-select popovers, and the Accounts
   view does not draw them — it has its own chip rows for the same dimensions,
   which is why Board and Table went away on 2026-09-19. This file kept
   clicking #fKpi and threw, taking the rest of the run with it. The filter
   that IS in this bar on every view is Focus, so that is what gets exercised
   here: Accounts is the tab people are on. */
for (const v of ['focus', 'depri', 'none', '']) {
  await f.locator('#fFocus').selectOption(v);
  await page.waitForTimeout(900); f = F();
  console.log(`  focus=${(v || 'all').padEnd(6)}    :`, await f.locator('.vr[data-id]').count(), 'row(s)');
}
/* Sticky header: after a scroll it must still be at the top of the scroller.
   Only meaningful when there is something to scroll — with a filter on there
   may be three rows and a short page, and "false" would say nothing. */
console.log('  header sticky       :', await f.locator('.vr.vh').evaluate((h) => {
  const port = h.closest('#viewport');
  if (port.scrollHeight <= port.clientHeight) return 'n/a — page does not scroll';
  port.scrollTop = 400;
  return Math.abs(h.getBoundingClientRect().top - port.getBoundingClientRect().top) < 3;
}));
console.log('  tabular figures     :', await f.locator('.vwrap').evaluate(n =>
  getComputedStyle(n).fontVariantNumeric));
await page.screenshot({ path: '/tmp/claude-0/view-companies.png' });

// back to a record page hides the view
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/1776620/'));
await page.waitForTimeout(2200);
console.log('\n  view hidden on a record page :', !(await F().locator('#viewport').isVisible()));
console.log(errors.length ? '\nERRORS: '+errors.join('; ') : '\nno page errors');
await ctx.close();
