/* A copy of the Airtable tables the console reads, kept in D1, so a read never
 * waits on Airtable.
 *
 * WHY THIS EXISTS. Every screen of the console is computed from whole tables —
 * the dashboard from four of them, the queue and a company card from Contacts
 * and Event Rows. Airtable serves 100 rows a request at five requests a second,
 * so on a hosted runtime, where every request can land on a fresh instance with
 * nothing in memory, "open the dashboard" meant re-reading those tables page by
 * page while an associate watched. Caching the RESULT (what 1.14 did) moved the
 * wait to whoever came first after it expired. This moves it off the request
 * path entirely: the tables live in D1, next to the Worker, and are kept current
 * in the background.
 *
 * HOW IT STAYS CURRENT — three ways, cheapest first:
 *
 *   1. WRITE-THROUGH. Every write this server makes to Airtable comes back with
 *      the record as Airtable now holds it, and that goes straight into the
 *      copy. The console's own saves — nearly every change there is — cost no
 *      read at all and are visible at once.
 *   2. DELTA. A scheduled job asks Airtable for rows modified since last time
 *      (LAST_MODIFIED_TIME), which is one request per table when nothing much
 *      changed. That covers edits made in Airtable by hand or by another script.
 *   3. REBUILD. Once a day, after the Kylas sync, each table is read in full into
 *      a new generation and swapped in whole. That covers what a delta cannot
 *      see: deleted rows, and computed fields (rollups, formulas) whose inputs
 *      changed in ANOTHER table — Airtable does not count those as modifications.
 *
 * HOW INSTANCES AGREE. Every change bumps a version number per table in D1.
 * Each instance holds the rows in memory with the version it has seen, and at
 * most every CHECK_MS asks D1 for the current versions — one small query — then
 * pulls only rows newer than its own. A cold instance loads a table once, in one
 * query, only when something first reads it.
 *
 * WHAT IS NOT MIRRORED is read from Airtable as before: any table not listed
 * below, any projection naming a field the copy does not hold, and any filter
 * other than {Field} = 'value'. Nothing that used to work stops working; it just
 * is not faster. And if a table has not been built yet — the minutes after a
 * first deploy — reads go straight to Airtable, so the copy is an accelerator,
 * never a dependency.
 */
import {
  COMPANY_READ_FIELDS, CONTACT_READ_FIELDS, KPI_FIELDS, RCA_READ_FIELDS, RESEARCH_COLUMNS,
} from "./airtable.mjs";

const uniq = (a) => [...new Set(a)];

/* Each table with every field any reader asks of it. A field the base does not
   have is dropped at build time (and said so), exactly as listTolerant does. */
export const MIRROR_TABLES = {
  Companies: uniq([...COMPANY_READ_FIELDS, ...KPI_FIELDS]),
  Contacts: uniq([...CONTACT_READ_FIELDS, ...RCA_READ_FIELDS,
                  "Is Right POC", "Is Discovery", "KPI Rank At", "First Worked At",
                  "First Picked At", "Company Kylas ID"]),
  "Event Rows": ["Row Key", "Period", "Event Type", "Budget", "Timeline", "Pax", "Remarks",
                 "Contact", "Removed At", "Kylas Contact ID (from Contact)"],
  "Call Log": ["Called At", "Owner", "Outcome"],
  "Call Rollup": ["Day", "Owner", "Outcome", "Calls"],
  "Stage Transitions": ["Changed At", "Owner", "To Stage", "Contact"],
  RCA: ["Key", "Gate", "Reason", "Answered At"],
  Team: ["Name", "Role", "In Funnel", "Note"],
  Focus: ["Kylas Company ID", "Company Name", "Status", "Reason", "Note", "Owner", "Set By", "Set At"],
  Research: ["Kylas Company ID", ...Object.values(RESEARCH_COLUMNS), "Updated By", "Updated At"],
};

/* Airtable's LAST_MODIFIED_TIME is not instantaneous and two clocks are
   involved, so each delta starts this far before the previous one ended. Rows
   seen twice are harmless; a row missed is not. */
const SLACK_MS = 2 * 60 * 1000;
/* D1 allows 100 bound parameters a statement: a write-through binds two per
   row plus the table name, a build four per row. */
const ROWS_PER_STMT = 30;
const ROWS_PER_BUILD_STMT = 24;
const STMTS_PER_BATCH = 40;

const project = (fields, keep) => {
  const out = {};
  for (const k of keep) if (fields?.[k] !== undefined) out[k] = fields[k];
  return out;
};
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

/* {Field} = 'value', with Airtable's \' escape — the only filter the readers
   send that the copy answers. Anything else returns null and goes to Airtable. */
export function simpleFilter(formula) {
  const m = /^\{([^}]+)\}\s*=\s*'((?:[^'\\]|\\.)*)'$/.exec(String(formula || "").trim());
  if (!m) return null;
  const [, field, raw] = m;
  const want = raw.replace(/\\(.)/g, "$1");
  return {
    field,
    test: (fields) => {
      const v = fields?.[field];
      const s = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      return s === want;
    },
  };
}

export function createMirror({ db, log = () => {}, tables = MIRROR_TABLES, checkMs = 1500, now = () => Date.now() }) {
  if (!db) throw new Error("the mirror needs a D1 binding");
  const spec = (t) => tables[t] || null;

  let schema = null;
  const ready = () => (schema ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS mirror_meta (
      tbl TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0, v INTEGER NOT NULL DEFAULT 0,
      full_at INTEGER, delta_from TEXT, delta_at INTEGER, read_at INTEGER,
      lease_until INTEGER NOT NULL DEFAULT 0, count INTEGER, fields TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS mirror_rows (
      tbl TEXT NOT NULL, gen INTEGER NOT NULL, id TEXT NOT NULL, data TEXT,
      v INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tbl, gen, id))`),
    db.prepare("CREATE INDEX IF NOT EXISTS mirror_rows_v ON mirror_rows (tbl, gen, v)"),
  ]).catch((e) => { schema = null; throw e; }));

  /* What this instance has seen. */
  let meta = new Map();                   /* tbl -> row of mirror_meta */
  let checkedAt = 0, checking = null, touchedAt = 0;
  const local = new Map();                /* tbl -> { gen, v, rows: Map(id -> fields) } */
  const loading = new Map();              /* tbl -> promise */
  /* D1 writes that nobody awaits, so a hosted shell can hand them to waitUntil
     rather than have them cut off with the request. */
  const pending = new Set();
  const track = (p) => {
    const q = p.catch((e) => log(`! mirror: ${e.message}`)).finally(() => pending.delete(q));
    pending.add(q);
    return q;
  };

  async function check(force = false) {
    if (!force && now() - checkedAt < checkMs) return meta;
    if (!checking) {
      checking = (async () => {
        await ready();
        const r = await db.prepare("SELECT * FROM mirror_meta").all();
        meta = new Map((r.results || []).map((m) => [m.tbl, m]));
        checkedAt = now();
        /* Somebody is using the console, which is what lets the scheduled job
           skip its refresh overnight. Written at most once a minute. */
        if (now() - touchedAt > 60_000) {
          touchedAt = now();
          track(db.prepare("UPDATE mirror_meta SET read_at = ?").bind(now()).run());
        }
        return meta;
      })().finally(() => { checking = null; });
    }
    return checking;
  }

  const built = (m) => !!(m && m.full_at);

  /* The rows of one table, current to within CHECK_MS, or null when the table
     has never been built — the caller then reads Airtable. */
  async function rows(t) {
    if (!spec(t)) return null;
    await check();
    const m = meta.get(t);
    if (!built(m)) return null;
    const have = local.get(t);
    if (have && have.gen === m.gen && have.v >= m.v) return have.rows;
    if (!loading.has(t)) {
      loading.set(t, (async () => {
        const cur = local.get(t);
        if (!cur || cur.gen !== m.gen) {
          const r = await db.prepare(
            "SELECT id, data FROM mirror_rows WHERE tbl = ? AND gen = ? AND data IS NOT NULL ORDER BY rowid")
            .bind(t, m.gen).all();
          const map = new Map();
          for (const x of r.results || []) map.set(x.id, JSON.parse(x.data));
          local.set(t, { gen: m.gen, v: m.v, rows: map });
        } else {
          const r = await db.prepare(
            "SELECT id, data FROM mirror_rows WHERE tbl = ? AND gen = ? AND v > ? ORDER BY rowid")
            .bind(t, m.gen, cur.v).all();
          for (const x of r.results || []) {
            if (x.data == null) cur.rows.delete(x.id);
            else cur.rows.set(x.id, JSON.parse(x.data));
          }
          cur.v = m.v;
        }
      })().finally(() => loading.delete(t)));
    }
    await loading.get(t);
    return local.get(t)?.rows || null;
  }

  /* A string that changes whenever any of these tables does, so a result
     computed from them can be reused until it is actually out of date. Null
     when any of them is not built. */
  async function stamp(list) {
    await check();
    const parts = [];
    for (const t of list) {
      const m = meta.get(t);
      if (!built(m)) return null;
      parts.push(`${t}:${m.gen}.${m.v}`);
    }
    return parts.join("|");
  }

  /* Records as Airtable returned them, into the copy: this instance at once,
     D1 in the background. `deleted` records are tombstoned so other instances
     drop them too. Nothing happens for a table that is not built — a build in
     progress catches these writes with its closing delta. */
  function apply(t, records) {
    const keep = spec(t);
    if (!keep || !records?.length) return Promise.resolve();
    const cur = local.get(t);
    const items = records.filter((r) => r?.id).map((r) => {
      const data = r.deleted ? null : project(r.fields, keep);
      if (cur) { if (data) cur.rows.set(r.id, data); else cur.rows.delete(r.id); }
      return [r.id, data ? JSON.stringify(data) : null];
    });
    if (!items.length) return Promise.resolve();
    return track((async () => {
      await ready();
      const stmts = [db.prepare("UPDATE mirror_meta SET v = v + 1 WHERE tbl = ? AND full_at IS NOT NULL").bind(t)];
      for (const part of chunk(items, ROWS_PER_STMT)) {
        stmts.push(db.prepare(
          "INSERT INTO mirror_rows (tbl, gen, id, data, v) " +
          "SELECT m.tbl, m.gen, x.column1, x.column2, m.v FROM mirror_meta m, " +
          `(VALUES ${part.map(() => "(?, ?)").join(", ")}) x ` +
          "WHERE m.tbl = ? AND m.full_at IS NOT NULL " +
          "ON CONFLICT (tbl, gen, id) DO UPDATE SET data = excluded.data, v = excluded.v")
          .bind(...part.flat(), t));
      }
      for (const b of chunk(stmts, STMTS_PER_BATCH)) await db.batch(b);
    })());
  }

  /* The hook createAirtable calls after every successful write. */
  function written(method, table, out) {
    if (!spec(table)) return;
    const list = out?.records || (out?.id ? [out] : []);
    apply(table, method === "DELETE" ? list.map((r) => ({ id: r.id, deleted: true })) : list);
  }

  /* Re-read named records. After a save, the contact's formulas and its
     company's rollups have changed because OTHER rows were written — the
     write-through copy of them is already stale, and a delta cannot see it. */
  async function refetch(at, t, ids) {
    const recs = [];
    for (const id of ids.filter(Boolean)) {
      try { recs.push(await at.call("GET", `/${encodeURIComponent(t)}/${encodeURIComponent(id)}`)); }
      catch (e) { log(`! mirror: could not re-read ${t} ${id} — ${e.message.slice(0, 100)}`); }
    }
    await apply(t, recs);
  }

  /* Every row, dropping a field the base does not have rather than failing —
     one missing column must not keep a whole table out of the copy. */
  async function readAll(at, t) {
    let fields = [...spec(t)];
    for (let i = 0; i <= spec(t).length; i++) {
      try {
        return { recs: await at.listAll(t, { fields, pageSize: 100, maxPages: 2000 }), fields };
      } catch (e) {
        if (/TABLE_NOT_FOUND|NOT_FOUND|-> 404/.test(e.message)) return { recs: [], fields: [], missing: true };
        if (!/UNKNOWN_FIELD_NAME/.test(e.message)) throw e;
        const which = /Unknown field name:\s*\\?"([^"\\]+)/.exec(e.message)?.[1];
        if (!which || !fields.includes(which)) throw e;
        log(`  mirror: ${t} has no field "${which}" — kept without it. Run repair-base.`);
        fields = fields.filter((f) => f !== which);
      }
    }
    throw new Error(`${t}: gave up dropping unknown fields`);
  }

  /* Only one instance works on a table at a time. The lease expires on its own,
     so a job killed mid-build does not lock the table for ever. */
  async function lease(t, ms) {
    await ready();
    await db.prepare("INSERT OR IGNORE INTO mirror_meta (tbl) VALUES (?)").bind(t).run();
    const r = await db.prepare("UPDATE mirror_meta SET lease_until = ? WHERE tbl = ? AND lease_until < ?")
      .bind(now() + ms, t, now()).run();
    return (r.meta?.changes || 0) > 0;
  }
  const release = (t) => db.prepare("UPDATE mirror_meta SET lease_until = 0 WHERE tbl = ?").bind(t).run();

  /* The whole table into a NEW generation, swapped in with one statement, so a
     reader sees the old copy or the new one and never half of each. */
  async function build(at, t) {
    if (!spec(t)) throw new Error(`${t} is not a mirrored table`);
    if (!(await lease(t, 15 * 60 * 1000))) return { table: t, skipped: "another build holds it" };
    const started = now();
    try {
      const { recs, fields, missing } = await readAll(at, t);
      const cur = await db.prepare("SELECT gen FROM mirror_meta WHERE tbl = ?").bind(t).first();
      const gen = Number(cur?.gen || 0) + 1;
      await db.prepare("DELETE FROM mirror_rows WHERE tbl = ? AND gen = ?").bind(t, gen).run();
      const stmts = chunk(recs, ROWS_PER_BUILD_STMT).map((part) => db.prepare(
        "INSERT INTO mirror_rows (tbl, gen, id, data, v) VALUES " +
        part.map(() => "(?, ?, ?, ?, 0)").join(", ") +
        " ON CONFLICT (tbl, gen, id) DO UPDATE SET data = excluded.data")
        .bind(...part.flatMap((r) => [t, gen, r.id, JSON.stringify(project(r.fields, fields))])));
      for (const b of chunk(stmts, STMTS_PER_BATCH)) await db.batch(b);
      await db.batch([
        db.prepare("UPDATE mirror_meta SET gen = ?, v = v + 1, full_at = ?, delta_from = ?, delta_at = ?, " +
                   "count = ?, fields = ? WHERE tbl = ?")
          .bind(gen, now(), new Date(started - SLACK_MS).toISOString(), now(), recs.length,
                JSON.stringify(fields), t),
        db.prepare("DELETE FROM mirror_rows WHERE tbl = ? AND gen <> ?").bind(t, gen),
      ]);
      log(`  mirror: ${t} built — ${recs.length} row(s)${missing ? " (table missing in the base)" : ""} ` +
          `in ${((now() - started) / 1000).toFixed(1)}s`);
      await check(true);
      /* Anything written while the table was being read. */
      const d = missing ? { changed: 0 } : await delta(at, t, { leased: true });
      return { table: t, rows: recs.length, caughtUp: d.changed };
    } finally {
      await release(t).catch(() => {});
    }
  }

  /* Rows modified since the last delta. One request when nothing changed. */
  async function delta(at, t, { leased = false } = {}) {
    await ready();
    const m = await db.prepare("SELECT * FROM mirror_meta WHERE tbl = ?").bind(t).first();
    if (!built(m)) return { table: t, skipped: "not built" };
    if (!leased && !(await lease(t, 5 * 60 * 1000))) return { table: t, skipped: "busy" };
    const started = now();
    try {
      const fields = JSON.parse(m.fields || "[]");
      if (!fields.length) return { table: t, changed: 0 };
      const recs = await at.listAll(t, {
        formula: `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${m.delta_from}'))`,
        fields, pageSize: 100, maxPages: 2000,
      });
      await apply(t, recs);
      await db.prepare("UPDATE mirror_meta SET delta_from = ?, delta_at = ? WHERE tbl = ?")
        .bind(new Date(started - SLACK_MS).toISOString(), now(), t).run();
      if (recs.length) log(`  mirror: ${t} — ${recs.length} changed row(s) since ${m.delta_from}`);
      return { table: t, changed: recs.length };
    } finally {
      if (!leased) await release(t).catch(() => {});
    }
  }

  /* What the scheduled job calls. Builds what is missing, rebuilds what is a
     day old, and — only while somebody has used the console recently — picks
     up changes made outside it. Idle, it costs nothing: no Airtable request. */
  async function maintain(at, { deltaEveryMs = 10 * 60 * 1000, fullEveryMs = 26 * 3600 * 1000,
                                activeWithinMs = 60 * 60 * 1000, rebuild = false, only = null } = {}) {
    await check(true);
    const out = [];
    for (const t of only || Object.keys(tables)) {
      const m = meta.get(t);
      try {
        if (rebuild || !built(m) || now() - Number(m.full_at) > fullEveryMs) out.push(await build(at, t));
        else if (now() - Number(m.delta_at || 0) > deltaEveryMs &&
                 now() - Number(m.read_at || 0) < activeWithinMs) out.push(await delta(at, t));
      } catch (e) {
        log(`! mirror: ${t} — ${e.message.slice(0, 200)}`);
        out.push({ table: t, error: e.message.slice(0, 200) });
      }
    }
    return out;
  }

  async function status() {
    await check(true);
    return Object.keys(tables).map((t) => {
      const m = meta.get(t);
      return { table: t, built: built(m), rows: m?.count ?? null, version: m ? `${m.gen}.${m.v}` : null,
               builtAt: m?.full_at ? new Date(m.full_at).toISOString() : null,
               deltaAt: m?.delta_at ? new Date(m.delta_at).toISOString() : null };
    });
  }

  return { spec, rows, stamp, apply, written, refetch, build, delta, maintain, status,
           pending: () => [...pending] };
}

/* An Airtable client that answers whole-table reads from the copy. Same shape
   as createAirtable's, so every reader in airtable.mjs uses it unchanged. */
export function mirrored(at, mirror) {
  return {
    ...at,
    mirrored: true,
    async listAll(table, opts = {}) {
      const keep = mirror.spec(table);
      const want = opts.fields || [];
      /* No projection means "every field", which the copy does not hold. */
      if (keep && want.length && want.every((f) => keep.includes(f))) {
        const filter = opts.formula ? simpleFilter(opts.formula) : null;
        if (!opts.formula || (filter && keep.includes(filter.field))) {
          const rows = await mirror.rows(table);
          if (rows) {
            const out = [];
            for (const [id, fields] of rows) {
              if (filter && !filter.test(fields)) continue;
              out.push({ id, fields: project(fields, want) });
            }
            return out;
          }
        }
      }
      return at.listAll(table, opts);
    },
  };
}
