#!/usr/bin/env node
/* Renders the extension's icons from the badge the console already wears.
 *
 *   node scripts/gen-icons.mjs
 *
 * WHY THIS EXISTS AND WHY IT IS A SCRIPT
 * The manifest had no `icons` key and the tree had no icon files, so Chrome
 * drew the generic puzzle piece everywhere and the Web Store had nothing to
 * list. Drawing four PNGs by hand in an editor means the day the accent colour
 * moves, the icons quietly stop matching the product. This renders them from
 * the same hex and the same shape as `.bar .g` in console.css — the "EN" badge
 * in the console's own title bar — so they are the badge rather than a copy of
 * it.
 *
 * Chromium does the rendering because it is already here for the live tests,
 * and because it is the only thing in this repo that can lay out text. The
 * bundled Bricolage Grotesque is used, so the letterforms are the product's.
 *
 * 16 / 32 / 48 / 128 are what Chrome asks for: 16 in the page favicon spot, 32
 * on Windows, 48 in the extensions manager, 128 at install and on the store.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(EXT, "icons");
const SIZES = [16, 32, 48, 128];

/* One source of truth for the two values that matter, read from the stylesheet
   rather than retyped. A hex that drifts from --blue is exactly the failure
   this script exists to prevent. */
const css = readFileSync(join(EXT, "console", "console.css"), "utf8");
const BLUE = (css.match(/--blue:\s*(#[0-9A-Fa-f]{6})/) || [])[1] || "#4338CA";
const ON_BLUE = (css.match(/--onBlue:\s*(#[0-9A-Fa-f]{6})/) || [])[1] || "#FFFFFF";

/* The font, inlined as a data URI: a file:// page cannot fetch a sibling woff2
   without tripping CORS, and a silent fallback to a system face would give the
   128 and the 16 different letterforms. */
const woff = readFileSync(join(EXT, "console", "fonts", "f0.woff2")).toString("base64");

/* Proportions from `.bar .g`: a 24px square with a 6px radius, i.e. a quarter.
   Scaling the radius with the size keeps the silhouette identical at 16 and at
   128 — a fixed radius reads as a circle at 16 and as a square at 128. */
const page = (size) => `<!doctype html><meta charset="utf-8"><style>
  @font-face{font-family:'Bricolage Grotesque';src:url(data:font/woff2;base64,${woff}) format('woff2');
    font-weight:700;font-display:block}
  html,body{margin:0;padding:0;background:transparent}
  .g{width:${size}px;height:${size}px;border-radius:${Math.round(size / 4)}px;
     background:${BLUE};color:${ON_BLUE};display:grid;place-items:center;
     font-family:'Bricolage Grotesque',system-ui,sans-serif;font-weight:700;
     /* Optically centred: the cap height sits high in the em box, so a purely
        geometric centre leaves the mark looking as though it has slipped up. */
     font-size:${Math.round(size * 0.46)}px;letter-spacing:${size * -0.02}px;
     line-height:1;padding-bottom:${Math.max(0, Math.round(size * 0.02))}px}
</style><div class="g">EN</div>`;

const { chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ channel: "chromium", headless: true });
mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const p = await browser.newPage({ viewport: { width: size, height: size },
                                    deviceScaleFactor: 1 });
  await p.setContent(page(size));
  await p.evaluate(() => document.fonts.ready);
  const buf = await p.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `icon${size}.png`), buf);
  console.log(`  icons/icon${size}.png  ${buf.length} bytes`);
  await p.close();
}
await browser.close();
console.log(`\n${SIZES.length} icon(s) from --blue ${BLUE} on ${ON_BLUE}.`);
console.log(`Re-run this if the accent colour changes.`);
