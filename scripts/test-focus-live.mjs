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
           /* THE RIGHT POC WHO NEVER MOVED STAGE, seeded on purpose. Shorehouse
              gets its own First Right POC At and NO KPI Rank At; everyone else
              keeps the rank date. Ayush, 2026-09-21: "2 right POCs and 1
              discovery call, but these are not reflecting in the KPI
              dashboard." Is Right POC is a formula that goes true when an event
              row carries a budget — no stage moves, so the rank never rises, so
              there was no date and the report dropped the arrival. With that
              one row undated the rungs below read right 1 / discovery 1 instead
              of 2, which is what the assertions further down catch. */
           ...(id === '903'
             ? { 'First Right POC At': ago(6), 'First Discovery At': ago(6) }
             : { 'KPI Rank At': ago(6) }),
           /* First Picked At means somebody ANSWERED, so Kritsnam — which
              never left the CNC ladder — must not carry one, or rung 2 counts
              it and "phone picked" stops excluding a company nobody spoke to. */
           'First Worked At': ago(20),
           ...(id === '1778327' ? {} : { 'First Picked At': ago(18) }) };
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

/* THEIR enrichment base, standing in for app55PsyRKqkf2CAQ /
   tbl2Jje9EBC4Cqydw. Ayush, 2026-09-21: "the research section should be taken
   from airtable (every company id has a research section)".

   The column names are copied VERBATIM from that message — "linkedin -
   Appollo" with the typo, "No. of Employees (kylas)" with the full stop and
   the brackets, "at_rev_per_employee" in snake case. Loose matching that is
   only ever tested against tidy names is not tested, and I cannot see the real
   table to check. The second row is deliberately half-filled: most enrichment
   tables are, and a panel that renders blanks for the missing half is worse
   than one that leaves them out.

   Employees is a NUMBER, not a string, because Airtable returns it as one and
   `.trim()` on a number is a TypeError that would take the whole panel down.
   live-stack.sh points RESEARCH_TABLE at this. */
SEED['Apollo Research'] = [
  { 'Kylas Company ID': '903',
    'linkedin - Appollo': 'https://www.linkedin.com/company/shorehouse',
    'Boolean Post link': 'https://www.google.com/search?q=shorehouse+offsite',
    'Total Funding': '$48M', 'Latest Funding Amount': '$40M',
    'Latest Funding Type': 'Series C',
    'Source - Concatenate': 'Apollo · LinkedIn · Tracxn',
    'Account Pipeline Stage': 'SQL', 'Annual Revenue': '₹320 Cr',
    'No. of Employees (kylas)': 760, at_rev_per_employee: 4210526 },
  { 'Kylas Company ID': '1776620',
    'linkedin - Appollo': 'https://www.linkedin.com/company/seats',
    'Total Funding': '$6M', 'Latest Funding Type': 'Seed',
    'Annual Revenue': '₹40 Cr', 'No. of Employees (kylas)': 85,
    'Source - Concatenate': 'Apollo' },
];
SEED['Apollo Research'].forEach(rid);

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
/* TWO CLICKS NOW, DELIBERATELY. #accRes opens the research COLUMN, beside the
   call — reading it must not cover the thing you are working. The sheet is one
   more click, on Edit research, because editing is the one job that earns the
   whole screen. */
console.log('\n— research —');
await f.locator('#accRes').click();
await page.waitForTimeout(500);
check('reading it does not cover anything', await f.locator('.scrim').count(), 0);
check('it is a column, not a sheet', await f.locator('#split').getAttribute('data-res'), 'on');
await f.locator('#accResEdit').click();
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
/* The peek sits between the word and the count now — "Research · Series C,
   Mar 2026 · 8/15" — so the two are no longer adjacent. */
check('the control still carries its count', await strip(f), (s) => /Research\b.*\d+\/\d+/.test(s));

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

/* ── which build is actually running ───────────────────────── */
/* The manifest version was identical on two branches four features apart, so
   "did my pull land" had no answer anybody could see, and four rounds went by
   on screenshots. The console hashes the JS Chrome is serving and the proxy
   hashes the same files on disk. */
console.log('\n— the build handshake —');
const build = await f.evaluate(async () => {
  await API.health?.();
  return { line: API.buildLine, stale: API.staleProxy, note: API.staleNote };
});
check('the console knows its own build', build.line, (v) => /^[0-9a-f]{8}/.test(v || ''));
check('and names the branch it came from', build.line, (v) => /\//.test(v || ''));
/* Both halves are the same checkout here, so they must agree. Verified to FAIL
   on a one-line edit to a console file — the message then names both causes,
   a missed reload and Chrome loading a different folder. */
check('console and proxy agree', build.stale, false);
check('so nothing is warned about', build.note, '');
/* On the dashboard, not here — the company page has no .vbuild. Checked where
   it actually lives, below, rather than asserting something always true. */

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
/* nth(1), not nth(2): timeline stopped being a free-text blank when it
   became the quarter/month/date picker, so the sentence now holds two .bl
   inputs — pax and budget — rather than three. */
check('with the value still in the field', await f.locator('#formR .bl input').nth(1).inputValue(), '9L');

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
/* THE CARD'S ×, not the chip. The chip used to toggle, which made it the one
   control on screen that could destroy a filled-in card — and it also made a
   second offsite impossible to record. It always adds now; removing is the ×,
   which keeps the row, offers an undo and leaves it restorable. */
console.log('\n— removing it with the card\u2019s × —');
check('the chip adds rather than removes', await f.evaluate(() => {
  const before = rec().current.length;
  document.querySelectorAll('#formR .tc').forEach((b) => {
    if (b.textContent.includes('Employee offsites')) b.click();
  });
  const after = rec().current.length;
  /* put it back the way the rest of this block expects */
  rec().current = rec().current.slice(0, before); renderRight();
  return after > before;
}), true);
await page.waitForTimeout(300);
await f.locator('#formR .ev .del').first().click();
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
/* THE SECOND REGRESSION OF THE SAME SHAPE. Shorehouse's contact is seeded
   with First Right POC At and no KPI Rank At — a contact who gave a budget
   without the stage moving. The proxy used to date these from KPI Rank At
   alone and `continue` past the ones that had none, so this rung read 1.
   Ayush, 2026-09-21: "2 right POCs… not reflecting in the KPI dashboard." */
check('right POC', ladder[2]?.n, 2);
check('discovery', ladder[3]?.n, 2);
check('booked', ladder[4]?.n, 1);
check('done', ladder[5]?.n, 1);
check('sql', ladder[6]?.n, 1);
/* A funnel that widens is a real finding, but this fixture should not: each
   rung must be at most the one above it. */
check('the ladder descends', ladder.every((r, i) => i === 0 || r.n <= ladder[i - 1].n), true);
/* The build line lives on the dashboard, beside the data age — the one place
   a person can read it without opening a terminal. */
check('the dashboard prints the build', (await f.locator('.vbuild').textContent() || ''),
      (t) => /^[0-9a-f]{8}/.test(t.trim()));
await page.screenshot({ path: '/tmp/claude-0/live-ladder.png' });

/* ── research beside the call, and where it comes from ────────────────── */
console.log('\n— research beside the call —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(3200);
f = F();
/* ONE CONTROL, carrying the peek. There used to be two — a "Research 8/15"
   button and a strip under it repeating the word, the funding line and the
   same count, both opening the same thing. */
check('there is one research control', await f.locator('.ares').count(), 1);
check('the funding shows without opening anything',
      await f.locator('.ares .peek').textContent(), (t) => /Series C/.test(t || ''));

/* OPEN IS REMEMBERED FOR THE SESSION, so by now the earlier click has left it
   open. Normalise first: a test that only works in the order it happens to run
   in is not a test. */
if ((await f.locator('#split').getAttribute('data-res')) === 'on') {
  await f.locator('#accRes').click();
  await page.waitForTimeout(400);
}
check('closed, the column is not there', await f.locator('#paneRes').isVisible(), false);

await f.locator('#accRes').click();
await page.waitForTimeout(700);
/* THE ASK, 2026-09-21: "the Research tab should remain visible alongside the
   calling interface, so that I can access research while making calls without
   switching between screens." So: the column is up, AND both working panes are
   still up, AND nothing is covering anything. */
check('the column opens', await f.locator('#paneRes').isVisible(), true);
check('Basic information is still on screen', await f.locator('#paneL').isVisible(), true);
check('so is Event & vendor', await f.locator('#paneR').isVisible(), true);
check('and the contact queue', await f.locator('#qfil .qf').count(), (n) => n >= 3);
check('nothing is covering it', await f.locator('.scrim').count(), 0);

const blocks = await f.locator('#paneRes .rblock h4').allTextContents();
check('two blocks, theirs and ours', blocks.length, 2);
check('their base is named first', blocks[0], (t) => /research base/i.test(t || ''));

/* THE TEN COLUMNS FROM THEIR BASE. Ayush, 2026-09-21: "the research section
   should be taken from airtable", with a link to app55PsyRKqkf2CAQ. The seed
   spells the columns exactly as that message did, typo and all, so this is
   also the proof that the loose matching earns its keep. */
const srcFacts = await f.locator('#paneRes .rblock:first-child .rlist > div').evaluateAll(
  (ds) => ds.map((d) => d.querySelector('dt').textContent + '=' + d.querySelector('dd').textContent));
check('all ten are drawn', srcFacts.length, 10);
check('total funding', srcFacts.join('|'), (t) => /Total funding=\$48M/.test(t));
check('latest amount is not swallowed by total', srcFacts.join('|'), (t) => /Latest funding amount=\$40M/.test(t));
check('the concatenated source', srcFacts.join('|'), (t) => /Source=Apollo/.test(t));
check('a numeric employee count survives', srcFacts.join('|'), (t) => /Employees \(Kylas\)=760/.test(t));
check('the Apollo link is a link', await f.locator('#paneRes .rlist dd a').count(), (n) => n >= 1);

/* And ours, below theirs, kept apart — a scraped funding figure and a BD's own
   note are different kinds of fact. */
const ourFacts = await f.locator('#paneRes .rblock:last-child .rlist > div').evaluateAll(
  (ds) => ds.map((d) => d.querySelector('dt').textContent));
check('our own fields are their own block', ourFacts.length, (n) => n >= 5);
check('industry is one of ours', ourFacts.join('|'), (t) => /Industry/.test(t));

await f.evaluate(() => render());
await page.waitForTimeout(300);
check('it survives a render', await f.locator('#paneRes .rblock').count(), 2);
await page.screenshot({ path: '/tmp/claude-0/live-research.png' });

/* An account their base has nothing for must say so, and say WHY it is empty —
   "no research" and "the PAT cannot see that base" look identical otherwise. */
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/1773706/'));
await page.waitForTimeout(3000);
f = F();
check('an account with no enrichment row says so, with the count',
      await f.locator('#paneRes .rblock:first-child .rnote').textContent(),
      (t) => /Nothing in that table for company 1773706/.test(t || '') && /account\(s\)/.test(t || ''));
await page.evaluate(() => history.pushState({}, '', '/sales/companies/details/903/'));
await page.waitForTimeout(2500);
f = F();

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

/* ── picking is instant ───────────────────────────────────────────────── */
/* Ayush, 2026-09-21: "while clicking on focus it is taking time than usual."
   It was awaiting the round trip before painting. The write still happens and
   still rolls the strip back with a toast if it fails — what changed is that
   the button no longer waits for it. The number is the whole assertion, so it
   is measured rather than eyeballed. */
console.log('\n— picking an account is instant —');
const t0 = Date.now();
await f.locator('.aseg button[data-fs="focus"]').click();
await f.locator('.aseg button[data-fs="focus"][aria-pressed="true"]').waitFor({ timeout: 2500 });
const took = Date.now() - t0;
check(`it paints without waiting for the write (${took}ms)`, took, (ms) => ms < 800);
await page.waitForTimeout(1200);
check('and the write still lands', await f.evaluate(
  () => Views.FOCUS.rows['903']?.status), 'focus');

/* ── a chip tapped twice ──────────────────────────────────────────────── */
/* Ayush, 2026-09-21: "once you click employee offsite once the section would
   appear — if it has data it will remain, else if you click back again it
   will be gone." So the chip is not a toggle over the TYPE, it is a toggle
   over the EMPTY card: an untouched one goes away, a filled one stays and a
   second card is added beside it. */
console.log('\n— a chip tapped twice —');
const chip = () => f.locator('#formR .tc', { hasText: 'Product launch' });
const cards = () => f.evaluate(() => rec().current.filter((r) => r.eventType === 'Product launch').length);
await chip().click(); await page.waitForTimeout(400);
check('one tap opens a card', await cards(), 1);
await chip().click(); await page.waitForTimeout(400);
check('tapping again takes an EMPTY one back', await cards(), 0);
await chip().click(); await page.waitForTimeout(350);
await f.evaluate(() => { rec().current.find((r) => r.eventType === 'Product launch').budget = '500000'; renderRight(); });
await page.waitForTimeout(300);
await chip().click(); await page.waitForTimeout(400);
check('but one with data survives, and a second opens', await cards(), 2);

/* ── the focus filter on the accounts list ────────────────────────────── */
/* Ayush, 2026-09-21: "create a filter to find account who are in focus list."
   It took the place of Compact, which set a row height nobody changed. */
console.log('\n— the focus filter —');
await page.evaluate(() => history.pushState({}, '', '/sales/companies/list'));
await page.waitForTimeout(3200);
f = F();
if (await f.locator('.vtabs button[data-tab="accounts"]').count()) {
  await f.locator('.vtabs button[data-tab="accounts"]').click();
  await page.waitForTimeout(1800);
  f = F();
}
check('Compact is gone', await f.locator('#fDensity').count(), 0);
check('a Focus filter is there instead', await f.locator('#fFocus').count(), 1);
const allRows = await f.locator('.vr[data-id]').count();
await f.locator('#fFocus').selectOption('focus');
await page.waitForTimeout(1400);
const picked = await f.locator('.vr[data-id]').count();
check('it narrows the list', picked, (n) => n > 0 && n <= allRows);
await f.locator('#fFocus').selectOption('none');
await page.waitForTimeout(1200);
check('and "neither" is a different set', await f.locator('.vr[data-id]').count(), (n) => n !== picked);

console.log(`\nerrors: ${errors.length ? errors.join('\n  ') : 'none'}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await ctx.close();
process.exit(failures || errors.length ? 1 : 0);
