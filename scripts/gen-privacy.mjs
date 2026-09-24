#!/usr/bin/env node
/* PRIVACY.md → worker/privacy.mjs, so the Worker can serve the policy at
 * https://bd.enout.website/privacy — the public URL the Chrome Web Store asks
 * for. The Worker cannot read files, and Node (the tests) cannot import .md,
 * so the text is carried as a JS string. Regenerate after editing PRIVACY.md:
 *
 *   node scripts/gen-privacy.mjs
 *
 * test-worker.mjs fails if the two disagree. */
import { readFileSync, writeFileSync } from "node:fs";
const md = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
writeFileSync(new URL("../worker/privacy.mjs", import.meta.url),
  `/* GENERATED from PRIVACY.md by scripts/gen-privacy.mjs — do not edit. */\nexport default ${JSON.stringify(md)};\n`);
console.log("worker/privacy.mjs written");
