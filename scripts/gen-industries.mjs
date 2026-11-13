#!/usr/bin/env node
/* docs/industries.json -> scripts/industries.mjs (proxy/Worker, no fs there)
   and extension/console/industries.js (window.Industries). Run after editing
   the JSON:  node scripts/gen-industries.mjs */
import { readFileSync, writeFileSync } from "node:fs";
const j = JSON.parse(readFileSync(new URL("../docs/industries.json", import.meta.url), "utf8"));
const data = JSON.stringify({ groups: j.groups, map: j.map });
const head = "/* GENERATED FROM docs/industries.json by scripts/gen-industries.mjs — do not edit. */\n";
writeFileSync(new URL("./industries.mjs", import.meta.url), head + `export const INDUSTRIES = ${data};\n`);
writeFileSync(new URL("../extension/console/industries.js", import.meta.url), head + `window.Industries = ${data};\n`);
console.log(`${Object.keys(j.groups).length} groups -> scripts/industries.mjs, extension/console/industries.js`);
