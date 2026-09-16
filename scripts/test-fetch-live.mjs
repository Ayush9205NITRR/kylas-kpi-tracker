import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const EXT = '/tmp/claude-0/exttest';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pfetch', {
  headless: false, viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION/.test(m.text())) errors.push(m.text()); });

const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));
const open = async () => {
  await page.locator('#enout-console-host').evaluate(h => h.shadowRoot.querySelector('.fab').click());
  await page.waitForTimeout(2500);
};

// company 1776620 exists only in Kylas, not in the console's local data
await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(700);
await open();
let f = F();

console.log('link state      :', await f.locator('#linkState').textContent(), '|', await f.locator('#linkState').getAttribute('title'));
console.log('company name    :', (await f.locator('.coName .nm b').textContent()).trim());
console.log('roster          :', await f.locator('.qi').count(), 'contacts fetched from Kylas');
for (const r of await f.locator('.qi').all()) console.log('   ', (await r.textContent()).replace(/\s+/g, ' ').trim());
console.log('tiles           :', (await f.locator('.tile').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | '));
console.log('company rung    :', (await f.locator('.kpi').textContent()).trim());

// a contact whose stage arrived as a numeric picklist id
const hema = await f.evaluate(() => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  return a && { stage: a.stage, owner: a.owner, phone: a.phones[0]?.value, company: a.company, kid: a.kid };
});
console.log('\nid -> code      :', JSON.stringify(hema));

// the contact with no phone / stage / company must not break anything
const odd = await f.evaluate(() => {
  const a = DATA.find(x => String(x.kid) === '99001');
  return a && { name: a.pocName, phones: a.phones.length, stage: a.stage || '(blank)', company: a.company || '(none)' };
});
console.log('sparse record   :', JSON.stringify(odd));

// ── the merge must not destroy local work ──
await f.locator('.qi', { hasText: 'Hema' }).click();
await page.waitForTimeout(300);
await F().evaluate(() => {
  const a = rec();
  a.current.push({ eventType: 'Employee offsites', budget: 'approx 9L', timeline: 'Q4', pax: '80', remarks: '' });
  a.vendorInfo = 'First Event';
  a.flagged = true;
  render();
});
await page.waitForTimeout(300);
console.log('\nbefore refetch  :', JSON.stringify(await F().evaluate(() => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  return { current: a.current.length, vendor: a.vendorInfo, flagged: a.flagged, designation: a.designation };
})));

// navigate away and back — forces a second fetch over the top of local edits
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(2200);
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/1776620/'));
await page.waitForTimeout(2500);
console.log('after refetch   :', JSON.stringify(await F().evaluate(() => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  return { current: a.current.length, vendor: a.vendorInfo, flagged: a.flagged, designation: a.designation };
})));

// second company, fetched fresh
console.log('\nother company   :', (await F().locator('.qi').count()), 'contacts at 1776620 after round trip');
await page.screenshot({ path: '/tmp/claude-0/fetch.png' });

console.log(errors.length ? '\nERRORS: ' + errors.join('; ') : '\nno page errors');
await ctx.close();
