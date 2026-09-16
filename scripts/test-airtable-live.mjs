import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const AT = 'http://127.0.0.1:9901';
const H = { Authorization: 'Bearer pattest' };
const reset = () => fetch(AT + '/__reset', { headers: H });
const dump = () => fetch(AT + '/__writes', { headers: H }).then(r => r.json());

await reset();
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pat', {
  headless: false, viewport: { width: 1600, height: 1000 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest', '--load-extension=/tmp/claude-0/exttest'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION|fonts/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));

await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(2500);
/* start from nothing: earlier runs leave contacts and stages in chrome.storage */
await F().evaluate(() => Store.wipe());
await page.reload();
await page.waitForTimeout(4000);
await page.locator('#enout-console-host').evaluate(h => h.shadowRoot.querySelector('.fab')?.click());
await page.waitForTimeout(3500);

/* Set the stage in script rather than by keystroke — a key press only reaches
   the iframe when it already has focus, which made this flaky. */
await F().evaluate(async () => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  cur = DATA.indexOf(a);
  a.stage = 'DISCOVERY_CALL_BOOKED';
  a.current = [{ rowKey: 'row-A', eventType: 'Employee offsites', budget: 'approx 9L', timeline: 'Q4 FY27', pax: '80', remarks: 'Founder wants Goa' }];
  a.past = [{ rowKey: 'row-B', eventType: 'Product launch', budget: '', timeline: 'Q1', pax: '', remarks: '' }];
  a.vendorInfo = 'First Event';
  render();
  await API.save(a, { at: new Date().toISOString(), outcome: 'Discovery', duration: 42, durationSource: 'dialed' });
});

/* Poll rather than guess: the writer queues with a gap and retries 429s. */
let d = null;
for (let i = 0; i < 30; i++) {
  d = await dump();
  if (d.tables.Contacts?.length && d.tables['Call Log']?.length) break;
  await page.waitForTimeout(500);
}
console.log('— tables written —');
for (const [t, rows] of Object.entries(d.tables)) console.log(`  ${t.padEnd(19)} ${rows.length} record(s)`);

const contact = d.tables.Contacts?.[0]?.fields || {};
console.log('\n— the contact row —');
for (const k of ['Kylas Contact ID','Name','Current Stage','KPI Rank','Ever Picked','Owner','Company'])
  console.log(`  ${k.padEnd(20)} ${JSON.stringify(contact[k])}`);

console.log('\n— event rows —');
for (const r of d.tables['Event Rows'] || [])
  console.log(`  ${r.fields['Row Key']}  ${r.fields.Period.padEnd(8)} budget=${JSON.stringify(r.fields.Budget)} timeline=${JSON.stringify(r.fields.Timeline)} pax=${JSON.stringify(r.fields.Pax)}`);

console.log('\n— call log —');
for (const r of d.tables['Call Log'] || [])
  console.log(`  outcome=${r.fields.Outcome} source=${r.fields['Duration Source']} stage=${r.fields['Stage Set']}`);

console.log('\n— stage transitions —');
for (const r of d.tables['Stage Transitions'] || [])
  console.log(`  ${r.fields['From Stage'] || '(new)'} -> ${r.fields['To Stage']}  source=${r.fields.Source}`);

console.log('\n— links resolve —');
const coId = d.tables.Companies?.[0]?.id;
console.log('  contact.Company ->', JSON.stringify(contact.Company), coId === contact.Company?.[0] ? '✓ matches the company record' : '✗');
const cId = d.tables.Contacts?.[0]?.id;
const rowLinks = (d.tables['Event Rows'] || []).every(r => r.fields.Contact?.[0] === cId);
console.log('  event rows -> contact :', rowLinks ? '✓' : '✗');

// ── the rank must not fall ──
await F().evaluate(async () => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  a.stage = 'CNC_COULD_NOT_CONNECT';            // rung 6, far below Discovery
  await API.save(a, null);
});
for (let i = 0; i < 20; i++) {
  d = await dump();
  if (d.tables.Contacts?.[0]?.fields?.['Current Stage'] === 'CNC_COULD_NOT_CONNECT') break;
  await page.waitForTimeout(500);
}
const after = d.tables.Contacts[0].fields;
console.log('\n— monotonic rank —');
console.log('  stage now :', after['Current Stage'], '| KPI Rank still', after['KPI Rank'],
  after['KPI Rank'] === 19 ? '✓ did not fall' : '✗ expected 19');
console.log('  Ever Picked still :', after['Ever Picked']);

// ── an edited row updates rather than duplicating; a removed one is deleted ──
await F().evaluate(async () => {
  const a = DATA.find(x => x.pocName === 'Hema Bharathi');
  a.current[0].budget = 'approx 12L, signed off';
  a.past = [];                                   // row-B removed
  await API.save(a, null);
});
for (let i = 0; i < 20; i++) {
  d = await dump();
  if ((d.tables['Event Rows'] || []).length === 1) break;
  await page.waitForTimeout(500);
}
console.log('\n— row upsert and cleanup —');
console.log('  event rows now :', (d.tables['Event Rows'] || []).length, '(expect 1, not 3)');
console.log('  budget         :', JSON.stringify(d.tables['Event Rows']?.[0]?.fields?.Budget));
console.log('  deletes issued :', d.writes.filter(w => w.kind === 'delete').length);

console.log('\n— call log idempotency —');
const keys = (d.tables['Call Log'] || []).map(r => r.fields.Key);
console.log('  rows:', keys.length, '| unique keys:', new Set(keys).size, keys.length === new Set(keys).size ? '✓' : '✗');

console.log(errors.length ? '\nERRORS:\n  ' + errors.slice(0, 5).join('\n  ') : '\nno page errors');
await ctx.close();
