#!/usr/bin/env node
/* go-live.mjs, with a stub wrangler and a stub cutover, in a copy of the folder.
 *
 *   node scripts/test-go-live.mjs
 *
 * Checks the order of things, that wrangler.toml is edited exactly and only
 * once, that a re-run reuses the database and does not reload it, that a wrong
 * login stops before anything is written, that --switch needs a READY first,
 * that a failed deploy undoes the switch, and that no token is ever printed.
 */
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, setKpiDb, kpiDbOf, setStore, storeOf, setEnv } from "./go-live.mjs";
import { readLogin } from "./wrangler-login.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${String(d).slice(0, 300)}`}`); };

const REPO = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "go-live-"));
const ROOT = join(dir, "repo");
mkdirSync(join(ROOT, "db"), { recursive: true });
copyFileSync(join(REPO, "wrangler.toml"), join(ROOT, "wrangler.toml"));
writeFileSync(join(ROOT, ".env.local"), "AIRTABLE_PAT=patSECRET\nAIRTABLE_BASE=appX");
writeFileSync(join(ROOT, "db", "d1-import.sql"), "SELECT 1;");
const ORIGINAL = readFileSync(join(ROOT, "wrangler.toml"), "utf8");

/* the stub wrangler: answers from a JSON world, logs every call */
const world = join(dir, "world.json"), calls = join(dir, "calls.log");
const W = (o) => writeFileSync(world, JSON.stringify(o));
writeFileSync(join(dir, "wrangler.mjs"), `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const w = JSON.parse(readFileSync(${JSON.stringify(world)}, "utf8"));
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
const save = () => writeFileSync(${JSON.stringify(world)}, JSON.stringify(w));
if (a[0] === "whoami") console.log("Account Name | Account ID\\n Enout | " + w.account);
else if (a[0] === "d1" && a[1] === "list") console.log("🌀 banner\\n" + JSON.stringify(w.dbs));
else if (a[0] === "d1" && a[1] === "create") { w.dbs.push({ uuid: "11111111-2222-3333-4444-555555555555", name: a[2] }); save(); console.log('database_id = "11111111-2222-3333-4444-555555555555"'); }
else if (a[0] === "d1" && a[1] === "execute" && a.includes("--command")) console.log(JSON.stringify([{ results: [{ n: w.loaded ? 7 : 0 }], success: true }]));
else if (a[0] === "d1" && a[1] === "execute") { w.loaded = true; save(); }
else if (a[0] === "deploy") { if (w.deployFails) process.exit(1); w.deploys = (w.deploys || 0) + 1; save(); }
`);
const cut = join(dir, "cutover.mjs");
writeFileSync(cut, `appendFileSync(${JSON.stringify(calls)}, "CUTOVER " + process.argv.slice(2).join(" ") + " acct=" + process.env.CF_ACCOUNT_ID + " db=" + process.env.KPI_DB_ID + " login=" + process.env.CF_WRANGLER_LOGIN + "\\n");
import { appendFileSync } from "node:fs";
console.log(process.env.STUB_READY === "0" ? "NOT READY" : "READY");
process.exit(process.env.STUB_READY === "0" ? 1 : 0);`);

const ACCOUNT = "5a73b76e8a1e4266f40291216c664ed4";
let out = [];
const go = async (argv = [], extra = {}) => {
  out = [];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GO_LIVE_ROOT: ROOT, WRANGLER_CMD: `${process.execPath} ${join(dir, "wrangler.mjs")}`,
    GO_LIVE_CUTOVER: cut, GO_LIVE_UNPAUSE: "1", ...extra };
  return main({ argv, env, log: (s) => out.push(s) });
};
const toml = () => readFileSync(join(ROOT, "wrangler.toml"), "utf8");
const envl = () => readFileSync(join(ROOT, ".env.local"), "utf8");
const log = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);

console.log("\n1. the text edits");
const once = setKpiDb(ORIGINAL, "abc");
ok("the waiting KPI_DB block is uncommented with the id", kpiDbOf(once) === "abc" && !/# database_id = "<from/.test(once));
ok("binding it twice changes nothing", setKpiDb(once, "abc") === once);
ok("a new id replaces the old one, still one block", kpiDbOf(setKpiDb(once, "def")) === "def" && setKpiDb(once, "def").split('database_name = "enout-kpi"').length === 2);
const appended = once + '\n[[d1_databases]]\nbinding = "enout_kpi"\ndatabase_name = "enout-kpi"\ndatabase_id = "abc"\n';
ok("a block `d1 create` appended by itself is folded into ours", setKpiDb(appended, "abc").split('database_name = "enout-kpi"').length === 2);
ok("the read mirror's binding is untouched", /database_name = "enout-bd"/.test(setKpiDb(appended, "abc")));
ok('STORE goes under [vars] and comes back out exactly', storeOf(setStore(once, true)) === "d1" && setStore(setStore(once, true), false) === once);
ok("only the three lines in .env.local change", setEnv("A=1\nCF_ACCOUNT_ID=old\n", { CF_ACCOUNT_ID: "new", KPI_DB_ID: "x" }) === "A=1\nCF_ACCOUNT_ID=new\nKPI_DB_ID=x\n");

console.log("\n2. a wrong login stops before anything is written");
W({ account: "894575eed7b23cfb05288e31e0293c37", dbs: [] });
let r = await go();
ok("it stops, and says which login to use", !r.ok && /cannot see account 5a73b76e/.test(out.join("\n")), out.join(" | "));
ok("wrangler.toml untouched, no database made", toml() === ORIGINAL && !log().some((l) => /create|deploy|execute/.test(l)), log());

console.log("\n3. prepare");
rmSync(calls, { force: true });
W({ account: ACCOUNT, dbs: [{ uuid: "old-wrong", name: "enout-bd" }] });
r = await go();
const L = log();
const idx = (re) => L.findIndex((l) => re.test(l));
ok("it ends READY", r.ok && /READY/.test(out.join("\n")), out.join(" | "));
ok("in order: login, list, create, load, deploy, check",
  [/^whoami/, /^d1 create enout-kpi --location=apac/, /^d1 execute enout-kpi --remote --yes --file/, /^deploy/, /^CUTOVER --check/].map(idx)
    .every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), L.join(" / "));
ok("wrangler.toml now binds the new database", kpiDbOf(toml()) === "11111111-2222-3333-4444-555555555555");
ok(".env.local has the three settings and kept the rest",
  /CF_ACCOUNT_ID=5a73b76e/.test(envl()) && /KPI_DB_ID=11111111/.test(envl()) && /CF_WRANGLER_LOGIN=1/.test(envl()) && /AIRTABLE_PAT=patSECRET/.test(envl()));
ok("the check runs on the wrangler login, against that account and database",
  L.some((l) => /^CUTOVER --check .*acct=5a73b76e\S+ db=11111111\S+ login=1/.test(l)), L.at(-1));
ok("no secret is printed", !out.join("\n").includes("patSECRET"));

console.log("\n4. a re-run");
rmSync(calls, { force: true });
r = await go();
ok("reuses the database and does not reload it", r.ok && !log().some((l) => /create|--file/.test(l)) && /already loaded/.test(out.join("\n")), log().join(" / "));
ok("wrangler.toml unchanged by the re-run", toml().split('database_name = "enout-kpi"').length === 2);

console.log("\n5. NOT READY blocks the switch");
r = await go([], { STUB_READY: "0" });
ok("prepare says NOT READY", !r.ok && /NOT READY/.test(out.join("\n")));
r = await go(["--switch"]);
ok("--switch refuses without a READY", !r.ok && storeOf(toml()) === "airtable", out.join(" | "));

console.log("\n6. the switch");
await go();
W({ ...JSON.parse(readFileSync(world, "utf8")), deployFails: true });
r = await go(["--switch"]);
ok("a failed deploy leaves STORE off", !r.ok && storeOf(toml()) === "airtable" && !/^STORE=/m.test(envl()), out.join(" | "));
W({ ...JSON.parse(readFileSync(world, "utf8")), deployFails: false });
rmSync(calls, { force: true });
r = await go(["--switch"]);
ok("SWITCHED", r.ok && /SWITCHED/.test(out.join("\n")), out.join(" | "));
ok('wrangler.toml says STORE = "d1"; .env.local says STORE=d1', storeOf(toml()) === "d1" && /^STORE=d1$/m.test(envl()));
ok("deploy, then cutover --after with the cut time", /^deploy/.test(log()[1] || "") && new RegExp(`^CUTOVER --after --cut ${r.cut.replace(/[.]/g, "\\.")}`).test(log()[2] || ""), log().join(" / "));
r = await go();
ok("prepare refuses after the switch (no reload over newer data)", !r.ok && /already says STORE/.test(out.join("\n")));

console.log("\n7. the wrangler login file");
const auth = join(dir, "default.toml");
writeFileSync(auth, `oauth_token = "tokXYZ"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nrefresh_token = "r"\n`);
const lg = readLogin({ WRANGLER_AUTH_FILE: auth });
ok("the token and its expiry are read from wrangler's file", lg?.token === "tokXYZ" && lg.expires > Date.now());
const { wranglerToken } = await import("./wrangler-login.mjs");
writeFileSync(join(dir, "w2.mjs"), `const a = process.argv.slice(2).join(" ");
if (a === "auth token --json") console.log(process.env.NO_AUTH_CMD ? "" : JSON.stringify({ type: "oauth", token: "tokFROMCMD" }));
if (process.env.NO_AUTH_CMD && a === "auth token --json") process.exit(1);`);
ok("the token comes from `wrangler auth token --json`",
  await wranglerToken({ WRANGLER_CMD: `${process.execPath} ${join(dir, "w2.mjs")}`, WRANGLER_AUTH_FILE: auth }) === "tokFROMCMD");

console.log("\n8. an expired login is renewed once, then the query goes through");
const { d1Http } = await import("./d1-node.mjs");
const http = await import("node:http");
let seen = [], tok = "old", refreshes = 0;
const api = http.createServer((q, s) => {
  seen.push(q.headers.authorization);
  if (q.headers.authorization !== "Bearer new") { s.writeHead(401); return s.end(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] })); }
  s.writeHead(200, { "Content-Type": "application/json" }); s.end(JSON.stringify({ success: true, result: [{ results: [{ n: 1 }] }] }));
});
await new Promise((res) => api.listen(0, "127.0.0.1", res));
const db = d1Http({ accountId: "a", databaseId: "d", apiBase: `http://127.0.0.1:${api.address().port}`,
  token: async () => tok, refresh: async () => { refreshes++; tok = "new"; } });
const row = await db.prepare("SELECT 1 AS n").first();
ok("refused once, renewed once, answered", row?.n === 1 && refreshes === 1 && seen.join(",") === "Bearer old,Bearer new", seen.join(","));
tok = "bad"; refreshes = 0;
const db2 = d1Http({ accountId: "a", databaseId: "d", apiBase: `http://127.0.0.1:${api.address().port}`, token: async () => tok, refresh: async () => { refreshes++; } });
ok("a login that stays refused fails plainly, after one renewal", await db2.prepare("SELECT 1").all().then(() => false, (e) => /D1 401/.test(e.message)) && refreshes === 1);
api.close();

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
