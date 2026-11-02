/* GATE 2: keeping the SQL copy current, without touching the save path.
 *
 * The obvious way to dual-write is to add a second write to performSave. This
 * does not do that, on purpose.
 *
 * A save already writes five Airtable tables and an associate waits on it.
 * Hanging anything else off it — even something wrapped so it cannot throw —
 * means the busiest, most-tested path in the system grows a branch for the
 * benefit of a database nobody reads yet. And it would have to be unpicked
 * again at Gate 4.
 *
 * So the copy is kept current by PULLING, on the cron that already runs every
 * minute. Airtable knows when each row last changed; this asks for the ones
 * that changed since it last looked and upserts them. The save path does not
 * know this exists.
 *
 * What that costs: the copy trails the base by up to a minute. For something
 * no screen reads, that is not a cost at all — and it is the same mechanism,
 * and the same watermark-with-slack, that the read mirror has used in
 * production since 1.14.
 *
 * INERT UNLESS TURNED ON. No binding, no shadow: createShadow returns null and
 * every call site skips. Deploying this changes nothing until a D1 database is
 * bound as KPI_DB.
 */
import { sqlSchema, tableName } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";
import { BACKFILL_ORDER, recordToRow, upsertSql, LINKS_BY_TABLE } from "./sql-store.mjs";
import { listTolerant } from "./airtable.mjs";

/* Airtable's LAST_MODIFIED_TIME is not instantaneous and two clocks are
   involved, so each pass starts this far before the last one ended. Rows seen
   twice are upserts and harmless; a row missed is not. The same two minutes
   the mirror uses. */
const SLACK_MS = 2 * 60 * 1000;

export function createShadow({ db, at, log = () => {} }) {
  if (!db || !at) return null;

  let ready = null;
  const init = () => (ready ||= (async () => {
    /* CREATE TABLE IF NOT EXISTS throughout, and the views are dropped and
       recreated — so this is safe on every cold start, and a copy can never be
       left holding an older build's view definitions. */
    for (const stmt of splitStatements(sqlSchema({ looseSelects: true }) + "\n" + sqlDerived()))
      await db.prepare(stmt).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS shadow_state (
      tbl TEXT PRIMARY KEY, since TEXT, rows INTEGER DEFAULT 0,
      ran_at TEXT, last_error TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS shadow_rejects (
      tbl TEXT, airtable_id TEXT, why TEXT, at TEXT, PRIMARY KEY (tbl, airtable_id))`).run();
  })().catch((e) => { ready = null; throw e; }));

  const watermark = async (t) =>
    (await db.prepare("SELECT since FROM shadow_state WHERE tbl = ?").bind(t).first())?.since || null;

  /* The local row id for an Airtable record, so a child can find its parent.
     Read from the database, not from this pass: a contact whose company was
     copied last week still resolves. */
  const parentCache = new Map();
  async function parentIdOf(table, airtableId) {
    const key = `${table}:${airtableId}`;
    if (parentCache.has(key)) return parentCache.get(key);
    if (parentCache.size > 5000) parentCache.clear();
    const row = await db.prepare(`SELECT id FROM "${tableName(table)}" WHERE airtable_id = ?`)
      .bind(airtableId).first();
    if (row?.id != null) parentCache.set(key, row.id);
    return row?.id ?? null;
  }

  async function syncTable(table, { max = 500, depth = 0 } = {}) {
    const since = await watermark(table);
    const started = Date.now();
    /* No watermark yet means this table has never been copied, so take it
       whole. maxPages is high deliberately: a cap would copy a PREFIX and then
       record a watermark, which would make the gap permanent. */
    const opts = since
      ? { formula: `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${since}'))`, pageSize: 100, maxPages: 200 }
      : { pageSize: 100, maxPages: 5000 };
    const recs = await listTolerant(at, table, opts);
    if (!recs.length) {
      await stamp(table, started, 0, null);
      return { table, rows: 0, full: !since };
    }
    const { sql, cols } = upsertSql(table);
    let wrote = 0, rejected = 0;
    /* ONE BATCH PER PASS (2026-11-03 stress test). A statement per row made a
       busy minute cost hundreds of D1 calls in one invocation. The rows go as
       one batch; only if that batch is refused are they retried one by one, so
       the single bad row can be set aside and the rest still land. */
    const rows = [];
    const take = recs.slice(0, max === Infinity ? undefined : max);
    /* Parents looked up IN BULK, ninety ids to a query (D1 binds at most a
       hundred): a pass of 300 calls used to make 300 lookups. */
    const lookup = async (l, ids) => {
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const found = (await db.prepare(`SELECT id, airtable_id FROM "${tableName(l.to)}" WHERE airtable_id IN (${part.map(() => "?").join(",")})`)
          .bind(...part).all())?.results || [];
        const got = new Map(found.map((r) => [String(r.airtable_id), r.id]));
        for (const id of part) { if (got.has(id)) parentCache.set(`${l.to}:${id}`, got.get(id)); else parentCache.delete(`${l.to}:${id}`); }
      }
    };
    for (const l of LINKS_BY_TABLE[table] || []) {
      const want = [...new Set(take.map((rec) => { const v = rec.fields?.[l.name]; return Array.isArray(v) ? v[0] : v; })
        .filter(Boolean).map(String))].filter((id) => parentCache.get(`${l.to}:${id}`) == null);
      await lookup(l, want);
      /* A PARENT NOT COPIED YET is copied now, before the child is written —
         a contact made a minute ago and its first call arrive in the same
         window, and a call written first would point at nothing for good
         (its row would never change again to be re-read). */
      const missing = want.filter((id) => parentCache.get(`${l.to}:${id}`) == null);
      if (missing.length && depth < 2) {
        await syncTable(l.to, { max: Infinity, depth: depth + 1 }).catch(() => {});
        await lookup(l, missing);
      }
    }
    for (const rec of take) {
      const row = recordToRow(table, rec, () => null);
      /* Resolved from the SCHEMA's list of links, never by looking for columns
         whose name ends in _id. Three real fields end that way — kylas_contact_id,
         kylas_company_id, kylas_owner_id — and a loop that matched on the suffix
         overwrote all three with null. The row still had a name, so it looked
         copied; it just could not be found by the key anything joins on. */
      for (const l of LINKS_BY_TABLE[table] || []) {
        const ids = rec.fields?.[l.name];
        const first = Array.isArray(ids) ? ids[0] : ids;
        row[l.col] = first ? await parentIdOf(l.to, String(first)) : null;
      }
      rows.push({ rec, args: cols.map((k) => row[k] ?? null) });
    }
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      try {
        if (db.batch) await db.batch(part.map((r) => db.prepare(sql).bind(...r.args)));
        else for (const r of part) await db.prepare(sql).bind(...r.args).run();
        wrote += part.length;
      } catch {
        for (const r of part) {
          /* A row the copy's rules refuse is recorded and passed over, not
             allowed to stop the table: one bad value would otherwise hold the
             watermark for ever and nothing after it would arrive. */
          try { await db.prepare(sql).bind(...r.args).run(); wrote++; }
          catch (e) {
            rejected++;
            await db.prepare(`INSERT INTO shadow_rejects (tbl, airtable_id, why, at) VALUES (?, ?, ?, ?)
              ON CONFLICT (tbl, airtable_id) DO UPDATE SET why = excluded.why, at = excluded.at`)
              .bind(table, r.rec.id, e.message.slice(0, 200), new Date().toISOString()).run().catch(() => {});
          }
        }
      }
    }
    /* Every row refused is not "a bad value" — it is a table the copy cannot
       hold (missing, renamed). That is a failure: reported, watermark kept. */
    if (!wrote && rejected) throw new Error(`all ${rejected} row(s) refused — the table cannot be written`);
    await stamp(table, started, wrote, rejected ? `${rejected} row(s) refused — see shadow_rejects` : null);
    return { table, rows: wrote, rejected, full: !since, more: recs.length > wrote + rejected };
  }

  /* A FAILED PASS DOES NOT MOVE THE WATERMARK (2026-11-03). It used to: the
     catch below stamped `since = now`, so a first full copy that died (a
     35,000-row table cannot be read in one Worker invocation) left a fresh
     watermark behind, every later pass asked only for "changed since then",
     and the rows never read were never read. An error is recorded; `since`
     keeps whatever it was — null for a table never copied, so it is retried. */
  const fail = (t, err) => db.prepare(
    `INSERT INTO shadow_state (tbl, since, rows, ran_at, last_error) VALUES (?, NULL, 0, ?, ?)
     ON CONFLICT (tbl) DO UPDATE SET ran_at = excluded.ran_at, last_error = excluded.last_error`)
    .bind(t, new Date().toISOString(), err).run();
  const stamp = (t, started, rows, err) => db.prepare(
    `INSERT INTO shadow_state (tbl, since, rows, ran_at, last_error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tbl) DO UPDATE SET since = excluded.since, rows = shadow_state.rows + excluded.rows,
     ran_at = excluded.ran_at, last_error = excluded.last_error`)
    .bind(t, new Date(started - SLACK_MS).toISOString(), rows, new Date().toISOString(), err).run();

  /* ONE TABLE PER RUN, parent-first. The cron fires every minute and a save
     writes at most five tables, so a full lap takes thirteen minutes at worst
     and normally finds nothing to do. Doing them all in one invocation is how
     a background job turns into a subrequest-limit failure. */
  async function tick({ tables = BACKFILL_ORDER, max = 500 } = {}) {
    await init();
    const out = [];
    for (const t of tables) {
      /* A table that has never been copied jumps the queue: until it has, its
         children cannot resolve their parents. */
      if (!(await watermark(t))) {
        try { out.push(await syncTable(t, { max: Infinity })); }
        catch (e) { out.push({ table: t, error: e.message.slice(0, 160) }); await fail(t, e.message.slice(0, 160)); }
        return out;
      }
    }
    /* Otherwise the one that has gone longest without a look. */
    const rows = (await db.prepare("SELECT tbl, ran_at FROM shadow_state").all())?.results || [];
    const age = new Map(rows.map((r) => [r.tbl, Date.parse(r.ran_at || 0) || 0]));
    const next = [...tables].sort((a, b) => (age.get(a) || 0) - (age.get(b) || 0))[0];
    try { out.push(await syncTable(next, { max })); }
    catch (e) {
      out.push({ table: next, error: e.message.slice(0, 160) });
      await fail(next, e.message.slice(0, 160));
      log(`! shadow: ${next} — ${e.message.slice(0, 120)}`);
    }
    return out;
  }

  async function status() {
    await init();
    const rows = (await db.prepare(
      "SELECT tbl, since, rows, ran_at, last_error FROM shadow_state ORDER BY tbl").all())?.results || [];
    const counts = {};
    for (const t of BACKFILL_ORDER) {
      try { counts[t] = (await db.prepare(`SELECT COUNT(*) n FROM "${tableName(t)}"`).first())?.n ?? null; }
      catch { counts[t] = null; }
    }
    return { tables: rows, counts };
  }

  return { tick, status, syncTable, init };
}

/* ── helpers ───────────────────────────────────────────────────────── */
/* D1 takes one statement per prepare(). Splitting on semicolons is wrong in
   general and right here, because the generated SQL contains no semicolon
   inside a string or a comment — the generator does not emit one, and the
   test builds the same text through this splitter to prove it. */
export function splitStatements(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
