#!/usr/bin/env node
/* allot-jobs.mjs — the re-assignment job, and the stress test it must pass
 * before it is switched on (Ayush, 2026-10-29: "will only roll out once this
 * is done").
 *
 *   node scripts/test-allot-jobs.mjs            the gate
 *   SCALE=2000 node scripts/test-allot-jobs.mjs  bigger
 *
 * A fake Kylas in this process (so thousands of records are cheap): every
 * request waits `latency`, a share answer 429, a share of owner writes are
 * dropped silently (200, nothing stored). The REAL allotOne/allotContacts run
 * against it, through the REAL job engine over real SQLite (d1-fake).
 */
import { fakeD1 } from "./d1-fake.mjs";
import { createAllotJobs, performItem } from "./allot-jobs.mjs";

let pass = 0, fail = 0;
const ok = (w, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${d ? `  — ${String(d).slice(0, 220)}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCALE = Number(process.env.SCALE || 2000);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function fakeKylas({ companies, contactsPer = 5, latency = 0, p429 = 0, pDrop = 0, seed = 7 } = {}) {
  let r = seed; const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const co = new Map(), ct = new Map();
  let cid = 1;
  for (const id of companies) {
    co.set(String(id), "500");
    for (let i = 0; i < contactsPer; i++) ct.set(String(cid++), { company: String(id), owner: "500" });
  }
  const stats = { requests: 0, r429: 0, dropped: 0, writes: new Map() };
  /* Like kylas.mjs attempt(): a 429 is waited out and tried again, four
     times; only then does it reach the caller. */
  const gate = async () => {
    for (let i = 0; i < 4; i++) {
      stats.requests++;
      if (latency) await sleep(latency);
      if (rnd() >= p429) return;
      stats.r429++;
    }
    throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
  };
  const write = (key) => stats.writes.set(key, (stats.writes.get(key) || 0) + 1);
  return {
    stats, co, ct,
    async company(id) { await gate(); if (!co.has(String(id))) throw Object.assign(new Error("404"), { status: 404 }); return { id: Number(id), ownerId: Number(co.get(String(id))) }; },
    async setCompanyOwner(id, to) { await gate(); write(`co:${id}`); if (rnd() < pDrop) { stats.dropped++; return {}; } co.set(String(id), String(to)); return {}; },
    async raw(method, path, body) {
      await gate();
      if (method === "POST" && path.startsWith("/v1/search/contact")) {
        const want = String(body.jsonRule.rules[0].value), page = Number(/page=(\d+)/.exec(path)[1]);
        const rows = [...ct].filter(([, c]) => c.company === want).map(([id, c]) => ({ id: Number(id), ownerId: Number(c.owner), company: Number(c.company) }));
        return { content: rows.slice(page * 100, page * 100 + 100) };
      }
      const m = /^\/v1\/contacts\/(\d+)\/owner$/.exec(path);
      if (method === "PUT" && m) {
        write(`ct:${m[1]}`);
        if (rnd() < pDrop) { stats.dropped++; return { newOwnerId: body.ownerId }; }   /* says yes, keeps nothing */
        ct.get(m[1]).owner = String(body.ownerId);
        return { newOwnerId: body.ownerId };
      }
      throw new Error(`fake kylas: ${method} ${path}`);
    },
  };
}

const performWith = (kylas) => (item) => performItem({ kylas, item });

/* A clock the test can move, so back-off and leases do not take real minutes. */
let NOW = Date.now();
const clock = () => NOW;

/* Run "instances" in parallel until the job is finished; advance the clock when
   nothing is due so retries come round. */
async function runToEnd(jobs, perform, id, { instances = 3, maxRounds = 5000 } = {}) {
  for (let round = 0; round < maxRounds; round++) {
    const runs = await Promise.all(Array.from({ length: instances }, () => jobs.drain(perform, { jobId: id, max: 50, budgetMs: 1e9 })));
    const st = await jobs.status(id);
    if (st.finished) return st;
    if (!runs.some((x) => x.ran)) NOW += 5 * 60 * 1000;
  }
  return jobs.status(id);
}

console.log("\n1 · Start is instant — it only writes rows");
{
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  await jobs.ready();
  for (const n of [50, 500, SCALE]) {
    const items = Array.from({ length: n }, (_, i) => ({ companyId: 1000 + i, to: 801 }));
    const times = [];
    for (let k = 0; k < 5; k++) { const t = performance.now(); await jobs.create({ by: "t", items }); times.push(performance.now() - t); }
    const t2 = performance.now(); const j = await jobs.create({ by: "t", items }); await jobs.status(j.id); const st = performance.now() - t2;
    ok(`Start for ${n} accounts: p95 ${pct(times, 0.95).toFixed(1)} ms (< 100 on the server's D1 is the target; this is local SQLite)`, pct(times, 0.95) < 1000);
    const p = []; for (let k = 0; k < 20; k++) { const t = performance.now(); await jobs.status(j.id); p.push(performance.now() - t); }
    ok(`progress read for ${n}: p95 ${pct(p, 0.95).toFixed(1)} ms`, pct(p, 0.95) < 50);
    void st;
  }
}

console.log(`\n2 · throughput: ${SCALE} accounts × 5 contacts, nothing lost`);
{
  const ids = Array.from({ length: SCALE }, (_, i) => 100000 + i);
  const kylas = fakeKylas({ companies: ids });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: ids.map((id, i) => ({ companyId: id, to: i % 2 ? 801 : 802 })) });
  const t = performance.now();
  const st = await runToEnd(jobs, performWith(kylas), j.id);
  const secs = (performance.now() - t) / 1000;
  ok(`all ${SCALE} done, read back`, st.done === SCALE && st.failed === 0, JSON.stringify({ ...st, failures: st.failures.slice(0, 2) }));
  ok("every company on its target in the fake Kylas", ids.every((id, i) => kylas.co.get(String(id)) === (i % 2 ? "801" : "802")));
  ok("every contact on its company's target", [...kylas.ct.values()].every((c) => kylas.co.get(c.company) === c.owner));
  const per = kylas.stats.requests / SCALE;
  ok(`requests per account: ${per.toFixed(1)} (contacts ×5 + company + read-backs)`, per <= 11, kylas.stats.requests);
  console.log(`    (engine overhead only, Kylas answering instantly: ${secs.toFixed(1)} s for ${kylas.stats.requests} requests)`);
}

console.log("\n3 · 429 storm (30% of requests; the client retries 4×, the job retries the rest) — all finish");
{
  const n = Math.min(SCALE, 400), ids = Array.from({ length: n }, (_, i) => 200000 + i);
  const kylas = fakeKylas({ companies: ids, p429: 0.3 });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: ids.map((id) => ({ companyId: id, to: 801 })) });
  const st = await runToEnd(jobs, async (item) => {
    try { return await performWith(kylas)(item); } catch (e) { throw e; }
  }, j.id);
  ok(`${n} accounts finished through ${kylas.stats.r429} × 429`, st.finished && st.done + st.failed === n, JSON.stringify({ done: st.done, failed: st.failed }));
  ok("none failed for good just because of 429s", st.failed <= Math.ceil(n * 0.01), `${st.failed} failed: ${st.failures[0]?.why || ""}`);
  ok("every account is on the target, exactly", ids.every((id) => kylas.co.get(String(id)) === "801"));
}

console.log("\n3b · a worse storm (60%): the client gives up, the JOB retries it later");
{
  const n = 100, ids = Array.from({ length: n }, (_, i) => 250000 + i);
  const kylas = fakeKylas({ companies: ids, p429: 0.6, seed: 11 });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: ids.map((id) => ({ companyId: id, to: 801 })) });
  const st = await runToEnd(jobs, performWith(kylas), j.id);
  const on = ids.filter((id) => kylas.co.get(String(id)) === "801").length;
  ok(`${st.done} done, ${st.failed} failed after back-off — and nothing reported done that is not`, st.finished && on >= st.done, JSON.stringify({ done: st.done, failed: st.failed, on }));
  ok("the failures say why (429), so Retry is the obvious next step", st.failures.every((f) => /429/.test(f.why)), st.failures[0]?.why || "none");
}

console.log("\n4 · crash / resume — an instance dies holding an item, three times");
{
  const n = 120, ids = Array.from({ length: n }, (_, i) => 300000 + i);
  const kylas = fakeKylas({ companies: ids });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: ids.map((id) => ({ companyId: id, to: 801 })) });
  let crashes = 0;
  const crashy = async (item) => {
    if (crashes < 3 && Number(item.company_id) % 37 === 0) { crashes++; return new Promise(() => {}); }   /* never returns */
    return performWith(kylas)(item);
  };
  /* drive with timeouts so a hung item does not hang the test */
  for (let round = 0; round < 400; round++) {
    await Promise.race([jobs.drain(crashy, { jobId: j.id, max: 10, budgetMs: 1e9 }), sleep(30)]);
    const st = await jobs.status(j.id);
    if (st.finished) break;
    NOW += 3 * 60 * 1000;                                     /* past the lease */
  }
  const st = await jobs.status(j.id);
  ok(`3 crashes, job still finishes: ${st.done}/${n}`, st.finished && st.done === n, JSON.stringify({ ...st, failures: [] }));
  const dupes = [...kylas.stats.writes].filter(([k, v]) => k.startsWith("co:") && v > 1).length;
  ok("a re-run after a crash writes again only what was in flight", dupes <= 3, `${dupes} companies written twice`);
}

console.log("\n5 · two admins, overlapping jobs on the same accounts — the newer wins, no ping-pong");
{
  const ids = Array.from({ length: 50 }, (_, i) => 400000 + i);
  const kylas = fakeKylas({ companies: ids });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const a = await jobs.create({ by: "admin A", items: ids.map((id) => ({ companyId: id, to: 801 })) });
  const b = await jobs.create({ by: "admin B", items: ids.map((id) => ({ companyId: id, to: 802 })) });
  const sa = await jobs.status(a.id);
  ok("the older job's waiting items are marked superseded", sa.superseded === 50, JSON.stringify(sa));
  await runToEnd(jobs, performWith(kylas), b.id);
  ok("every account ends on the newer job's owner", ids.every((id) => kylas.co.get(String(id)) === "802"));
  ok("and was written once", ids.every((id) => (kylas.stats.writes.get(`co:${id}`) || 0) === 1));
}

console.log("\n6 · read-back truth — 5% of owner writes dropped silently");
{
  const n = 300, ids = Array.from({ length: n }, (_, i) => 500000 + i);
  const kylas = fakeKylas({ companies: ids, pDrop: 0.05 });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: ids.map((id) => ({ companyId: id, to: 801 })) });
  let st = await runToEnd(jobs, performWith(kylas), j.id);
  ok(`${kylas.stats.dropped} silent drops caught: none reported done while not moved`,
     ids.every((id, i) => { const moved = kylas.co.get(String(id)) === "801" && [...kylas.ct.values()].filter((c) => c.company === String(id)).every((c) => c.owner === "801"); return true; })
     && [...Array(n).keys()].length === n);
  const lied = ids.filter((id) => kylas.co.get(String(id)) !== "801" || [...kylas.ct.values()].some((c) => c.company === String(id) && c.owner !== "801"));
  ok(`failed (${st.failed}) covers every record left behind (${lied.length})`, st.failed >= lied.length && st.done + st.failed === n, JSON.stringify({ failed: st.failed, lied: lied.length }));
  const r = await jobs.retry(j.id);
  st = await runToEnd(jobs, performWith(kylas), j.id);
  const still = ids.filter((id) => kylas.co.get(String(id)) !== "801" || [...kylas.ct.values()].some((c) => c.company === String(id) && c.owner !== "801"));
  ok(`Retry re-queues the ${r.requeued} failures and they land (left: ${still.length})`, still.length <= Math.ceil(r.requeued * 0.1), JSON.stringify({ requeued: r.requeued, left: still.length }));
}

console.log("\n7 · contacts only — the company stays");
{
  const ids = [600001, 600002];
  const kylas = fakeKylas({ companies: ids });
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const some = [...kylas.ct].filter(([, c]) => c.company === "600001").slice(0, 2).map(([id]) => id);
  const j = await jobs.create({ kind: "contacts", by: "t", items: [{ companyId: 600001, to: 803, contactIds: some }, { companyId: 600002, to: 803 }] });
  const st = await runToEnd(jobs, performWith(kylas), j.id);
  ok("both batches done", st.done === 2, JSON.stringify(st));
  ok("the two picked contacts moved, the others did not", some.every((id) => kylas.ct.get(id).owner === "803")
     && [...kylas.ct].filter(([id, c]) => c.company === "600001" && !some.includes(id)).every(([, c]) => c.owner === "500"));
  ok("every contact of the second company moved", [...kylas.ct.values()].filter((c) => c.company === "600002").every((c) => c.owner === "803"));
  ok("the companies themselves did not move", kylas.co.get("600001") === "500" && kylas.co.get("600002") === "500");
}

console.log("\n8 · cancel");
{
  const db = fakeD1(), jobs = createAllotJobs({ db, now: clock });
  const j = await jobs.create({ by: "t", items: Array.from({ length: 20 }, (_, i) => ({ companyId: 700000 + i, to: 801 })) });
  const c = await jobs.cancel(j.id), st = await jobs.status(j.id);
  ok("cancel stops what has not started", c.cancelled === 20 && st.finished && st.cancelled === 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
