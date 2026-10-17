#!/usr/bin/env node
/* HOW MUCH FASTER IS A BULK RE-ASSIGN WHEN REQUESTS OVERLAP?
 *
 *   node scripts/bench-reassign.mjs
 *
 * Ayush, 2026-10-16: "Bulk allotment — UI se fast nahi hai (accounts aur contacts
 * dono ek saath ho jaaye)."
 *
 * WHAT MAKES IT SLOW. Every contact costs two Kylas requests (read it, then PUT
 * it back — a PUT replaces the record, so the read cannot be skipped), every
 * account one more to set its owner, and the Kylas client sends them ONE AT A
 * TIME: the next starts only after the last has answered, then waits out a
 * 450 ms gap. With Kylas answering in 700 ms that is 1.4 requests a second where
 * the gap alone would allow 2.2.
 *
 * WHAT THIS CHANGES, and what it cannot. The client can now keep several requests
 * in flight, STARTING THEM THE SAME 450 ms APART. The ceiling does not move; only
 * the wait for each answer comes off the critical path. So the gain is
 * latency / gap at best, and NONE when Kylas already answers inside the gap.
 * This runs both ends so the claim is a measurement:
 *
 *   700 ms  a plausible round trip to Kylas  -> should be about 1.5x
 *   250 ms  Kylas answering inside the gap   -> should be about 1.0x (no gain)
 *
 * AGAINST THE MOCK, NOT KYLAS. Its latency is injected (MOCK_LATENCY_MS) and its
 * rate limit is 4 a second. What this cannot tell you is Kylas' real latency or
 * whether it limits concurrency as well as rate — and for that,
 * scripts/probe-throughput.mjs measures the live account, read-only.
 */
import { spawn } from "node:child_process";
import { createClient } from "./kylas.mjs";
import { apply } from "./reassign.mjs";

const PORT = 9951, ACCOUNTS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;
process.on("exit", () => { try { proc?.kill("SIGKILL"); } catch { /* gone */ } });
async function freshKylas(latency) {
  if (proc) { proc.kill("SIGKILL"); await sleep(300); }
  proc = spawn(process.execPath, ["scripts/mock-kylas.mjs"], { env: { ...process.env, PORT: String(PORT), MOCK_MANY: "12", MOCK_CONTACTS: "32", MOCK_LATENCY_MS: String(latency) }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/__writes`, { headers: { "api-key": "k" } }); if (r.ok || r.status === 429) return; } catch { /* not yet */ } await sleep(250); }
  throw new Error("the Kylas mock did not start");
}

const rows = [];
for (const latency of [700, 250]) {
  for (const k of [1, 3]) {
    await freshKylas(latency);
    const kylas = createClient("k", { base: `http://127.0.0.1:${PORT}`, log: () => {} });
    const ids = Array.from({ length: ACCOUNTS }, (_, i) => String(200000 + i));
    const out = await apply({ kylas, companies: ids, ownerId: "99999", concurrency: k });
    rows.push({ latency, k, ...out.timing, contacts: out.contacts, failed: out.failed.length, ownersSet: out.accountOwners });
    process.stderr.write(`  ${latency} ms · ${k} at a time · ${(out.timing.ms / 1000).toFixed(1)}s\n`);
  }
}

const base = (l) => rows.find((r) => r.latency === l && r.k === 1).ms;
console.log(`\nRE-ASSIGN SPEED · ${ACCOUNTS} accounts · mock Kylas · client gap 450 ms · mock limit 4 requests/s`);
console.log(`\n${"Kylas latency".padEnd(15)}${"at a time".padEnd(11)}${"time".padEnd(9)}${"requests".padEnd(10)}${"per contact".padEnd(13)}${"429s".padEnd(6)}${"contacts moved".padEnd(16)}vs one at a time`);
for (const r of rows) {
  const x = base(r.latency) / r.ms;
  console.log(`${(r.latency + " ms").padEnd(15)}${String(r.k).padEnd(11)}${((r.ms / 1000).toFixed(1) + "s").padEnd(9)}${String(r.requests).padEnd(10)}${((r.perContactMs / 1000).toFixed(2) + "s").padEnd(13)}${String(r.throttled).padEnd(6)}${String(r.contacts).padEnd(16)}${r.k === 1 ? "—" : `${x.toFixed(2)}x ${x > 1.15 ? "faster" : "(no gain)"}`}`);
}
const same = rows.every((r) => r.contacts === rows[0].contacts && r.failed === 0);
console.log(`\nSame work every run: ${same ? "yes" : "NO"} (${rows[0].contacts} contacts moved, ${rows[0].ownersSet} account owners set, 0 failures).`);
const hi = rows.find((r) => r.latency === 700 && r.k === 3), lo = rows.find((r) => r.latency === 250 && r.k === 3);
console.log(`At 700 ms: ${(base(700) / hi.ms).toFixed(2)}x. At 250 ms: ${(base(250) / lo.ms).toFixed(2)}x — which is the point: it hides latency, it does not raise Kylas' rate.`);
process.exit(same ? 0 : 1);
