/* THE CONSOLE CAN BE PICKED UP, RESIZED AND PUT BACK — in a real Chrome with
 * the real extension loaded, because none of this can be tested any other way.
 *
 *   node scripts/dev-seed.mjs all          (fixtures, optional)
 *   xvfb-run -a node scripts/test-move-live.mjs
 *
 * Extensions only load in a HEADED browser, hence xvfb-run. It needs the host
 * stub on :8778 and a copy of extension/ whose manifest also matches
 * http://127.0.0.1:8778/* — see docs/STATE.md §2.
 *
 * WHY IT EXISTS. Every part of this was written, reviewed and believed to
 * work, and none of it did. `.viewport` was `inset:0`, so on the two screens
 * an associate actually uses the report covered the header — and the header is
 * the handle you drag the console by, and it carries Dock and Close. The grab
 * cursor and the mousedown handler were both real and both sat under an
 * element no pointer could reach. Nothing short of a real press at real
 * coordinates finds that: the handler fires happily when a test dispatches the
 * event straight at the element.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

/* Where the patched copy of extension/ lives, and the host stub it matches. */
const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const HOST = process.env.HOST_STUB || 'http://127.0.0.1:8778';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pv-' + Date.now(), {
  headless: false, viewport: { width: 1500, height: 1000 },
  args: ['--disable-extensions-except=/tmp/claude-0/exttest',
         '--load-extension=/tmp/claude-0/exttest', '--no-proxy-server'] });
const page = ctx.pages()[0] || await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('enout.setting.proxy', JSON.stringify('http://127.0.0.1:8787')));
await page.goto(HOST + '/sales/companies/list/');
await page.waitForTimeout(3500);
const SR = () => page.evaluate(() => { const h = [...document.querySelectorAll('*')]
  .find(n => n.shadowRoot?.querySelector('.wrap')); return !!h; });
const box = () => page.evaluate(() => {
  const w = [...document.querySelectorAll('*')].find(n => n.shadowRoot?.querySelector('.wrap'))
    .shadowRoot.querySelector('.wrap');
  const r = w.getBoundingClientRect();
  return { cls: w.className, x: Math.round(r.x), y: Math.round(r.y),
           w: Math.round(r.width), h: Math.round(r.height) };
});
const open = () => page.evaluate(() => [...document.querySelectorAll('*')]
  .find(n => n.shadowRoot?.querySelector('.wrap')).shadowRoot.querySelector('.fab').click());
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;
let fails = 0;
const ok = (what, cond, detail = '') => { if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}${cond || !detail ? '' : ` — ${detail}`}`); };

await open(); await page.waitForTimeout(3000);
const full = await box();
console.log('opened:', JSON.stringify(full));
ok('opens full-screen, inset 10px', full.cls.includes('full') && full.x === 10 && full.y === 10);

/* the bar is reachable — it is the handle, and it holds Dock and Close */
const frame = page.frames().find(f => f.url().startsWith('chrome-extension'));
const hit = await frame.evaluate(() => {
  const r = document.querySelector('header').getBoundingClientRect();
  const el = document.elementFromPoint(r.x + 300, r.y + r.height / 2);
  return { tag: el?.tagName, cls: el?.className, inBar: !!el?.closest('header'),
           closeVisible: !!document.getElementById('closeBtn')?.offsetParent };
});
ok('a press on the bar reaches the bar', hit.inBar, `lands on ${hit.tag}.${hit.cls}`);
ok('Close is on screen on the accounts view', hit.closeVisible);
ok('the bar says what it does',
  /Drag to move/.test(await frame.evaluate(() => document.querySelector('header').title)));

/* ── 1 · shrink from the south-east corner ── */
const grab = async (x, y, dx, dy) => {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up(); await page.waitForTimeout(500);
};
await grab(full.x + full.w - 3, full.y + full.h - 3, -480, -380);
const small = await box();
ok('SE corner shrinks it', near(small.w, full.w - 480) && near(small.h, full.h - 380),
   `${full.w}x${full.h} -> ${small.w}x${small.h}`);
ok('...and the top-left stays put', small.x === full.x && small.y === full.y);

/* ── 2 · move it by the header ── */
const hb = await frame.evaluate(() => { const r = document.querySelector('header').getBoundingClientRect();
  return { x: r.x + 300, y: r.y + r.height / 2 }; });
await grab(small.x + hb.x, small.y + hb.y, 300, 200);
const moved = await box();
ok('dragging the header moves it', near(moved.x, small.x + 300) && near(moved.y, small.y + 200),
   `wanted ${small.x + 300},${small.y + 200} — got ${moved.x},${moved.y}`);
ok('...without resizing it', moved.w === small.w && moved.h === small.h);

/* ── 3 · each edge moves only its own side ── */
const right = moved.x + moved.w, bottom = moved.y + moved.h;
await grab(moved.x + 3, moved.y + moved.h / 2, -180, 0);
const w1 = await box();
ok('the west edge grows leftward', near(w1.w, moved.w + 180) && near(w1.x, moved.x - 180),
   `${moved.w} -> ${w1.w} at x ${w1.x}`);
ok('...and the east edge does not move', near(w1.x + w1.w, right));

await grab(w1.x + w1.w / 2, w1.y + 3, -0, -120);
const n1 = await box();
ok('the north edge grows upward', near(n1.h, w1.h + 120) && near(n1.y, w1.y - 120),
   `${w1.h} -> ${n1.h} at y ${n1.y}`);
ok('...and the bottom edge does not move', near(n1.y + n1.h, bottom));

/* ── 4 · it is remembered ── */
await page.reload(); await page.waitForTimeout(3000);
await open(); await page.waitForTimeout(2500);
const back = await box();
ok('the position survives a reload', near(back.x, n1.x) && near(back.y, n1.y)
   && near(back.w, n1.w) && near(back.h, n1.h), JSON.stringify(back));

/* ── 5 · double-click the bar puts it back ── */
const f2 = page.frames().find(f => f.url().startsWith('chrome-extension'));
const hb2 = await f2.evaluate(() => { const r = document.querySelector('header').getBoundingClientRect();
  return { x: r.x + 300, y: r.y + r.height / 2 }; });
await page.mouse.dblclick(back.x + hb2.x, back.y + hb2.y);
await page.waitForTimeout(700);
const reset = await box();
ok('double-clicking the bar resets it', reset.cls.includes('full') && reset.x === 10 && reset.y === 10,
   JSON.stringify(reset));

/* ── 6 · a button in the bar still behaves like a button ── */
const f3 = page.frames().find(f => f.url().startsWith('chrome-extension'));
await f3.evaluate(() => document.getElementById('dockBtn').click());
await page.waitForTimeout(700);
const docked = await box();
ok('Dock still docks rather than starting a drag', docked.cls.includes('dock'), JSON.stringify(docked));
await page.screenshot({ path: (process.env.SHOT || '/tmp/claude-0/move.png') });
console.log(errs.length ? 'ERRORS: ' + errs.slice(0,3).join('; ') : '');
console.log(fails ? `\n${fails} failed` : '\nall passed');
await ctx.close();
process.exit(fails ? 1 : 0);
