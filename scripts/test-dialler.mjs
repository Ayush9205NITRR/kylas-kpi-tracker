#!/usr/bin/env node
/* THE DIALLER APP'S TALK TIME, FROM KYLAS TO THE DASHBOARD.
 *
 *   node scripts/test-dialler.mjs
 *
 * The Kylas mock serves the two kinds of call log the live account serves
 * (probe, 2026-10-15): the dialler app's — timed, with a device, owned by the
 * associate — and this console's — 0 seconds, owned by the API key's user.
 * Only the first is talk time, and this pins every step of getting it onto
 * the dashboard: the one read Kylas allows, the filter, the idempotent write,
 * the gap check, and the report that sums it without double-counting dials.
 */
import { spawn, spawnSync } from "node:child_process";
import { report } from "./report.mjs";

const KY = 9961, AT = 9962, PROXY = 9963;
const DAY = "2026-10-14";
let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d ? `  — ${d}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: "Bearer x", "content-type": "application/json" };
const kids = [];
process.on("exit", () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }));
const start = (script, env) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
  kids.push(p); return p;
};
/* A 429 means it is up and throttling, which is exactly what the Kylas mock
   does above four a second — polling faster than that never gets an ok and
   reads as "did not start". */
/* Each mock guards its hooks with its own header — the Kylas one wants
   `api-key` and 401s on anything else — and a 429 means it is up and
   throttling, which is what it does above four a second. */
const upFor = async (url, headers = H) => { for (let i = 0; i < 40; i++) {
  try { const r = await fetch(url, { headers }); if (r.ok || r.status === 429) return true; }
  catch { /* not yet */ } await sleep(300); } return false; };

start("scripts/mock-kylas.mjs", { PORT: String(KY), MOCK_DIALLER: "20", MOCK_DIALLER_FROM: `${DAY}T04:00:00.000Z` });
start("scripts/mock-airtable.mjs", { PORT: String(AT) });
if (!await upFor(`http://127.0.0.1:${AT}/__count`)
    || !await upFor(`http://127.0.0.1:${KY}/__writes`, { "api-key": "k" })) {
  console.error("! the mocks did not start"); process.exit(1);
}
await fetch(`http://127.0.0.1:${AT}/__reset`, { headers: H });

const run = (...a) => {
  const r = spawnSync(process.execPath, ["scripts/import-dialler-calls.mjs", ...a], {
    env: { ...process.env, KYLAS_KEY: "k", KYLAS_BASE: `http://127.0.0.1:${KY}`,
           AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK", AIRTABLE_BASE_URL: `http://127.0.0.1:${AT}` },
    encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const tables = async () => (await fetch(`http://127.0.0.1:${AT}/__writes`, { headers: H }).then((r) => r.json())).tables;
const stored = async () => ((await tables())["Dialler Calls"] || []);

console.log("\n1 · the one read Kylas allows, and what it is filtered to");
{
  const dry = run();
  ok("it reads through ?size=, the only shape that pages", /asked for 1000/.test(dry.out), (dry.out.match(/reading the newest[^\n]*/) || [""])[0]);
  /* 40 generated (20 dialler + 20 console) plus the mock's own fixture log. */
  ok("only the timed half is talk time", /2\d of 4\d carry a duration/.test(dry.out),
     (dry.out.match(/\d+ of \d+ carry a duration[^\n]*/) || [""])[0]);
  ok("credited to the three associates who dialled",
     /Muskan Rajpoot/.test(dry.out) && /Aditi saini/.test(dry.out) && /Arshdeep Singh/.test(dry.out),
     (dry.out.match(/Muskan Rajpoot[^\n]*/) || [""])[0]);
  /* The key's user owns the 20 console saves in this fixture AND one older
     log the mock has always carried, which does have a duration. So it may
     appear — but for that one log only, never for the 20 saves. */
  ok("...and the API key's user only for the one fixture log, never the 20 saves",
     ((dry.out.match(/Enout Super Admin\s+(\d+) call/) || [])[1] || "0") === "1",
     (dry.out.match(/Enout Super Admin[^\n]*/) || ["(absent)"])[0]);
  ok("a dry run writes nothing", (await stored()).length === 0 && /Nothing was written/.test(dry.out));
}

console.log("\n2 · the write, and re-running it");
{
  const a = run("--apply");
  const rows = await stored();
  /* The 20 the generator placed, by their own ids. */
  const mine = rows.filter((r) => /^459000\d\d$/.test(String(r.fields.Key)));
  ok("every dialler call is stored", mine.length === 20, `${mine.length} of ${rows.length} rows`);
  ok("...with the duration Kylas measured", mine.every((r) => Number(r.fields.Duration) > 0));
  /* 20 calls of 40 + (i%5)*23 seconds: four each of 40, 63, 86, 109, 132. */
  ok("...summing to the 1,720 seconds Kylas reported",
     mine.reduce((n, r) => n + Number(r.fields.Duration), 0) === 1720,
     `${mine.reduce((n, r) => n + Number(r.fields.Duration), 0)}s`);
  ok("...the associate as owner", mine.every((r) => /Muskan|Aditi|Arshdeep/.test(String(r.fields.Owner))));
  ok("...and the contact it was about", mine.every((r) => /^53\d+$/.test(String(r.fields["Contact Kylas ID"]))));
  ok("it says what it imported", /imported \d+ dialler call\(s\), \d+m\d+s/.test(a.out), (a.out.match(/imported[^\n]*/) || [""])[0]);
  const before = rows.length;
  const again = run("--apply");
  ok("re-running the same window adds nothing", (await stored()).length === before, `${(await stored()).length} vs ${before}`);
  ok("...and says none were new", /0 not yet stored/.test(again.out), (again.out.match(/in hand[^\n]*/) || [""])[0]);
}

console.log("\n3 · the gap the read cannot close is reported, not hidden");
{
  /* The whole window is already stored, so the oldest log read is older than
     the newest row held — the windows overlap and nothing was missed. */
  const quiet = run();
  ok("no gap while the windows overlap", !/GAP/.test(quiet.out));
  /* Now the opposite: wipe the table and leave ONE row from days earlier. The
     oldest log Kylas will serve is then newer than everything stored, so the
     calls in between were never read and never can be. */
  /* Let the Airtable mock's limiter drain first: it 429s above five a second,
     and a throttled read of the table leaves the importer with nothing to
     compare against, which reads as "no gap" and made this flaky. */
  await sleep(1500);
  await fetch(`http://127.0.0.1:${AT}/__reset`, { headers: H });
  await fetch(`http://127.0.0.1:${AT}/v0/appMOCK/Dialler%20Calls`, { method: "POST", headers: H,
    body: JSON.stringify({ records: [{ fields: { Key: "older-1", "Called At": "2026-10-10T09:00:00.000Z",
                                                 Owner: "Muskan Rajpoot", Duration: 60 } }], typecast: true }) });
  /* --size 5 makes the window genuinely "the newest five", the way size=1000
     is against an account of 8,655. Without it the mock's own fixture log —
     older than everything — is always served and the window never starts late. */
  const gap = run("--size", "5");
  ok("a gap is called out loudly", /! GAP/.test(gap.out), (gap.out.match(/! GAP[\s\S]{0,70}/) || [""])[0].replace(/\n/g, " "));
  ok("...and says what to do about it", /Run this more often/.test(gap.out));
  /* Put the table back for the end-to-end read below. */
  run("--apply");
}

console.log("\n4 · the dashboard sums it without double-counting dials");
{
  /* Two console saves (the dials) and two dialler calls for the same work. */
  const r = report("day", {
    calls: [{ at: `${DAY}T09:00:00Z`, owner: "Muskan Rajpoot", stage: "FOLLOW_UP_1" },
            { at: `${DAY}T09:30:00Z`, owner: "Muskan Rajpoot", stage: "CNC_COULD_NOT_CONNECT" }],
    dialler: [{ at: `${DAY}T08:59:00Z`, owner: "Muskan Rajpoot", secs: 71 },
              { at: `${DAY}T09:29:00Z`, owner: "Muskan Rajpoot", secs: 47 }],
  }, { from: DAY, to: DAY });
  const d = r.periods[0];
  ok("Calls dialled counts the saves only", d.calls === 2, `${d.calls}`);
  ok("Connected still comes from the stage", d.connects === 1, `${d.connects}`);
  ok("talk time is the dialler's seconds", d.talkSeconds === 118, `${d.talkSeconds}`);
  ok("...covering 2 of the 2 calls", d.timedCalls === 2, `${d.timedCalls}`);
  ok("per owner too", (r.byOwner || []).find((o) => o.owner === "Muskan Rajpoot")?.talkSeconds === 118);
  /* A dialler row outside the window must not leak in. */
  const out = report("day", { calls: [{ at: `${DAY}T09:00:00Z`, owner: "A" }],
                              dialler: [{ at: "2026-09-01T09:00:00Z", owner: "A", secs: 600 }] },
                     { from: DAY, to: DAY });
  ok("a call outside the window is not counted", out.periods[0].talkSeconds === 0, `${out.periods[0].talkSeconds}`);
}

console.log("\n5 · end to end, through the proxy the console talks to");
{
  start("scripts/proxy.mjs", { PORT: String(PROXY), KYLAS_BASE: `http://127.0.0.1:${KY}`, KYLAS_KEY: "k",
    AIRTABLE_BASE_URL: `http://127.0.0.1:${AT}`, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK" });
  if (!await upFor(`http://127.0.0.1:${PROXY}/health`)) { ok("the proxy came up", false); }
  else {
    /* owner=all: the report scopes to the signed-in person by default, and
       these calls belong to Muskan, Aditi and Arshdeep — not to the key's
       user. That is the right behaviour, and the reason to ask for the team. */
    const rep = await fetch(`http://127.0.0.1:${PROXY}/report?period=day&from=${DAY}&to=${DAY}&owner=all&fresh=1`)
      .then((r) => r.json()).catch((e) => ({ error: e.message }));
    const cur = rep.current || (rep.periods || [])[0] || {};
    ok("/report serves the imported talk time", Number(cur.talkSeconds) === 1720,
       `talkSeconds ${cur.talkSeconds}, timedCalls ${cur.timedCalls}`);
    ok("...and counts the calls it covers", Number(cur.timedCalls) === 20, `${cur.timedCalls}`);
    const per = (rep.currentByOwner || []).filter((o) => /Muskan|Aditi|Arshdeep/.test(o.owner));
    ok("...split across the three who dialled", per.length === 3,
       JSON.stringify(per.map((o) => [o.owner, o.talkSeconds])));
    ok("...and their seconds add back up", per.reduce((n, o) => n + o.talkSeconds, 0) === 1720);
    ok("...and the report says the table is in use", rep.dialler?.state === "ok",
       JSON.stringify(rep.dialler));
  }
}

console.log("\n6 · a base with no talk time says WHY, and says the right why");
{
  /* Ayush, 2026-10-15: "Talk time is not getting mapped." The dashboard read
     `not timed` against every associate on a base whose Dialler Calls table
     had never been created — which reads as "nobody dialled" rather than
     "nothing has been imported", and sends somebody to look at the team
     instead of at the setup. The route has to tell the two apart. */
  const AT2 = 9964, PROXY2 = 9965;
  start("scripts/mock-airtable.mjs", { PORT: String(AT2), MOCK_AIRTABLE_404: "Dialler Calls" });
  if (!await upFor(`http://127.0.0.1:${AT2}/__count`)) { ok("the second Airtable mock came up", false); }
  else {
    start("scripts/proxy.mjs", { PORT: String(PROXY2), KYLAS_BASE: `http://127.0.0.1:${KY}`, KYLAS_KEY: "k",
      AIRTABLE_BASE_URL: `http://127.0.0.1:${AT2}`, AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK" });
    if (!await upFor(`http://127.0.0.1:${PROXY2}/health`)) { ok("the second proxy came up", false); }
    else {
      const gone = await fetch(`http://127.0.0.1:${PROXY2}/report?period=day&from=${DAY}&to=${DAY}&owner=all&fresh=1`)
        .then((r) => r.json()).catch((e) => ({ error: e.message }));
      ok("a base with no Dialler Calls table reports it missing", gone.dialler?.state === "missing",
         JSON.stringify(gone.dialler));
      ok("...and still serves the rest of the report", !gone.error && Array.isArray(gone.periods),
         gone.error || `${(gone.periods || []).length} period(s)`);
    }
  }
  /* And the third state: the table is there, and simply has nothing in it yet.
     Last, because it wipes the rows every section above reads. */
  await sleep(1500);
  await fetch(`http://127.0.0.1:${AT}/__reset`, { headers: H });
  const bare = await fetch(`http://127.0.0.1:${PROXY}/report?period=day&from=${DAY}&to=${DAY}&owner=all&fresh=1`)
    .then((r) => r.json()).catch((e) => ({ error: e.message }));
  ok("an empty table reports empty, not missing", bare.dialler?.state === "empty",
     JSON.stringify(bare.dialler));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
