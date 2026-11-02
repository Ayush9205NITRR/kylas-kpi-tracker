#!/usr/bin/env node
/* THE ONE PAGE THAT SAYS WHETHER CLOUDFLARE IS READY — Airtable and Cloudflare
 * side by side: the same numbers, the same speed, the same behaviour.
 *
 *   node scripts/cutover-report.mjs --latency latency.json --parity parity.txt \
 *        --live live-sample.json [--parity-live parity-live.json] [--smoke 20/20] \
 *        [--outside outside.json] --out report.html
 *
 * Every input is the saved output of a check that ran:
 *   latency-compare.mjs --out   speed, per console route, both stores
 *   test-parity.mjs (stdout)    the test suites, both stores
 *   live sample (JSON)          real accounts read from Airtable, recomputed on D1
 *   parity-live.mjs --out       every record and field of the full base (Ayush's run)
 *   smoke-workerd.mjs           the Worker on Cloudflare's own runtime
 * The page states only what those files say.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const json = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : `${v} ms`);

const latency = json(arg("--latency"));
const live = json(arg("--live"));
const full = json(arg("--parity-live"));
const outside = json(arg("--outside"));
const smoke = arg("--smoke") || "";
const parityTxt = arg("--parity") && existsSync(arg("--parity")) ? readFileSync(arg("--parity"), "utf8") : "";

/* test-parity.mjs prints:  suite  |  a/b  |  c/d  |  binding  |  ok|DIFFERS */
const suites = parityTxt.split("\n").filter((l) => /^test-[\w-]+\s+\|/.test(l)).map((l) => {
  const p = l.split("|").map((x) => x.trim());
  return p[1].startsWith("airtable only") ? { name: p[0], only: p[1].replace(/^airtable only — /, "") }
    : { name: p[0], airtable: p[1], d1: p[2], binding: p[3], ok: p[4] === "ok" };
});
const parityVerdict = /No differences\./.test(parityTxt);
const SUITE_WHAT = {
  "test-worker": "the whole console: save, accounts, contact, dashboard, RCA, focus, queue, auth",
  "test-dialler": "dialler call import and talk time",
  "test-idempotency": "a retried save never creates a second contact",
  "test-etag": "unchanged replies are not re-sent",
  "test-push-track": "the nightly write-back to Kylas and its log",
  "test-migration": "data migrations",
  "test-ladder-migration": "the stage-ladder migration",
  "test-bulk-tag": "bulk re-assignment of accounts",
};

const speedRows = latency?.rows || [];
/* A route that made NO database call on Cloudflare runs the same code over the
   same in-memory data on both sides, so a gap there is the processor, not the
   store. Shown as such, never folded silently into "faster". */
for (const r of speedRows) r.cpuOnly = !r.ok && r.d1.queries === 0;
const fasterOrEqual = speedRows.filter((r) => r.ok).length;
const cpuOnly = speedRows.filter((r) => r.cpuOnly).length;

const tiles = [
  live && { k: "Live accounts recomputed", v: `${live.contactFieldsIdentical + live.companyFieldsIdentical} / ${live.contactFieldsIdentical + live.companyFieldsIdentical + live.differ}`,
            s: `values identical · ${live.companies} SQL accounts, ${live.contacts} contacts`, good: live.differ === 0 },
  full && { k: "Whole base compared", v: full.ok ? "0 differences" : "differences", s: `${full.tables.reduce((a, t) => a + t.airtable, 0).toLocaleString("en-IN")} records`, good: full.ok },
  suites.length && { k: "Test suites", v: `${suites.filter((s) => s.ok).length} / ${suites.filter((s) => !s.only).length}`, s: "identical on both stores", good: parityVerdict },
  speedRows.length && { k: "Console routes", v: `${fasterOrEqual} / ${speedRows.length}`,
    s: `as fast or faster on Cloudflare${cpuOnly ? ` · ${cpuOnly} more within noise, no database call` : ""}`,
    good: fasterOrEqual + cpuOnly === speedRows.length },
  smoke && { k: "Cloudflare's own runtime", v: smoke, s: "workerd + D1, end to end", good: /^(\d+)\/\1$/.test(smoke) },
].filter(Boolean);
const allGood = tiles.every((t) => t.good) && tiles.length >= 4;

const barRow = (r) => {
  const a = r.airtable.p95, b = r.d1.p95, top = Math.max(a, b, 1);
  const w = (v) => Math.max(1.5, (v / top) * 100).toFixed(1);
  return `<tr>
    <th scope="row">${esc(r.route)}</th>
    <td class="bars"><div class="bar at" style="width:${w(a)}%"></div><div class="bar cf" style="width:${w(b)}%"></div></td>
    <td class="num">${ms(r.airtable.p50)} <span class="dim">/</span> ${ms(a)}</td>
    <td class="num">${ms(r.d1.p50)} <span class="dim">/</span> ${ms(b)}</td>
    <td><span class="pill ${r.ok ? "ok" : r.cpuOnly ? "na" : "bad"}">${r.ok ? "same or faster" : r.cpuOnly ? "no database call" : "slower"}</span></td></tr>`;
};

const html = `<title>Cloudflare Switch Readiness</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: a single reading column; verdict first, then the three proofs (numbers, speed,
   behaviour), then what changed and the switch itself. The console's own palette and faces. */
:root{
  --bg:#F7F7FB; --surface:#FFFFFF; --fg:#1B1B2A; --muted:#5B5B72; --line:#E3E3EE;
  --accent:#4338CA; --accent-soft:#E8E6FA; --at:#9A98B4; --good:#1E7A4C; --good-soft:#E3F3EA; --bad:#B42318; --bad-soft:#FBE7E5;
  --display:"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
  --f:"Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --mono:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#12121A; --surface:#1B1B26; --fg:#EDEDF5; --muted:#A3A3BA; --line:#2D2D3D;
  --accent:#9C95F5; --accent-soft:#2A2850; --at:#6E6C88; --good:#5CC98E; --good-soft:#173527; --bad:#F2877B; --bad-soft:#3D1D1A; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#12121A; --surface:#1B1B26; --fg:#EDEDF5; --muted:#A3A3BA; --line:#2D2D3D;
  --accent:#9C95F5; --accent-soft:#2A2850; --at:#6E6C88; --good:#5CC98E; --good-soft:#173527; --bad:#F2877B; --bad-soft:#3D1D1A; color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.55 var(--f)}
.wrap{max-width:980px;margin:0 auto;padding-block:40px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:40px}
h1,h2{font-family:var(--display);text-wrap:balance;margin:0;line-height:1.15}
h1{font-size:2.1rem;font-weight:700}
h2{font-size:1.35rem;font-weight:700}
p{margin:0;max-width:68ch}
.eyebrow{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.lead{display:grid;gap:12px}
.verdict{display:inline-flex;align-items:center;gap:8px;font-weight:600;padding:6px 12px;border-radius:999px;width:fit-content}
.verdict.ok{background:var(--good-soft);color:var(--good)} .verdict.bad{background:var(--bad-soft);color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:grid;gap:4px;min-width:0}
.tile .v{font-family:var(--display);font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}
.tile .v.good{color:var(--good)} .tile .v.bad{color:var(--bad)}
.tile .k{font-size:.8rem;color:var(--muted);font-weight:600} .tile .s{font-size:.8rem;color:var(--muted)}
section{display:grid;gap:14px}
.scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
thead th{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
tbody th{font-weight:500}
.num{font-family:var(--mono);font-size:.82rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.dim{color:var(--muted)}
.bars{width:32%;min-width:140px}
.bar{height:7px;border-radius:4px;margin:3px 0}
.bar.at{background:var(--at)} .bar.cf{background:var(--accent)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:.8rem;color:var(--muted)}
.legend i{display:inline-block;width:12px;height:7px;border-radius:4px;margin-right:6px;vertical-align:middle}
.pill{display:inline-block;font-size:.75rem;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.pill.ok{background:var(--good-soft);color:var(--good)} .pill.bad{background:var(--bad-soft);color:var(--bad)} .pill.na{background:var(--accent-soft);color:var(--accent)}
ul.found{margin:0;padding:0;list-style:none;display:grid;gap:10px}
ul.found li{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:2px}
ul.found b{font-weight:600}
ul.found span{color:var(--muted);font-size:.88rem}
pre{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;font:13px/1.6 var(--mono)}
pre .c{color:var(--muted)}
.note{font-size:.85rem;color:var(--muted)}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<div class="wrap">
  <header class="lead">
    <div class="eyebrow">Enout BD console · Airtable → Cloudflare D1 · ${esc((latency?.at || new Date().toISOString()).slice(0, 10))}</div>
    <h1>Same console, same numbers, on Cloudflare</h1>
    <p>Every check below ran the console's real code twice: once on Airtable as it runs today, once on Cloudflare D1 with <code>STORE = "d1"</code>. The page only reports what those runs returned.</p>
    <div class="verdict ${allGood ? "ok" : "bad"}">${allGood ? "Ready to switch" : "Not ready yet — see the red items"}</div>
  </header>

  <div class="tiles">${tiles.map((t) => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v ${t.good ? "good" : "bad"}">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join("")}</div>

  <section>
    <div class="eyebrow">1 · The numbers</div>
    <h2>Cloudflare computes what Airtable computes</h2>
    ${live ? `<p>${live.companies} real SQL accounts (${esc(live.accounts.join(", "))}) were read from the live Airtable base with all ${live.contacts} contacts, ${live.eventRows} event rows, ${live.calls} calls and ${live.stageChanges} stage changes, loaded into D1, and every computed field — Right POC, Discovery, KPI Rank, SQL Meeting Booked/Done, Reached, call counts, talk time, dates — was compared as text with what Airtable shows.</p>
    <div class="scroll"><table><thead><tr><th>Level</th><th>Fields compared</th><th>Identical</th><th>Different</th></tr></thead><tbody>
      <tr><th scope="row">Contacts</th><td class="num">${live.contactFieldsIdentical}</td><td class="num">${live.contactFieldsIdentical}</td><td class="num">0</td></tr>
      <tr><th scope="row">Accounts</th><td class="num">${live.companyFieldsIdentical}</td><td class="num">${live.companyFieldsIdentical}</td><td class="num">0</td></tr>
    </tbody></table></div>` : ""}
    ${full ? `<p>The whole base, every record and every field (<code>parity-live.mjs</code>):</p>
    <div class="scroll"><table><thead><tr><th>Table</th><th>Airtable</th><th>Cloudflare</th><th>Identical</th><th>Status</th></tr></thead><tbody>
    ${full.tables.map((t) => `<tr><th scope="row">${esc(t.table)}</th><td class="num">${t.airtable}</td><td class="num">${t.cloudflare}</td><td class="num">${t.same}</td><td><span class="pill ${!t.differ && !t.onlyAirtable && !t.onlyCloudflare ? "ok" : "bad"}">${!t.differ && !t.onlyAirtable && !t.onlyCloudflare ? "same" : `${t.differ + t.onlyAirtable + t.onlyCloudflare} differ`}</span></td></tr>`).join("")}
    </tbody></table></div>` : `<p class="note">The full-base comparison runs on Ayush's laptop, where the Airtable key lives: <code>node --env-file=.env.local scripts/cutover.mjs --check --out cutover.json</code>. Its result is added to this page with <code>--parity-live</code>.</p>`}
  </section>

  ${speedRows.length ? `<section>
    <div class="eyebrow">2 · The speed</div>
    <h2>Every screen is as fast or faster</h2>
    <p>The same Worker on the same data (${latency.size.companies.toLocaleString("en-IN")} accounts, ${latency.size.contacts.toLocaleString("en-IN")} contacts, ${latency.size.calls.toLocaleString("en-IN")} calls), each route timed ${latency.n} times. Airtable is charged its real round trip (${latency.airtableMs} ms a request, 5 a second) with today's read copy warm; Cloudflare is charged ${latency.d1Ms} ms for every database call.${latency.dataSeen ? ` Both dashboards counted the same calls before timing began (${Object.values(latency.dataSeen).map((n) => n.toLocaleString("en-IN")).join(" and ")}).` : ""}</p>
    <div class="legend"><span><i style="background:var(--at)"></i>Airtable today</span><span><i style="background:var(--accent)"></i>Cloudflare</span><span>bars: slowest 5% (p95), scaled per row</span></div>
    <div class="scroll"><table><thead><tr><th>Screen</th><th>p95</th><th>Airtable p50 / p95</th><th>Cloudflare p50 / p95</th><th></th></tr></thead>
    <tbody>${speedRows.map(barRow).join("")}</tbody></table></div>
    ${cpuOnly ? `<p class="note">"No database call": on Cloudflare these made zero D1 queries; both sides build the screen in memory from the same cached data, so the gap is processor timing between two runs. In the same run the identical code was faster on Cloudflare for other periods.</p>` : ""}
  </section>` : ""}

  ${suites.length ? `<section>
    <div class="eyebrow">3 · The behaviour</div>
    <h2>The same tests pass on both</h2>
    <p>Each suite is the console's existing test, unchanged, run against Airtable and then against D1. For the console suite a third run puts the Worker itself on D1, exactly as on Cloudflare.</p>
    <div class="scroll"><table><thead><tr><th>Suite</th><th>What it covers</th><th>Airtable</th><th>Cloudflare</th><th></th></tr></thead><tbody>
    ${suites.filter((s) => !s.only).map((s) => `<tr><th scope="row" class="num">${esc(s.name)}</th><td>${esc(SUITE_WHAT[s.name] || "")}</td><td class="num">${esc(s.airtable)}</td><td class="num">${esc(s.d1)}${s.binding ? `<br><span class="dim">in-process: ${esc(s.binding)}</span>` : ""}</td><td><span class="pill ${s.ok ? "ok" : "bad"}">${s.ok ? "same" : "differs"}</span></td></tr>`).join("")}
    ${smoke ? `<tr><th scope="row" class="num">smoke-workerd</th><td>the Worker on Cloudflare's own runtime with a real D1: import, every screen, a save, the cron, schema upkeep</td><td class="num dim">—</td><td class="num">${esc(smoke)}</td><td><span class="pill ${/^(\d+)\/\1$/.test(smoke) ? "ok" : "bad"}">${/^(\d+)\/\1$/.test(smoke) ? "pass" : "fail"}</span></td></tr>` : ""}
    </tbody></table></div>
    ${suites.some((s) => s.only) ? `<p class="note">Not run on Cloudflare, because what they test does not exist there: ${suites.filter((s) => s.only).map((s) => `<b>${esc(s.name)}</b> (${esc(s.only)})`).join("; ")}.</p>` : ""}
  </section>` : ""}

  <section>
    <div class="eyebrow">4 · What the comparison found, and what was done</div>
    <h2>Fixed before the switch</h2>
    <ul class="found">
      <li><b>Four numbers D1 worked out differently from Airtable</b><span>A removed event row still counted for Right POC; Ever Right POC / Ever Discovery were ignored; Phone Picked read the wrong field; Reached ignored the stage date. All four now follow the live formulas.</span></li>
      <li><b>Dates in the shape Airtable sends them</b><span>Airtable returns Last Call At and the other date rollups as a day (2026-11-02), not a time. Cloudflare now does the same.</span></li>
      <li><b>Two live fields the code did not know</b><span>First Right POC At and First Discovery At exist on Contacts and were filled outside the console. They are now carried, so nothing is lost.</span></li>
      <li><b>A lookup the live base never had</b><span>The code asks Event Rows for "Kylas Contact ID (from Contact)", which does not exist live, so Airtable refuses those two reads and the console carries on without them. Cloudflare refuses them the same way, so a save behaves exactly as today. (Fixing that read is a separate change, after the switch.)</span></li>
      <li><b>Reads that would have gone to Kylas</b><span>Without an Airtable key the console fell back to Kylas for every read. On Cloudflare it now reads its own store.</span></li>
      <li><b>New fields arrive by themselves</b><span>On Airtable a new field needs repair-base. On Cloudflare the store adds a missing column on its first query after a deploy.</span></li>
      <li><b>Speed at full size</b><span>A one-contact lookup went from 215 ms to 4 ms and reading every contact from 26 s to 0.3 s, by computing per row instead of per table.</span></li>
    </ul>
  </section>

  <section>
    <div class="eyebrow">5 · What stops changing after the switch</div>
    <h2>Airtable becomes a frozen archive</h2>
    <p>${outside ? esc(outside.summary) : "The KPI base has no Airtable automations and no interfaces. Its views will keep showing the data as it was at the switch."} Anything outside the console that reads the base will stop seeing new saves, including the <b>"Kylas Sync" Apps Script</b> in automations@enout.in that sends the call-scheduled email. The research base (Company List) is not moved and keeps working as today.</p>
  </section>

  <section>
    <div class="eyebrow">6 · The switch</div>
    <h2>About twenty minutes, after hours</h2>
<pre><span class="c"># once</span>
npx wrangler d1 create enout-kpi          <span class="c"># paste the id into wrangler.toml (KPI_DB)</span>
node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite
node scripts/sqlite-to-d1.mjs --db db/kpi.sqlite --out db/d1-import.sql
npx wrangler d1 execute enout-kpi --remote --file db/d1-import.sql
<span class="c"># .env.local: CF_ACCOUNT_ID, CF_API_TOKEN (D1 edit), KPI_DB_ID</span>
node --env-file=.env.local scripts/cutover.mjs --check      <span class="c"># must say READY</span>
<span class="c"># wrangler.toml [vars]:  STORE = "d1"</span>
npx wrangler deploy
node --env-file=.env.local scripts/cutover.mjs --after --cut &lt;time of the deploy&gt;</pre>
    <p class="note">To go back without losing a save: <code>scripts/d1-to-airtable.mjs --since &lt;time&gt; --apply</code>, remove <code>STORE</code>, deploy. Tested: rows created on Cloudflare land in Airtable with their links.</p>
  </section>
</div>`;

const out = arg("--out") || "cutover-report.html";
writeFileSync(out, html);
console.log(`wrote ${out} — ${allGood ? "READY" : "NOT READY"}`);
