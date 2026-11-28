#!/usr/bin/env node
/* THE CAPPED CHIP ROWS, IN A REAL CHROME (1.97.0).
 *
 *   MOCK_MANY=60 MOCK_MANY_CREATORS=13 (on mock-kylas), then
 *   xvfb-run -a node scripts/test-chiprow-live.mjs
 *
 * NEEDS the stack and the :8778 host stub as test-views-live.mjs says, with
 * mock-kylas started under MOCK_MANY_CREATORS so Created by passes its cap.
 *
 * Ayush, 2026-11-28: "While clicking last created at — it is not showing all
 * names. +1 more value — how do I search about it?" Created by, Last updated
 * by and Sub-industry were capped at ten with no expand flag, so "+N more"
 * drew and did nothing. And "Last updated by should be there" in + Filter:
 * the field was listed, but on the live path its value list was empty.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const HOST = process.env.HOST_STUB || 'http://127.0.0.1:8778';
const BASE = process.env.PROXY || 'http://127.0.0.1:8787';
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}${cond || !detail ? '' : `  — ${detail}`}`);
};

const ctx = await chromium.launchPersistentContext(`/tmp/claude-0/chip-${Date.now()}`, {
  headless: false, viewport: { width: 1700, height: 1000 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server'] });
const page = ctx.pages()[0] || await ctx.newPage();
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 160)); });
try {
  await page.goto(`${HOST}/sales/companies/list/`); await W(3500);
  await F().evaluate(async (b) => { await API.setBase(b); }, BASE); await page.reload(); await W(6000);
  await F().evaluate(() => window.showConsoleView('companies')); await W(5000);
  /* The chip rows sit behind "Filters & chips ▾" (1.89.0), and the audit rows
     behind "More filters" inside it. */
  if (await F().locator('#fDrawer[aria-expanded="false"]').count()) { await F().locator('#fDrawer').click(); await W(1500); }
  if (await F().locator('#moreBtn[aria-expanded="false"]').count()) { await F().locator('#moreBtn').click(); await W(1500); }
  const row = () => F().locator('.frow', { has: F().locator('.lbl', { hasText: /^Created by$/ }) });
  const shown = async () => row().locator('.chip[data-f="cby"]:visible').evaluateAll((cs) => cs.map((c) => c.dataset.label));

  console.log('\n1 · Created by, past its cap');
  ok('the row is there', await row().count() === 1);
  const before = await shown();
  ok('ten names show before it is opened', before.length === 10, `${before.length}: ${before.join(', ')}`);
  const more = row().locator('.chip.more');
  const moreText = (await more.textContent() || '').trim();
  ok('"+N more people" says how many are hidden, in people', /^\+\d+ more (people|person)$/.test(moreText), moreText);
  ok('no find box while it is closed', await row().locator('input[data-find]').count() === 0);

  console.log('\n2 · opening it');
  await more.click(); await W(1500);
  const all = await shown();
  ok('the button now opens the row — every name shows', all.length > 10, `${all.length}`);
  ok('...and offers to close it again', /Show fewer/.test(await row().locator('.chip.more').textContent()));
  ok('a find box appears on the opened row', await row().locator('input[data-find="cby"]').count() === 1);

  console.log('\n3 · searching it');
  await row().locator('input[data-find="cby"]').fill('Creator 1'); await W(400);
  const hits = await shown();
  ok('typing filters the chips to the names that match', hits.length >= 1 && hits.every((t) => /Creator 1/.test(t)), hits.join(', '));
  ok('...without losing the caret (filtered in place, not redrawn)',
     await F().evaluate(() => document.activeElement?.dataset?.find === 'cby'));
  await row().locator('.chip[data-f="cby"]:visible').first().click(); await W(2000);
  const picked = await row().locator('.chip[data-f="cby"][aria-pressed="true"]').evaluateAll((cs) => cs.map((c) => c.dataset.label));
  ok('a chip can be picked from the search', picked.length === 1, picked.join(', '));
  await row().locator('input[data-find="cby"]').fill('zzz-nobody'); await W(400);
  const kept = await shown();
  ok('a PICKED chip survives a search that matches nothing else', kept.length === 1 && kept[0] === picked[0], kept.join(', '));

  console.log('\n4 · closing it');
  await row().locator('.chip.more').click(); await W(1500);
  ok('Show fewer closes the row', await row().locator('input[data-find]').count() === 0 && (await shown()).length <= 10);
  ok('...and the pick is still in force', await row().locator('.chip[data-f="cby"][aria-pressed="true"]').count() === 1);
  /* Clear it so the builder below sees the whole list. */
  await row().locator('.chip[data-f="cby"][aria-pressed="true"]').click(); await W(1500);

  console.log('\n5 · Last updated by, in + Filter');
  await F().locator('#fbBtn').click(); await W(800);
  await F().locator('#fbAdd').click(); await W(800);
  const fsel = F().locator('select.fb-f').last();
  const fields = await fsel.locator('option').allTextContents();
  ok('"Last updated by" is a field the builder offers', fields.some((t) => /Last updated by/.test(t)), fields.length + ' fields');
  await fsel.selectOption({ label: 'Last updated by' }); await W(800);
  const opsel = F().locator('select.fb-op').last();
  const ops = await opsel.locator('option').evaluateAll((o) => o.map((x) => x.value));
  if (ops.includes('anyof')) { await opsel.selectOption('anyof'); await W(800); }
  const vals = await F().locator('select.fb-add').last().locator('option').allTextContents();
  ok('...and it has names to pick, not an empty list', vals.filter((t) => /Creator/.test(t)).length >= 10, `${vals.length - 1} values`);

  ok('no console errors', !errs.length, errs.slice(0, 3).join(' | '));
} catch (e) {
  fail++; console.log(`  FAIL  the run itself — ${e.message.split('\n')[0]}`);
} finally {
  await ctx.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
