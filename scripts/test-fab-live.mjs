/* THE LAUNCHER MOVES, AND MOVING IT DOES NOT OPEN THE CONSOLE.
 *
 *   xvfb-run -a node scripts/test-fab-live.mjs
 *
 * A real Chrome with the extension loaded, driving the real mouse — the button
 * is the host page's own element and the gestures under test are a click and a
 * drag that START IDENTICALLY. They are told apart by distance, and no test
 * that dispatches events at an element can tell you whether that works.
 *
 * It lived in the bottom-right corner with no way off it, which is also where
 * Kylas puts its own controls: on some records the one control that opens this
 * thing was underneath something else.
 *
 * Needs the host stub on :8778 and a copy of extension/ whose manifest also
 * matches http://127.0.0.1:8778/* — see docs/STATE.md §2.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const EXT = process.env.EXT_DIR || '/tmp/claude-0/exttest';
const HOST = process.env.HOST_STUB || 'http://127.0.0.1:8778';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pv-' + Date.now(), {
  headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server'] });
const page = ctx.pages()[0] || await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
const fabRaw = () => page.evaluate(() => {
  const h = [...document.querySelectorAll('*')].find(n => n.shadowRoot?.querySelector('.fab'));
  const f = h.shadowRoot.querySelector('.fab'); const r = f.getBoundingClientRect();
  return { cls: f.className, x: Math.round(r.x), y: Math.round(r.y),
           w: Math.round(r.width), h: Math.round(r.height), title: f.title }; });
/* Wait for layout — the button is added by the content script and measures
   0x0 until the page has settled. */
const fab = async () => { for (let i = 0; i < 40; i++) { const r = await fabRaw();
  if (r.w > 0) return r; await page.waitForTimeout(250); } return fabRaw(); };
const open = () => page.evaluate(() => [...document.querySelectorAll('*')]
  .find(n => n.shadowRoot?.querySelector('.fab')).classList.contains('open'));
/* The console AUTO-OPENS on the companies list and the dashboard, and the
   button is hidden while it is open — so close it before looking for it. */
const shut = async () => { await page.waitForTimeout(500);
  if (await open().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(800); } };
await page.goto(HOST + '/sales/companies/list/');
await page.waitForTimeout(3500);
await shut();

let fails = 0;
const ok = (w, c, d='') => { if (!c) fails++; console.log(`  ${c?'PASS':'FAIL'}  ${w}${c||!d?'':` — ${d}`}`); };

const a = await fab();
console.log('at rest:', JSON.stringify(a));
/* The RIGHT edge, not the left: the label changes width (since 1.57 it says
   why the console just closed), and a wider label moves the left edge while
   the button is still in the corner. */
ok('sits bottom-right by default', a.x + a.w > 1350 && a.y > 800 && !a.cls.includes('free'), JSON.stringify(a));
ok('says it can be moved', /Drag to move/.test(a.title), a.title);

/* ── a plain click still opens the console ── */
await page.mouse.click(a.x + a.w/2, a.y + a.h/2); await page.waitForTimeout(1500);
ok('a click still opens the console', await open());
await page.keyboard.press('Escape'); await page.waitForTimeout(900);

/* ── drag it to the middle ── */
await page.mouse.move(a.x + a.w/2, a.y + a.h/2);
await page.mouse.down();
await page.mouse.move(a.x + a.w/2 - 600, a.y + a.h/2 - 400, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(600);
const b = await fab();
console.log('after drag:', JSON.stringify(b));
ok('it moved', Math.abs(b.x - (a.x - 600)) < 6 && Math.abs(b.y - (a.y - 400)) < 6,
   `wanted ${a.x-600},${a.y-400} — got ${b.x},${b.y}`);
ok('...and the drag did NOT open the console', !(await open()));

/* ── remembered ── */
await page.reload(); await page.waitForTimeout(3000); await shut();
const c = await fab();
ok('remembered across a reload', Math.abs(c.x - b.x) < 4 && Math.abs(c.y - b.y) < 4, JSON.stringify(c));

/* ── click still works where it now is ── */
await page.mouse.click(c.x + c.w/2, c.y + c.h/2); await page.waitForTimeout(1500);
ok('still opens from its new place', await open());
await page.keyboard.press('Escape'); await page.waitForTimeout(900);

/* ── dropped back in the corner forgets ── */
const d0 = await fab();
await page.mouse.move(d0.x + d0.w/2, d0.y + d0.h/2);
await page.mouse.down();
await page.mouse.move(1380 - d0.w/2, 880 - d0.h/2, { steps: 12 });
await page.mouse.up(); await page.waitForTimeout(600);
const e = await fab();
ok('dropping it in the corner resets it', !e.cls.includes('free'), JSON.stringify(e));
await page.reload(); await page.waitForTimeout(2500); await shut();
const f = await fab();
ok('...and it stays reset', !f.cls.includes('free') && f.x + f.w > 1350, JSON.stringify(f));

/* ── a narrow window cannot strand it ── */
await page.mouse.move(f.x + f.w/2, f.y + f.h/2); await page.mouse.down();
await page.mouse.move(700, 120, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
await page.setViewportSize({ width: 500, height: 420 }); await page.waitForTimeout(700);
const g = await fab();
ok('a smaller window pulls it back on screen', g.x + g.w <= 500 && g.y + g.h <= 420, JSON.stringify(g));
console.log(errs.length ? 'ERRORS: ' + errs.slice(0,3).join('; ') : '');
console.log(fails ? `\n${fails} failed` : '\nall passed');
await ctx.close();
process.exit(fails ? 1 : 0);
