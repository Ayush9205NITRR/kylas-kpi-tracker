#!/usr/bin/env node
/* The scans behind /company and /queue, and when they are allowed to be stale.
 *
 *   node scripts/test-read-cache.mjs
 *
 * Opening an account reads three whole tables: Companies, Contacts and Event
 * Rows. Uncached, on a base of 400 companies and 1400 event rows, that was
 * 3.08 SECONDS on every single click — measured, not estimated — because the
 * event scan alone is fourteen pages at the 220ms rate-limit gap. Ayush,
 * 2026-09-21: "reduce latency, it should be super smooth."
 *
 * Caching them takes that to about two milliseconds. The whole cost of the
 * change is this file: a cache that hands back rows from before somebody's
 * save is worse than a slow one, because the associate is then looking at a
 * screen that disagrees with what they just typed and has no way to tell.
 *
 * The subtle case is the last one. A crawl already in flight when a save lands
 * was started BEFORE that write, so its rows are stale — but it resolves
 * afterwards, and if it stamps the cache on the way out it looks fresh. I
 * wrote that bug first and this is what catches it.
 */
import { createServer } from "node:http";

/* One row per table, and a count of how many times each was crawled. */
const hits = new Map();
let contactRows = [{ id: "recC1", fields: { Name: "Before", Company: ["recCo1"] } }];
let eventRows = [{ id: "recE1", fields: { "Row Key": "r1", Budget: "1L", Contact: ["recC1"] } }];

/* THE UN-REPAIRED BASE, which is the one Ayush is on: no "Company Kylas ID"
   rollup on Contacts, so the server-side filter 422s and readCompany falls
   back to scanning the whole table in memory. That fallback is the expensive
   path and therefore the one worth caching — on a repaired base the filter is
   a single narrow request and there is nothing to save. The last block below
   covers the repaired case so neither is assumed. */
let rollup = false;
const answer = (table) => (
  table === "Contacts" ? contactRows
  : table === "Event Rows" ? eventRows
  : table === "Companies" ? [{ id: "recCo1", fields: { "Kylas Company ID": "903", Name: "Shorehouse" } }]
  : []);

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const table = decodeURIComponent(url.pathname.split("/").pop());
  const formula = url.searchParams.get("filterByFormula") || "";
  if (!rollup && /Company Kylas ID/.test(formula)) {
    res.writeHead(422, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "INVALID_FILTER_BY_FORMULA" } }));
  }
  hits.set(table, (hits.get(table) || 0) + 1);
  if (formula) hits.set(table + " (filtered)", (hits.get(table + " (filtered)") || 0) + 1);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ records: answer(table) }));
});
await new Promise((r) => server.listen(0, r));
/* Before the import: airtable.mjs reads this at module scope, and setting it
   afterwards points the client at the real api.airtable.com. */
process.env.AIRTABLE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { createAirtable, readQueue, readCompany, dropReadCaches } = await import("./airtable.mjs");
const at = createAirtable("pat_test", "appT", { log: () => {} });

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n         got: ${JSON.stringify(got)}`}`);
};
const count = (t) => hits.get(t) || 0;

console.log("— the second account open does not re-crawl —");
{
  await readCompany(at, "903");
  const after1 = { c: count("Contacts"), e: count("Event Rows") };
  await readCompany(at, "903");
  await readCompany(at, "903");
  check("Contacts read once, not three times", count("Contacts"), after1.c);
  check("Event Rows read once, not three times", count("Event Rows"), after1.e);
}

console.log("\n— the queue shares those scans rather than repeating them —");
{
  const before = { c: count("Contacts"), e: count("Event Rows") };
  /* /queue used to run its own listTolerant of Contacts with the identical
     projection — a second uncached copy of the same crawl, 2.4s on the big
     fixture, on the screen the console opens on. */
  await readQueue(at, "");
  check("no new Contacts crawl", count("Contacts"), before.c);
  check("no new Event Rows crawl", count("Event Rows"), before.e);
}

console.log("\n— concurrent opens share one flight —");
{
  dropReadCaches();
  const before = count("Event Rows");
  await Promise.all([readCompany(at, "903"), readCompany(at, "903"), readQueue(at, "")]);
  /* Not three identical crawls pacing against each other into the rate limit. */
  check("one crawl covers all three callers", count("Event Rows") - before, 1);
}

console.log("\n— a save makes the next read see the new row —");
{
  eventRows = [...eventRows, { id: "recE2", fields: { "Row Key": "r2", Budget: "9L", Contact: ["recC1"] } }];
  /* What syncContact calls after writing. Without it the associate reopens the
     account they just saved and their row is not there. */
  dropReadCaches();
  const r = await readCompany(at, "903");
  const keys = (r.contacts[0].current || []).concat(r.contacts[0].past || []).map((x) => x.rowKey);
  check("the row just written is there", keys.includes("r2"), true);
}

console.log("\n— a crawl in flight when the save lands does not publish —");
{
  /* THE SUBTLE ONE. The crawl below starts before the write and finishes
     after it, so its rows are stale. If it stamps the cache on resolution it
     looks FRESH, and the next reader is shown the base as it was before the
     save — for a full TTL, with a re-open not fixing it. */
  dropReadCaches();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const table = decodeURIComponent(url.pathname.split("/").pop());
    if (/Company Kylas ID/.test(url.searchParams.get("filterByFormula") || "")) {
      res.writeHead(422, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "INVALID_FILTER_BY_FORMULA" } }));
    }
    if (table === "Event Rows") await gate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ records: answer(table) }));
  });
  await new Promise((r) => slow.listen(0, r));
  process.env.AIRTABLE_BASE_URL = `http://127.0.0.1:${slow.address().port}`;
  const at2 = createAirtable("pat_test", "appT", { log: () => {} });

  const inflight = readCompany(at2, "903");        /* starts the crawl */
  await new Promise((r) => setTimeout(r, 150));
  /* The save lands while it is in the air, and adds a row. */
  eventRows = [...eventRows, { id: "recE3", fields: { "Row Key": "r3", Budget: "3L", Contact: ["recC1"] } }];
  dropReadCaches();
  release();
  await inflight;

  const after = await readCompany(at2, "903");
  const keys = (after.contacts[0].current || []).concat(after.contacts[0].past || []).map((x) => x.rowKey);
  check("the read after the save sees the new row", keys.includes("r3"), true);
  slow.close();
}

console.log("\n— a repaired base filters server-side instead —");
{
  /* With the rollup present readCompany asks for ONE company's contacts and
     gets them in a single narrow request. That is not a cache miss to be fixed
     — it is the fast path, and the whole reason repair-base matters. */
  rollup = true;
  dropReadCaches();
  /* Back to the main server — the block above pointed the env at the gated one
     and then closed it, and the fresh import below reads the env at load. */
  process.env.AIRTABLE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  /* noCompanyRollup latches for the process once the filter has failed, so a
     fresh module is the only honest way to exercise the other branch. */
  const fresh = await import("./airtable.mjs?repaired=1");
  const at3 = fresh.createAirtable("pat_test", "appT", { log: () => {} });
  hits.clear();
  await fresh.readCompany(at3, "903");
  await fresh.readCompany(at3, "903");
  check("it uses the narrow filter", count("Contacts (filtered)"), (n) => n >= 1);
  check("and never scans the whole table", count("Contacts"), count("Contacts (filtered)"));
}

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
