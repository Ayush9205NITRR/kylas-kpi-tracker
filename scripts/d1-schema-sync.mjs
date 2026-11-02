/* THE D1 TABLES FOLLOW THE CODE — repair-base.mjs, for Cloudflare.
 *
 * On Airtable, a field added to schema.mjs reaches the base when somebody runs
 * repair-base.mjs, and until then the save drops it (upsertTolerant) and says
 * so. Once D1 is the store there is nobody to run anything, so the store does
 * it itself: the first query of each server start compares a fingerprint of
 * the DDL with the one D1 last applied, and only if they differ:
 *
 *   - creates any table that is missing (CREATE TABLE IF NOT EXISTS)
 *   - adds any column that is missing (ALTER TABLE … ADD COLUMN), which is how
 *     a new field arrives without touching a row that is already there
 *   - rebuilds the views and the indexes
 *
 * Nothing is ever dropped or retyped: a column the code no longer names is
 * left alone, exactly as repair-base.mjs leaves a field it does not know.
 *
 * Cost: three small queries per server start when nothing has changed.
 */
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";

const split = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  .split(";").map((s) => s.trim()).filter(Boolean);

export function fingerprint(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ":" + s.length;
}

/* Every column every table should have, read off the DDL. */
function wantedColumns(ddl) {
  const out = [];
  for (const s of split(ddl).filter((x) => /^CREATE TABLE/i.test(x))) {
    const tbl = /CREATE TABLE IF NOT EXISTS "([^"]+)"/i.exec(s)?.[1];
    for (const line of s.split("\n")) {
      const m = /^\s*,?\s*"([^"]+)"\s+(.+)$/.exec(line);
      if (tbl && m && !/^\s*,?\s*UNIQUE/i.test(line)) out.push(`${tbl}.${m[1]}`);
    }
  }
  return out;
}
async function columnsPresent(db, ddl) {
  try {
    const rows = (await db.prepare(`SELECT m.name AS t, p.name AS c FROM sqlite_master m
      JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table'`).all())?.results || [];
    const have = new Set(rows.map((r) => `${r.t}.${r.c}`));
    return wantedColumns(ddl).every((c) => have.has(c));
  } catch { return false; }
}

export const DDL = () => sqlSchema({ looseSelects: true }) + "\n" + sqlDerived();

export async function ensureSchema(db, { log = () => {} } = {}) {
  const ddl = DDL();
  const want = fingerprint(ddl);
  await db.prepare(`CREATE TABLE IF NOT EXISTS "_schema_version" (k TEXT PRIMARY KEY, v TEXT, at TEXT)`).run().catch(() => {});
  const have = await db.prepare(`SELECT v FROM "_schema_version" WHERE k = 'kpi'`).first().catch(() => null);
  /* The stamp says the views are current; the columns are checked as well, in
     one query, because a stamp is only a claim — a copy imported with an older
     column list must still get the new field before a save needs it. */
  if (have?.v === want && await columnsPresent(db, ddl)) return { changed: false };

  const stmts = split(ddl).filter((s) => !/^PRAGMA/i.test(s));
  const added = [], skipped = [];
  for (const s of stmts.filter((x) => /^CREATE TABLE/i.test(x))) {
    await db.prepare(s).run();
    const tbl = /CREATE TABLE IF NOT EXISTS "([^"]+)"/i.exec(s)?.[1];
    if (!tbl) continue;
    const cols = new Set(((await db.prepare(`PRAGMA table_xinfo("${tbl}")`).all())?.results || []).map((c) => c.name));
    for (const line of s.split("\n")) {
      const m = /^\s*,?\s*"([^"]+)"\s+(.+)$/.exec(line);
      if (!m || cols.has(m[1]) || /^\s*,?\s*UNIQUE/i.test(line)) continue;
      const def = m[2].replace(/,\s*$/, "");
      /* A stored generated column, or a default that is not a constant, cannot
         be added to a table that has rows. Said, not guessed at. */
      if (/GENERATED|PRIMARY KEY|DEFAULT \(/i.test(def)) { skipped.push(`${tbl}.${m[1]}`); continue; }
      await db.prepare(`ALTER TABLE "${tbl}" ADD COLUMN "${m[1]}" ${def}`).run();
      added.push(`${tbl}.${m[1]}`);
    }
  }
  /* Views and indexes in ONE batch, which D1 runs as one transaction: a view
     is dropped and re-created with no moment between where a request running
     alongside could find it missing. The version is stamped in the same one. */
  const rest = stmts.filter((x) => !/^CREATE TABLE/i.test(x)).map((x) => db.prepare(x));
  rest.push(db.prepare(`INSERT INTO "_schema_version" (k, v, at) VALUES ('kpi', ?, ?)
    ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at`).bind(want, new Date().toISOString()));
  if (db.batch) await db.batch(rest); else for (const st of rest) await st.run();
  if (added.length) log(`d1 schema: added ${added.join(", ")}`);
  if (skipped.length) log(`! d1 schema: could not add ${skipped.join(", ")} to a table that has rows — see d1-schema-sync.mjs`);
  return { changed: true, added, skipped };
}
