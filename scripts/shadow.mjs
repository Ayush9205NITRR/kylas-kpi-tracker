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
    for (const stmt of splitStatements(sqlSchema() + "\n" + sqlDerived()))
      await db.prepare(stmt).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS shadow_state (
      tbl TEXT PRIMARY KEY, since TEXT, rows INTEGER DEFAULT 0,
      ran_at TEXT, last_error TEXT)`).run();
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
    parentCache.set(key, row?.id ?? null);
    return row?.id ?? null;
  }

  async function syncTable(table, { max = 500 } = {}) {
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
    let wrote = 0;
    for (const rec of recs.slice(0, max === Infinity ? undefined : max)) {
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
      await db.prepare(sql).bind(...cols.map((k) => row[k] ?? null)).run();
      wrote++;
    }
    await stamp(table, started, wrote, null);
    return { table, rows: wrote, full: !since, more: recs.length > wrote };
  }

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
        catch (e) { out.push({ table: t, error: e.message.slice(0, 160) }); await stamp(t, Date.now(), 0, e.message.slice(0, 160)); }
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
      await stamp(next, Date.now(), 0, e.message.slice(0, 160));
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
