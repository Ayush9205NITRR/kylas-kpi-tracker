#!/usr/bin/env node
/* THE SAME SERVER, TWO STORES, ONE STOPWATCH.
 *
 * Ayush, 2026-11-03: "it should handle the code at the same latency."
 *
 *   node scripts/latency-compare.mjs                  # today's size, ~6 minutes
 *   node scripts/latency-compare.mjs --out x.json     # also write the numbers (cutover-report reads them)
 *   AIRTABLE_MS=350 D1_MS=40 node scripts/latency-compare.mjs
 *
 * Runs the real Worker (worker/index.mjs) twice, on the same data, against
 * the same mock Kylas:
 *
 *   A  Airtable, as it is live today — the mock Airtable at Airtable's round
 *      trip (AIRTABLE_MS, default 350 ms, and its 5 a second ceiling), with
 *      the D1 read copy (mirror) built and warm.
 *   B  STORE=d1 — every KPI read and write in D1, each D1 call charged D1_MS
 *      (default 40 ms: a Worker in India talking to a D1 primary in APAC).
 *
 * The data is built once in SQLite and exported, ids and computed fields
 * included, as the mock Airtable's seed — so both runs read the same rows and
 * the same KPI numbers. Every route the console calls is timed N times
 * (default 12): p50 and p95, plus the D1 queries B spent.
 *
 * The gate: on every route, B's p95 is no slower than A's p95, within the
 * noise of the stopwatch (15% + 25 ms).
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { airtableOverD1 } from "./airtable-d1.mjs";
import { TABLES } from "./schema.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const AIRTABLE_MS = Number(process.env.AIRTABLE_MS || 350);
const D1_MS = Number(process.env.D1_MS || 40);
const N = Number(arg("--n", 12));
const SIZE = { companies: Number(arg("--companies", 2000)), contacts: Number(arg("--contacts", 35000)),
               calls: Number(arg("--calls", 20000)), events: 8000, moves: 6000 };
const OUT = arg("--out", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
if (existsSync(REPO + "/.save-journal.json")) unlinkSync(REPO + "/.save-journal.json");

/* ── 1 · one dataset ─────────────────────────────────────────────────── */
const file = join(tmpdir(), `latency-kpi-${process.pid}.sqlite`);
rmSync(file, { force: true });
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(sqlSchema({ looseSelects: true })); db.exec(sqlDerived());
  db.exec("BEGIN");
  const rid = (p, i) => "rec" + p + String(i).padStart(11, "0");
  const owners = ["Enout Super Admin", "Priya"];
  let s = db.prepare(`INSERT INTO companies (airtable_id, kylas_company_id, name, owner, kylas_owner_id) VALUES (?,?,?,?,?)`);
  /* the mock Kylas' own companies, then its MOCK_MANY bulk ones (200000+i) */
  const kylasIds = [1776620, 1778327, 903, ...Array.from({ length: SIZE.companies }, (_, i) => 200000 + i)];
  kylasIds.forEach((k, i) => s.run(rid("COM", i), String(k), `Co ${k}`, owners[i % 2], String(74725 + (i % 2))));
  s = db.prepare(`INSERT INTO contacts (airtable_id, kylas_contact_id, name, company_id, owner, kylas_owner_id, kpi_rank, kpi_rank_at, current_stage, first_worked_at, first_picked_at, ever_picked) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < SIZE.contacts; i++) {
    const w = i % 7 === 0;
    s.run(rid("CON", i), i === 0 ? "112936" : String(500000 + i), `Person ${i}`, 1 + (i % kylasIds.length), owners[i % 2], String(74725 + (i % 2)),
      w ? i % 27 : null, w ? `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z` : null,
      w ? "MQL_MARKETING_QUALIFIED_LEAD" : null, w ? "2026-10-01T00:00:00.000Z" : null,
      w && i % 3 === 0 ? "2026-10-02T00:00:00.000Z" : null, w && i % 3 === 0 ? 1 : 0);
  }
  s = db.prepare(`INSERT INTO event_rows (airtable_id, row_key, contact_id, period, event_type, budget, timeline, pax) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < SIZE.events; i++) s.run(rid("EVR", i), `er${i}`, 1 + ((i * 3) % SIZE.contacts), "Current", "Offsite",
    i % 2 ? "5L" : null, i % 3 ? "Q4" : null, i % 5 ? "80" : null);
  s = db.prepare(`INSERT INTO call_log (airtable_id, key, contact_id, called_at, owner, outcome, duration, duration_source) VALUES (?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (let i = 0; i < SIZE.calls; i++) s.run(rid("CAL", i), `k${i}`, 1 + ((i * 7) % SIZE.contacts),
    new Date(now - (i % (40 * 24)) * 3600_000).toISOString(), owners[i % 2], "No answer", 30, i % 2 ? "dialed" : "estimated");
  s = db.prepare(`INSERT INTO stage_transitions (airtable_id, key, contact_id, changed_at, owner, to_stage) VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < SIZE.moves; i++) s.run(rid("STT", i), `st${i}`, 1 + ((i * 5) % SIZE.contacts),
    new Date(now - (i % 30) * 86400_000).toISOString(), owners[i % 2], "MQL_MARKETING_QUALIFIED_LEAD");
  /* the sync's own record, so /companies serves from the store as in production */
  db.prepare(`INSERT INTO schema_migrations (airtable_id, key, note, applied_at) VALUES (?,?,?,?)`).run(rid("SCM", 0), "last-sync",
    JSON.stringify({ at: new Date().toISOString(), kylas: { reportedTotal: kylasIds.length } }), new Date().toISOString());
  db.exec("COMMIT");
  db.close();
}

/* Export every table through the engine, as Airtable would hand it over. */
const seedFile = join(tmpdir(), `latency-seed-${process.pid}.json`);
{
  const eng = airtableOverD1(fakeD1(file), { maxPageSize: 5000 });
  const seed = {};
  for (const t of TABLES) {
    const recs = [];
    let off = "";
    do {
      const r = await eng.handle("GET", `/${encodeURIComponent(t.name)}?pageSize=5000${off ? `&offset=${off}` : ""}`);
      recs.push(...r.body.records); off = r.body.offset || "";
    } while (off);
    if (recs.length) seed[t.name] = recs.map((r) => ({ __id: r.id, ...r.fields }));
  }
  writeFileSync(seedFile, JSON.stringify(seed));
}

/* ── 2 · the mocks ───────────────────────────────────────────────────── */
const kids = [];
const spawnIt = (args, env) => {
  const p = spawn("node", args, { cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" });
  kids.push(p); return p;
};
const done = () => kids.forEach((p) => { try { p.kill("SIGKILL"); } catch {} });
process.on("exit", done);
spawnIt(["scripts/mock-kylas.mjs"], { MOCK_MANY: String(SIZE.companies) });
spawnIt(["scripts/mock-airtable.mjs"], { MOCK_AIRTABLE_SEED: seedFile, MOCK_LATENCY_MS: String(AIRTABLE_MS),
  MOCK_AIRTABLE_STORE: "" });
for (let i = 0; i < 200; i++) {
  try {
    await fetch("http://127.0.0.1:9901/__count", { headers: { Authorization: "Bearer x" } });
    await fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } });
    break;
  } catch { await sleep(250); }
}

const BASE = { KYLAS_KEY: "x", KYLAS_BASE: "http://127.0.0.1:9900", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", VERSION: "latency", ALLOWED_ORIGIN: ORIGIN, AUTH: "none",
  CRON_MAINTAIN: "*/5 * * * *" };

/* ── 3 · the routes ──────────────────────────────────────────────────── */
const ROUTES = [
  ["save: a call on an existing contact", "POST", "/save", () => ({
    contact: { lid: "", kid: "112936", pocName: "Person 0", companyId: "1776620", company: "seats", owner: "Enout Super Admin",
      ownerId: 74725, phones: [{ type: "MOBILE", cc: "+91", value: "9800004321", primary: true }], emails: [],
      stage: "MQL_MARKETING_QUALIFIED_LEAD", past: [], current: [], remarks: "" },
    call: { at: new Date().toISOString(), outcome: "No answer", duration: 0, durationSource: "dialed", createdHere: true } })],
  ["save: full discovery (event row, stage)", "POST", "/save", () => ({
    contact: { lid: "", kid: "112936", pocName: "Person 0", companyId: "1776620", company: "seats", owner: "Enout Super Admin",
      ownerId: 74725, phones: [{ type: "MOBILE", cc: "+91", value: "9800004321", primary: true }], emails: [],
      stage: "MQL_MARKETING_QUALIFIED_LEAD", past: [], remarks: "Goa in March",
      current: [{ rowKey: "lat-row-1", eventType: "Offsite", budget: "8L", timeline: "Mar", pax: "40", remarks: "" }] },
    call: { at: new Date().toISOString(), outcome: "Connected", duration: 120, durationSource: "dialed", createdHere: true } })],
  ["accounts list (/companies)", "GET", "/companies?owner=all"],
  ["one account (/company)", "GET", "/company?id=1776620"],
  ["one contact (/contact)", "GET", "/contact?id=112936"],
  ["earlier notes (/history)", "GET", "/history?id=112936"],
  ["dashboard, today (/report)", "GET", "/report?period=day&owner=all"],
  ["dashboard, this week", "GET", "/report?period=week&owner=all"],
  ["dashboard, this month", "GET", "/report?period=month&owner=all"],
  ["RCA (/rca)", "GET", "/rca?owner=74725"],
  ["call queue (/queue)", "GET", "/queue?owner=74725"],
  ["focus (/focus)", "GET", "/focus"],
  ["mode split", "GET", "/mode-split?owner=74725"],
  ["snapshots (7 days)", "GET", "/snapshots?days=7"],
];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function measure(label, env, counter) {
  const worker = (await import(`../worker/index.mjs?store=${label}`)).default;
  const call = async (method, path, body) => {
    const held = [];
    const t0 = performance.now();
    const r = await worker.fetch(new Request(`https://bd.enout.website${path}`, {
      method, headers: { Origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: (p) => held.push(p) });
    const text = await r.text();
    const ms = performance.now() - t0;
    await Promise.allSettled(held);
    return { ms, status: r.status, text };
  };
  /* Warm-up: the cron, as production runs it every minute — on A it builds
     the read copy, which is how Airtable is served today. */
  for (let i = 0; i < 400; i++) {
    const held = [];
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, { waitUntil: (p) => held.push(p) });
    await Promise.allSettled(held);
    const st = JSON.parse((await call("GET", "/cache-status")).text || "{}");
    const pending = (st.mirror || []).filter((t) => !t.built).length;
    if (!pending) break;
    if (i % 10 === 0) console.log(`   ${label}: building the read copy — ${pending} table(s) to go`);
  }
  for (const [, m, p, b] of ROUTES) await call(m, p, b?.());       /* first touch, not timed */
  const out = {};
  for (const [name, method, path, body] of ROUTES) {
    const times = [], qs = [];
    let status = 0;
    for (let i = 0; i < N; i++) {
      const q0 = counter ? counter() : 0;
      const r = await call(method, path, body?.());
      times.push(r.ms); qs.push(counter ? counter() - q0 : 0); status = r.status;
    }
    out[name] = { p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), status,
                  queries: counter ? Math.max(...qs) : null };
    console.log(`   ${label.padEnd(9)} ${name.padEnd(42)} p50 ${String(out[name].p50).padStart(6)}ms  p95 ${String(out[name].p95).padStart(6)}ms` +
      (counter ? `  ${out[name].queries} D1 queries` : "") + (status !== 200 ? `  (HTTP ${status})` : ""));
  }
  return out;
}

console.log(`\nA · Airtable as live today (${AIRTABLE_MS} ms a request, 5/s, read copy warm)`);
/* The read copy lives in D1 in production (the DB binding), so it pays the
   same D1 round trip as B does — anything else would flatter Airtable. */
const A = await measure("airtable", { ...BASE, DB: fakeD1(":memory:", { latencyMs: D1_MS }) });
console.log(`\nB · STORE=d1 (${D1_MS} ms a D1 call)`);
const kpi = fakeD1(file, { latencyMs: D1_MS });
const B = await measure("d1", { ...BASE, DB: fakeD1(":memory:", { latencyMs: D1_MS }), STORE: "d1", KPI_DB: kpi }, () => kpi.queries());

/* ── 4 · the verdict ─────────────────────────────────────────────────── */
console.log(`\n${"route".padEnd(42)} ${"Airtable p50/p95".padStart(18)} ${"Cloudflare p50/p95".padStart(20)}  verdict`);
let slower = 0;
const rows = ROUTES.map(([name]) => {
  const a = A[name], b = B[name];
  /* Same speed means within what a stopwatch can tell apart: 15% plus 25ms,
     the spread between two runs of the SAME store on a route that makes no
     database call at all (measured: in-memory report builds vary ~20ms). */
  const ok = b.status === a.status && b.p95 <= a.p95 * 1.15 + 25;
  if (!ok) slower++;
  console.log(`${name.padEnd(42)} ${`${a.p50} / ${a.p95} ms`.padStart(18)} ${`${b.p50} / ${b.p95} ms`.padStart(20)}  ${ok ? "ok" : "SLOWER"}`);
  return { route: name, airtable: a, d1: b, ok };
});
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), airtableMs: AIRTABLE_MS, d1Ms: D1_MS,
  size: SIZE, n: N, rows }, null, 2));
console.log(slower ? `\n${slower} route(s) slower on Cloudflare.` : `\nEvery route is as fast or faster on Cloudflare.`);
rmSync(file, { force: true }); rmSync(seedFile, { force: true });
done();
process.exit(slower ? 1 : 0);
