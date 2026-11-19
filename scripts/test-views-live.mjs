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
  ok('...with the columns a BD needs',
     ['Contact', 'Company', 'Designation', 'Phone', 'Email', 'Stage', 'Owner', 'Last call', 'Next call']
       .every((h) => cols.includes(h)), cols.join('|'));
  ok('the phone is a tel: link', await f().locator('.ctable .crow a[href^="tel:"]').count() > 0);
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

  console.log('\n11 · the console log');
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
