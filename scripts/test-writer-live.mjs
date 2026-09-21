import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const MOCK = 'http://127.0.0.1:9900';
const reset = () => fetch(MOCK + '/__reset', { headers: { 'api-key': 'x' } });
const writes = () => fetch(MOCK + '/__writes', { headers: { 'api-key': 'x' } }).then(r => r.json());

await reset();

/* channel:'chromium' deliberately — Playwright's own bundled build does not
   load MV3 extensions, and the symptom is not an error: the content script
   never injects and every locator times out waiting for a frame that was
   never going to exist. HEADLESS=1 to run it where there is no display. */
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pwrite', {
  channel: 'chromium', headless: process.env.HEADLESS === '1', viewport: { width: 1600, height: 950 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest', '--load-extension=/tmp/claude-0/exttest'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));

// ── auto-open ──
await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(3500);
const opened = await page.locator('#enout-console-host').evaluate(h => h.classList.contains('open'));
console.log('auto-opened on a company page :', opened);
let f = F();

// ── company is fixed, not typeable ──
const co = await f.locator('#f-co').evaluate(n => ({ tag: n.tagName, text: n.textContent.trim(), value: n.dataset.value }));
console.log('company field                 :', JSON.stringify(co));

// ── Past renders above Current ──
console.log('event section order           :', (await f.locator('#formR .sec').evaluateAll(ns => ns.map(n => n.dataset.kind))).join(' -> '));

// ── conditional logic ──
await f.locator('.qi').first().click(); await page.waitForTimeout(300);
const logic = await F().evaluate(() => {
  const a = rec();
  const snap = () => ({ connected: connected(a), rightPOC: hasSignal(a), discovery: isComplete(a),
                        companyRung: companyStage(companyRoster(a.companyId)).t });
  const out = {};
  a.stage = 'CNC_COULD_NOT_CONNECT'; a.past = []; a.current = [];
  out['CNC, no data'] = snap();
  a.stage = 'MQL_MARKETING_QUALIFIED_LEAD';
  out['MQL, no data'] = snap();
  a.current = [{ eventType: '', budget: 'approx 8L', timeline: '', pax: '', remarks: '' }];
  out['+ budget only'] = snap();
  a.current = [{ eventType: 'Employee offsites', budget: 'approx 8L', timeline: 'Q4', pax: '60', remarks: '' }];
  out['+ full row'] = snap();
  a.current = []; a.past = [{ eventType: 'Offsite', budget: '40L', timeline: 'Q1', pax: '300', remarks: '' }];
  out['full PAST row'] = snap();
  render();
  return out;
});
console.log('\n— conditional logic —');
for (const [k, v] of Object.entries(logic))
  console.log(`  ${k.padEnd(16)} connected=${String(v.connected).padEnd(5)} rightPOC=${String(v.rightPOC).padEnd(5)} discovery=${String(v.discovery).padEnd(5)} company="${v.companyRung}"`);

// ── the writer ──
await F().evaluate(() => { const a = rec(); a.current = [{ eventType: 'Employee offsites', budget: 'approx 9L, not approved', timeline: 'Q4 FY27', pax: '80', remarks: 'Founder wants Goa' }]; a.vendorInfo = 'First Event'; render(); });
await page.waitForTimeout(300);
await page.keyboard.press('3'); await page.waitForTimeout(300);
await page.keyboard.press('Enter'); await page.waitForTimeout(2500);

const w = await writes();
console.log('\n— what reached Kylas —');
for (const x of w.writes) {
  if (x.kind === 'calllog') console.log(`  calllog  outcome=${x.body.outcome} duration=${x.body.duration} contact=${x.body.relatedTo.id}`);
  else console.log(`  ${x.kind.padEnd(8)} id=${x.id} stage=${x.body.customFieldValues?.cfPipelineStageBd} company=${x.body.company}`);
}
const upd = w.writes.find(x => x.kind === 'update');
if (upd) {
  console.log('\n— remarks written —');
  console.log(upd.body.remarks.split('\n').map(l => '  ' + l).join('\n'));
}

// ── a human's own text above the markers must survive ──
console.log('\n— second save over existing remarks —');
await F().evaluate(async () => {
  /* a contact that actually came from this fetch, not one left in storage */
  const a = DATA.find(x => String(x.companyId) === '1776620' && x.kid);
  await API.save(a, null);
});
await page.waitForTimeout(1500);
const w2 = await writes();
const last = w2.writes.filter(x => x.kind === 'update').at(-1);
console.log('  marker blocks in field      :', (last.body.remarks.match(/BD CONSOLE/g) || []).length, '(expect 1, not stacking)');

await page.screenshot({ path: '/tmp/claude-0/writer.png' });
console.log(errors.length ? '\nERRORS: ' + errors.join('; ') : '\nno page errors');
await ctx.close();
