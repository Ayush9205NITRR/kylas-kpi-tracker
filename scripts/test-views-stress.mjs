#!/usr/bin/env node
/* NAMED VIEWS, UNDER LOAD AND UNDER ATTACK.
 *
 *   node scripts/test-views-stress.mjs
 *
 * The routes are built HERE, with a callerOf this file controls, because the
 * thing most worth testing is the part no single-user stack can reach: six
 * BDs signed in as themselves, at the same time, on the same views. The local
 * proxy runs every request as the key's owner, so a test driven through it
 * would be one admin talking to himself and would have proved nothing about
 * permissions.
 *
 * What it asserts:
 *   1  identity        ayush@enout.in is admin, the other five are not
 *   2  isolation       a personal view is invisible to everyone but its owner
 *                      and an admin; reading, writing and deleting are 403
 *   3  who may write   a team view takes anybody's edit, but only its owner
 *                      or an admin may delete it
 *   4  concurrency     40+ simultaneous creates, edits, adds and deletes with
 *                      ZERO lost updates — the one that matters, because a
 *                      read-modify-write per view is exactly how a team list
 *                      quietly loses the accounts somebody just added
 *   5  caps            company and name limits hold, and are not off by one
 *   6  hostile input   XSS, control characters, 10k names, empty, duplicates
 *   7  view-contacts   scale, the unworked-account fallback, and permissions
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createHandlers } from "./handlers.mjs";
import { fileStore } from "./store.mjs";
import { VIEW_LIMITS } from "./views.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const JOURNAL = new URL(`../.views-stress-${process.pid}.json`, import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

/* ── the team ──────────────────────────────────────────────────────────── */
const ADMIN = "ayush@enout.in";
const BDS = ["anjali@enout.in", "bhaumik@enout.in", "mayra@enout.in", "sejal@enout.in", "gurnoor@enout.in"];
let CALLER = { email: ADMIN, name: "Ayush Tiwari" };
const as = (email) => { CALLER = { email, name: email.split("@")[0] }; };

const procs = [];
const start = (file, env = {}) => procs.push(spawn("node", [file], {
  cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" }));
const wait = async (url) => { for (let i = 0; i < 80; i++) { try { await fetch(url); return; } catch { await sleep(300); } } throw new Error(`${url} never came up`); };

let routes;
/* The routes take (url, body); a GET is an empty object in both runtimes. */
const call = (path, body) => {
  const u = new URL(`http://x${path}`);
  return routes[u.pathname](u, body || {});
};
const fails = async (path, body) => {
  try { await call(path, body); return null; } catch (e) { return { status: e.status || 500, message: e.message }; }
};

try {
  start("scripts/mock-kylas.mjs", { PORT: "9910", MOCK_USER_LIST: "1", MOCK_MANY: "60" });
  await wait("http://127.0.0.1:9910/__writes");
  start("scripts/mock-airtable.mjs", { PORT: "9911" });
  await wait("http://127.0.0.1:9911/v0/appMOCK/Companies");

  rmSync(JOURNAL, { force: true });
  ({ routes } = await createHandlers({
    env: { KYLAS_BASE: "http://127.0.0.1:9910", KYLAS_KEY: "x",
           AIRTABLE_BASE_URL: "http://127.0.0.1:9911", AIRTABLE_PAT: "pat_mock",
           AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH",
           /* Only Ayush is an admin. Without this every caller is one, and
              every permission assertion below would pass for the wrong reason. */
           ADMIN_EMAILS: ADMIN, VERSION: "test" },
    store: fileStore(JOURNAL, { log: () => {} }),
    log: () => {},
    callerOf: () => ({ email: CALLER.email, name: CALLER.name }),
  }));

  /* ── 1 · who is who ─────────────────────────────────────────────────── */
  console.log("\n1 · identity");
  as(ADMIN);
  const meA = (await call("/views")).me;
  ok("ayush@enout.in is an admin", meA.admin === true && meA.email === ADMIN, JSON.stringify(meA));
  as(BDS[0]);
  const meB = (await call("/views")).me;
  ok("a BD is not", meB.admin === false && meB.email === BDS[0], JSON.stringify(meB));

  /* ── 2 · personal views are personal ────────────────────────────────── */
  console.log("\n2 · personal vs shared");
  as(BDS[0]);
  const mine = (await call("/views", { name: "Anjali's shortlist", visibility: "personal",
    companies: ["903", "1776620"] })).view;
  ok("a BD can create a personal view", !!mine.id && mine.visibility === "personal" && mine.count === 2);
  const team = (await call("/views", { name: "Team GPTW", visibility: "team", companies: ["903"] })).view;
  ok("...and a shared one", team.visibility === "team");

  as(BDS[1]);
  const seen = (await call("/views")).views.map((v) => v.name);
  ok("another BD sees the shared view", seen.includes("Team GPTW"), seen.join(" | "));
  ok("...and NOT the personal one", !seen.includes("Anjali's shortlist"), seen.join(" | "));
  ok("reading its contacts is refused", (await fails(`/view-contacts?id=${mine.id}`))?.status === 403);
  ok("editing it is refused", (await fails("/views", { id: mine.id, name: "Mine now" }))?.status === 403);
  ok("adding accounts to it is refused", (await fails("/views/companies", { id: mine.id, add: ["7"] }))?.status === 403);
  ok("deleting it is refused", (await fails("/views/delete", { id: mine.id }))?.status === 403);

  as(ADMIN);
  const adminSees = (await call("/views")).views.map((v) => v.name);
  ok("an admin sees everybody's, personal included", adminSees.includes("Anjali's shortlist"), adminSees.join(" | "));

  /* ── 3 · a team view is the team's, but deleting is not ─────────────── */
  console.log("\n3 · who may change a shared view");
  as(BDS[1]);
  const edited = (await call("/views", { id: team.id, description: "edited by bhaumik" })).view;
  ok("any BD may edit a shared view", edited.description === "edited by bhaumik");
  ok("...and add accounts to it",
     (await call("/views/companies", { id: team.id, add: ["1776620"] })).view.count === 2);
  ok("but NOT delete somebody else's", (await fails("/views/delete", { id: team.id }))?.status === 403);
  as(ADMIN);
  ok("an admin may delete it", (await call("/views/delete", { id: team.id })).deleted === team.id);
  ok("...and deleting a view that is gone is not an error", (await call("/views/delete", { id: team.id })).gone === true);

  /* ── 4 · the one that matters: no lost updates ──────────────────────── */
  console.log("\n4 · 40+ at once, nothing lost");
  as(ADMIN);
  const shared = (await call("/views", { name: "Everyone adds here", visibility: "team", companies: [] })).view;
  /* Six BDs, each adding eight different accounts to ONE view, all at once.
     A read-modify-write that is not serialised loses most of these. */
  const adds = [];
  for (let i = 0; i < 48; i++) {
    const who = BDS[i % BDS.length];
    adds.push(async () => { as(who); return call("/views/companies", { id: shared.id, add: [String(600000 + i)] }); });
  }
  await Promise.all(adds.map((f) => f().catch((e) => ({ error: e.message }))));
  as(ADMIN);
  const after = (await call("/views")).views.find((v) => v.id === shared.id);
  ok(`all 48 concurrent adds landed (${after.count}/48)`, after.count === 48,
     `missing ${48 - after.count}`);

  /* 40 BDs creating their own view at the same moment: one key each, so
     nobody's save can tread on anybody else's. */
  const before = (await call("/views")).views.length;
  await Promise.all(Array.from({ length: 40 }, (_, i) => (async () => {
    as(BDS[i % BDS.length]);
    return call("/views", { name: `Concurrent ${i}`, visibility: i % 2 ? "team" : "personal", companies: ["903"] });
  })().catch((e) => ({ error: e.message }))));
  as(ADMIN);
  const nowAll = (await call("/views")).views;
  const made = nowAll.filter((v) => /^Concurrent \d+$/.test(v.name));
  ok("40 simultaneous creates all survive", made.length === 40, `${made.length} of 40`);
  ok("...each with its own id", new Set(made.map((v) => v.id)).size === 40);
  ok("...and the ones that were there are untouched", nowAll.length >= before + 40);

  /* Adds and removes crossing each other must not resurrect or drop. */
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => call("/views/companies", { id: shared.id, add: [String(700000 + i)] })),
    ...Array.from({ length: 10 }, (_, i) => call("/views/companies", { id: shared.id, remove: [String(600000 + i)] })),
  ].map((p) => p.catch(() => null)));
  const mixed = (await call("/views")).views.find((v) => v.id === shared.id);
  ok("adds and removes at once leave exactly the right set", mixed.count === 48 - 10 + 10, `${mixed.count}`);

  /* Deleting a view while somebody is writing to it must not revive it. */
  const doomed = (await call("/views", { name: "Doomed", visibility: "team", companies: ["903"] })).view;
  await Promise.all([
    call("/views/delete", { id: doomed.id }).catch(() => null),
    ...Array.from({ length: 8 }, (_, i) => call("/views/companies", { id: doomed.id, add: [String(800000 + i)] }).catch(() => null)),
  ]);
  const ghost = (await call("/views")).views.find((v) => v.id === doomed.id);
  ok("a view deleted mid-write stays deleted", !ghost, ghost ? `came back with ${ghost.count}` : "");

  /* ── 5 · caps ───────────────────────────────────────────────────────── */
  console.log("\n5 · limits");
  const big = Array.from({ length: VIEW_LIMITS.companies + 50 }, (_, i) => String(900000 + i));
  ok(`more than ${VIEW_LIMITS.companies} accounts is refused`,
     (await fails("/views", { name: "Too big", companies: big }))?.status === 400);
  const atCap = (await call("/views", { name: "At the cap", companies: big.slice(0, VIEW_LIMITS.companies) })).view;
  ok("...and exactly the cap is fine", atCap.count === VIEW_LIMITS.companies, String(atCap.count));
  const over = await call("/views/companies", { id: atCap.id, add: ["999999999"] });
  ok("adding past the cap does not grow it", over.view.count === VIEW_LIMITS.companies, String(over.view.count));
  const longName = (await call("/views", { name: "N".repeat(500) })).view;
  ok(`a ${500}-character name is cut to ${VIEW_LIMITS.name}`, longName.name.length === VIEW_LIMITS.name, String(longName.name.length));

  /* ── 6 · hostile and empty input ────────────────────────────────────── */
  console.log("\n6 · bad input");
  for (const [what, name] of [["empty", ""], ["spaces", "    "], ["one letter", "x"],
                              ["a tab and a newline", "\t\n"]]) {
    ok(`${what} is refused`, (await fails("/views", { name }))?.status === 400);
  }
  const xss = (await call("/views", { name: `<img src=x onerror="alert(1)">`, description: `</script><script>alert(2)</script>` })).view;
  ok("a script tag is stored as text, not run anywhere", xss.name.includes("<img"), xss.name);
  ok("...and control characters are stripped",
     !/[\u0000-\u001F]/.test((await call("/views", { name: "a\u0000b\u0007c" })).view.name));
  const dupes = (await call("/views", { name: "Dupes", companies: ["903", "903", "903", "bad", "", null, "1776620"] })).view;
  ok("duplicate and junk company ids are dropped", dupes.count === 2, JSON.stringify(dupes.companies));
  ok("a bad visibility is refused", (await fails("/views", { name: "Bad vis", visibility: "everyone" }))?.status === 400);
  ok("a bad scope is refused", (await fails("/views", { name: "Bad scope", scope: "sideways" }))?.status === 400);
  ok("editing a view that does not exist is a 404", (await fails("/views", { id: "nope", name: "x" }))?.status === 404);
  ok("adding to a view that does not exist is a 404", (await fails("/views/companies", { id: "nope", add: ["1"] }))?.status === 404);

  /* Duplicating must copy, never move — the bug this caught the first time. */
  const orig = (await call("/views", { name: "Keep me", visibility: "team", companies: ["903"] })).view;
  const copy = (await call("/views", { id: orig.id, action: "duplicate" })).view;
  const both = (await call("/views")).views;
  ok("duplicate leaves the original alone", both.some((v) => v.id === orig.id && v.name === "Keep me"),
     both.filter((v) => v.name.startsWith("Keep me")).map((v) => `${v.id}:${v.name}`).join(" | "));
  ok("...and the copy is its own view", copy.id !== orig.id && copy.name === "Keep me (copy)", `${copy.id} ${copy.name}`);
  const copy2 = (await call("/views", { id: orig.id, action: "duplicate" })).view;
  ok("...twice gives two names, not one", copy2.name === "Keep me (copy 2)", copy2.name);

  /* Pins are per person. */
  as(BDS[2]);
  await call("/views", { id: orig.id, action: "pin" });
  ok("a pin is the pinner's own", (await call("/views")).views.find((v) => v.id === orig.id)?.pinned === true);
  as(BDS[3]);
  ok("...and nobody else's", (await call("/views")).views.find((v) => v.id === orig.id)?.pinned === false);

  /* ── 7 · the contacts half ──────────────────────────────────────────── */
  console.log("\n7 · view-contacts");
  as(ADMIN);
  const real = (await call("/views", { name: "Real accounts", visibility: "team",
    companies: ["903", "1776620"] })).view;
  const vc = await call(`/view-contacts?id=${real.id}`);
  ok("returns the people at the view's accounts", vc.contacts.length >= 2, `${vc.contacts.length}`);
  ok("...each with a name and a company", vc.contacts.every((c) => c.pocName !== undefined && c.companyId));
  ok("...and says which view it answered for", vc.view?.id === real.id);
  const wide = (await call("/views", { name: "Wide", visibility: "team",
    companies: Array.from({ length: 500 }, (_, i) => String(910000 + i)) })).view;
  const vw = await call(`/view-contacts?id=${wide.id}&cap=50`);
  ok("a big view is capped and says so", vw.companies === 50 && vw.truncated === true && vw.asked === 500,
     JSON.stringify({ c: vw.companies, t: vw.truncated, a: vw.asked }));
  ok("an empty view answers empty, not an error", (await call(`/view-contacts?id=${
    (await call("/views", { name: "Nothing in it" })).view.id}`)).contacts.length === 0);
  ok("a view that does not exist is a 404", (await fails("/view-contacts?id=nope"))?.status === 404);
  as(BDS[4]);
  ok("somebody else's personal view is 403 here too", (await fails(`/view-contacts?id=${mine.id}`))?.status === 403);

  /* ── and the whole lot survived a reload from the store ─────────────── */
  console.log("\n8 · it is really on the server");
  as(ADMIN);
  const countBefore = (await call("/views")).views.length;
  const { routes: fresh } = await createHandlers({
    env: { KYLAS_BASE: "http://127.0.0.1:9910", KYLAS_KEY: "x",
           AIRTABLE_BASE_URL: "http://127.0.0.1:9911", AIRTABLE_PAT: "pat_mock",
           AIRTABLE_BASE: "appMOCK", RESEARCH_BASE: "appRESEARCH", ADMIN_EMAILS: ADMIN, VERSION: "test" },
    store: fileStore(JOURNAL, { log: () => {} }), log: () => {},
    callerOf: () => ({ email: CALLER.email, name: CALLER.name }),
  });
  const u = new URL("http://x/views");
  const reread = await fresh["/views"](u, {});
  ok("a second server reads the same views", reread.views.length === countBefore,
     `${reread.views.length} vs ${countBefore}`);
} catch (e) {
  fail++;
  console.error(`\n! the run itself failed: ${e.stack || e.message}`);
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  rmSync(JOURNAL, { force: true });
  rmSync(new URL(JOURNAL.href + ".tmp"), { force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
