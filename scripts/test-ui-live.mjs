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

/* ── re-assigning the owner from the card ───────────────────────────────
   The dropdown showed names and carried no ids, so picking a new owner
   relabelled the record and the save sent the old ownerId. */
console.log('\n4. re-assigning the owner');
await page.evaluate(() => {
  const host = document.querySelector('#enout-console-host');
  host?.shadowRoot?.querySelector('iframe')?.contentWindow
      ?.postMessage({ source: 'enout-host', type: 'company', kylasId: '1776620' }, '*');
});
await page.waitForTimeout(4000);
for (let i = 0; i < 40; i++) {
  if (await f.evaluate(() => Object.keys(OWNER_ID).length)) break;
  await page.waitForTimeout(500);
}
const ids = await f.evaluate(() => JSON.parse(JSON.stringify(OWNER_ID)));
ok('the owner names carry their Kylas ids', Object.keys(ids).length >= 1, JSON.stringify(ids));
const was = await f.locator('#f-ow').inputValue();
const pick = Object.keys(ids).find((o) => o !== was);
if (pick) {
  await f.locator('#f-ow').selectOption(pick);
  await page.waitForTimeout(300);
  const got = await f.evaluate(() => ({ owner: rec().owner, ownerId: rec().ownerId }));
  ok('picking an owner sets the name', got.owner === pick, JSON.stringify(got));
  ok('...and the id the save reassigns by', got.ownerId === String(ids[pick]), JSON.stringify(got));
} else ok('an owner to switch to', false, `only ${JSON.stringify(Object.keys(ids))}`);

/* ── the owner filter takes more than one ───────────────────────────────
   It was a single select: "one owner, or everyone". A manager's question is
   "Gurnoor and Muskan together". */
console.log('\n5. the owner filter, multi-select');
await page.evaluate(() => {
  const host = document.querySelector('#enout-console-host');
  host?.shadowRoot?.querySelector('iframe')?.contentWindow
      ?.postMessage({ source: 'enout-host', type: 'companies' }, '*');
});
await page.waitForTimeout(7000);
ok('the old single select is gone', await f.locator('#accOwner').count() === 0);
ok('a checklist is in its place', await f.locator('#ownerBtn').count() === 1);
const total = await f.locator('.acctable .vr, .bcard').count();
await f.locator('#ownerBtn').click();
await page.waitForTimeout(500);
const names = await f.locator('#ownerList .msel-name').allTextContents();
console.log(`   owners offered: ${JSON.stringify(names.slice(0, 6))}`);
ok('it lists the owners with counts', names.length >= 2, JSON.stringify(names));
const boxes = f.locator('#ownerList input[data-ownerv]');
await boxes.nth(0).check();
await page.waitForTimeout(700);
const one = await f.locator('.acctable .vr, .bcard').count();
await f.locator('#ownerBtn').click().catch(() => {});
await page.waitForTimeout(300);
await f.locator('#ownerBtn').click().catch(() => {});
await page.waitForTimeout(400);
await f.locator('#ownerList input[data-ownerv]').nth(1).check();
await page.waitForTimeout(700);
const two = await f.locator('.acctable .vr, .bcard').count();
/* ACC lives inside views.js's closure, so the selection is read from the
   checklist itself — which is also what the person sees. */
const picked = await f.locator('#ownerList input[data-ownerv]:checked')
  .evaluateAll((ns) => ns.map((n) => n.dataset.ownerv));
console.log(`   rows: all=${total} one=${one} two=${two} · picked=${JSON.stringify(picked)}`);
ok('two owners are held at once', picked.length === 2, JSON.stringify(picked));
ok('...and two owners show more than one', two > one, `one=${one} two=${two}`);
ok('...and still no more than everybody', two <= total, `two=${two} all=${total}`);
const label = await f.locator('#ownerBtn .msel-v').textContent();
ok('the button says how many', /any of 2/.test(label || ''), JSON.stringify(label));
/* COPY LINK HAS TO CARRY BOTH. The filter state lives in the console's own
   URL so a question can be sent to somebody; one key per owner, the way the
   other multi-selects encode. A link from the old build carried one name
   under the same key, and getAll of one key is still one name — so old links
   keep working. */
const hash = await f.evaluate(() => location.hash);
/* The hash is "#<view>=<querystring>", so the view name comes off first —
   parsing from the "#" makes the first key read as part of the view name. */
const owners = [...new URLSearchParams(hash.replace(/^#[^=]*=/, '')).getAll('owner')];
console.log(`   hash owners: ${JSON.stringify(owners)}`);
ok('the link carries both owners', owners.length === 2, hash.slice(0, 160));

/* ── a save repaints the dashboard while it is open ─────────────────────
   The numbers reach the server in about three seconds, but a dashboard that
   is already on screen had no reason to ask again. */
console.log('\n6. a save repaints the open dashboard');
await page.evaluate(() => {
  const host = document.querySelector('#enout-console-host');
  host?.shadowRoot?.querySelector('iframe')?.contentWindow
      ?.postMessage({ source: 'enout-host', type: 'dashboard' }, '*');
});
await page.waitForTimeout(7000);
const ladder = await f.locator('.vsec h2', { hasText: 'The ladder' }).count();
ok('the dashboard is open', ladder >= 1, `${ladder} ladders`);
const dials = async () => {
  const t = await f.locator('.vsec').first().textContent().catch(() => '');
  return t.replace(/\s+/g, ' ').slice(0, 300);
};
const beforeText = await dials();
/* Land a save the way a finished job does, through the one choke point.
   WATCHED ON API.report, not on Views.dashboard: savedLanded calls the
   dashboard through the module's own closure, so wrapping the exported name
   spies on something nothing calls — and the test reads as a dead hook when
   the hook is fine. Asking the server again is also the behaviour that
   matters: a repaint that re-rendered the held numbers would prove nothing. */
const fired = await f.evaluate(() => {
  if (!window.Views?.savedLanded) return 'no hook';
  window.__asked = 0;
  const real = API.report.bind(API);
  API.report = (...a) => { window.__asked++; return real(...a); };
  window.Views.savedLanded();
  return 'called';
});
ok('the hook exists and is exported', fired === 'called', fired);
await page.waitForTimeout(4000);
const asked = await f.evaluate(() => window.__asked || 0);
ok('...and it re-asks the server once', asked === 1, `asked ${asked}x`);
/* An outbox draining thirty saves must not repaint thirty times. */
await f.evaluate(() => { window.__asked = 0; for (let i = 0; i < 30; i++) window.Views.savedLanded(); });
await page.waitForTimeout(4000);
const many = await f.evaluate(() => window.__asked || 0);
ok('thirty saves in a row ask once, not thirty', many === 1, `asked ${many}x`);
ok('the dashboard is still there afterwards', (await dials()).length > 20, await dials());

/* ── the accounts board live-updates too, but not under somebody's hands ── */
console.log('\n7. a save repaints the open accounts view');
await page.evaluate(() => {
  const host = document.querySelector('#enout-console-host');
  host?.shadowRoot?.querySelector('iframe')?.contentWindow
      ?.postMessage({ source: 'enout-host', type: 'companies' }, '*');
});
await page.waitForTimeout(7000);
ok('the accounts view is open', await f.locator('#accQ').count() === 1);
/* §5 left the owner picker open, and the guard below correctly refuses to
   repaint under one — so close it, and prove it is closed, before testing the
   case where nothing is in the way. */
if (await f.locator('#ownerList').count()) { await f.locator('#ownerBtn').click(); await page.waitForTimeout(600); }
ok('no picker is in the way', await f.locator('#ownerList').count() === 0);
const spy = await f.evaluate(() => {
  window.__cos = 0;
  const real = API.companies.bind(API);
  API.companies = (...a) => { window.__cos++; return real(...a); };
  window.Views.savedLanded();
  return 'called';
});
ok('the hook runs on this view too', spy === 'called', spy);
await page.waitForTimeout(9000);
const cos = await f.evaluate(() => window.__cos || 0);
console.log(`   waited for: ${JSON.stringify(await f.evaluate(() => window.__repaintWaitedFor))}`);
ok('...and it re-reads the accounts once', cos === 1, `asked ${cos}x`);
ok('the view survived the repaint', await f.locator('#accQ').count() === 1);

/* THE GUARD. A picker open is a deliberate interaction; the repaint waits. */
console.log('\n   ...and waits while a picker is open');
await page.waitForTimeout(1500);                    /* let the repaint settle first */
await f.locator('#ownerBtn').click();
await page.waitForTimeout(800);
ok('a picker is open', await f.locator('#ownerList').count() === 1);
await f.evaluate(() => { window.__cos = 0; window.Views.savedLanded(); });
await page.waitForTimeout(5000);
console.log(`   waited for: ${JSON.stringify(await f.evaluate(() => window.__repaintWaitedFor))}`);
ok('nothing was re-read while it is open',
   (await f.evaluate(() => window.__cos || 0)) === 0, `asked ${await f.evaluate(() => window.__cos || 0)}x`);
ok('...and the picker is still open', await f.locator('#ownerList').count() === 1);
/* Close it, and the waiting repaint lands on its next try. */
await f.locator('#ownerBtn').click();
await page.waitForTimeout(6000);
ok('once it closes, the repaint happens',
   (await f.evaluate(() => window.__cos || 0)) >= 1, `asked ${await f.evaluate(() => window.__cos || 0)}x`);

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) { console.log('\nPAGE ERRORS:'); [...new Set(errors)].slice(0, 8).forEach((e) => console.log('  ! ' + e)); }
await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/ui-board.png' });
await ctx.close();
process.exit(fail || errors.length ? 1 : 0);
