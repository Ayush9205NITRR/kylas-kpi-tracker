/* THE THINGS THAT ONLY EXIST ON SCREEN, driven in a real Chrome.
 *
 *   xvfb-run -a node scripts/test-ui-live.mjs
 *
 * Every assertion here is about something no unit test can see: a border that
 * has to be draggable, a chip cascade that has to write into a text field
 * without eating what was typed beside it, a board whose columns have to be
 * the right columns. All three shipped having only been syntax-checked, and
 * two of them had probe bugs that looked exactly like product bugs until the
 * probe was fixed — which is the argument for this file existing.
 *
 * WHAT IT NEEDS (docs/STATE.md §2), and each of these was learned by it
 * failing in a way that blamed the product:
 *
 *   the stack      mock-kylas :9900, mock-airtable :9901, proxy :8787,
 *                  the host stub :8778, then `node scripts/dev-seed.mjs all`
 *   a patched copy of extension/ at EXT_DIR, whose manifest adds
 *                  http://127.0.0.1:8778/* to BOTH content_scripts.matches
 *                  AND web_accessible_resources.matches — without the second
 *                  Chrome refuses to load console.html and there is no frame
 *                  at all, which reads as "the console is broken"
 *   API.setBase    the console defaults to the DEPLOYED proxy. Left alone,
 *                  every list is empty and every board assertion passes
 *                  vacuously — the worst kind of green
 *   a fresh profile dir per run: the event chips TOGGLE, so a second run in
 *                  the same profile removes the card the first one added
 *   headed + xvfb  extensions do not load headless. Never `headless: true`.
 *
 * The console's iframe lives in an OPEN shadow root on #enout-console-host,
 * so the host page reaches it with host.shadowRoot.querySelector("iframe"),
 * and the accounts view is opened the way the real toolbar opens it: a
 * postMessage of { source: "enout-host", type: "companies" }.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const ctx = await chromium.launchPersistentContext((process.env.PROFILE_DIR || '/tmp/claude-0/pui-') + Date.now(), {
  headless: false, viewport: { width: 1700, height: 1000 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/CERT|404|ERR_CONNECTION|favicon/.test(m.text())) errors.push(m.text()); });
const F = () => page.frames().find((f) => f.url().startsWith('chrome-extension'));

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}${cond || !detail ? '' : ` — ${detail}`}`);
};

await page.goto('http://127.0.0.1:8778/sales/companies/details/903/');
await page.waitForTimeout(4000);
/* Point the console at the local stack. The default is the deployed proxy,
   which this container cannot reach — without this every list is empty and
   every board assertion passes vacuously. */
await F().evaluate(async () => { await API.setBase('http://127.0.0.1:8787'); });
await page.reload();
await page.waitForTimeout(5000);
let f = F();
console.log(`frame: ${f ? 'console loaded' : 'NO CONSOLE FRAME'}`);

/* ── 1 · the panes resize ─────────────────────────────────────────────── */
console.log('\n1. draggable pane widths');
const grips = await f.locator('.pgrip').count();
ok('grips exist on the pane borders', grips === 2, `found ${grips}`);
const widthOf = (id) => f.locator(`#${id}`).evaluate((n) => n.getBoundingClientRect().width);
const beforeL = await widthOf('paneL'), beforeR = await widthOf('paneR');
if (grips) {
  const box = await f.locator('.pgrip').first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + Math.min(200, box.height / 2);
  console.log(`   grip at ${x.toFixed(0)},${y.toFixed(0)} (${box.width.toFixed(0)}x${box.height.toFixed(0)})`);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x - 160, y, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(400);
}
const afterL = await widthOf('paneL'), afterR = await widthOf('paneR');
ok('dragging left narrows the contact pane', afterL < beforeL - 100, `${beforeL.toFixed(0)} → ${afterL.toFixed(0)}`);
ok('...and widens the one beside it', afterR > beforeR + 100, `${beforeR.toFixed(0)} → ${afterR.toFixed(0)}`);
await f.locator('.pgrip').first().dblclick();
await page.waitForTimeout(300);
ok('double-click resets', Math.abs((await widthOf('paneL')) - beforeL) < 20,
   `${beforeL.toFixed(0)} vs ${(await widthOf('paneL')).toFixed(0)}`);

/* ── 2 · the quarter picker ───────────────────────────────────────────── */
console.log('\n2. quarter → month → week');
await f.locator('.tc', { hasText: 'Employee offsites' }).first().click().catch(() => {});
await page.waitForTimeout(500);
const when = f.locator('.ev .bl input').nth(1);
await when.click();
await page.waitForTimeout(300);
const rows = await f.locator('.strip .qrow').count();
ok('the cascade renders as labelled rows', rows >= 2, `${rows} rows`);
const labels = await f.locator('.strip .qrow .lbl').allTextContents();
ok('it starts with Quarter', labels[0]?.startsWith('Quarter'), JSON.stringify(labels));
await f.locator('.strip .qc', { hasText: 'Jul–Sep' }).first().click();
await page.waitForTimeout(300);
ok('picking a quarter writes it into the free text',
   (await when.inputValue()).includes('Jul–Sep'), await when.inputValue());
const lbl2 = await f.locator('.strip .qrow .lbl').allTextContents();
ok('...and a Month row appears', lbl2.some((t) => t.startsWith('Month')), JSON.stringify(lbl2));
await f.locator('.strip .qc', { hasText: /^Aug$/ }).first().click();
await page.waitForTimeout(300);
const afterMonth = await when.inputValue();
ok('picking a month REPLACES the quarter, not appends', afterMonth.includes('Aug') && !afterMonth.includes('Jul–Sep'), afterMonth);
const lbl3 = await f.locator('.strip .qrow .lbl').allTextContents();
ok('...and a Week row appears', lbl3.some((t) => t.startsWith('Week')), JSON.stringify(lbl3));
await f.locator('.strip .qc', { hasText: 'Week 2' }).first().click();
await page.waitForTimeout(300);
ok('the week joins the month', /Aug, week 2/.test(await when.inputValue()), await when.inputValue());
/* free text typed by hand must survive the next chip */
await when.fill('Aug, week 2, not signed off');
await when.click(); await page.waitForTimeout(200);
await f.locator('.strip .qc', { hasText: 'Oct–Dec' }).first().click();
await page.waitForTimeout(300);
const kept = await when.inputValue();
ok('a chip replaces only its own phrase, keeping typed text',
   kept.includes('Oct–Dec') && kept.includes('not signed off'), kept);

/* ── 3 · the accounts view ────────────────────────────────────────────── */
console.log('\n3. accounts: width, stage filter, board switch');
/* Exactly how the host page opens it: a postMessage from the toolbar. */
/* The iframe lives inside an OPEN shadow root on the host element, so it is
   not reachable with a plain descendant selector. */
const posted = await page.evaluate(() => {
  const host = document.querySelector('#enout-console-host');
  const fr = host?.shadowRoot?.querySelector('iframe') || host?.querySelector('iframe');
  if (!fr) return 'no iframe';
  fr.contentWindow.postMessage({ source: 'enout-host', type: 'companies' }, '*');
  return 'posted';
});
console.log(`   ${posted}`);
await page.waitForTimeout(9000);
ok('the accounts view opened', await f.locator('#viewport').isVisible(),
   (await f.locator('#vwrap').textContent().catch(() => '')).slice(0, 120));
const wrapWide = await f.locator('.vwrap').evaluate((n) => ({
  wide: n.classList.contains('wide'), max: getComputedStyle(n).maxWidth, w: n.getBoundingClientRect().width })).catch(() => null);
console.log(`   .vwrap → ${JSON.stringify(wrapWide)}`);
ok('the accounts view drops the reading measure', wrapWide?.wide === true && wrapWide?.max === 'none', JSON.stringify(wrapWide));

const stageBtnText = await f.locator('#stageBtn .msel-k').textContent().catch(() => '');
ok('the toolbar filter is named Account stage', stageBtnText.trim() === 'Account stage', JSON.stringify(stageBtnText));
const moreLabels = await f.locator('.morebody .chiprow > .lbl, .morebody .lbl').allTextContents().catch(() => []);
ok('the demand-team row is no longer called Account stage',
   !moreLabels.some((t) => /^Account stage/.test(t.trim())), JSON.stringify(moreLabels.slice(0, 8)));

await f.locator('#accBoard').click().catch(() => {});
await page.waitForTimeout(900);
const bg = await f.locator('#bgBucket, #bgStage').count();
ok('the board offers Buckets / Stages', bg === 2, `found ${bg}`);
const bucketCols = await f.locator('.bcol header h3').allTextContents();
console.log(`   bucket columns: ${JSON.stringify(bucketCols)}`);
ok('buckets give the six (plus the unplaced pile)', bucketCols.length >= 6, JSON.stringify(bucketCols));
await f.locator('#bgStage').click().catch(() => {});
await page.waitForTimeout(900);
const stageCols = await f.locator('.bcol header h3').allTextContents();
const stageHints = await f.locator('.bcol header em').allTextContents();
console.log(`   stage columns: ${JSON.stringify(stageCols)}`);
ok('stages give a column per stage present', stageCols.length >= 2, JSON.stringify(stageCols));
ok('...each naming its rung', stageHints.some((h) => /rung \d+ of 26/.test(h)), JSON.stringify(stageHints.slice(0, 4)));
const rungs = stageHints.map((h) => Number((/rung (\d+)/.exec(h) || [])[1])).filter(Number.isFinite);
ok('...furthest first', rungs.every((r, i) => i === 0 || rungs[i - 1] >= r), JSON.stringify(rungs));

/* A card must not repeat the column it is standing in. */
const stageCards = await f.locator('.bcol .bcard .bstage').count();
ok('on the Stages board a card does not repeat its column', stageCards === 0, `${stageCards} cards still say it`);
await f.locator('#bgBucket').click().catch(() => {});
await page.waitForTimeout(900);
const bucketCards = await f.locator('.bcol .bcard .bstage').count();
ok('...while on Buckets it still says WHICH stage, which the column does not',
   bucketCards > 0, `${bucketCards} cards name their stage`);

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) { console.log('\nPAGE ERRORS:'); [...new Set(errors)].slice(0, 8).forEach((e) => console.log('  ! ' + e)); }
await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/ui-board.png' });
await ctx.close();
process.exit(fail || errors.length ? 1 : 0);
