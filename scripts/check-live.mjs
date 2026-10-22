#!/usr/bin/env node
/* THREE THINGS, CHECKED AGAINST THE LIVE DATA THROUGH THE CONSOLE'S OWN CODE.
 *
 * Ayush, 2026-10-22: "Check — Boolean Post, notification enabler, account
 * allotment". The deployed Worker sits behind Google sign-in, so this runs the
 * same handlers (createHandlers, as select-accounts.mjs does) with the live
 * Kylas key and Airtable token, and answers what the console would:
 *
 *   1. Boolean post — the research pane for accounts whose link lives only in
 *      Company List's "Boolean (linked)", and how many accounts in the list
 *      now carry a Boolean post at all.
 *   2. Notifications — what the morning "called, below Activation" mail would
 *      say today, and whether mail is configured HERE (the Worker's own
 *      secrets live in Cloudflare and cannot be read from anywhere).
 *   3. Allotment — the people the Allot panel offers (active only, never the
 *      Super Admin) and that /allot moves every contact with its account.
 *
 * Reads only. Writes nothing to Kylas or Airtable, sends no mail.
 * Logs: ids and BD first names only (public Actions logs).
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
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${d}` : ""}`); };
const first = (s) => String(s || "").split(" ")[0];

/* ── 1 · Boolean post ─────────────────────────────────────────────── */
console.log("\n1 · Boolean post (Company Database → Company List)");
/* Rows whose link is ONLY in "Boolean (linked)" (read from the base on 2026-10-22). */
const ONLY_LINKED = String(process.env.BOOLEAN_IDS || "1773113,1772069,1781275,1772221,1778051").split(",");
let shown = 0;
for (const id of ONLY_LINKED) {
  const r = await routes["/research"](new URL(`http://local/research?companyId=${id}`)).catch((e) => ({ error: e.message }));
  const F = r?.fields || {};
  const col = ["Boolean Post link - kylas", "Boolean - New", "Boolean Post Link (Demand Team)", "Boolean (linked)"]
    .find((k) => String(F[k] ?? "").trim() !== "");
  const link = col ? /^https?:\/\/(www\.)?linkedin\.com\//i.test(String(F[col])) : false;
  if (col) shown++;
  console.log(`  ${id.padEnd(9)} ${r?.found ? "row found" : r?.error ? `ERROR ${r.error}` : "no row"} · Boolean post ${col ? `from "${col}"${link ? " (a LinkedIn post)" : ""}` : "— (empty)"}`);
}
ok(`the research pane shows the Boolean post for accounts that keep it only in "Boolean (linked)"`, shown === ONLY_LINKED.length, `${shown}/${ONLY_LINKED.length}`);
console.log("  …and the accounts list (Boolean post column / filter):");
const all = await routes["/companies"](new URL("http://local/companies?owner=all"));
const cos = all?.companies || [];
const withBp = cos.filter((c) => c.enrich?.bp).length;
const linkedOnly = cos.filter((c) => ONLY_LINKED.includes(String(c.id)) && c.enrich?.bp).length;
console.log(`  ${cos.length} accounts listed (${all?.source || "?"}); ${withBp} carry a Boolean post.`);
ok("the sample accounts carry it in the list too", linkedOnly === ONLY_LINKED.filter((id) => cos.some((c) => String(c.id) === id)).length,
   `${linkedOnly} of the sample`);

/* ── 2 · Notifications ────────────────────────────────────────────── */
console.log("\n2 · Notifications — the morning mail");
const r2 = await routes["/below-activation"](new URL("http://local/below-activation")).catch((e) => ({ error: e.message }));
if (r2?.error) ok("the mail can be built from today's data", false, r2.error);
else {
  ok("the mail can be built from today's data", Number.isFinite(r2.count), `${r2.count} account(s) called but below Activation`);
  if (r2.subject) console.log(`  Subject: ${r2.subject.replace(/·\s*\d{4}-\d{2}-\d{2}/, "· <today>")}`);
  const by = {};
  for (const a of r2.accounts || []) by[first(a.owner)] = (by[first(a.owner)] || 0) + 1;
  console.log(`  By owner: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
}
const has = (k) => !!String(process.env[k] || "").trim();
console.log(`  Mail settings in THIS run: MAIL_SMTP_USER ${has("MAIL_SMTP_USER") ? "set" : "not set"} · MAIL_SMTP_PASS ${has("MAIL_SMTP_PASS") ? "set" : "not set"} · ` +
  `MAIL_TO ${has("MAIL_TO") ? "set" : "not set"} · MAIL_TO_STUCK ${has("MAIL_TO_STUCK") ? "set" : "not set"}`);
console.log("  The Worker sends with ITS OWN secrets (Cloudflare: npx wrangler secret list shows their names). " +
  "Until MAIL_SMTP_USER, MAIL_SMTP_PASS and MAIL_TO are there, the mail is built and logged, not sent.");

/* ── 3 · Allotment ────────────────────────────────────────────────── */
console.log("\n3 · Allotment");
const r3 = await routes["/allot-people"](new URL("http://local/allot-people")).catch((e) => ({ error: e.message, status: e.status }));
if (r3?.error) ok("the Allot panel's people list answers", false, `${r3.status || ""} ${r3.error}`);
else {
  const names = (r3.people || []).map((p) => first(p.name));
  ok("the Allot panel's people list answers", names.length > 0, `${names.length}: ${names.join(", ")}`);
  ok("...never the Super Admin", !(r3.people || []).some((p) => /super\s*admin/i.test(p.name)));
}
const src = readFileSync(new URL("./handlers.mjs", import.meta.url), "utf8");
ok("/allot moves every contact with its account (leaveActive is never honoured)", /allot\(\{ kylas, assignments: body\?\.assignments, leaveActive: false,/.test(src));
const owners = {};
for (const c of cos) owners[c.owner || "—"] = (owners[c.owner || "—"] || 0) + 1;
console.log(`  Accounts per owner now: ${Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${first(k)} ${n}`).join(" · ")}`);

console.log(`\n${pass} passed, ${fail} failed. Nothing was written or sent.`);
process.exit(fail ? 1 : 0);
