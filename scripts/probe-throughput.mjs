#!/usr/bin/env node
/* HOW FAST CAN THIS KYLAS ACCOUNT ACTUALLY BE ASKED THINGS? READ-ONLY.
 *
 *   node --env-file=.env.local scripts/probe-throughput.mjs
 *
 * The bulk re-assign is limited by two numbers nobody has measured on the live
 * account: how long Kylas takes to answer, and how fast it lets requests start.
 * The client's 450 ms gap was set after "a burst of 8 drew three 429s", which is
 * one data point. bench-reassign.mjs shows what overlapping requests buys at a
 * GIVEN latency; this tells you which latency you actually have.
 *
 * It only sends GET /v1/users/me — read-only, no record touched, about 100
 * requests in all, and it STOPS A SETTING AT ITS FIRST 429 rather than pushing
 * on, so a limit is found by touching it once, not by leaning on it.
 *
 *   A  one at a time, with a gap of 450 / 300 / 200 ms   — is 450 too careful?
 *   B  overlapping, started 450 ms apart, 2 / 3 / 4 in flight — is concurrency
 *      refused, or only a high rate?
 *
 * Then it says what to set REASSIGN_CONCURRENCY to.
 */
const KEY = process.env.KYLAS_KEY, BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
if (!KEY) { console.error("KYLAS_KEY is not set"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 12;

async function one() {
  const t = Date.now();
  const r = await fetch(`${BASE}/v1/users/me`, { headers: { "api-key": KEY }, signal: AbortSignal.timeout(30000) });
  await r.text();
  return { status: r.status, ms: Date.now() - t };
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

/* `inflight` requests may overlap; each one starts at least `gap` after the last start. */
async function run(label, gap, inflight) {
  const lat = [], status = {};
  let last = 0, running = 0, sent = 0, stop = false;
  const t0 = Date.now();
  const slots = [];
  const worker = async () => {
    while (!stop && sent < N) {
      if (running >= inflight) { await new Promise((r) => slots.push(r)); continue; }
      sent++; running++;
      const start = Math.max(Date.now(), last + gap); last = start;
      await sleep(Math.max(0, start - Date.now()));
      one().then((r) => { lat.push(r.ms); status[r.status] = (status[r.status] || 0) + 1; if (r.status === 429) stop = true; })
        .catch(() => { status.error = (status.error || 0) + 1; })
        .finally(() => { running--; const n = slots.shift(); if (n) n(); });
    }
  };
  await Promise.all(Array.from({ length: inflight }, worker));
  while (running) await sleep(50);
  const secs = (Date.now() - t0) / 1000, ok = status[200] || 0;
  return { label, gap, inflight, ok, throttled: status[429] || 0, errors: status.error || 0, p50: pct(lat, 0.5), p95: pct(lat, 0.95), rate: ok / secs, stopped: stop };
}

console.log(`\nPROBING ${BASE} · GET /v1/users/me only · ${N} requests per setting · stops a setting at its first 429\n`);
const out = [];
for (const [label, gap, k] of [["one at a time, gap 450", 450, 1], ["one at a time, gap 300", 300, 1], ["one at a time, gap 200", 200, 1],
                                ["overlapping x2, 450 apart", 450, 2], ["overlapping x3, 450 apart", 450, 3], ["overlapping x4, 450 apart", 450, 4]]) {
  const r = await run(label, gap, k);
  out.push(r);
  console.log(`  ${label.padEnd(28)} ${String(r.ok).padStart(2)} ok · ${r.throttled ? `429 after ${r.ok}` : "no 429"} · answers ${String(r.p50).padStart(4)} ms median, ${String(r.p95).padStart(4)} ms slowest · ${r.rate.toFixed(2)} req/s`);
  await sleep(r.throttled ? 6000 : 1500);       /* let a limit cool before the next try */
}

const p50 = pct(out.filter((r) => r.inflight === 1 && !r.throttled).map((r) => r.p50), 0.5) || out[0].p50;
const gap450 = out[0], over = out.filter((r) => r.inflight > 1);
const okOver = over.filter((r) => !r.throttled);
const best = okOver.length ? Math.max(...okOver.map((r) => r.inflight)) : 1;
console.log(`\nRESULT`);
console.log(`  Kylas answers in about ${p50} ms.`);
if (gap450.throttled) console.log(`  ! Even one at a time with a 450 ms gap drew a 429: the gap is too small for this account right now. Do not turn concurrency on.`);
else if (p50 <= 450) console.log(`  That is inside the 450 ms gap, so overlapping requests will NOT help: set REASSIGN_CONCURRENCY=1.`);
else console.log(`  That is longer than the 450 ms gap, so overlapping helps by about ${(p50 / 450).toFixed(1)}x at best.`);
if (over.length) console.log(`  Overlapping: ${over.map((r) => `x${r.inflight} ${r.throttled ? "was refused" : "was accepted"}`).join(", ")}.`);
if (!gap450.throttled && p50 > 450) console.log(`  Suggested:  REASSIGN_CONCURRENCY=${Math.max(1, Math.min(best, Math.ceil(p50 / 450)))}   (it drops back to 1 by itself on the first 429).`);
/* A shorter gap only counts as TESTED if the requests really did start that close
   together. One at a time, a 600 ms answer makes the gap irrelevant — requests
   start 600 ms apart whatever the gap says — and "accepted at 200 ms" would be a
   claim nothing measured. */
const faster = out.filter((r) => r.inflight === 1 && !r.throttled && r.gap < 450 && r.rate >= 0.85 * (1000 / r.gap));
if (faster.length) console.log(`  A shorter gap was accepted down to ${Math.min(...faster.map((r) => r.gap))} ms; the client's KYLAS_GAP could be lowered to match, but that speeds EVERYTHING and is a separate decision.`);
else if (out.some((r) => r.inflight === 1 && r.gap < 450 && !r.throttled)) console.log(`  The shorter gaps were not really tested: answers take longer than the gap, so requests never started that close together.`);
console.log("");
