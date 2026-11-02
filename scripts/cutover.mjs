#!/usr/bin/env node
/* THE SWITCH, MADE SAFE: one command before it and one after it.
 *
 *   node --env-file=.env.local scripts/cutover.mjs --check
 *       Before the switch, while Airtable is still live. Copies everything
 *       Airtable changed since the last pull into D1, then compares every
 *       record and every field (parity-live.mjs). Ends READY or NOT READY.
 *
 *   node --env-file=.env.local scripts/cutover.mjs --after --cut <ISO time of the deploy>
 *       Right after `wrangler deploy` with STORE = "d1". Copies the saves that
 *       reached Airtable in the last minute before the deploy — but NEVER over
 *       a row D1 has already changed since the cut, because that one is newer.
 *       Then compares again, counting rows written after the cut as expected.
 *       Prints the rollback command with the cut time filled in.
 *
 *   … --out cutover.json    the result, for cutover-report.mjs
 *
 * Needs, in .env.local: AIRTABLE_PAT, AIRTABLE_BASE (read only from here on),
 * and the D1 to fill — CF_ACCOUNT_ID + CF_API_TOKEN + KPI_DB_ID, or
 * D1_SQLITE=<file> for a dry run against a local copy.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { createAirtable, nodeD1 } from "./airtable.mjs";
import { createShadow } from "./shadow.mjs";
import { BACKFILL_ORDER } from "./sql-store.mjs";
import { run as parity } from "./parity-live.mjs";

export async function run({ env = process.env, log = console.log, after = false, cut = null,
                            d1 = undefined, airtable = null } = {}) {
  if (after && !Number.isFinite(Date.parse(cut || ""))) throw new Error("--after needs --cut <ISO time of the deploy>.");
  const db = d1 ?? nodeD1();
  const at = airtable || createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {}, d1: null,
    ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  const shadow = createShadow({ db, at, log, keepNewerThan: after ? cut : null });

  /* 1 · the last changes from Airtable, table by table, until nothing is left */
  log(`${after ? "Final pull (rows D1 changed since the cut are kept)" : "Pull"} — Airtable → Cloudflare`);
  const pulled = {};
  await shadow.init();                    /* the tables, the views, the watermarks */
  for (const t of BACKFILL_ORDER) {
    let n = 0;
    for (let lap = 0; lap < 50; lap++) {
      const r = await shadow.syncTable(t, { max: Infinity });
      n += r.rows || 0;
      if (!r.more) break;
    }
    pulled[t] = n;
    if (n) log(`  ${t.padEnd(18)} ${n} row(s)`);
  }
  const st = await shadow.status();
  const rejected = (await db.prepare(`SELECT tbl, COUNT(*) n FROM shadow_rejects GROUP BY tbl`).all().catch(() => ({ results: [] })))?.results || [];
  if (rejected.length) log(`! rows Cloudflare refused: ${rejected.map((r) => `${r.tbl} ${r.n}`).join(", ")} — see shadow_rejects`);

  /* 2 · every record, every field */
  log(`\nComparing every record and field…`);
  const p = await parity({ env, log, d1: db, airtable: at, cut: after ? cut : null });

  const ok = p.ok && !rejected.length;
  log(ok
    ? (after ? `\nSWITCHED. Cloudflare holds everything Airtable held, plus what was saved since ${cut}.`
             : `\nREADY. Cloudflare holds exactly what Airtable holds. Set STORE = "d1" in wrangler.toml and deploy.`)
    : `\nNOT READY — see the differences above.${after ? " To go back: the rollback below." : ""}`);
  if (after) {
    log(`\nKeep this. To go back to Airtable without losing a save:`);
    log(`  node --env-file=.env.local scripts/d1-to-airtable.mjs --since ${cut} --apply`);
    log(`  then remove STORE = "d1" from wrangler.toml and: npx wrangler deploy`);
  }
  return { at: new Date().toISOString(), mode: after ? "after" : "check", cut, ok, pulled, rejected, shadow: st, parity: p };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  run({ after: process.argv.includes("--after"), cut: arg("--cut") || null })
    .then((o) => { if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(o, null, 2)); process.exit(o.ok ? 0 : 1); })
    .catch((e) => { console.error(e.message || String(e)); process.exit(2); });
}
