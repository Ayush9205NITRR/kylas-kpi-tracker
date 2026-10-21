#!/usr/bin/env node
/* THE CONSOLE'S OWN ACCOUNTS LIST, FILTERED THE WAY THE SCREEN FILTERS IT.
 *
 * Ayush, 2026-10-21, from a screenshot of All accounts with Offsite timeline
 * Q1 + Q2 + Q3 and ten owners ticked: "inko bhi allot karo — 40% Sejal, baaki
 * Mayra". The offsite quarter on that screen is DERIVED (handlers.mjs: the KPI
 * base's offsite rows, Kylas' own Offsite Timeline fields, and Company List),
 * so rebuilding it here would be a second copy of the rule that drifts. This
 * runs the console's own /companies route — the same code the Worker runs —
 * and filters its answer, so the ids are exactly what the screen counted.
 *
 *   node --env-file=.env.local scripts/select-accounts.mjs \
 *        --owners "gaurav kumar,enout super admin,shreya bodwal" \
 *        --offsite APR_JUN,JUL_SEP,OCT_DEC  --out picked.txt
 *
 * Owners are matched by NAME as the console shows it (case-insensitive) or by
 * Kylas id. Writes the ids, one per line, and prints the count per owner so it
 * can be held against the screen. Reads only; writes nothing anywhere.
 * reassign-deactivated.mjs --ids picked.txt then re-reads every one from Kylas
 * before moving it, so a list a few minutes old cannot move the wrong account.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHandlers } from "./handlers.mjs";
import { memoryStore } from "./store.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const OWNERS = String(arg("owners", "")).split(",").map(norm).filter(Boolean);
const OFFSITE = String(arg("offsite", "")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const OUT = arg("out", "picked.txt");
if (!OWNERS.length) { console.error('--owners "name one,name two,..." (as the console shows them, or Kylas ids)'); process.exit(1); }

/* The Worker's own [vars], so this behaves as the deployed console does; the
   secrets (KYLAS_KEY, AIRTABLE_PAT) come from the environment. */
const vars = {};
let inVars = false;
for (const line of readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").split(/\r?\n/)) {
  if (/^\[/.test(line)) { inVars = /^\[vars\]/.test(line); continue; }
  const m = inVars && line.match(/^([A-Z_]+)\s*=\s*"(.*)"\s*$/);
  if (m) vars[m[1]] = m[2];
}
const env = { ...vars, ...process.env, AUTH: "none" };
for (const k of ["KYLAS_KEY", "AIRTABLE_PAT"]) if (!env[k]) { console.error(`Set ${k}.`); process.exit(1); }

const quiet = process.env.SELECT_VERBOSE ? (...a) => console.log(...a) : () => {};
const { routes } = await createHandlers({ env, store: memoryStore(), log: quiet });
console.log("Reading the accounts list the console reads (every owner)…");
const got = await routes["/companies"](new URL("http://local/companies?owner=all"));
const list = got?.companies || [];
console.log(`${list.length} companies${got?.source ? ` (from ${got.source})` : ""}.`);
if (!list.length) { console.error("The list came back empty — nothing selected."); process.exit(1); }

const ownerHit = (c) => OWNERS.includes(norm(c.owner)) || OWNERS.includes(String(c.ownerId || ""));
const offsiteHit = (c) => !OFFSITE.length || (c.offsite || []).some((q) => OFFSITE.includes(String(q).toUpperCase()));
const inQuarter = list.filter(offsiteHit);
const picked = inQuarter.filter(ownerHit);

/* Every owner in the quarter filter, with counts — the owner picker's list. */
const byOwner = {};
for (const c of inQuarter) { const k = `${c.owner || "(none)"} [${c.ownerId || "?"}]`; byOwner[k] = (byOwner[k] || 0) + 1; }
console.log(`\nOffsite ${OFFSITE.join(" + ") || "(any)"}: ${inQuarter.length} companies. By owner (the picker's list):`);
for (const [k, n] of Object.entries(byOwner).sort((a, b) => b[1] - a[1]))
  console.log(`  ${ownerHit({ owner: k.replace(/ \[.*\]$/, ""), ownerId: k.match(/\[(.*)\]$/)?.[1] }) ? "→" : " "} ${k.padEnd(36)} ${n}`);
const unmatched = OWNERS.filter((o) => !inQuarter.some((c) => norm(c.owner) === o || String(c.ownerId || "") === o));
if (unmatched.length) console.log(`\n! no company in this filter for: ${unmatched.join(", ")}`);

writeFileSync(OUT, picked.map((c) => String(c.id)).join("\n") + "\n");
console.log(`\n${picked.length} picked (→ above) — written to ${OUT}. Nothing was changed anywhere.`);
