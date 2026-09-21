#!/usr/bin/env node
/* The two ways a save can look like it worked and not have.
 *
 *   node scripts/test-focus-live.mjs --seed > /tmp/claude-0/focus-seed.json
 *   MOCK_AIRTABLE_NOFIELD="Contacts.First Right POC At" \
 *     scripts/live-stack.sh /tmp/claude-0/focus-seed.json
 *   node scripts/test-gaps-live.mjs
 *
 * Ayush, 2026-09-22: "the data once gets updated is not getting saved, or
 * reflected back, thus my KPI count is still mismatched." Two separate faults
 * produce exactly that sentence, and neither of them says anything at the
 * moment it happens.
 *
 * ONE — the save never ran. Save & next was `disabled` whenever a required
 * field was empty, so the click did nothing, fired nothing and explained
 * nothing; the only account of why was one line of small red text at the far
 * end of the footer. The screenshot that came with that message shows a greyed
 * Save and "Still needed: A day to call back". saveNext() has always named the
 * missing field and could never be reached to do it.
 *
 * TWO — the save ran and Airtable dropped a column. upsertTolerant drops a
 * field the base does not have and sends the record again, which is right: one
 * missing column must not cost an afternoon of dialling. But if the dropped
 * one is First Right POC At, the flag is written and the DATE it needs is not,
 * and the rung stays uncountable for ever. Kylas takes the write, Airtable
 * takes the write, the card says Logged, and the funnel never moves. The one
 * toast that said so scrolled away four seconds after the first call of the
 * day.
 *
 * This file needs the stack started with MOCK_AIRTABLE_NOFIELD, which stands
 * up a base one repair-base behind — the state Ayush's base is actually in.
 */
import { rmSync } from 'node:fs';
rmSync('/tmp/claude-0/pgaps', { recursive: true, force: true });

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pgaps', {
  channel: 'chromium', headless: true, viewport: { width: 1700, height: 1000 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest', '--load-extension=/tmp/claude-0/exttest'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n         got: ${JSON.stringify(got)}`}`);
};

await page.goto('http://127.0.0.1:8778/sales/companies/details/1776620/');
await page.waitForTimeout(5500);
const f = F();
if (!f) { console.log('! no console frame — is the stack up?'); process.exit(1); }

/* ── one: a blocked save says so, and takes you there ─────────────────── */
console.log('— a save that cannot go yet —');
/* Fill everything EXCEPT the call-back date, which is required at MQL and
   above by Ayush's own rule (2026-09-19). This is the exact card from the
   screenshot: two event rows, right POC, and a greyed Save. */
await f.locator('#formR .tc', { hasText: 'Employee offsites' }).click();
await page.waitForTimeout(400);
await f.evaluate(() => {
  const a = rec();
  const r = a.current.find((x) => x.eventType === 'Employee offsites');
  r.budget = '1000000'; r.timeline = 'Q1 2027'; r.pax = '80–100';
  a.vendorInfo = 'Internal'; a.modeOfMeeting = 'In Person'; a.serviceOffering = true;
  a.stage = 'MQL_MARKETING_QUALIFIED_LEAD';
  a.nextCallDate = '';
  if (!(a.phones || []).length) a.phones = [{ type: 'MOBILE', cc: '+91', value: '9826857638', primary: true }];
  render();
});
await page.waitForTimeout(600);

const blocked = await f.evaluate(() => missing().map((x) => x[0]));
check('the call-back date is what is missing', blocked, (v) => v.includes('A day to call back'));
/* NOT DISABLED. A dead button is why this was reported as "not getting saved". */
check('Save is still clickable', await f.locator('#saveBtn').isDisabled(), false);
check('and reads as unavailable',
      await f.locator('#saveBtn').getAttribute('class'), (c) => /blocked/.test(c || ''));
check('with the reason on it',
      await f.locator('#saveBtn').getAttribute('title'), (t) => /A day to call back/.test(t || ''));

await f.locator('#saveBtn').evaluate(
  (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
await page.waitForTimeout(700);
check('clicking it says what is missing',
      (await f.locator('.toast').allTextContents()).join(' '), (t) => /A day to call back/.test(t));
/* AND TAKES YOU THERE. Naming a field in a pane you are not looking at, below
   the fold, is most of the way to useless. */
check('and puts the field on screen', await f.evaluate(() => {
  const n = document.getElementById('f-next');
  if (!n) return 'no such field';
  const r = n.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight + 200;
}), true);
check('nothing was written', await f.evaluate(() => rec().done), false);

/* ── and once it is filled, it saves ──────────────────────────────────── */
console.log('\n— and once the gap is filled —');
await f.evaluate(() => {
  rec().nextCallDate = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  render();
});
await page.waitForTimeout(600);
check('Save is no longer blocked',
      await f.locator('#saveBtn').getAttribute('class'), (c) => !/blocked/.test(c || ''));
await f.locator('.nextbtn button').click();
await page.waitForTimeout(4500);
check('the record is logged', await f.evaluate(
  () => DATA.some((d) => d.kid === '112936' && d.done)), true);

/* ── two: the base is missing a column the KPIs need ──────────────────── */
console.log('\n— a base one repair-base behind —');
/* The stack was started with MOCK_AIRTABLE_NOFIELD="Contacts.First Right POC
   At", so the write of that column is rejected, dropped, and the record is
   sent again without it. The save succeeds. The rung it feeds cannot. */
const gaps = f.locator('#gaps');
check('the console says so, and keeps saying so', await gaps.isVisible(), true);
const text = (await gaps.textContent() || '').replace(/\s+/g, ' ');
check('it names the column', text, (t) => /First Right POC At/.test(t));
check('it says the KPIs are the casualty', text, (t) => /under-counted/i.test(t));
check('and what to run', text, (t) => /repair-base/.test(t));
console.log(`     "${text.trim().slice(0, 150)}…"`);

/* THE POINT OF THE BANNER, stated as an assertion: the save itself looks
   completely fine. Nothing else on this screen would tell you. */
check('while the save itself reports success',
      await f.evaluate(() => DATA.map((d) => d.syncError).filter(Boolean)), (v) => v.length === 0);

console.log(`\nerrors: ${errors.length ? errors.join('\n  ') : 'none'}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await ctx.close();
process.exit(failures || errors.length ? 1 : 0);
