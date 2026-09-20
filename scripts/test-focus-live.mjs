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
/* RECORD LINKS, BUILT BY CONSTRUCTION. The ladder counts COMPANIES, and a
   transition reaches its company only through Contact -> Company. A fixture
   without those links collapses every transition onto one empty company key,
   which reads as "the rung is broken" when it means "the fixture is". The mock
   hands out record ids sequentially in the seed file's key order, so they can
   be computed here rather than guessed. */
let recN = 0;
const rid = () => 'rec' + String(++recN).padStart(14, '0');
const ids = {};

const CO = [
  ['1776620', 'seats',              'Rubal Sansanwal', 'DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS', 22],
  ['1773706', 'vincitlabs',         'Rubal Sansanwal', 'MQL_MARKETING_QUALIFIED_LEAD',               14],
  ['903',     'Shorehouse Retail',  'Priya Deshmukh',  'SQL_SALES_QUALIFIED_LEAD',                   26],
  ['1778327', 'Kritsnam Analytics', 'Priya Deshmukh',  'CNC_COULD_NOT_CONNECT_2',                     7],
];
const qualified = (id) => id === '1776620' || id === '903';

const SEED = {};
SEED.Companies = CO.map(([id, Name, Owner, stage, rank]) => {
  ids['co:' + id] = rid();
  return { 'Kylas Company ID': id, Name, Owner, 'Kylas Stage': stage, 'KPI Stage': stage,
           'KPI Rank': rank, 'KPI Stage At': ago(4), 'Last Call At': ago(2) };
});
SEED.Contacts = CO.map(([id, , Owner, stage], i) => {
  ids['ct:' + id] = rid();
  return { Name: ['Hema Bharathi', 'Shipra Gupta', 'Devanshi Kalro', 'Arun Menon'][i],
           'Kylas Contact ID': 'c' + (i + 1), Owner, 'Current Stage': stage,
           Company: [ids['co:' + id]],
           'Is Right POC': qualified(id) ? 1 : 0, 'Is Discovery': qualified(id) ? 1 : 0,
           'KPI Rank At': ago(6) };
});

/* The history the ladder is counted from. Deliberately shaped so every rung
   has a different number and one company drops out at Phone picked:
     seats      CNC -> MQL -> Discovery done     reached, picked, right, discovery
     vincitlabs CNC -> MQL                       reached, picked
     Shorehouse MQL -> AR booked -> done -> SQL  all seven
     Kritsnam   CNC -> CNC 2                     reached ONLY — never left CNC
   So: reached 4, picked 3, right 2, discovery 2, booked 1, done 1, sql 1. */
const T = [];
const move = (coid, to, d) => T.push({
  Key: `${coid}-${d}`, 'From Stage': '', 'To Stage': to, 'Changed At': ago(d),
  Owner: CO.find((c) => c[0] === coid)[2], Source: 'Console', Contact: [ids['ct:' + coid]] });
move('1776620', 'CNC_COULD_NOT_CONNECT', 20);
move('1776620', 'MQL_MARKETING_QUALIFIED_LEAD', 14);
move('1776620', 'DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS', 6);
move('1773706', 'CNC_COULD_NOT_CONNECT', 18);
move('1773706', 'MQL_MARKETING_QUALIFIED_LEAD', 9);
move('903', 'MQL_MARKETING_QUALIFIED_LEAD', 25);
move('903', 'ACTIVE_REQUIREMENT_CALL_BOOKED', 12);
move('903', 'ACTIVE_REQUIREMENT_CALL_DONE_\u2013_AWAITING_CLIENT_INPUTS', 8);
move('903', 'SQL_SALES_QUALIFIED_LEAD', 5);
move('1778327', 'CNC_COULD_NOT_CONNECT', 15);
move('1778327', 'CNC_COULD_NOT_CONNECT_2', 7);
SEED['Stage Transitions'] = T; T.forEach(rid);

SEED.Focus = [
  { 'Kylas Company ID': '903', 'Company Name': 'Shorehouse Retail', Status: 'focus',
    Reason: '', Note: '', Owner: 'Priya Deshmukh', 'Set By': 'priya@enout.in', 'Set At': ago(3) },
  { 'Kylas Company ID': '1773706', 'Company Name': 'vincitlabs', Status: 'focus',
    Reason: '', Note: '', Owner: 'Rubal Sansanwal', 'Set By': 'rubal@enout.in', 'Set At': ago(1) },
  { 'Kylas Company ID': '1778327', 'Company Name': 'Kritsnam Analytics', Status: 'depri',
    Reason: "Can't reach the right POC", Note: 'Four attempts, switchboard only, no direct line anywhere.',
    Owner: 'Priya Deshmukh', 'Set By': 'priya@enout.in', 'Set At': ago(2) },
];
SEED.Focus.forEach(rid);

SEED.Research = [
  /* Employees is "501-1,000" with a PLAIN HYPHEN where the field list offers an
     en dash. Deliberate: it is the shape of a value entered before this form
     existed, and the check below is that it survives rather than being blanked
     by a <select> that cannot match it.
     Funding and Recent Trigger are here because they are what the strip on the
     company page is for — Ayush, 2026-09-20: "I can show that this company has
     raised funding, so that they're able to see that". */
  { 'Kylas Company ID': '903', 'Company Name': 'Shorehouse Retail', Industry: 'Retail',
    Employees: '501-1,000', 'HQ City': 'Mumbai', 'Other Offices': '',
    Funding: 'Series C, Mar 2026 - $40M led by Accel',
    'Recent Trigger': 'Opened a Pune office in August; hiring 120',
    'Event Season': 'Q3 FY27 / Oct-Dec', 'Decides Events': 'CHRO + Admin head',
    'Known Events': 'Annual dealer meet, regional store openings',
    'Updated By': 'priya@enout.in', 'Updated At': ago(5) },
];
SEED.Research.forEach(rid);

/* In Funnel, not Active: counter() reads In Funnel and nothing else, and a
   roster where it is missing excludes everybody — every rung reads zero with
   the reason only visible in `excluded`. */
SEED.Team = [
  { Name: 'Rubal Sansanwal', Role: 'Business Development Associate', 'In Funnel': true, Note: '' },
  { Name: 'Priya Deshmukh', Role: 'Business Development Associate', 'In Funnel': true, Note: '' },
];
SEED.Team.forEach(rid);

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

/* ── save locks a card, edit reopens it ─────────────────────── */
/* A card used to be an always-open form whether it held numbers somebody spent
   a call earning or nothing at all, which is what let one tap reach them. */
console.log('\n— save and edit an event card —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(3000);
f = F();
await f.locator('#formR .tc', { hasText: 'Employee offsites' }).click();
await page.waitForTimeout(400);
check('a new chip opens ready to type', await f.locator('#formR .ev.editing').count(), 1);
await f.evaluate(() => {
  const r = rec().current.find((x) => x.eventType === 'Employee offsites');
  Object.assign(r, { budget: '9L', timeline: 'Q4', pax: '80', remarks: 'they asked for a quote' });
  renderRight();
});
await page.waitForTimeout(300);
await f.locator('#formR .evsave').click();
await page.waitForTimeout(400);
check('save locks it', await f.locator('#formR .ev.evlock').count(), 1);
check('and there is nothing left to type into', await f.locator('#formR .ev.evlock input').count(), 0);
check('the numbers read back', (await f.locator('.evsum').textContent() || '').replace(/\s+/g, ' '),
      (t) => /80/.test(t) && /Q4/.test(t) && /9L/.test(t));
await f.locator('#formR .evedit').click();
await page.waitForTimeout(400);
check('edit reopens it', await f.locator('#formR .ev.editing').count(), 1);
check('with the value still in the field', await f.locator('#formR .bl input').nth(2).inputValue(), '9L');

/* ── a selection made during a fetch is not overruled by it ───────── */
/* openCompany() captured the selected record BEFORE its await and restored it
   after, so clicking the second contact while the company was still loading
   put you back on the first. Verified to FAIL without the epoch guard. */
console.log('\n— picking a contact mid-fetch —');
const race = await f.evaluate(async () => {
  if (DATA.filter((a) => String(a.companyId) === '903').length < 2) {
    const base = DATA.find((a) => String(a.companyId) === '903');
    DATA.push({ ...structuredClone(base), kid: '99001', lid: 'race-2',
                pocName: 'Second Poc', past: [], current: [], removed: [] });
  }
  const real = API.company;
  API.company = (id) => new Promise((r) => setTimeout(() => real(id).then(r), 1200));
  openCompanyFromView('903', 'Shorehouse Retail');
  await new Promise((r) => setTimeout(r, 400));
  const rows = visible();
  const want = rows[1].i, wantName = DATA[want].pocName;
  chooseRecord(want); render();
  await new Promise((r) => setTimeout(r, 2000));
  API.company = real;
  return { wantName, after: DATA[cur].pocName };
});
check('the reply does not drag the selection back', race.after, race.wantName);

/* ── an event row removed is not an event row lost ────────────────── */
/* THE REGRESSION. Tapping a lit chip used to hard-drop the row, and on the
   next save syncContact DELETED the Airtable record — taking the budget,
   timeline and pax with it and pulling Right POC and Successful Discovery back
   down. Nothing else in the base keeps those values. */
console.log('\n— removing an event row —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(3000);
f = F();

// tag an event type and fill the qualification fields
await f.evaluate(() => {
  const a = rec();
  a.current = [{rowKey:'rk-test', eventType:'Employee offsites', budget:'9L', timeline:'Q4', pax:'80', remarks:'they asked'}];
  touch('record'); renderRight(); refreshQual();
});
await page.waitForTimeout(400);
console.log('— a tagged event with data on it —');
check('the card is there', await f.locator('#formR .ev').count(), 1);
check('qualification reads Right POC', await f.evaluate(() => qualOf(rec())), (q) => q !== 'MQL');

// the destructive click
console.log('\n— tapping the lit chip —');
await f.locator('#formR .tc', { hasText: 'Employee offsites' }).click();
await page.waitForTimeout(400);
check('the card goes away', await f.locator('#formR .ev').count(), 0);
check('but the row is KEPT', await f.evaluate(() => rec().removed.length), 1);
check('with its budget intact', await f.evaluate(() => rec().removed[0].budget), '9L');
check('an undo is offered', (await f.locator('.toast').textContent() || ''), (t) => /removed/.test(t));
check('and a restore line is on screen', await f.locator('.evgone .gb').count(), 1);
check('which shows what would come back', await f.locator('.evgone .v').textContent(), (t)=>/9L/.test(t||''));

console.log('\n— restoring it —');
await f.locator('.evgone .gb').click();
await page.waitForTimeout(400);
check('the card is back', await f.locator('#formR .ev').count(), 1);
check('budget survived the round trip', await f.evaluate(() => rec().current.find(r=>r.eventType==='Employee offsites')?.budget), '9L');
check('and it is out of removed', await f.evaluate(() => rec().removed.length), 0);
check('qualification restored', await f.evaluate(() => qualOf(rec())), (q) => q !== 'MQL');

console.log('\n— an empty tag is still a plain toggle —');
await f.locator('#formR .tc', { hasText: 'Product launch' }).click();
await page.waitForTimeout(300);
await f.locator('#formR .tc', { hasText: 'Product launch' }).click();
await page.waitForTimeout(300);
check('no restore line for an empty row', await f.locator('.evgone .gb').count(), 0);


/* ── the ladder ───────────────────────────────────────────────────────── */
console.log('\n— the ladder —');
await page.evaluate(() => history.pushState({}, '', '/sales/home'));
await page.waitForTimeout(3000);
f = F();
/* Everyone, and a quarter wide enough to hold the seeded history. The mock
   Kylas user is not one of the two BDs, so the default "Me" scope correctly
   counts nothing — that is not the bug being tested here. */
await f.locator('#dOwner').selectOption('all');
await page.waitForTimeout(2000);
await f.locator('.vperiod button', { hasText: 'Quarter' }).click().catch(() => {});
await page.waitForTimeout(2500);
f = F();

const ladder = await f.locator('table.ladder tbody tr').evaluateAll((rs) => rs.map((r) => ({
  /* The rung number is its own <i> inside .rungname, so textContent is
     "\n  1Companies reached" — trim BEFORE stripping the digits. */
  rung: r.querySelector('.rungname')?.textContent?.trim().replace(/^\d+/, '').trim(),
  n: Number(r.querySelector('.teamcol b')?.textContent?.trim() || 0),
})));
check('seven rungs', ladder.length, 7);
/* THE REGRESSION THIS SUITE EXISTS FOR. FLOORS in report.mjs held only
   booked/done/sql, so firstArrivals() could never emit worked or picked and
   the top two rungs were structurally zero — every rung below them had
   numbers, which reads as a broken funnel rather than an absent metric. */
check('rung 1 is Companies reached', ladder[0]?.rung, 'Companies reached');
check('rung 1 is NOT zero', ladder[0]?.n, 4);
check('rung 2 is Phone picked', ladder[1]?.rung, 'Phone picked');
/* Kritsnam never left the CNC ladder, so it is reached and not picked. */
check('phone picked excludes a CNC-only company', ladder[1]?.n, 3);
check('right POC', ladder[2]?.n, 2);
check('discovery', ladder[3]?.n, 2);
check('booked', ladder[4]?.n, 1);
check('done', ladder[5]?.n, 1);
check('sql', ladder[6]?.n, 1);
/* A funnel that widens is a real finding, but this fixture should not: each
   rung must be at most the one above it. */
check('the ladder descends', ladder.every((r, i) => i === 0 || r.n <= ladder[i - 1].n), true);
await page.screenshot({ path: '/tmp/claude-0/live-ladder.png' });

/* ── research on the company page, not behind a button ────────────────── */
console.log('\n— research on the company page —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(3000);
f = F();
check('the strip is on the page', await f.locator('.ares').count(), 1);
/* Collapsed at five facts, and the funding line is the peek — the whole point
   is that somebody about to dial sees it without asking for it. */
check('the funding shows without opening anything',
      await f.locator('.ares .peek').textContent(), (t) => /Series C/.test(t || ''));
await f.locator('#accResToggle').click();
await page.waitForTimeout(400);
const facts = await f.locator('.ares dl > div').evaluateAll((ds) => ds.map((d) =>
  d.querySelector('dt').textContent + '=' + d.querySelector('dd').textContent));
check('expanding shows every fact we hold', facts.length, 5);
check('funding is one of them', facts.join('|'), (t) => /Funding.*Series C/.test(t));
check('so is the recent trigger', facts.join('|'), (t) => /Recent trigger.*Pune/.test(t));
/* Research notes and industry are deliberately NOT here — they are context,
   not an opener, and a paragraph would push the queue off the screen. */
check('research notes stay in the form', facts.join('|'), (t) => !/Research notes/.test(t));
await f.evaluate(() => render());
await page.waitForTimeout(300);
check('it survives a render', await f.locator('.ares dl > div').count(), 5);

/* ── the focus lists view ─────────────────────────────────────────────── */
console.log('\n— focus lists —');
/* THE REAL KYLAS URL, and then the tab. There used to be a
   /sales/companies/list/focus route; Kylas has no such page, so the overlay
   drew the focus lists on top of Kylas' own 404 and the only way in was to
   send the CRM somewhere it does not go. */
await page.evaluate(() => history.pushState({}, '', '/sales/companies/list'));
await page.waitForTimeout(2800);
f = F();
check('the companies screen has both tabs', await f.locator('.vtabs button').count(), 2);
check('accounts is the one selected', await f.locator('.vtabs button[aria-pressed="true"]').textContent(),
      (t) => /Accounts/.test(t || ''));
await f.locator('.vtabs button[data-tab="focus"]').click();
await page.waitForTimeout(2500);
f = F();
check('the tab switch keeps the tabs on screen', await f.locator('.vtabs button').count(), 2);
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

/* The tab is remembered, so coming back lands where you left. */
await page.evaluate(() => history.pushState({}, '', '/sales/home'));
await page.waitForTimeout(1500);
await page.evaluate(() => history.pushState({}, '', '/sales/companies/list'));
await page.waitForTimeout(2800);
f = F();
check('the focus tab is remembered', await f.locator('.vtabs button[aria-pressed="true"]').textContent(),
      (t) => /Focus/.test(t || ''));

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
