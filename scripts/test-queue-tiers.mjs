#!/usr/bin/env node
/* Who goes first through the one Airtable queue.
 *
 *   node scripts/test-queue-tiers.mjs
 *
 * Airtable allows 5 requests a second per base, so everything this proxy sends
 * to one base goes through one pacer. The ORDER within it is ours, and it is
 * the whole of what an associate experiences as "fast" or "slow" — a read they
 * are waiting for that sits behind twenty pages of a crawl nobody asked for is
 * slow, however quick each individual request was.
 *
 * Three tiers:
 *   hi   a save. Somebody pressed a button and is watching.
 *   lo   an interactive read — /company, /queue. Somebody is waiting.
 *   bg   a whole-table crawl prefetched so a panel is instant LATER. Nobody is
 *        waiting, and it must never delay the two above.
 *
 * bg exists because of a measurement: the console kicks off the Research crawl
 * on the first account it opens, which is while /company is in flight. Cold, on
 * the mock, /company took 2279ms with the crawl alongside it. Ayush,
 * 2026-09-21: "the system is still experiencing noticeable latency… especially
 * while making calls."
 *
 * PER PAGE, not per crawl. A twenty-page crawl that only yielded between
 * crawls would still put its first page in front of the read.
 */
import { createServer } from "node:http";

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n         got: ${JSON.stringify(got)}`}`);
};

/* A server that records the order it was asked, and answers a page at a time
   so a crawl really is several requests. */
const seen = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seen.push(decodeURIComponent(url.pathname.split("/").pop()) + (url.searchParams.get("offset") ? "+" : ""));
  const page = Number(url.searchParams.get("offset") || 0);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ records: [{ id: "rec1", fields: {} }],
                           offset: page < 2 ? String(page + 1) : undefined }));
});
await new Promise((r) => server.listen(0, r));
/* AIRTABLE_BASE_URL is read at MODULE scope in airtable.mjs, so it has to be
   set before the import evaluates — hence the dynamic import here rather than
   a static one at the top. Setting it afterwards silently points the client at
   the real api.airtable.com, which is a test that either fails confusingly or,
   worse, succeeds against production. */
process.env.AIRTABLE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { createAirtable } = await import("./airtable.mjs");

const at = createAirtable("pat_test", "appT", { log: () => {} });

console.log("— a crawl already running, then a read somebody is waiting for —");
{
  seen.length = 0;
  /* The crawl goes in FIRST and is three pages long. Under one queue its three
     requests would all precede the read. */
  const crawl = at.listAll("Crawl", { maxPages: 3, tier: "bg" });
  const read = at.listAll("Waiting", { maxPages: 1 });
  await Promise.all([crawl, read]);
  /* The crawl's first page is already in flight when the read arrives — that
     one cannot be helped and should not be. What matters is that the read does
     not then wait for pages two and three. */
  check("the read overtakes the rest of the crawl",
        seen.indexOf("Waiting") < seen.lastIndexOf("Crawl+"), true);
  console.log(`     order: ${seen.join(" ")}`);
}

console.log("\n— a save beats everything —");
{
  seen.length = 0;
  const crawl = at.listAll("Crawl", { maxPages: 3, tier: "bg" });
  const read = at.listAll("Waiting", { maxPages: 1 });
  const save = at.call("PATCH", "/Save", { records: [] });
  await Promise.all([crawl, read, save]);
  const iSave = seen.indexOf("Save");
  check("the write is not last", iSave < seen.length - 1, true);
  check("and it is ahead of the interactive read", iSave < seen.indexOf("Waiting"), true);
  console.log(`     order: ${seen.join(" ")}`);
}

console.log("\n— an untiered read is interactive, not background —");
{
  /* THE DEFAULT MATTERS MORE THAN THE OPT-IN. Every existing call site passes
     no tier, and every one of them is a read somebody is waiting for. A
     default of "bg" would have quietly demoted all of them. */
  seen.length = 0;
  const crawl = at.listAll("Crawl", { maxPages: 3, tier: "bg" });
  const plain = at.listAll("Plain", { maxPages: 1 });
  await Promise.all([crawl, plain]);
  check("it overtakes the crawl", seen.indexOf("Plain") < seen.lastIndexOf("Crawl+"), true);
}

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
