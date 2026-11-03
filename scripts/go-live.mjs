#!/usr/bin/env node
/* GOING LIVE ON CLOUDFLARE, IN TWO COMMANDS (2026-11-03).
 *
 * Ayush: "just help me with what I need to execute to make it live." Fifteen
 * steps became these two. Run them from the repo folder on the laptop, signed
 * in with `npx wrangler login` to the account that owns enout-bd-proxy:
 *
 *   node --env-file=.env.local scripts/go-live.mjs
 *       PREPARE. Safe at any time; the console keeps running on Airtable.
 *       Finds or creates the enout-kpi database, binds it in wrangler.toml,
 *       loads db/d1-import.sql (only into an empty database), deploys, and
 *       compares every record and field. Ends READY or NOT READY.
 *
 *   node --env-file=.env.local scripts/go-live.mjs --switch
 *       THE SWITCH, after hours, only after a READY. Sets STORE = "d1",
 *       deploys, then brings over the saves of the last minute (cutover.mjs
 *       --after). Ends SWITCHED.
 *
 *   node --env-file=.env.local scripts/go-live.mjs --rollback
 *       BACK TO AIRTABLE without losing a save: copies everything D1 changed
 *       since the switch into Airtable, removes STORE, deploys.
 *
 * No API token to make: the scripts use the laptop's wrangler login
 * (wrangler-login.mjs). Nothing secret is printed or written; .env.local gets
 * CF_ACCOUNT_ID, KPI_DB_ID and CF_WRANGLER_LOGIN=1 (none of them secret), and
 * STORE=d1 after the switch so the laptop scripts follow the Worker.
 *
 *   --reimport    load db/d1-import.sql even if the database already has data
 *
 * Tests: GO_LIVE_ROOT (a copy of the folder), WRANGLER_CMD (a stub wrangler),
 * GO_LIVE_CUTOVER (a stub cutover script).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wrangler } from "./wrangler-login.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "enout-kpi";

/* ── wrangler.toml and .env.local, edited as text so every comment stays ── */

/* Bind KPI_DB to `id`: uncomment the waiting block (or replace an old id).
   Any other enout-kpi block — e.g. one `d1 create` appended by itself — goes,
   so the binding is declared once. */
export function setKpiDb(toml, id) {
  const block = `[[d1_databases]]\nbinding = "KPI_DB"\ndatabase_name = "${DB_NAME}"\ndatabase_id = "${id}"\n`;
  let placed = false;
  let t = toml.replace(/^\[\[d1_databases\]\]\n(?:[A-Za-z_]+\s*=.*(?:\n|$))*/gm, (b) => {
    if (!new RegExp(`database_name\\s*=\\s*"${DB_NAME}"`).test(b)) return b;
    if (placed) return "";
    placed = true;                       /* the first one is rewritten where it stands */
    return block;
  });
  if (placed) return t;
  const waiting = /^# \[\[d1_databases\]\]\n# binding = "KPI_DB"\n# database_name = "enout-kpi"\n# database_id = ".*"\n?/m;
  if (waiting.test(t)) return t.replace(waiting, block);
  return t.replace(/\n*$/, "\n\n") + block;
}
export const kpiDbOf = (toml) =>
  /^\[\[d1_databases\]\]\nbinding = "KPI_DB"\ndatabase_name = "enout-kpi"\ndatabase_id = "([^"]+)"/m.exec(toml)?.[1] || null;

export const storeOf = (toml) => /^STORE\s*=\s*"([^"]*)"/m.exec(toml)?.[1] || "airtable";
export function setStore(toml, on) {
  const line = /^STORE\s*=.*\n/m;
  if (!on) return toml.replace(line, "");
  if (line.test(toml)) return toml.replace(line, `STORE = "d1"\n`);
  return toml.replace(/^\[vars\]\n/m, `[vars]\nSTORE = "d1"   # scripts/go-live.mjs --switch; --rollback removes it\n`);
}
export const accountOf = (toml) => /^account_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || null;

/* KEY=value lines: set, or remove with null. Every other line stays. */
export function setEnv(text, kv) {
  let t = text;
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*(?:\\n|$)`, "m");
    if (v === null) { t = t.replace(re, ""); continue; }
    if (re.test(t)) t = t.replace(re, `${k}=${v}\n`);
    else t = t.replace(/([^\n])$/, "$1\n") + `${k}=${v}\n`;
  }
  return t;
}

/* The JSON a wrangler --json command printed, past any banner. */
export function jsonOut(s) {
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i < 0 || j < i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

/* ── the run ── */

export async function main({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const ROOT = env.GO_LIVE_ROOT || REPO;
  const P = { toml: join(ROOT, "wrangler.toml"), env: join(ROOT, ".env.local"),
              state: join(ROOT, "db", ".go-live.json"), sql: join(ROOT, "db", "d1-import.sql") };
  const read = (f, d = "") => (existsSync(f) ? readFileSync(f, "utf8") : d);
  const state = () => JSON.parse(read(P.state, "{}") || "{}");
  const saveState = (s) => { mkdirSync(dirname(P.state), { recursive: true }); writeFileSync(P.state, JSON.stringify({ ...state(), ...s }, null, 2) + "\n"); };
  const w = (args, o = {}) => wrangler(args, { env, cwd: ROOT, ...o });
  const stop = (msg) => { log(`\n✗ ${msg}`); return { ok: false, reason: msg }; };
  const step = (n, s) => log(`\n${n}. ${s}`);

  /* The laptop scripts read .env.local themselves; a run without --env-file still works. */
  if (!env.AIRTABLE_PAT && existsSync(P.env)) {
    for (const m of read(P.env).matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
  const toml0 = read(P.toml);
  const ACCOUNT = accountOf(toml0);
  if (!ACCOUNT) return stop("wrangler.toml has no account_id — run this from the repo folder.");

  const loginOk = () => {
    const r = w(["whoami"], { quiet: true });
    if (/not authenticated|wrangler login/i.test(r.out) && !r.out.includes(ACCOUNT)) return "You are not logged in to Cloudflare. Run: npx wrangler login";
    if (!r.out.includes(ACCOUNT))
      return `This Cloudflare login cannot see account ${ACCOUNT}, which runs enout-bd-proxy.\n` +
             `  Run: npx wrangler logout   then   npx wrangler login   with the login that owns enout-bd-proxy.`;
    return null;
  };
  const cutover = (args, extra = {}) => {
    const script = env.GO_LIVE_CUTOVER || join(REPO, "scripts", "cutover.mjs");
    const r = spawnSync(process.execPath, [script, ...args], {
      cwd: ROOT, stdio: "inherit",
      env: { ...env, CF_ACCOUNT_ID: ACCOUNT, KPI_DB_ID: extra.id, CF_WRANGLER_LOGIN: "1" },
    });
    return r.status ?? 1;
  };
  const deploy = () => w(["deploy"]).code === 0;

  /* ─────────────── --rollback ─────────────── */
  if (argv.includes("--rollback")) {
    const s = state(), id = kpiDbOf(toml0), since = s.cut;
    if (!since || !id) return stop("Nothing to roll back: no switch is recorded in db/.go-live.json.");
    step(1, "Cloudflare login"); { const e = loginOk(); if (e) return stop(e); } log("   ok");
    step(2, `Copying everything Cloudflare changed since ${since} back into Airtable`);
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "d1-to-airtable.mjs"), "--since", since, "--apply"],
      { cwd: ROOT, stdio: "inherit", env: { ...env, CF_ACCOUNT_ID: ACCOUNT, KPI_DB_ID: id, CF_WRANGLER_LOGIN: "1" } });
    if (r.status !== 0) return stop("The copy back did not finish — nothing else was changed. Send Claude the output above.");
    step(3, "Back to Airtable: removing STORE and deploying");
    writeFileSync(P.toml, setStore(read(P.toml), false));
    if (!deploy()) { writeFileSync(P.toml, setStore(read(P.toml), true)); return stop("The deploy failed; the console is still on Cloudflare."); }
    writeFileSync(P.env, setEnv(read(P.env), { STORE: null }));
    saveState({ switched: false, rolledBackAt: new Date().toISOString() });
    log(`\n✓ ROLLED BACK. The console reads and writes Airtable again.`);
    return { ok: true, mode: "rollback" };
  }

  /* ─────────────── --switch ─────────────── */
  if (argv.includes("--switch")) {
    const s = state(), id = kpiDbOf(toml0);
    if (!s.ready || !id || s.dbId !== id)
      return stop("Run the prepare step first and get READY:\n  node --env-file=.env.local scripts/go-live.mjs");
    if (storeOf(toml0) === "d1" && s.switched) { log(`Already switched at ${s.cut}. Nothing to do.`); return { ok: true, mode: "switch", already: true }; }
    step(1, "Cloudflare login"); { const e = loginOk(); if (e) return stop(e); } log("   ok");
    step(2, 'Setting STORE = "d1" and deploying');
    const cut = new Date().toISOString();
    writeFileSync(P.toml, setStore(read(P.toml), true));
    if (!deploy()) { writeFileSync(P.toml, setStore(read(P.toml), false)); return stop("The deploy failed. Nothing changed: the console is still on Airtable."); }
    writeFileSync(P.env, setEnv(read(P.env), { STORE: "d1" }));
    saveState({ switched: true, cut });
    step(3, "Bringing over the saves made during the deploy, and comparing again");
    const code = cutover(["--after", "--cut", cut, "--out", join(ROOT, "db", "cutover-after.json")], { id });
    if (code !== 0) {
      log(`\n! The console IS on Cloudflare now, but the last comparison was not clean. Send Claude the output above.`);
      log(`  To go back to Airtable without losing a save:  node --env-file=.env.local scripts/go-live.mjs --rollback`);
      return { ok: false, mode: "switch", cut };
    }
    log(`\n✓ SWITCHED at ${cut}. Every read and write now goes to Cloudflare.`);
    log(`  If anything looks wrong:  node --env-file=.env.local scripts/go-live.mjs --rollback`);
    return { ok: true, mode: "switch", cut };
  }

  /* ─────────────── prepare ─────────────── */
  if (storeOf(toml0) === "d1")
    return stop('wrangler.toml already says STORE = "d1": the switch is done, so nothing is loaded again.');

  step(1, `Cloudflare login (account ${ACCOUNT})`);
  { const e = loginOk(); if (e) return stop(e); }
  log("   ok");

  step(2, `The ${DB_NAME} database`);
  const find = () => {
    const r = w(["d1", "list", "--json"], { quiet: true });
    const list = jsonOut(r.stdout) || jsonOut(r.out);
    if (!Array.isArray(list)) return { err: r.out.trim().split("\n").slice(-3).join("\n") };
    return { id: list.find((d) => d.name === DB_NAME)?.uuid || null };
  };
  let f = find();
  if (f.err) return stop(`Could not list the databases:\n${f.err}`);
  if (f.id) log(`   found: ${f.id}`);
  else {
    const c = w(["d1", "create", DB_NAME, "--location=apac"], { quiet: true });
    f = find();
    if (!f.id) return stop(`Could not create ${DB_NAME}:\n${c.out.trim().split("\n").slice(-4).join("\n")}`);
    log(`   created: ${f.id} (Asia-Pacific)`);
  }
  const id = f.id;

  step(3, "wrangler.toml and .env.local");
  const toml1 = setKpiDb(read(P.toml), id);
  if (toml1 !== read(P.toml)) { writeFileSync(P.toml, toml1); log(`   wrangler.toml: KPI_DB → ${id}`); }
  else log("   wrangler.toml: already bound");
  writeFileSync(P.env, setEnv(read(P.env), { CF_ACCOUNT_ID: ACCOUNT, KPI_DB_ID: id, CF_WRANGLER_LOGIN: "1" }));
  log("   .env.local: CF_ACCOUNT_ID, KPI_DB_ID, CF_WRANGLER_LOGIN=1");

  step(4, "Loading the copy of Airtable");
  const count = w(["d1", "execute", DB_NAME, "--remote", "--json", "--command", "SELECT COUNT(*) AS n FROM shadow_state"], { quiet: true });
  const loaded = Number(jsonOut(count.stdout)?.[0]?.results?.[0]?.n || 0);
  if (loaded && !argv.includes("--reimport")) log("   already loaded — the check below brings it up to date");
  else {
    if (!existsSync(P.sql))
      return stop("db/d1-import.sql is missing. Make it first:\n" +
        "  node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite\n" +
        "  node scripts/sqlite-to-d1.mjs --db db/kpi.sqlite --out db/d1-import.sql");
    if (w(["d1", "execute", DB_NAME, "--remote", "--yes", "--file", P.sql]).code !== 0)
      return stop("Loading db/d1-import.sql failed. Run this again — it only fills what is missing.");
    log("   loaded");
  }

  step(5, "Deploying (the console stays on Airtable; the calendar invites start)");
  if (!deploy()) return stop("The deploy failed — see above. Nothing is live yet; run this again once fixed.");

  step(6, "Comparing every record and field, Airtable vs Cloudflare (a few minutes)");
  const code = cutover(["--check", "--out", join(ROOT, "db", "cutover-check.json")], { id });
  if (code !== 0) {
    saveState({ ready: false, dbId: id, checkedAt: new Date().toISOString() });
    return stop("NOT READY — the differences are listed above. Send Claude that output; nothing is switched.");
  }
  saveState({ ready: true, dbId: id, checkedAt: new Date().toISOString() });
  log(`\n✓ READY. Cloudflare holds exactly what Airtable holds.`);
  log(`  When the team has stopped calling for the day, switch with:`);
  log(`    node --env-file=.env.local scripts/go-live.mjs --switch`);
  log(`  (wrangler.toml now carries database_id ${id} — send Claude that line so it goes into git.)`);
  return { ok: true, mode: "prepare", id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(e.stack || String(e)); process.exit(2); });
}
