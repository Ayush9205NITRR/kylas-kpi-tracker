#!/usr/bin/env node
/* One call, entered through the real UI, followed all the way to both systems.
 *
 *   node scripts/test-focus-live.mjs --seed > /tmp/claude-0/focus-seed.json
 *   scripts/live-stack.sh /tmp/claude-0/focus-seed.json
 *   node scripts/test-roundtrip-live.mjs
 *
 * Ayush, 2026-09-22: "Test whether KPI's are counted correctly, data is being
 * updated on kylas and airtable (as per the UI changes)" — and, separately,
 * "how the data is being appended to kylas (additional info, about offsites
 * (past, now)), vale remarks mein kaise push hoga".
 *
 * Every other suite here tests one layer. This one tests the seam, because the
 * seam is where the answers have actually been wrong: a field the console
 * showed and never sent, a flag Airtable set with no date so the ladder could
 * not count it, a remarks block that lost half its rows. Each of those passed
 * every unit test in the repo.
 *
 * So: tag an offsite as PAST and another as NOW, fill budget, timeline and pax
 * on both, answer the three questions a discovery claim requires, save — and
 * then read back what each side actually received.
 *
 *   Kylas    remarks (the block between the markers), pipeline stage, call log
 *   Airtable Companies, Contacts, Event Rows, Call Log, Stage Transitions
 *   Ladder   Right POC and Discovery counting this company, once
 *
 * channel:'chromium' — Playwright's bundled build does not load MV3
 * extensions, and the symptom is silence rather than an error.
 *
 * A FRESH PROFILE EVERY RUN, deleted below rather than left to the caller.
 * The console persists drafts to chrome.storage, so a profile carried over
 * from an earlier run restores that run's record — including its Kylas id —
 * and the save then PUTs to a contact this stack has never heard of. The
 * failure reads as "nothing was written to Kylas", which is true, tells you
 * nothing, and is not the product's fault. It cost a round of debugging here.
 */
import { rmSync } from 'node:fs';
rmSync('/tmp/claude-0/proundtrip', { recursive: true, force: true });
const CO = '1776620';                     /* "seats", from the shared seed */

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/proundtrip', {
  channel: 'chromium', headless: true, viewport: { width: 1700, height: 1000 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest', '--load-extension=/tmp/claude-0/exttest'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION|fonts|favicon/.test(m.text())) errors.push(m.text());
});
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n         got: ${JSON.stringify(got)}`}`);
};
/* mock-kylas requires the header the real API does; mock-airtable a Bearer. */
const get = async (u) => (await fetch(u, {
  headers: { 'api-key': 'test', authorization: 'Bearer pat_test' } })).json();

await page.goto(`http://127.0.0.1:8778/sales/companies/details/${CO}/`);
await page.waitForTimeout(5000);
let f = F();
if (!f) { console.log('! no console frame — is the stack up? scripts/live-stack.sh <seed>'); process.exit(1); }

/* ── the shipped samples must be gone ─────────────────────────────────── */
/* console.js seeds DATA with plausible-looking contacts so the console is not
   blank without a proxy, and both fetch paths MERGE by Kylas id — so a real
   contact sharing an id with a sample used to come back wearing its invented
   budget and event rows. Found by giving this fixture real Kylas ids: Devanshi
   Kalro at Shorehouse Retail arrived with "Approx 40L, signed off by CFO" and
   a dealer meet nobody had entered. */
console.log('— the shipped samples —');
check('none survive a real fetch', await f.evaluate(() => DATA.filter((d) => d.demo).length), 0);
check('and nothing invented is on the record',
      await f.evaluate(() => (rec().past || []).concat(rec().current || []).length), 0);

/* ── enter a call the way an associate does ───────────────────────────── */
console.log('\n— entering one call through the UI —');

/* Two event cards of the same type: one PAST, one NOW. This is the shape
   Ayush asked about — "additional info, about offsites (past, now)" — and it
   only became possible when the chip stopped being a per-type toggle. */
await f.locator('#formR .tc', { hasText: 'Employee offsites' }).click();
await page.waitForTimeout(400);
await f.evaluate(() => {
  const r = rec().current.find((x) => x.eventType === 'Employee offsites');
  r.budget = '1200000'; r.timeline = 'Q1 2027 · 12 Feb 2027'; r.pax = '80–100';
  r.remarks = 'Goa, 3 nights, wants a quote by Friday';
  renderRight();
});
await page.waitForTimeout(300);
/* Mark it PAST, then add a second card of the same type for the CURRENT one. */
await f.locator('.ev .seg button', { hasText: 'PAST' }).first().click();
await page.waitForTimeout(400);
await f.locator('#formR .tc', { hasText: 'Employee offsites' }).click();
await page.waitForTimeout(400);
await f.evaluate(() => {
  const r = rec().current.find((x) => x.eventType === 'Employee offsites' && !x.budget);
  if (!r) throw new Error('no second card to fill');
  r.budget = '3500000'; r.timeline = 'Q3 2027 · Oct'; r.pax = '201–500';
  r.remarks = 'Annual offsite, bigger budget this year';
  renderRight();
});
await page.waitForTimeout(300);

const rows = await f.evaluate(() => ({
  past: (rec().past || []).map((r) => ({ t: r.eventType, b: r.budget, p: r.pax })),
  current: (rec().current || []).map((r) => ({ t: r.eventType, b: r.budget, p: r.pax })),
}));
check('one row in Past', rows.past.length, 1);
check('one row in Current', rows.current.length, 1);
check('both are the same event type',
      rows.past[0]?.t === 'Employee offsites' && rows.current[0]?.t === 'Employee offsites', true);

/* The three things a discovery claim requires before the console will save. */
await f.evaluate(() => {
  const a = rec();
  a.vendorInfo = 'Internal'; a.modeOfMeeting = 'In Person'; a.serviceOffering = true;
  a.nextCallDate = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  if (!(a.phones || []).length) a.phones = [{ type: 'MOBILE', cc: '+91', value: '9826857638', primary: true }];
  a.stage = 'DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS';
  render();
});
await page.waitForTimeout(500);
/* The console's own predicates, not a guess at a property name — these are the
   two the whole ladder hangs off (docs/kpi-spec.md §5, §6). */
check('qualification reads Right POC and Discovery',
      await f.evaluate(() => { const a = rec(); return [hasSignal(a), isComplete(a)]; }),
      (v) => v[0] === true && v[1] === true);

/* THE SAVE GATE, ASSERTED BEFORE THE CLICK. saveNext() refuses and toasts when
   anything required is unfilled, so a fixture that misses one field produces
   twenty downstream failures that all read as "nothing was written" — which is
   true and says nothing about why. This names the field instead. */
const stillNeeded = await f.evaluate(() => missing().map((x) => x[0]));
check(`nothing is blocking the save`, stillNeeded, (v) => v.length === 0);
if (stillNeeded.length) console.log(`         still needed: ${stillNeeded.join(', ')}`);

const before = (await get('http://127.0.0.1:9900/__writes')).writes.length;
/* THE HEADER'S Save & next, not the footer's. Both are wired to saveNext and
   both work for a person; the footer one sits at the bottom of an iframe
   inside a shadow root, and a synthetic click at those coordinates does not
   reach it through that nesting — the event dispatches, nothing happens, and
   twenty downstream checks report "nothing was written to Kylas". That is a
   harness limit, not a product fault: an in-page dispatchEvent on the same
   element runs the save and writes to both systems. Clicking the header one
   exercises the identical path without the coordinate mapping. */
check('the save button is live', await f.locator('.nextbtn button').isDisabled(), false);
await f.locator('.nextbtn button').click();
await page.waitForTimeout(4500);
check('the save reported no error', await f.evaluate(
  () => DATA.map((d) => d.syncError).filter(Boolean)), (v) => v.length === 0);
check('no page errors during the save', errors.length, 0);

/* ── what Kylas received ──────────────────────────────────────────────── */
console.log('\n— what reached Kylas —');
const kw = await get('http://127.0.0.1:9900/__writes');
const writes = kw.writes.slice(before);
const contactWrite = writes.filter((w) => w.kind === 'update' || w.kind === 'create').pop();
check('the contact was written', !!contactWrite, true);

const remarks = String(contactWrite?.body?.remarks || '');
/* THE ANSWER TO "remarks mein kaise push hoga". The console rewrites only the
   block between its two markers; anything a human typed above them survives
   the save untouched. */
check('the block is fenced by the markers',
      /--- BD CONSOLE \(auto, do not edit below\) ---[\s\S]*--- END ---/.test(remarks), true);
check('the PAST offsite is in it', remarks, (t) => /Past\s+Employee offsites \| 1200000/.test(t));
check('and carries its timeline and pax', remarks, (t) => /1200000 \| Q1 2027 · 12 Feb 2027 \| 80–100/.test(t));
check('the CURRENT offsite is in it too', remarks, (t) => /Current\s+Employee offsites \| 3500000/.test(t));
/* EVERY row's note, under its own row. One "Notes" line at the bottom built
   from c.current lost the past row's remark entirely, and once a contact could
   hold two offsites it no longer said which note belonged to which. */
check("the PAST row's own note", remarks, (t) => /Goa, 3 nights, wants a quote by Friday/.test(t));
check("the CURRENT row's own note", remarks, (t) => /Annual offsite, bigger budget this year/.test(t));
check('each note sits under its row', remarks,
      (t) => /1200000[^\n]*\n\s+\u21b3 Goa/.test(t) && /3500000[^\n]*\n\s+\u21b3 Annual/.test(t));
check('the stage line', remarks, (t) => /^Stage\s+/m.test(t));
check('vendor, mode and pitch', remarks,
      (t) => /Vendor\s+Internal/.test(t) && /Mode\s+In Person/.test(t) && /Offering\s+pitched/.test(t));
check('the next call date', remarks, (t) => /Next call\s+\d{4}-\d{2}-\d{2}/.test(t));

/* The pipeline stage is a picklist VALUE ID, never a code — a code is accepted
   and silently stores nothing. */
check('the pipeline stage went as a picklist id',
      contactWrite?.body?.customFieldValues?.cfPipelineStageBd, (v) => !!v && typeof v !== 'object');
check('a call log was posted', writes.some((w) => w.kind === 'calllog'), true);

console.log('\n  --- the remarks block Kylas now holds ---');
console.log(remarks.split('\n').map((l) => '  ' + l).join('\n'));

/* ── what Airtable received ───────────────────────────────────────────── */
console.log('\n— what reached Airtable —');
const at = await get('http://127.0.0.1:9901/__writes');
const T = at.tables;
const rowsOf = (t) => (T[t] || []).map((r) => r.fields);
const mine = rowsOf('Contacts').filter((r) => String(r.Name || '').length);

const evs = rowsOf('Event Rows').filter((r) => /Employee offsites/.test(String(r['Event Type'] || '')));
check('two event rows were written', evs.length, (n) => n >= 2);
check('one is Past', evs.some((r) => r.Period === 'Past'), true);
check('one is Current', evs.some((r) => r.Period === 'Current'), true);
check('budgets survived the trip',
      evs.map((r) => String(r.Budget)).sort().join('|'), (t) => /1200000/.test(t) && /3500000/.test(t));
check('so did the per-row remarks',
      evs.map((r) => String(r.Remarks || '')).join(' | '), (t) => /Goa, 3 nights/.test(t));
check('and the pax bands',
      evs.map((r) => String(r.Pax || '')).join('|'), (t) => /80–100/.test(t) && /201–500/.test(t));

const ct = mine.find((r) => (r['Kylas Contact ID'] || '') === String(contactWrite?.id || '')) || mine[0];
check('the contact row carries the monotonic flags',
      [!!ct?.['Ever Right POC'], !!ct?.['Ever Discovery']], (v) => v[0] === true && v[1] === true);
/* THE FIX FROM 2026-09-21, checked end to end. These are what date the two
   middle rungs; without them the flag is true and the ladder cannot place the
   arrival in any period, so the rung reads zero. */
check('and a date for Right POC', ct?.['First Right POC At'], (v) => !!v);
check('and a date for Discovery', ct?.['First Discovery At'], (v) => !!v);
check('and the first-worked stamp', ct?.['First Worked At'], (v) => !!v);

check('a call log row', rowsOf('Call Log').length, (n) => n >= 1);
check('the duration provenance travelled',
      rowsOf('Call Log').map((r) => r['Duration Source']).join(','), (t) => /dialed|estimated|none/.test(t));
const trans = rowsOf('Stage Transitions');
check('a stage transition was appended',
      trans.some((r) => /DISCOVERY_CALL_DONE/.test(String(r['To Stage'] || ''))), true);

/* ── and what the ladder then says ────────────────────────────────────── */
console.log('\n— and what the ladder counts —');
/* The proxy caches the report for a minute and drops it on a save, so this is
   the number an associate would see, not a specially refreshed one. */
const rep = await get('http://127.0.0.1:8787/report?period=quarter&owner=all');
const totals = rep.totals || {};
check('the company is counted at Right POC', totals.right, (n) => n >= 1);
check('and at Discovery', totals.discovery, (n) => n >= 1);
/* COMPANIES, NOT CONTACTS. Two qualifying contacts at one account is one
   arrival; counting both is how a rung once read above the one beneath it. */
check('the ladder still descends',
      ['worked', 'picked', 'right', 'discovery', 'booked', 'done', 'sql']
        .map((k) => totals[k] || 0),
      (v) => v.every((n, i) => i === 0 || n <= v[i - 1]));
console.log(`     worked ${totals.worked} · picked ${totals.picked} · right ${totals.right}` +
            ` · discovery ${totals.discovery} · booked ${totals.booked} · done ${totals.done} · sql ${totals.sql}`);

/* Saving twice must not count the company twice — first arrival wins. */
const rightBefore = totals.right;
await page.waitForTimeout(500);
await f.evaluate(() => { const a = rec(); a.done = false; render(); });
await f.locator('#saveBtn').click();
await page.waitForTimeout(4000);
const rep2 = await get('http://127.0.0.1:8787/report?period=quarter&owner=all&fresh=1');
check('a second save does not count the rung again', rep2.totals?.right, rightBefore);

console.log(`\nerrors: ${errors.length ? errors.join('\n  ') : 'none'}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await ctx.close();
process.exit(failures || errors.length ? 1 : 0);
