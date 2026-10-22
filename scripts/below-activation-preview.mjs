#!/usr/bin/env node
/* WHAT THE "CALLED, BELOW ACTIVATION" MAIL WOULD SAY TODAY — counts only.
 *
 *   node --env-file=.env.local scripts/below-activation-preview.mjs [--names]
 *
 * Runs the console's own /below-activation route (the same code the Worker's
 * morning mail uses) against the live Kylas + Airtable, and prints how many
 * accounts, by owner, by stage and by how long since the first call. Company
 * names only with --names: GitHub Actions logs of this repository are public.
 * Reads only; sends nothing, keeps nothing.
 */
import { readFileSync } from "node:fs";
import { createHandlers } from "./handlers.mjs";
import { memoryStore } from "./store.mjs";

const vars = {};
let inVars = false;
for (const line of readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").split(/\r?\n/)) {
  if (/^\[/.test(line)) { inVars = /^\[vars\]/.test(line); continue; }
  const m = inVars && line.match(/^([A-Z_]+)\s*=\s*"(.*)"\s*$/);
  if (m) vars[m[1]] = m[2];
}
const env = { ...vars, ...process.env, AUTH: "none" };
for (const k of ["KYLAS_KEY", "AIRTABLE_PAT"]) if (!env[k]) { console.error(`Set ${k}.`); process.exit(1); }
const { routes } = await createHandlers({ env, store: memoryStore(), log: process.env.VERBOSE ? console.log : () => {} });
/* The crawl gives the owners as Kylas has them now; build it first, as the Worker's job does. */
await routes["/companies"](new URL("http://local/companies?owner=all")).catch(() => null);
const r = await routes["/below-activation"](new URL("http://local/below-activation"));
const tally = (f) => { const m = {}; for (const a of r.accounts) { const k = f(a); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
const age = (d) => (d == null ? "unknown" : d <= 7 ? "0–7 days" : d <= 30 ? "8–30 days" : d <= 90 ? "31–90 days" : "90+ days");
console.log(`\nCalled, but still below Activation — ${r.day}: ${r.count} account(s)\n`);
console.log("By owner:");   for (const [k, n] of tally((a) => a.owner)) console.log(`  ${k.padEnd(28)} ${n}`);
console.log("\nBy stage:"); for (const [k, n] of tally((a) => a.stageLabel)) console.log(`  ${k.padEnd(40)} ${n}`);
console.log("\nSince the first call:"); for (const [k, n] of tally((a) => age(a.days))) console.log(`  ${k.padEnd(14)} ${n}`);
if (process.argv.includes("--names")) {
  console.log("\nThe longest stuck:");
  for (const a of r.accounts.slice(0, 30)) console.log(`  ${a.name} · ${a.owner} · ${a.stageLabel} · ${a.days ?? "?"} days · ${a.calls} call(s)`);
}
console.log("\nNothing was sent or kept.");
process.exit(0);
