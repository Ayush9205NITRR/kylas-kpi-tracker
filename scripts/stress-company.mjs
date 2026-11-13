#!/usr/bin/env node
/* STRESS: the 1.83 company search / create, at the size of the real account.
 *
 *   node scripts/stress-company.mjs
 *
 * Its own stack (mock Kylas with 18,000 companies, mock Airtable, proxy). Asserts:
 *   S1  search over 18K: 600 queries, 25 at a time — p50/p95, no errors, right hits
 *   S2  a cold crawl: search still answers (Kylas' own search) before the crawl lands
 *   S3  the race: 20 people create the SAME new company at the same moment → 1 in Kylas
 *   S4  20 spellings of one name at once ("X Ltd", "x pvt ltd", "X.") → 1 in Kylas
 *   S5  50 different new companies at once → 50, none lost, none doubled
 *   S6  hostile input: quotes, emoji, 300 chars, SQL-ish, only punctuation, blanks
 *   S7  search while creates run: no 5xx, results include the new names
 */
import { spawn } from "node:child_process";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ENV = { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK", PORT: "8787" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
const procs = [];
const start = (file, env = {}) => procs.push(spawn("node", [file], { cwd: REPO, env: { ...process.env, ...ENV, ...env }, stdio: "ignore" }));
const wait = async (url, h = {}) => { for (let i = 0; i < 100; i++) { try { await fetch(url, { headers: h }); return; } catch { await sleep(300); } } throw new Error(`${url} never came up`); };
const B = "http://127.0.0.1:8787";
const search = async (q) => { const t = Date.now(); const r = await fetch(`${B}/company-search?q=${encodeURIComponent(q)}`); return { ms: Date.now() - t, status: r.status, j: await r.json().catch(() => ({})) }; };
const create = async (name) => { const r = await fetch(`${B}/company-create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const made = async () => (await fetch("http://127.0.0.1:9900/__companies", { headers: { "api-key": "x" } })).json();
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; };

try {
  start("scripts/mock-kylas.mjs", { PORT: "9900", MOCK_MANY: "18000" });
  await wait("http://127.0.0.1:9900/__writes", { "api-key": "x" });
  start("scripts/mock-airtable.mjs", { PORT: "9901" }); await wait("http://127.0.0.1:9901/v0/appMOCK/Companies");
  start("scripts/proxy.mjs"); await wait(`${B}/health`);

  console.log("S2. cold crawl — search before the 18K list is cached");
  const cold = await search("shorehouse");
  ok("answers from Kylas' own search", cold.status === 200 && (cold.j.companies || []).some((c) => c.name === "Shorehouse Retail"), `${cold.ms} ms, ${JSON.stringify(cold.j).slice(0, 120)}`);

  console.log("\nwarming the crawl (all 18,000)…");
  const t0 = Date.now();
  const warm = await fetch(`${B}/companies?owner=all&fresh=1`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  console.log(`  crawl: ${(warm.companies || []).length} companies in ${((Date.now() - t0) / 1000).toFixed(1)} s${warm.error ? " — " + warm.error : ""}`);
  const sample = (warm.companies || []).filter((c) => c.name).slice(0, 18000);
  ok("crawl holds the whole account", sample.length >= 17000, String(sample.length));

  console.log("\nS1. 600 searches over 18K, 25 at a time");
  const qs = Array.from({ length: 600 }, (_, i) => {
    const c = sample[(i * 7919) % sample.length]; const n = String(c?.name || "acme");
    return i % 3 === 0 ? n.slice(0, 3) : i % 3 === 1 ? n.slice(0, Math.max(4, n.length - 2)) : n.slice(1, 6);
  });
  const res = await pool(qs, 25, (q) => search(q));
  const ms = res.map((r) => r.ms), errs = res.filter((r) => r.status !== 200);
  ok("no errors", errs.length === 0, `${errs.length} failed`);
  ok("p95 under 500 ms", pct(ms, 0.95) < 500, `p50 ${pct(ms, 0.5)} ms · p95 ${pct(ms, 0.95)} ms · max ${Math.max(...ms)} ms`);
  const hit = res.filter((r, i) => i % 3 === 1).filter((r) => (r.j.companies || []).length > 0).length;
  ok("a near-full name always finds something", hit === 200, `${hit}/200`);
  ok("never more than 15 rows back", res.every((r) => (r.j.companies || []).length <= 15));

  console.log("\nS3. 20 people create the same new company at once");
  const before = (await made()).length;
  const same = await Promise.all(Array.from({ length: 20 }, () => create("Quokka Analytics")));
  const created3 = (await made()).length - before;
  ok("exactly one company made in Kylas", created3 === 1, `${created3} made; answers: ${same.filter((r) => r.j.ok).length} created, ${same.filter((r) => r.j.ok === false).length} told it exists, ${same.filter((r) => r.status >= 400).length} errors`);
  ok("everyone else is shown the existing one", same.filter((r) => r.j.ok === false && (r.j.exists || []).length).length === 19);

  console.log("\nS4. 20 spellings of one new name at once");
  const sp = ["Wombat Labs", "WOMBAT LABS", "wombat labs pvt ltd", "Wombat Labs Ltd.", "The Wombat Labs", "Wombat-Labs", "wombat  labs", "Wombat Labs Private Limited", "Wombat Labs LLP", "Wombat Labs Inc"];
  const b4 = (await made()).length;
  await Promise.all([...sp, ...sp].map((n) => create(n)));
  const created4 = (await made()).length - b4;
  ok("one company, however it is spelled", created4 === 1, `${created4} made`);

  console.log("\nS5. 50 different new companies at once");
  const b5 = (await made()).length;
  const names = Array.from({ length: 50 }, (_, i) => `Stress Co ${i} Zylophone`);
  const r5 = await Promise.all(names.map((n) => create(n)));
  const created5 = (await made()).length - b5;
  ok("all 50 made, none doubled", created5 === 50 && r5.every((r) => r.j.ok), `${created5} made, ${r5.filter((r) => !r.j.ok).length} refused/errored`);
  let rowsAt = [], off = "";
  do { const pg = await fetch(`http://127.0.0.1:9901/v0/appMOCK/Companies?pageSize=100${off ? "&offset=" + off : ""}`, { headers: { Authorization: "Bearer pat_mock" } }).then((r) => r.json()).catch(() => ({}));
       rowsAt.push(...(pg.records || [])); off = pg.offset || ""; } while (off);
  const zy = rowsAt.filter((x) => /Zylophone/.test(x.fields?.Name || "")).length;
  ok("all 50 have their Airtable row", zy === 50, `${zy}`);

  console.log("\nS6. hostile input");
  for (const [label, name, want] of [
    ["quotes", `O'Brien "Tea" Co`, "ok"], ["emoji", "Rocket 🚀 Labs", "ok"], ["300 chars", "A".repeat(300), 400],
    ["sql-ish", "x'; DROP TABLE Companies;--", "ok"], ["only punctuation", "!!!---...", 400], ["blank", "   ", 400],
    ["one letter", "Q", 400], ["formula-ish", "{Name} = '' OR 1", "ok"],
  ]) {
    const r = await create(name);
    ok(`${label}`, want === "ok" ? r.status === 200 : r.status === want, `${r.status} ${JSON.stringify(r.j).slice(0, 90)}`);
  }
  const s6 = await search(`'"{}%_\\`);
  ok("search with junk characters answers, no 5xx", s6.status === 200, String(s6.status));
  const s6b = await search("o'brien");
  ok("the quoted name is findable", (s6b.j.companies || []).some((c) => /O'Brien/.test(c.name)));

  console.log("\nS7. searches while creates run");
  const mixed = await Promise.all([
    ...Array.from({ length: 30 }, (_, i) => create(`Mixload ${i} Pangolin`)),
    ...Array.from({ length: 120 }, (_, i) => search(i % 2 ? "pangolin" : "shore")),
  ]);
  ok("no 5xx under mixed load", mixed.every((r) => r.status < 500), `${mixed.filter((r) => r.status >= 500).length} 5xx`);
  const s7 = await search("pangolin");
  ok("new companies are searchable at once", (s7.j.companies || []).length === 15, `${(s7.j.companies || []).length} of 15 shown`);
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
