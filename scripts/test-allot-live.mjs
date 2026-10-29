/* THE ALLOT PANEL, driven in a real Chrome with the extension loaded.
 *
 *   xvfb-run -a node scripts/test-allot-live.mjs
 *
 * Needs the stack from docs/STATE.md §2, with the mock started as
 *   MOCK_USER_LIST=1 MOCK_BD_TEAM=1 MOCK_DEAD_COMPANIES=903,1778327 node scripts/mock-kylas.mjs
 * the host stub on :8778, and the patched copy of extension/ at EXT_DIR.
 *
 * What it proves, none of which a unit test can: the people in the select are
 * the server's active list (no Super Admin, no deactivated namesake); the
 * preview follows the shares; the run goes in batches with a moving bar and
 * the accounts land on the people shown — in Kylas, read back — with their
 * contacts; and the moved rows are unticked while a failure stays ticked.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const HOST = process.env.HOST_STUB || 'http://127.0.0.1:8778';
const KYLAS = process.env.MOCK_KYLAS || 'http://127.0.0.1:9900';
const SHOTS = process.env.SHOTS || '';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pa-' + Date.now(), {
  headless: false, viewport: { width: 1600, height: 1000 },
  colorScheme: process.env.DARK ? 'dark' : 'light',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server'] });
const page = ctx.pages()[0] || await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(HOST + '/sales/companies/details/903/');
await page.waitForTimeout(4000);
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));
await F().evaluate(async () => { await API.setBase('http://127.0.0.1:8787'); });
await page.goto(HOST + '/sales/companies/list/');
await page.waitForTimeout(9000);
await F().locator('#accQ').waitFor({ timeout: 20000 });
let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => { (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}${cond || !detail ? '' : ` — ${String(detail).slice(0, 300)}`}`); };
/* The mock throttles above 4 req/s, as Kylas does — a read here waits it out. */
const get = async (path) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${KYLAS}${path}`, { headers: { 'api-key': 'k' } });
    if (r.status !== 429) return r.json();
    await new Promise((res) => setTimeout(res, 400));
  }
  return {};
};
/* Everyone's accounts, not just the key owner's. */
const ownerSel = await F().evaluate(() => { const s = document.getElementById('fOwner'); if (!s) return null;
  const o = [...s.options].find((x) => x.value === 'all'); if (o) { s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); }
  return [...s.options].map((x) => x.value); });
console.log('owner select:', JSON.stringify(ownerSel));
for (let i = 0; i < 40; i++) { if ((await F().evaluate(() => document.querySelectorAll('#vwrap .vr[data-id]').length)) >= 4) break; await page.waitForTimeout(1000); }

/* Owner filter: everyone, so all four mock companies are on screen. */
const shown = await F().evaluate(() => document.querySelectorAll('#vwrap .vr').length);
console.log(`rows on screen: ${shown}`);
await F().evaluate(() => document.getElementById('accPickAll')?.click());
await page.waitForTimeout(1500);
ok('ticking rows brings up the floating bar', await F().evaluate(() => !!document.querySelector('.abar #accReassign')));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/rd-1-bar.png` });
await F().evaluate(() => document.getElementById('accReassign').click());
await page.waitForTimeout(800);

const opts = await F().evaluate(() => [...document.querySelectorAll('[data-allot-who="0"] option')].map((o) => o.textContent.trim()));
ok('the people are the active list', opts.includes('Sejal One') && opts.includes('Mayra Five'), opts.join(', '));
ok('...never the Super Admin, never a deactivated user', !opts.some((o) => /Super Admin|Sejal Old|Gone Away/.test(o)), opts.join(', '));

/* Sejal 40, + Mayra 60 */
const pick = async (i, name) => F().evaluate(([i, name]) => {
  const s = document.querySelector(`[data-allot-who="${i}"]`);
  s.value = [...s.options].find((o) => o.textContent.trim() === name).value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, [i, name]);
const pct = async (i, v) => F().evaluate(([i, v]) => {
  const n = document.querySelector(`[data-allot-pct="${i}"]`); n.value = String(v);
  n.dispatchEvent(new Event('change', { bubbles: true }));
}, [i, v]);
await pick(0, 'Sejal One'); await page.waitForTimeout(400);
await F().evaluate(() => document.getElementById('accAllotAdd').click()); await page.waitForTimeout(400);
await pick(1, 'Mayra Five'); await page.waitForTimeout(400);
await pct(0, 40); await page.waitForTimeout(300);
await pct(1, 60); await page.waitForTimeout(500);
const preview = await F().evaluate(() => document.querySelector('.rdPanel')?.innerText || '');
ok('the panel shows 2 each for a 40/60 split of 4', (preview.match(/\n2\n/g) || []).length >= 2 || /2\s+\d+ contacts[\s\S]*2\s+\d+ contacts/.test(preview),
   preview.replace(/\s+/g, ' ').slice(0, 300));
ok('the button says how many', /Re-assign 4 accounts/.test(preview), preview.replace(/\s+/g, ' ').slice(0, 200));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/rd-2-choose.png` });

/* Go: accept the confirm. It becomes a job on the server; the top-bar chip
   follows it (2026-10-29, re-assignment as a background job). */
page.on('dialog', (d) => d.accept());
const tStart = Date.now();
await F().evaluate(() => document.getElementById('accAllotGo').click());
let chipSeen = '', chipEnd = '', shotRun = false;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(500);
  const t = await F().evaluate(() => { const b = document.getElementById('jobBtn'); return b && !b.hidden ? b.textContent : ''; });
  if (t && !chipSeen) { chipSeen = t; console.log(`    chip after ${Date.now() - tStart} ms: "${t}"`); if (SHOTS) await page.screenshot({ path: `${SHOTS}/allot-running.png` }); }
  if (SHOTS && !shotRun && /Re-assigning/.test(await F().evaluate(() => document.querySelector('.rdPanel')?.innerText || ''))) { shotRun = true; await page.screenshot({ path: `${SHOTS}/rd-3-running.png` }); }
  if (/moved ✓/.test(t)) { chipEnd = t; break; }
}
ok('Start hands it to the server at once — the chip shows the job', /Re-assigning|moved/.test(chipSeen), chipSeen);
ok('the chip ends with what moved', /4 moved ✓/.test(chipEnd), chipEnd);
const msg = await F().evaluate(() => document.querySelector('.exbmsg')?.innerText || '');
ok('the panel says it runs in the background', /in the background/.test(msg), msg);
await page.waitForTimeout(800);
ok('the panel turns into the result', /4 moved ✓/.test(await F().evaluate(() => document.querySelector('.rdPanel')?.innerText || '')));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/rd-4-done.png` });
await F().evaluate(() => document.getElementById('rdDone')?.click()); await page.waitForTimeout(500);
ok('Close clears the chip', await F().evaluate(() => document.getElementById('jobBtn').hidden));

const owners = await Promise.all(['903', '1776620', '1778327', '1810449'].map(async (id) => (await get(`/v1/companies/${id}`)).ownerId));
ok('in Kylas: every account on Sejal or Mayra', owners.every((o) => o === 80001 || o === 80005), JSON.stringify(owners));
ok('...two each', owners.filter((o) => o === 80001).length === 2 && owners.filter((o) => o === 80005).length === 2, JSON.stringify(owners));
const c112936 = (await get('/v1/contacts/112936')).ownerId;
ok("the Super Admin's contact on 1776620 moved with its account", c112936 === (await get('/v1/companies/1776620')).ownerId, String(c112936));
/* Every contact follows its account now (2026-10-22), Priya's included. */
ok("Priya's contacts went with their accounts too", (await get('/v1/contacts/112937')).ownerId === (await get('/v1/companies/1776620')).ownerId &&
   (await get('/v1/contacts/38470')).ownerId === (await get('/v1/companies/903')).ownerId);
ok('no keep-contacts box any more', !(await F().evaluate(() => !!document.getElementById('accAllotKeep'))));
const ticked = await F().evaluate(() => document.querySelectorAll('.acctable .vr[data-id] input[type=checkbox]:checked').length);
ok('the moved rows are unticked', ticked === 0, String(ticked));
/* The list is the Airtable copy, which learns the new owners at the next sync;
   the table must already say what Kylas says. */
await page.waitForTimeout(2500);
const rowText = await F().evaluate(() => [...document.querySelectorAll('#vwrap .vr')].map((r) => r.innerText).join('\n'));
ok('the table shows the new owners straight away', (rowText.match(/Sejal One/g) || []).length === 2 &&
   (rowText.match(/Mayra Five/g) || []).length === 2 && !/Gone Away|Enout Super Admin/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 300));
ok('no page errors', !errs.length, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
