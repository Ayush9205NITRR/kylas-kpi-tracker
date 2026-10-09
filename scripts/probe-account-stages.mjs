#!/usr/bin/env node
/* WHAT SHOULD THE BOARD SAY? — read-only, against the live Kylas account.
 *
 *   node --env-file=.env.local scripts/probe-account-stages.mjs
 *   node --env-file=.env.local scripts/probe-account-stages.mjs --name sarvam --name pictory
 *
 * Ayush, 2026-10-09: "Deployed, check if account stage pulls up now, and will
 * it change dynamically every day."
 *
 * The deployed Worker cannot be asked directly from a terminal — AUTH=google,
 * so /cache-status wants a signed-in console's token. So this does the next
 * best thing: it runs the SAME calculation the Worker runs (scripts/
 * contact-stages.mjs, through the same Kylas client, the same lean crawl) on
 * the live account and prints what the board should show. Open the board
 * beside it — Board → Stages — and the column counts should match.
 *
 * It also prints the newest contact change Kylas holds. Compare that with the
 * Worker's own log line (see the end of this output) to see the index keeping
 * up: a delta runs every ten minutes, a full rebuild once a day.
 *
 * Writes nothing. One full crawl of your contacts, at Kylas' own rate limit.
 */
import { createClient, toConsoleCompany, idOf, stageCode } from "./kylas.mjs";
import { emptyIndex, applyContacts, byCompany } from "./contact-stages.mjs";
import { STAGE_LABEL, STAGE_RUNG } from "./stages.mjs";

const KEY = process.env.KYLAS_KEY;
if (!KEY) { console.error("Set KYLAS_KEY (or use --env-file=.env.local)."); process.exit(1); }
const names = [];
process.argv.forEach((a, i) => { if (a === "--name" && process.argv[i + 1]) names.push(process.argv[i + 1].toLowerCase()); });
/* The accounts in the screenshot this was reported from, when none are named. */
const DEFAULT_NAMES = ["sarvam", "gamechangesolar", "pictory", "ssva", "slurrpfarm", "unison",
  "coredge", "qapita", "basf", "alpha capital", "preferre", "hytechp", "boldfit", "donyati", "enliteres", "catalyst"];
const LOOK = names.length ? names : DEFAULT_NAMES;

const label = (code) => code ? (STAGE_LABEL[code] || `${code} (not a known stage)`) : "—";
const fmt = (n) => Number(n).toLocaleString("en-IN");
const kylas = createClient(KEY, { log: () => {}, ...(process.env.KYLAS_BASE ? { base: process.env.KYLAS_BASE } : {}) });

/* ── 1 · every contact, the lean way the Worker reads them ───────────── */
console.log("\nreading every contact from Kylas — the same lean crawl the Worker does…");
let t = Date.now();
const got = await kylas.contactsChangedSince("", {
  fields: ["id", "company", "customFieldValues", "updatedAt"],
  onPage: (n) => process.stdout.write(`\r  ${fmt(n)} contacts…`),
});
const crawlSecs = (Date.now() - t) / 1000;
process.stdout.write("\n");
const ix = emptyIndex();
applyContacts(ix, got.contacts, {
  companyOf: (c) => idOf(c.company) ?? "",
  stageOf: (c) => stageCode((c.customFieldValues || {}).cfPipelineStageBd),
  stampOf: (c) => Date.parse(c.updatedAt || 0) || 0,
});
const acct = byCompany(ix);
const complete = got.reportedTotal == null || got.contacts.length >= got.reportedTotal;
console.log(`  ${fmt(got.contacts.length)} contacts read` +
  (got.reportedTotal != null ? ` of ${fmt(got.reportedTotal)} Kylas reports` : "") +
  ` in ${crawlSecs.toFixed(0)}s, ${got.pages} page(s)${got.windows ? ` + ${got.windows} window(s)` : ""}`);
if (!complete)
  console.log(`  ! SHORT by ${fmt(got.reportedTotal - got.contacts.length)} — the Worker keeps its previous index` +
              ` rather than swap in a prefix, and says "SHORT" in its log.`);

/* ── 2 · every company, and its OWN stage field ──────────────────────── */
console.log("\nreading every company…");
t = Date.now();
const companies = (await kylas.companies()).map(toConsoleCompany);
console.log(`  ${fmt(companies.length)} companies in ${((Date.now() - t) / 1000).toFixed(0)}s`);

/* ── 3 · what the board should show ─────────────────────────────────── */
const withContacts = companies.filter((c) => acct.get(String(c.id))?.n);
const staged = companies.filter((c) => acct.get(String(c.id))?.stage);
console.log(`\nWHAT THE BOARD SHOULD SHOW  (Accounts → Board → Stages, owner: all)`);
console.log("=".repeat(72));
console.log(`  ${fmt(companies.length)} accounts · ${fmt(withContacts.length)} with a contact in Kylas · ` +
            `${fmt(companies.length - withContacts.length)} with none`);
const byStage = new Map();
for (const c of companies) {
  const k = acct.get(String(c.id))?.stage || "";
  byStage.set(k, (byStage.get(k) || 0) + 1);
}
const order = [...byStage.entries()].sort((a, b) => (STAGE_RUNG[b[0]] || 0) - (STAGE_RUNG[a[0]] || 0));
for (const [k, n] of order)
  console.log(`  ${String(fmt(n)).padStart(7)}  ${k ? `${label(k)}  · rung ${STAGE_RUNG[k] || 0}` : "No stage yet"}`);

/* ── 4 · where the old rule and the new one disagree ───────────────── */
console.log(`\nWHERE THE COMPANY RECORD AND ITS CONTACTS DISAGREE`);
console.log("=".repeat(72));
console.log(`  The board used to use the company record for every account the console`);
console.log(`  had not saved a contact for. These are the accounts that moved.\n`);
const pairs = new Map();
let differ = 0, unknownCo = 0;
for (const c of companies) {
  const fromContacts = acct.get(String(c.id))?.stage || "";
  const fromCompany = c.stage || "";
  if (fromCompany && !STAGE_RUNG[fromCompany]) unknownCo++;
  if (!fromContacts || fromContacts === fromCompany) continue;
  differ++;
  const k = `${label(fromCompany)}  →  ${label(fromContacts)}`;
  pairs.set(k, (pairs.get(k) || 0) + 1);
}
for (const [k, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${String(fmt(n)).padStart(7)}  ${k}`);
console.log(`\n  ${fmt(differ)} accounts now read differently from their company record.`);
if (unknownCo)
  console.log(`  ${fmt(unknownCo)} company records hold a value that is not a contact stage at all —` +
              ` the "rung 0 of 26" column. None of them is used now.`);

/* ── 5 · the accounts from the screenshot ──────────────────────────── */
console.log(`\nTHE ACCOUNTS YOU NAMED`);
console.log("=".repeat(72));
for (const want of LOOK) {
  const hits = companies.filter((c) => String(c.name || "").toLowerCase().includes(want)).slice(0, 3);
  if (!hits.length) { console.log(`  ${want.padEnd(18)} not found by name`); continue; }
  for (const c of hits) {
    const a = acct.get(String(c.id));
    console.log(`  ${String(c.name).slice(0, 22).padEnd(24)} company record: ${label(c.stage).slice(0, 28).padEnd(30)}` +
                `board: ${a?.stage ? label(a.stage) : a?.n ? "No stage yet (contacts unstaged)" : "No stage yet (no contacts)"}` +
                `${a?.n ? `  · ${a.n} contact${a.n === 1 ? "" : "s"}` : ""}`);
  }
}

/* ── 6 · is it keeping up? ─────────────────────────────────────────── */
console.log(`\nWILL IT CHANGE BY ITSELF?`);
console.log("=".repeat(72));
console.log(`  Newest contact change in Kylas right now:  ${ix.watermark || "—"}`);
console.log(`
  The Worker keeps this index current three ways:
    every console save     the account moves at once (written through)
    every 10 minutes       contacts changed in Kylas itself, a delta
    once a day             a full rebuild, which also drops deleted contacts

  To SEE it doing so, on the deployed Worker:

    npx wrangler tail --format pretty | grep "contact stages"

  Expect within a minute or two of a deploy:
    contact stages: full — ${fmt(got.contacts.length)} read, … held, …ms
  and then every ten minutes:
    contact stages: delta — N read, M changed, ${fmt(got.contacts.length)} held, …ms

  The "held" figure should match the ${fmt(got.contacts.length)} above. "SHORT" in that line
  means a full crawl came back incomplete and the old index was kept.
  An error instead — "exceeded", "memory", "CPU" — is the thing to send back.
  (Cloudflare dashboard → Workers → enout-bd-proxy → Logs, search
  "contact stages", shows the same lines without a terminal.)

  The full crawl took ${crawlSecs.toFixed(0)}s from here. On the Worker it runs on the
  every-minute maintenance cron, inside a fifteen-minute limit.
`);
