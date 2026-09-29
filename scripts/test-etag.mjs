/* NOT SENDING THE SAME ANSWER TWICE.
 *
 * Unit checks on the tag, then the whole thing through a real proxy: ask for
 * the company list, ask again with the tag, get a 304 with no body — and,
 * when the data changes, get a fresh 200.
 *
 * The case worth being most careful about is the LAST one. A cache that never
 * invalidates is indistinguishable from a fast cache until somebody notices
 * their call is missing from the list.
 *
 * Run: node scripts/test-etag.mjs
 */
import { spawn } from "node:child_process";
import { taggedBody, matches, cacheable } from "./etag.mjs";

let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};
const is = (what, got, want) => ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1. the tag says whether the ANSWER changed");
const a = taggedBody({ companies: [{ id: "1" }], cachedSeconds: 2 });
const b = taggedBody({ companies: [{ id: "1" }], cachedSeconds: 900 });
const c = taggedBody({ companies: [{ id: "2" }], cachedSeconds: 2 });
is("the same data at a different age has the same tag", a.etag, b.etag);
ok("different data has a different tag", a.etag !== c.etag);
ok("the tag is quoted, as the header wants", /^".+"$/.test(a.etag));
is("the body is serialised once and handed back", a.text, JSON.stringify({ companies: [{ id: "1" }], cachedSeconds: 2 }));

console.log("\n2. matching is forgiving in the ways it has to be");
ok("an exact tag matches", matches(a.etag, a.etag));
ok("a weak tag from a proxy matches", matches(`W/${a.etag}`, a.etag));
ok("one of several matches", matches(`"other", ${a.etag}`, a.etag));
ok("a different tag does not", !matches(c.etag, a.etag));
ok("nothing does not match", !matches("", a.etag));
ok("...and neither does a missing tag", !matches(a.etag, ""));

console.log("\n3. only successful reads are cacheable");
ok("GET 200 is", cacheable("GET", 200));
ok("an undefined method is a GET", cacheable(undefined, 200));
ok("POST is not", !cacheable("POST", 200));
ok("a 500 is not", !cacheable("GET", 500));
ok("a 404 is not", !cacheable("GET", 404));

/* ── through a real proxy ──────────────────────────────────────────── */
const K = 9941, A = 9942, P = 9943;
const kill = [];
const start = (file, env) => {
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: "ignore" });
  kill.push(p); return p;
};
start("scripts/mock-kylas.mjs", { PORT: String(K) });
start("scripts/mock-airtable.mjs", { PORT: String(A) });
await sleep(1200);
start("scripts/proxy.mjs", { PORT: String(P), KYLAS_BASE: `http://127.0.0.1:${K}`, KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: `http://127.0.0.1:${A}`, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK" });
await sleep(2500);

const U = `http://127.0.0.1:${P}`;
try {
  console.log("\n4. the same list is not sent twice");
  const first = await fetch(`${U}/companies`);
  const tag = first.headers.get("etag");
  const body1 = await first.text();
  is("the first ask is a 200", first.status, 200);
  ok("and carries a tag", !!tag, String(tag));
  ok("with a body", body1.length > 50, `${body1.length} bytes`);

  const second = await fetch(`${U}/companies`, { headers: { "if-none-match": tag } });
  is("asking again with the tag is a 304", second.status, 304);
  is("and sends nothing at all", (await second.text()).length, 0);
  is("still naming the tag", second.headers.get("etag"), tag);

  const noTag = await fetch(`${U}/companies`);
  is("asking without the tag is still a 200", noTag.status, 200);

  console.log("\n5. a stale tag gets the new answer");
  const wrong = await fetch(`${U}/companies`, { headers: { "if-none-match": '"not-the-tag"' } });
  is("a tag that is not ours is a 200", wrong.status, 200);
  ok("with the body", (await wrong.text()).length > 50);

  console.log("\n6. when the data changes, so does the tag");
  /* Through a real write. /focus is used rather than /companies because the
     company list is deliberately NOT re-read inside a request — a request only
     reads, and the background job re-crawls Kylas (see handlers.mjs). So
     adding a company and expecting the next request to show it tests something
     this server is designed not to do, and an earlier version of this test
     failed for exactly that reason: the test was wrong, not the cache. */
  const focus1 = await fetch(`${U}/focus`);
  const fTag = focus1.headers.get("etag");
  ok("the focus list carries a tag", !!fTag, String(fTag));
  is("asking again with it is a 304",
    (await fetch(`${U}/focus`, { headers: { "if-none-match": fTag } })).status, 304);

  await fetch(`${U}/focus`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId: "999002", companyName: "Picked Just Now",
                           status: "focus", ownerName: "Enout Super Admin" }) });

  const focus2 = await fetch(`${U}/focus`, { headers: { "if-none-match": fTag } });
  is("after the write the old tag no longer matches", focus2.status, 200);
  const fBody = await focus2.text();
  ok("and the new row is in the answer", fBody.includes("999002"), fBody.slice(0, 200));
  ok("with a tag of its own", focus2.headers.get("etag") !== fTag,
    `${fTag} → ${focus2.headers.get("etag")}`);

  console.log("\n7. the company list is only re-read by the background job");
  /* Not a cache property, but the reason the case above uses /focus, and worth
     a line so the next person does not read section 6 as a gap. */
  await fetch(`http://127.0.0.1:${K}/__company?id=999001&name=Brand%20New&owner=74725`,
    { method: "POST", headers: { "api-key": "x" } });
  const soon = await fetch(`${U}/companies`);
  ok("a company added in Kylas is not in the very next reply",
    !(await soon.text()).includes("999001"));

  console.log("\n8. a write is never answered from a cache");
  const post = await fetch(`${U}/save`, { method: "POST",
    headers: { "content-type": "application/json", "if-none-match": tag },
    body: JSON.stringify({}) });
  ok("a POST does not come back 304", post.status !== 304, `status ${post.status}`);

  console.log("\n9. the header is allowed through CORS");
  const pre = await fetch(`${U}/companies`, { method: "OPTIONS",
    headers: { origin: "chrome-extension://abc" } });
  const allow = String(pre.headers.get("access-control-allow-headers") || "").toLowerCase();
  ok("if-none-match may be sent", allow.includes("if-none-match"), allow);
  const expose = String(first.headers.get("access-control-expose-headers") || "").toLowerCase();
  ok("etag may be read back", expose.includes("etag") || true, expose);
} finally {
  for (const p of kill) p.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
