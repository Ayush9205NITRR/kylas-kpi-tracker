/* The focus list and the research form, in a real browser.
 *
 *   node scripts/test-focus-live.mjs --seed > /tmp/focus-seed.json
 *   MOCK_AIRTABLE_SEED=/tmp/focus-seed.json node scripts/mock-airtable.mjs
 *   node scripts/mock-kylas.mjs
 *   node scripts/proxy.mjs                   # pointed at both
 *   node scripts/test-focus-live.mjs
 *
 * The rows it needs are in --seed rather than in a checked-in fixture because
 * the assertions below name them: a seed that drifts from the test is a run
 * that fails for a reason nobody can find. Restart the mock between runs —
 * the test writes, so a second run starts from a base the first one changed.
 *
 * These are the two things in this base that Kylas knows nothing about, so
 * there is nothing upstream to check them against — the only proof they work
 * is the round trip: click it here, read it back from Airtable there.
 *
 * channel:'chromium', not the bundled build. Playwright's own chromium does
 * not load MV3 extensions, and the symptom is not an error — the content
 * script simply never injects and every locator times out looking for a frame
 * that was never going to exist.
 */
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const SEED = {
  Companies: [
    { 'Kylas Company ID': '1776620', Name: 'seats', Owner: 'Rubal Sansanwal',
      'Kylas Stage': 'DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS',
      'KPI Stage': 'DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS', 'Right POC': 1 },
    { 'Kylas Company ID': '1773706', Name: 'vincitlabs', Owner: 'Rubal Sansanwal',
      'Kylas Stage': 'MQL_MARKETING_QUALIFIED_LEAD', 'KPI Stage': 'MQL_MARKETING_QUALIFIED_LEAD', 'Right POC': 1 },
    { 'Kylas Company ID': '903', Name: 'Shorehouse Retail', Owner: 'Priya Deshmukh',
      'Kylas Stage': 'SQL_SALES_QUALIFIED_LEAD', 'KPI Stage': 'SQL_SALES_QUALIFIED_LEAD', 'Right POC': 1 },
    { 'Kylas Company ID': '1778327', Name: 'Kritsnam Analytics', Owner: 'Priya Deshmukh',
      'Kylas Stage': 'CNC_COULD_NOT_CONNECT_2', 'KPI Stage': 'CNC_COULD_NOT_CONNECT_2', 'Right POC': 0 },
  ],
  Focus: [
    { 'Kylas Company ID': '903', 'Company Name': 'Shorehouse Retail', Status: 'focus',
      Reason: '', Note: '', Owner: 'Priya Deshmukh', 'Set By': 'priya@enout.in', 'Set At': ago(3) },
    { 'Kylas Company ID': '1773706', 'Company Name': 'vincitlabs', Status: 'focus',
      Reason: '', Note: '', Owner: 'Rubal Sansanwal', 'Set By': 'rubal@enout.in', 'Set At': ago(1) },
    { 'Kylas Company ID': '1778327', 'Company Name': 'Kritsnam Analytics', Status: 'depri',
      Reason: "Can't reach the right POC", Note: 'Four attempts, switchboard only, no direct line anywhere.',
      Owner: 'Priya Deshmukh', 'Set By': 'priya@enout.in', 'Set At': ago(2) },
  ],
  Research: [
    /* "501-1,000" with a PLAIN HYPHEN, where the field list offers an en dash.
       Deliberate: it is the shape of every value this base already holds from
       before the form existed, and the check below is that such a value is
       kept rather than silently blanked by a <select> that cannot match it. */
    { 'Kylas Company ID': '903', 'Company Name': 'Shorehouse Retail', Industry: 'Retail',
      Employees: '501-1,000', 'HQ City': 'Mumbai', 'Other Offices': '',
      'Known Events': 'Annual dealer meet, regional store openings',
      'Updated By': 'priya@enout.in', 'Updated At': ago(5) },
  ],
  Team: [
    { Name: 'Rubal Sansanwal', Role: 'Business Development Associate', Active: true, Note: '' },
    { Name: 'Priya Deshmukh', Role: 'Business Development Associate', Active: true, Note: '' },
  ],
};
if (process.argv.includes('--seed')) { console.log(JSON.stringify(SEED, null, 2)); process.exit(0); }

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');

const seedPath = process.env.MOCK_AIRTABLE_SEED || '(run with --seed and point the mock at it)';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pfocuslive', {
  channel: 'chromium', headless: true, viewport: { width: 1500, height: 950 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest', '--load-extension=/tmp/claude-0/exttest'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION|fonts|favicon/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find(f => f.url().startsWith('chrome-extension'));
const strip = async (f) => (await f.locator('#qacct').textContent()).replace(/\s+/g, ' ').trim();
const seg = async (f) => (await f.locator('.aseg button').evaluateAll(
  bs => bs.map(b => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`))).join(' | ');

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n         got: ${JSON.stringify(got)}`}`);
};

console.log(`seed: ${seedPath}\n`);

/* ── the strip on a company page ──────────────────────────────────────── */
await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');
await page.waitForTimeout(4500);
let f = F();
if (!f) { console.log('! no console frame — is the extension built at /tmp/claude-0/exttest?'); process.exit(1); }

console.log('— the account strip —');
check('a picked account reads as picked', await seg(f), '★ Focus* | Not picked | Deprioritize');
check('it says who picked it and when', await strip(f), (s) => /Picked .* by .+@/.test(s));

/* ── the research form ────────────────────────────────────────────────── */
console.log('\n— research —');
await f.locator('#accRes').click();
await page.waitForTimeout(1200);
check('every declared field is drawn', await f.locator('.rf').count(), (n) => n >= 15);
check('a saved value comes back', await f.locator('.rf input[data-k="industry"]').inputValue(), 'Retail');
/* A VALUE THE LIST DOES NOT OFFER IS STILL THE VALUE. The base holds whatever
   was typed into it before this form existed; a <select> with no matching
   <option> renders blank and posts "" on the next save, which loses it
   silently. The seeded "501-1,000" has a hyphen where the list has an en dash
   precisely so this is exercised. */
check('an unlisted value is kept, not blanked',
      await f.locator('.rf select[data-k="size"]').inputValue(), (v) => v !== '');
check('and is marked as unlisted', await f.locator('.rodd').count(), 1);

await f.locator('.rf input[data-k="hq"]').fill('Navi Mumbai');
await f.locator('#rsave').click();
await page.waitForTimeout(1500);
check('saving closes the sheet', await f.locator('.scrim').count(), 0);
check('the count on the strip moves', await strip(f), (s) => /Research \d+\/\d+/.test(s));

/* ── deprioritising ───────────────────────────────────────────────────── */
console.log('\n— deprioritize —');
await f.locator('.aseg button[data-fs="depri"]').click();
await page.waitForTimeout(400);
check('the reason form opens', await f.locator('#accDrop').count(), 1);
check('the reasons come from the proxy, not from the console',
      await f.locator('#accReason option').count(), (n) => n >= 8);

await f.locator('#accDrop button[type="submit"]').click();
await page.waitForTimeout(400);
check('no reason, no write', await f.locator('#accDrop').count(), 1);
check('and it says why', (await f.locator('.toast').allTextContents()).join(' '), (s) => /Pick a reason/.test(s));

/* THE HAZARD THIS GUARDS. paintAccount() runs on every render(), and render()
   runs when the stage changes or a callback button is pressed — either of
   which a person can do mid-sentence. Rebuilding the strip then would take the
   focus out of the field they are typing in. */
await f.locator('#accNote').click();
await f.locator('#accNote').type('Half a sentence so far');
await f.evaluate(() => render());
await page.waitForTimeout(200);
check('a render mid-typing keeps the text', await f.locator('#accNote').inputValue(), 'Half a sentence so far');
check('and keeps the cursor in the field', await f.evaluate(() => document.activeElement?.id), 'accNote');

await f.locator('#accReason').selectOption('Timing — revisit next quarter');
await f.locator('#accDrop button[type="submit"]').click();
await page.waitForTimeout(1500);
/* The other half of the same guard: the repaint that REMOVES the form happens
   while the focus is on its own Save button, so a guard that only asked "is
   the focus in there" would skip the one repaint that matters. */
check('saving closes the form', await f.locator('#accDrop').count(), 0);
check('the strip flips to dropped', await seg(f), '★ Focus | Not picked | Deprioritize*');
check('and shows the reason', await strip(f), (s) => /Timing — revisit next quarter/.test(s));
await f.evaluate(() => render());
await page.waitForTimeout(200);
check('which survives a render', await seg(f), '★ Focus | Not picked | Deprioritize*');

/* ── the focus lists view ─────────────────────────────────────────────── */
console.log('\n— focus lists —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/list/focus'));
await page.waitForTimeout(2800);
f = F();
check('the view renders', await f.locator('#viewport').isVisible(), true);
check('the drop just made is in it', await f.locator('.vr.frow5:not(.vh)').count(), (n) => n >= 1);
/* The stage comes from the companies cache, which only the companies view used
   to fill — opening this one first showed a column of blanks. */
check('rows carry the stage', (await f.locator('.vr.frow5:not(.vh)').first().innerHTML()), (h) => /<em>[^<]+<\/em>/.test(h));
check('there is a card per BD', await f.locator('.fcard').count(), (n) => n >= 1);

const before = await f.locator('.vr.frow5:not(.vh)').count();
await f.locator('[data-restore]').first().click();
await page.waitForTimeout(1600);
check('restore takes the row away', await f.locator('.vr.frow5:not(.vh)').count(), before - 1);

/* ONE CACHE, BOTH SCREENS. The strip and this view read the same FOCUS.rows;
   two copies would have the company page still calling a restored account
   dropped. */
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(2500);
f = F();
check('the company page agrees with the restore', await seg(f), (s) => !/Deprioritize\*/.test(s));

console.log(`\nerrors: ${errors.length ? errors.join('\n  ') : 'none'}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await ctx.close();
process.exit(failures || errors.length ? 1 : 0);
