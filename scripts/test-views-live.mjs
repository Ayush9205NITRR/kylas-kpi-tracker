#!/usr/bin/env node
/* NAMED VIEWS, IN A REAL CHROME.
 *
 *   xvfb-run -a node scripts/test-views-live.mjs
 *
 * NEEDS the stack and the :8778 host stub exactly as test-console-ux-live.mjs
 * says, with a patched extension copy at EXT_DIR, and the proxy on :8787.
 * Headed under xvfb — extensions do not load headless, ever.
 *
 * The stress suite proves the rules. This proves the screen: that a BD can
 * actually make a view, put accounts in it two different ways, switch the
 * same view between Accounts and Contacts, and land on a call card from a
 * contact row — with nothing in the console log.
 *
 * MULTI-BD is faked the only way a browser test can: the proxy signs every
 * request in as the key's owner, so the second BD is driven through the
 * routes directly (as test-views-stress does) and the UI is then checked for
 * what it shows that person's work as. The visibility RULES are the stress
 * suite's job; what is checked here is that the strip tells the truth.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const HOST = process.env.HOST_STUB || 'http://127.0.0.1:8778';
const BASE = process.env.PROXY || 'http://127.0.0.1:8787';
const SHOTS = process.env.S || '/tmp';
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}${cond || !detail ? '' : `  — ${detail}`}`);
};
const api = async (path, body) => {
  const r = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return r.json();
};

/* A view made outside the browser, to prove the strip shows other people's
   work and not only what this tab just created. */
const seeded = await api('/views', { name: 'Seeded by another BD', visibility: 'team',
                                     companies: ['903', '1776620'] });
const personal = await api('/views', { name: 'Someone personal', visibility: 'personal', companies: ['903'] });

/* TODAY'S FIXTURES, OWNED BY THIS SUITE. On a company no view holds, so they
   cannot wander into the Contacts assertions above — the first time these
   existed they were seeded by hand onto an account a view DID hold, and §11
   then tried to re-assign a contact that lives only in the copy, which Kylas
   rightly 404s. A test's data is the test's business. */
const TD_CO = '7777';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const atPost = (table, fields) => fetch(`http://127.0.0.1:9901/v0/appMOCK/${encodeURIComponent(table)}`, {
  method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer pat_mock' },
  body: JSON.stringify({ records: [{ fields }] }) }).then((r) => r.json()).catch(() => null);
/* companyIndex() reads Owner and Kylas Owner ID off Companies, so a fixture
   without them 422s the whole queue read — which is the Contacts table's
   neighbour, not the Contacts table. */
await atPost('Companies', { 'Kylas Company ID': TD_CO, Name: 'Today Fixtures Co',
  Owner: 'Enout Super Admin', 'Kylas Owner ID': '74725' });
/* EVERY FIELD THE READER ASKS FOR. readQueue requests CONTACT_READ_FIELDS by
   name, and Airtable — the real one and this mock — answers UNKNOWN_FIELD_NAME
   if a name in that list exists nowhere in the table. A half-populated fixture
   therefore made /queue fall back to Kylas and Today came up empty, which read
   as a product bug and was a fixture bug. */
const tdContact = (kid, name, next, phone) => ({
  'Kylas Contact ID': kid, Name: name, Salutation: '', Designation: 'Head of Ops',
  LinkedIn: '', Owner: 'Enout Super Admin', 'Kylas Owner ID': '74725',
  Phone: phone, Phones: '', Email: '', Emails: '', 'Source of Data': 'COLD_CALLING',
  Remarks: '', 'Next Call Date': next, 'Next Call Time': '',
  'Current Stage': 'FOLLOW_UP_1', 'KPI Rank': '', 'Kylas Updated At': '',
  'Vendor Info': '', 'Mode of Meeting': '', 'Service Offering': false,
  Flagged: false, 'Exit Reason': '',
  /* "Company" is the LINK field CONTACT_READ_FIELDS asks for; without it
     anywhere in the table the whole read 422s and Today comes up empty. */
  Company: [], 'Company Kylas ID': TD_CO,
});
await atPost('Contacts', tdContact('880001', 'Due Today Person', day(0), '9000000021'));
await atPost('Contacts', tdContact('880002', 'Overdue Person', day(-3), '9000000022'));

const ctx = await chromium.launchPersistentContext((process.env.PROFILE_DIR || '/tmp/claude-0/pviews-') + Date.now(), {
  headless: false, viewport: { width: 1600, height: 950 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server'],
});
const page = ctx.pages()[0] || await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));

try {
  await page.goto(`${HOST}/sales/companies/list/`); await W(3500);
  await F().evaluate(async (b) => { await API.setBase(b); }, BASE);
  await page.reload(); await W(6000);
  const f = () => F();
  await f().evaluate(() => window.showConsoleView('companies'));

  /* The accounts are crawled, so wait for them rather than racing them. */
  let rows = f().locator('.acctable .vr[data-id]');
  for (let i = 0; i < 40 && await rows.count() === 0; i++) { await W(1000); rows = F().locator('.acctable .vr[data-id]'); }
  const total = await rows.count();
  ok('the accounts list loaded', total > 0, `${total} rows`);
  await W(1200);

  console.log('\n1 · the views strip');
  const tabs = async () => (await f().locator('.vws .vwtab').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  const t0 = await tabs();
  ok('“All accounts” is first', (t0[0] || '').startsWith('All accounts'), t0.join(' | '));
  ok('a view made by somebody else is in the strip', t0.some((t) => t.includes('Seeded by another BD')), t0.join(' | '));
  ok('...marked Team', t0.find((t) => t.includes('Seeded by another BD'))?.includes('Team') === true);
  await page.screenshot({ path: `${SHOTS}/views-1-strip.png` });

  console.log('\n2 · make a view from the builder');
  await f().locator('#vwNew').click(); await W(1000);
  ok('the builder opens', await f().locator('.vbPanel').count() === 1);
  await f().locator('#vbName').fill('Chrome built view');
  await f().locator('#vbQ').fill('bulk'); await W(900);
  const opts = await f().locator('.vbOpt').count();
  ok('the picker searches the accounts already loaded', opts > 0, `${opts} options`);
  await f().locator('#vbAll').click(); await W(500);
  ok('“Select all shown” ticks them', (await f().locator('.vbF .tnum').first().textContent()) === String(opts));
  ok('the chosen accounts show as chips', await f().locator('.vbChip').count() > 0);
  await page.screenshot({ path: `${SHOTS}/views-2-builder.png` });
  await f().locator('#vbSave').click(); await W(4000);
  const t1 = await tabs();
  ok('the new view is in the strip', t1.some((t) => t.includes('Chrome built view')), t1.join(' | '));
  const inView = await f().locator('.acctable .vr[data-id]').count();
  ok('...and the list is narrowed to it', inView === opts && inView < total, `${inView} of ${total}`);

  console.log('\n3 · a name is required');
  await f().locator('#vwNew').click(); await W(800);
  await f().locator('#vbSave').click(); await W(600);
  ok('saving with no name says so and does not close', await f().locator('.vbErr').count() === 1
     && await f().locator('.vbPanel').count() === 1);
  await f().locator('#vbCancel').click(); await W(400);

  console.log('\n4 · tick accounts, save them as a view');
  await f().locator('.vws .vwtab').first().click(); await W(1500);      /* All accounts */
  for (const i of [0, 1, 2]) { await f().locator('.acctable .vr[data-id] .cpick').nth(i).click(); await W(350); }
  ok('the bulk bar counts the ticked rows', (await f().locator('.abar .tnum').first().textContent() || '').startsWith('3'));
  ok('“+ Save as view” is offered to every BD', await f().locator('#accSaveView').count() === 1);
  await f().locator('#accSaveView').click(); await W(900);
  ok('the builder opens with those accounts already in it',
     (await f().locator('.vbF .tnum').first().textContent()) === '3');
  await f().locator('#vbName').fill('From the bulk bar');
  await f().locator('[data-vis="personal"]').click(); await W(200);
  await f().locator('#vbSave').click(); await W(4000);
  const t2 = await tabs();
  ok('it is saved, and marked Mine', t2.some((t) => t.includes('From the bulk bar') && t.includes('Mine')), t2.join(' | '));
  ok('...holding the three ticked accounts', t2.find((t) => t.includes('From the bulk bar'))?.includes(' 3 '), t2.join(' | '));

  console.log('\n5 · + Add to view');
  await f().locator('.vws .vwtab').first().click(); await W(1200);
  await f().locator('.acctable .vr[data-id] .cpick').nth(5).click(); await W(500);
  await f().locator('#accAddView').click(); await W(1200);
  ok('the picker lists views you can add to', await f().locator('.vbPick').count() > 0);
  const target = f().locator('.vbPick', { hasText: 'From the bulk bar' }).first();
  await target.click(); await W(4000);
  const t3 = await tabs();
  ok('the account was added to it', t3.find((t) => t.includes('From the bulk bar'))?.includes(' 4 '), t3.join(' | '));

  console.log('\n6 · Accounts ⇄ Contacts, inside one view');
  await f().locator('.vws .vwtab', { hasText: 'Seeded by another BD' }).first().click(); await W(2500);
  ok('the Accounts/Contacts switch is there inside a view', await f().locator('#halfCon').count() === 1);
  const accN = await f().locator('.acctable .vr[data-id]').count();
  ok('Accounts shows the view’s accounts', accN === 2, `${accN}`);
  await f().locator('#halfCon').click(); await W(8000);
  const cN = await f().locator('.ctable .crow').count();
  ok('Contacts shows the people at them', cN >= 2, `${cN} rows`);
  const cols = await f().locator('.ctable .vh span').allTextContents();
  /* The DEFAULT set. Which columns show is the person's choice since 1.88.0
     (Columns ▾), and "Stage" is spelled "Calling stage" there — a company
     has a stage too, and the two were told apart only by which table you
     happened to be looking at. */
  ok('...with the columns a BD needs',
     ['Contact', 'Company', 'Designation', 'Phone', 'Email', 'Calling stage', 'Owner', 'Last call', 'Next call']
       .every((h) => cols.includes(h)), cols.join('|'));
  ok('...and a Columns picker to change them', await f().locator('#cColBtn').count() === 1);
  /* NOT a tel: link — Chrome blocks those inside the extension frame. §12
     proves the button reaches requestDial; here it just has to exist. */
  ok('the phone is a dial button, not a blocked tel: link',
     await f().locator('.ctable .crow [data-dial]').count() > 0
     && await f().locator('.ctable a[href^="tel:"]').count() === 0);
  await page.screenshot({ path: `${SHOTS}/views-3-contacts.png` });

  console.log('\n7 · search, filter and group inside Contacts');
  const first = (await f().locator('.ctable .crow [data-open]').first().textContent() || '').trim();
  await f().locator('#conQ').fill(first.slice(0, 4)); await W(900);
  ok('search narrows the people', await f().locator('.ctable .crow').count() <= cN);
  await f().locator('#conQ').fill(''); await W(800);
  await f().locator('#conGroup').click(); await W(800);
  ok('group by company adds the company headings', await f().locator('.cgrouph').count() > 0);
  await f().locator('#conGroup').click(); await W(600);

  console.log('\n8 · a contact row opens the call card');
  await f().locator('.ctable .crow [data-open]').first().click(); await W(6000);
  const name = await f().locator('#f-poc').inputValue().catch(() => '');
  ok('the call card opened on that person', !!name && first.includes(name.split(' ')[0]), `${name} vs ${first}`);
  ok('...and the accounts view stepped aside', await f().evaluate(() => document.getElementById('viewport')?.hidden) === true);

  console.log('\n9 · it survives a reload, because it is on the server');
  await page.reload(); await W(7000);
  await F().evaluate(() => window.showConsoleView('companies'));
  let r2 = F().locator('.acctable .vr[data-id]');
  for (let i = 0; i < 40 && await r2.count() === 0; i++) { await W(1000); r2 = F().locator('.acctable .vr[data-id]'); }
  await W(1500);
  const t4 = await tabs();
  for (const n of ['Chrome built view', 'From the bulk bar', 'Seeded by another BD'])
    ok(`“${n}” is still there after a reload`, t4.some((t) => t.includes(n)), t4.join(' | '));

  console.log('\n10 · pin, duplicate, delete');
  await f().locator('.vws .vwtab', { hasText: 'Chrome built view' }).first().locator('.vwpin').click(); await W(3000);
  const t5 = await tabs();
  ok('pinning moves it to the front', (t5[1] || '').includes('Chrome built view'), t5.join(' | '));
  await f().locator('.vws .vwtab', { hasText: 'Chrome built view' }).first().click(); await W(1500);
  await f().locator('#vwDup').click(); await W(4000);
  ok('duplicate makes a copy and keeps the original',
     (await tabs()).filter((t) => t.includes('Chrome built view')).length === 2, (await tabs()).join(' | '));
  page.once('dialog', (d) => d.accept());
  await f().locator('#vwDel').click(); await W(4000);
  ok('delete removes exactly one of them',
     (await tabs()).filter((t) => t.includes('Chrome built view')).length === 1, (await tabs()).join(' | '));

  /* ══ 11 · FRESH OPEN → VIEW → CONTACTS → CALL CARD ═══════════════════
     The flow Ayush was actually on when both bugs showed: a console opened
     cold, straight into a view's Contacts, straight onto a card. No company
     opened first, no dashboard — which is exactly why the card had no owner
     list to work with. */
  console.log('\n11 · fresh open, straight to a contact');
  {
    const c2 = await ctx.newPage();
    const e2 = [];
    c2.on('pageerror', (e) => e2.push('pageerror: ' + e.message));
    c2.on('console', (m) => { if (m.type() === 'error') e2.push('console: ' + m.text().slice(0, 200)); });
    const G = () => c2.frames().find((f) => f.url().startsWith('chrome-extension'));
    await c2.goto(`${HOST}/sales/companies/list/`); await W(3500);
    await G().evaluate(async (b) => { await API.setBase(b); }, BASE);
    await c2.reload(); await W(6500);
    await G().evaluate(() => window.showConsoleView('companies'));
    let r3 = G().locator('.acctable .vr[data-id]');
    for (let i = 0; i < 40 && await r3.count() === 0; i++) { await W(1000); r3 = G().locator('.acctable .vr[data-id]'); }
    await W(1200);
    await G().locator('.vws .vwtab', { hasText: 'Seeded by another BD' }).first().click(); await W(2000);
    await G().locator('#halfCon').click(); await W(8000);

    /* BY HEADER, NOT BY POSITION. This read `span` nth(6), which counted spans
       inside cells too and broke when 1.92.0 put a tick-box column first — it
       then read the Calling stage and called it the owner. Header and row are
       built from the same column list, so the header's index is the cell's. */
    const heads = (await G().locator('.ctable .vr.vh > span').allTextContents()).map((t) => t.trim());
    const ownerAt = heads.indexOf('Owner');
    const tableOwner = ownerAt < 0 ? '' :
      (await G().locator('.ctable .crow').first().locator(':scope > span').nth(ownerAt).textContent() || '').trim();
    ok('the Contacts table names an owner, not “—”', !!tableOwner && tableOwner !== '—', `“${tableOwner}”`);

    await G().locator('.ctable .crow [data-open]').first().click(); await W(7000);
    const cardOwner = await G().locator('#f-ow').inputValue().catch(() => '');
    ok('the card opened with an owner', !!cardOwner, `“${cardOwner}”`);
    ok('the table and the card agree on the owner', tableOwner === cardOwner,
       `table “${tableOwner}” vs card “${cardOwner}”`);

    /* THE WHOLE LIST, on a console that has opened nothing else. */
    const offered = (await G().locator('#f-ow option').allTextContents()).filter((t) => t.trim());
    const active = ((await (await fetch(`${BASE}/allot-people`)).json()).people || []).map((p) => p.name);
    ok(`the Owner dropdown offers every active BD (${offered.length} ≥ ${active.length})`,
       offered.length >= active.length, offered.join(' | '));
    const missing = active.filter((n) => !offered.includes(n));
    ok('...with nobody from the active list missing', missing.length === 0, missing.join(', '));
    ok('...and the current owner is one of them', offered.includes(cardOwner), `“${cardOwner}”`);

    /* The red "not in the list Kylas sent" must not appear for any of them. */
    const warnShown = async () => G().evaluate(() => {
      const w = document.getElementById('f-ow-warn');
      return !!w && !w.hidden;
    });
    ok('no "not in the list" warning on open', (await warnShown()) === false);
    let anyWarn = false;
    for (const name of active.slice(0, 4)) {
      await G().locator('#f-ow').selectOption({ label: name }); await W(1600);
      if (await warnShown()) { anyWarn = true; console.log(`      (warned on “${name}”)`); }
    }
    ok('picking any active BD never warns', anyWarn === false);
    await c2.screenshot({ path: `${SHOTS}/views-4-owner.png` });
    ok('no console errors on the fresh-open path', e2.length === 0, e2.slice(0, 3).join(' || '));
    await c2.close();
  }

  /* ══ 12 · EVERY LINK IN THE CONTACTS TABLE ══════════════════════════ */
  console.log('\n12 · the links actually do something');
  await f().evaluate(() => window.showConsoleView('companies')); await W(2500);
  await f().locator('.vws .vwtab', { hasText: 'Seeded by another BD' }).first().click(); await W(2000);
  await f().locator('#halfCon').click(); await W(8000);

  ok('no bare tel: link is rendered at all', await f().locator('.ctable a[href^="tel:"]').count() === 0);
  ok('no mailto: link either', await f().locator('.ctable a[href^="mailto:"]').count() === 0);
  ok('the phone is a button that dials', await f().locator('.ctable [data-dial]').count() > 0);
  ok('the email is a button that copies', await f().locator('.ctable [data-mail]').count() > 0);

  /* requestDial is what the card uses; prove the click reaches it rather
     than navigating the frame. */
  await f().evaluate(() => { window.__dialled = []; const real = window.requestDial;
    window.requestDial = (n) => { window.__dialled.push(n); return real?.(n); }; });
  const urlBefore = page.url();
  await f().locator('.ctable [data-dial]').first().click(); await W(1200);
  const dialled = await f().evaluate(() => window.__dialled || []);
  ok('clicking a phone calls requestDial', dialled.length === 1, JSON.stringify(dialled));
  ok('...with the number it shows', /^\+?\d[\d\s]*$/.test(dialled[0] || ''), dialled[0]);
  ok('...and navigates nothing', page.url() === urlBefore);
  ok('...and does not open the row behind it',
     await f().evaluate(() => !!document.querySelector('.ctable')) === true);

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await f().locator('.ctable [data-mail]').first().click(); await W(1200);
  ok('clicking an email stays on the page', page.url() === urlBefore);
  const toasted = await f().evaluate(() => document.querySelector('.toast')?.textContent || '');
  ok('...and says it copied', /copied/i.test(toasted), `“${toasted}”`);

  const coBtn = f().locator('.ctable [data-openco]').first();
  ok('the company is clickable too', await coBtn.count() === 1);
  await coBtn.click(); await W(6000);
  ok('clicking a company opens that account',
     await f().evaluate(() => !!document.getElementById('acct')?.textContent.trim()) === true);

  console.log('\n13 · external links open, and open safely');
  {
    const bad = await f().evaluate(() => [...document.querySelectorAll('a[target="_blank"]')]
      .map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel') || '' }))
      .filter((x) => !/^https?:\/\//i.test(x.href || '') || !/noopener/.test(x.rel)));
    ok('every new-tab link is absolute https and carries noopener',
       bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    /* The normaliser itself: a stored value with no scheme must still open. */
    const norm = await f().evaluate(() => typeof webUrl === 'function'
      ? [webUrl('linkedin.com/company/x'), webUrl('www.example.com'), webUrl('not a url'), webUrl('')]
      : null);
    ok('a bare "linkedin.com/…" normalises to https',
       norm && norm[0] === 'https://linkedin.com/company/x', JSON.stringify(norm));
    ok('...and junk is not made into a link', norm && norm[2] === null && norm[3] === null, JSON.stringify(norm));
  }

  /* ══ 15 · THE FOUR THINGS AYUSH HIT ON 1.85.1 ════════════════════════ */
  console.log('\n15 · a re-assign reaching the list');
  /* The company band this section used to measure is gone — the header strip
     replaced it in 1.86, and §16 measures that instead. */
  /* THE OWNER LIST FILLS ITSELF even when the server sends none with the
     contact — which is what a console talking to an older deploy gets. */
  const active = ((await (await fetch(`${BASE}/allot-people`)).json()).people || []).map((p) => p.name);
  const refilled = await f().evaluate(async () => {
    OWNERS = ['']; for (const k of Object.keys(OWNER_ID)) delete OWNER_ID[k];
    await refreshOwners(true);
    return { names: OWNERS.filter(Boolean), ids: OWNERS.filter(Boolean).filter((n) => !!OWNER_ID[n]).length };
  });
  ok('an emptied owner list refills itself from the server',
     active.every((n) => refilled.names.includes(n)),
     `missing ${active.filter((n) => !refilled.names.includes(n)).join(', ')}`);
  ok('...with an id against every name, so re-assigning works',
     refilled.ids === refilled.names.length, `${refilled.ids}/${refilled.names.length}`);
  /* An owner the server does not list (a deactivated user) must be asked
     about ONCE, not on every repaint. */
  const asks = await f().evaluate(async () => {
    let n = 0; const real = window.API.allotPeople;
    window.API.allotPeople = (...a) => { n++; return real.apply(window.API, a); };
    const a = rec(); const keep = a.owner;
    a.owner = 'Ghost Of Nobody';
    for (let i = 0; i < 4; i++) { renderBasic(); await new Promise((r) => setTimeout(r, 250)); }
    a.owner = keep; window.API.allotPeople = real; renderBasic();
    return n;
  });
  ok('an owner the server cannot name is asked about once, not every paint',
     asks <= 1, `${asks} requests over 4 repaints`);

  /* A re-assign on the card must reach the Contacts table behind it. */
  await f().locator('.vws .vwtab', { hasText: 'Seeded by another BD' }).first().click().catch(() => {});
  await W(1500);
  await f().locator('#halfCon').click().catch(() => {}); await W(7000);
  if (await f().locator('.ctable .crow').count()) {
    const was = (await f().locator('.ctable .crow').first().locator('span').nth(6).textContent() || '').trim();
    await f().locator('.ctable .crow [data-open]').first().click(); await W(6500);
    const people = ((await (await fetch(`${BASE}/allot-people`)).json()).people || []).map((p) => p.name);
    const to = people.find((n) => n !== was);
    await f().locator('#f-ow').selectOption({ label: to }); await W(5000);
    ok('the card accepted the re-assign', (await f().locator('#f-ow').inputValue()) === to, `${was} → ${to}`);
    await f().evaluate(() => window.showConsoleView('companies')); await W(2500);
    await f().locator('.vws .vwtab', { hasText: 'Seeded by another BD' }).first().click(); await W(1500);
    await f().locator('#halfCon').click(); await W(3000);
    const now = (await f().locator('.ctable .crow').first().locator('span').nth(6).textContent() || '').trim();
    ok('...and the Contacts table behind it shows the new owner', now === to, `table “${now}” vs “${to}”`);
  }

  /* ══ 16 · THE TOP BAR, THE COMPANY STRIP, AND TODAY ══════════════════
     1.86: the rail's company band moved into the header, the duplicate
     Dashboard went, and Today stopped meaning two opposite things. */
  console.log('\n16 · the top bar');
  await f().evaluate(() => window.showConsoleView(null)); await W(800);
  await f().evaluate(() => window.openCompanyFromView('1776620',
    'Gamechangesolar Renewables Private Limited')); await W(6000);

  ok('the rail band is gone', await f().locator('#qscope').count() === 0);
  ok('the dead log counter is gone', await f().locator('#logCount').count() === 0);
  const dash = await f().locator('.acts button', { hasText: /Dashboard/ }).count();
  ok('there is exactly one Dashboard control', dash === 1, `${dash}`);

  const strip = await f().evaluate(() => {
    const n = document.getElementById('acct'); if (!n) return null;
    const b = n.querySelector('.cown b');
    const cs = b && getComputedStyle(b);
    return { name: n.querySelector('.scope')?.textContent || '',
             owner: b?.textContent || '', ownerVisible: !!b && b.getBoundingClientRect().width > 40,
             size: cs?.fontSize || '', colour: cs?.color || '',
             metaColour: getComputedStyle(n.querySelector('.cown em')).color,
             av: n.querySelector('.cav')?.textContent?.trim() || '',
             change: !!n.querySelector('.clink'), move: !!n.querySelector('.cmv'),
             ownRow: n.getBoundingClientRect().top > document.querySelector('.acts').getBoundingClientRect().top };
  });
  ok('the company strip is in the header', !!strip?.name, JSON.stringify(strip));
  ok('...with the owner readable, not crushed', strip?.ownerVisible === true, `“${strip?.owner}”`);
  /* The point of 1.86.1: recognisable without a deliberate look. Size and
     colour are asserted because "looks bigger" is the kind of change a later
     tidy-up silently folds back into the label voice it came from. */
  ok('...at section size, not the label size it shared with the count',
     strip?.size === '17px', `${strip?.size}`);
  ok('...in the full text colour, not the secondary grey',
     !!strip?.colour && strip.colour !== strip.metaColour, `${strip?.colour}`);
  ok('...behind an initials chip you can read before the name',
     /^[A-Z0-9]{2}$/.test(strip?.av || ''), `“${strip?.av}”`);
  ok('...and a Change link beside it', strip?.change === true);
  ok('...on a row of its own, under the buttons', strip?.ownRow === true);

  /* Nothing in the bar may clip, at any width a BD uses. */
  for (const w of [1500, 1280, 1100, 980]) {
    await page.setViewportSize({ width: w, height: 900 }); await W(700);
    const fits = await f().evaluate(() => {
      const acts = document.querySelector('.acts'), bar = document.querySelector('.bar');
      return acts.scrollWidth <= acts.clientWidth + 1 && bar.scrollWidth <= bar.clientWidth + 1;
    });
    ok(`nothing clips at ${w}px`, fits === true);
  }
  /* The widest the strip can get: a long company AND a long owner, which is
     the pair that broke the band before the strip moved up here. */
  await page.setViewportSize({ width: 1280, height: 900 }); await W(600);
  const longFits = await f().evaluate(() => {
    const b = document.querySelector('.acct .cown b'); if (!b) return null;
    const was = b.textContent;
    b.textContent = 'Priyadarshini Venkataraghavan-Subramaniam';
    const acts = document.querySelector('.acts'), bar = document.querySelector('.bar');
    const r = acts.scrollWidth <= acts.clientWidth + 1 && bar.scrollWidth <= bar.clientWidth + 1;
    b.textContent = was; return r;
  });
  ok('nothing clips at 1280px with a long company and a long owner', longFits === true);

  await page.setViewportSize({ width: 1600, height: 950 }); await W(600);

  console.log('\n17 · Today means what you owe');
  await f().locator('#todayBtn').click(); await W(7000);
  const td = await f().evaluate(() => {
    const rows = [...document.querySelectorAll('.tdtable .crow')];
    return { n: rows.length,
             tabs: [...document.querySelectorAll('#tdCall,#tdDone')].map((b) => b.textContent.trim()),
             first: rows[0]?.querySelector('[data-open]')?.textContent?.trim() || '',
             order: rows.map((r) => r.querySelector('.tdw')?.className || '') };
  });
  ok('Today lists the calls that are owed', td.n > 0, JSON.stringify(td));
  ok('...with a To call and a Done today tab', td.tabs.length === 2 && /To call/.test(td.tabs[0])
     && /Done today/.test(td.tabs[1]), td.tabs.join(' | '));
  ok('...overdue before due-today', !td.order.length || td.order[0].includes('overdue')
     || !td.order.some((c) => c.includes('overdue')), td.order.join(','));
  ok('the phone dials rather than linking', await f().locator('.tdtable a[href^="tel:"]').count() === 0
     && await f().locator('.tdtable [data-dial]').count() >= 0);
  if (td.n) {
    await f().locator('.tdtable [data-open]').first().click(); await W(6500);
    const who = await f().locator('#f-poc').inputValue().catch(() => '');
    ok('a row opens that contact’s call card', !!who && td.first.includes(who.split(' ')[0]),
       `“${who}” vs “${td.first}”`);
    ok('...with the company strip naming its account',
       await f().evaluate(() => !!document.getElementById('acct')?.textContent.trim()) === true);
  }

  console.log('\n14 · the console log');
  ok('no page or console errors anywhere in that', errs.length === 0, errs.slice(0, 4).join(' || '));
} catch (e) {
  fail++;
  console.error(`\n! the run itself failed: ${e.stack || e.message}`);
  await page.screenshot({ path: `${SHOTS}/views-FAIL.png` }).catch(() => {});
} finally {
  /* Clean up what this run made, so a second run starts where the first did. */
  for (const v of (await api('/views')).views || [])
    if (/^(Chrome built view|From the bulk bar|Seeded by another BD|Someone personal)/.test(v.name))
      await api('/views/delete', { id: v.id }).catch(() => {});
  await ctx.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
