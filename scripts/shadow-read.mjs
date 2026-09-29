/* GATE 3: answer every read twice, serve one, record whether they agreed.
 *
 * This is the test row-level checks cannot do. The reconciler proves the rows
 * match and verify-kpis proves the numbers match; neither proves that the
 * REPLY the console gets is the same, because a reply is rows plus a filter
 * plus a sort plus a timezone, and any of those four can read differently
 * while every row is identical.
 *
 * THE AIRTABLE ANSWER IS ALWAYS THE ONE SERVED. The SQL answer is computed,
 * compared, counted and thrown away. Nothing a viewer sees depends on this
 * code being right, which is the property that lets it run on live traffic
 * for a fortnight.
 *
 * IT RUNS BEHIND THE REPLY. The comparison happens in the background slot the
 * save queue already uses, so the associate waits for the Airtable answer and
 * nothing else. A route that got slower while being checked would make the
 * check itself the reason to abandon the migration.
 *
 * WHAT IT RECORDS. Not the replies — those are megabytes and they are not the
 * finding. Per route: how many times they agreed, how many times they did
 * not, which FIELDS disagreed and how often, and the last few examples with
 * enough of both values to see why. Plus both timings, which is the other
 * question Gate 3 has to answer.
 */
import { diffLists } from "./compare.mjs";

export function createShadowReads({ db, log = () => {}, now = () => Date.now() }) {
  if (!db) return null;
  let ready = null;
  const init = () => (ready ||= db.prepare(`CREATE TABLE IF NOT EXISTS shadow_reads (
      route TEXT PRIMARY KEY,
      runs INTEGER DEFAULT 0, agreed INTEGER DEFAULT 0, disagreed INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      airtable_ms_total INTEGER DEFAULT 0, sql_ms_total INTEGER DEFAULT 0,
      airtable_ms_max INTEGER DEFAULT 0, sql_ms_max INTEGER DEFAULT 0,
      airtable_bytes INTEGER DEFAULT 0, sql_bytes INTEGER DEFAULT 0,
      rows INTEGER DEFAULT 0,
      field_counts TEXT, last_example TEXT, last_error TEXT, ran_at TEXT)`)
    .run().catch((e) => { ready = null; throw e; }));

  /* Compare one route's two answers and fold the result into its row. Never
     throws: a harness that can break a request is not a harness. */
  async function record(route, { airtable, sql, airtableMs, sqlMs, keyOf }) {
    try {
      await init();
      const d = diffLists(airtable, sql, keyOf);
      const prev = await db.prepare("SELECT field_counts FROM shadow_reads WHERE route = ?")
        .bind(route).first();
      const counts = { ...(safeParse(prev?.field_counts) || {}) };
      for (const [f, n] of Object.entries(d.fieldCounts)) counts[f] = (counts[f] || 0) + n;

      const example = d.clean ? null : JSON.stringify({
        at: new Date(now()).toISOString(),
        onlyAirtable: d.sampleOnlyAirtable, onlySql: d.sampleOnlySql,
        differing: d.sampleDiffering,
      }).slice(0, 4000);

      await db.prepare(`
        INSERT INTO shadow_reads (route, runs, agreed, disagreed, errors,
          airtable_ms_total, sql_ms_total, airtable_ms_max, sql_ms_max,
          airtable_bytes, sql_bytes, rows, field_counts, last_example, ran_at)
        VALUES (?, 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (route) DO UPDATE SET
          runs = shadow_reads.runs + 1,
          agreed = shadow_reads.agreed + excluded.agreed,
          disagreed = shadow_reads.disagreed + excluded.disagreed,
          airtable_ms_total = shadow_reads.airtable_ms_total + excluded.airtable_ms_total,
          sql_ms_total = shadow_reads.sql_ms_total + excluded.sql_ms_total,
          airtable_ms_max = MAX(shadow_reads.airtable_ms_max, excluded.airtable_ms_max),
          sql_ms_max = MAX(shadow_reads.sql_ms_max, excluded.sql_ms_max),
          airtable_bytes = excluded.airtable_bytes,
          sql_bytes = excluded.sql_bytes,
          rows = excluded.rows,
          field_counts = excluded.field_counts,
          last_example = COALESCE(excluded.last_example, shadow_reads.last_example),
          ran_at = excluded.ran_at`)
        .bind(route, d.clean ? 1 : 0, d.clean ? 0 : 1,
              Math.round(airtableMs), Math.round(sqlMs),
              Math.round(airtableMs), Math.round(sqlMs),
              bytes(airtable), bytes(sql), d.airtable,
              JSON.stringify(counts), example, new Date(now()).toISOString())
        .run();
      if (!d.clean)
        log(`  shadow read ${route}: ${d.differing} row(s) differ, ` +
            `${d.onlyAirtable} only in Airtable, ${d.onlySql} only in SQL`);
      return d;
    } catch (e) {
      log(`! shadow read ${route}: ${e.message.slice(0, 120)}`);
      try {
        await init();
        await db.prepare(`INSERT INTO shadow_reads (route, runs, errors, last_error, ran_at)
          VALUES (?, 1, 1, ?, ?) ON CONFLICT (route) DO UPDATE SET
          runs = shadow_reads.runs + 1, errors = shadow_reads.errors + 1,
          last_error = excluded.last_error, ran_at = excluded.ran_at`)
          .bind(route, e.message.slice(0, 200), new Date(now()).toISOString()).run();
      } catch { /* the harness cannot be the thing that fails */ }
      return null;
    }
  }

  async function status() {
    await init();
    const rows = (await db.prepare(
      "SELECT * FROM shadow_reads ORDER BY route").all())?.results || [];
    return rows.map((r) => ({
      route: r.route,
      runs: r.runs, agreed: r.agreed, disagreed: r.disagreed, errors: r.errors,
      rows: r.rows,
      /* The averages are what a decision gets made on; the maxima are what a
         complaint gets made about. Both. */
      airtableAvgMs: r.runs ? Math.round(r.airtable_ms_total / r.runs) : null,
      sqlAvgMs: r.runs ? Math.round(r.sql_ms_total / r.runs) : null,
      airtableMaxMs: r.airtable_ms_max, sqlMaxMs: r.sql_ms_max,
      speedup: r.sql_ms_total > 0
        ? Number((r.airtable_ms_total / r.sql_ms_total).toFixed(1)) : null,
      airtableBytes: r.airtable_bytes, sqlBytes: r.sql_bytes,
      fieldCounts: safeParse(r.field_counts) || {},
      lastExample: safeParse(r.last_example),
      lastError: r.last_error || null,
      ranAt: r.ran_at,
    }));
  }

  const reset = async () => { await init(); await db.prepare("DELETE FROM shadow_reads").run(); };

  return { record, status, reset };
}

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
/* Byte size of the reply as it would go over the wire. Measured, not
   estimated: "is the payload the same size" is one of the questions, and a
   guess would answer it wrongly in whichever direction flattered us. */
const bytes = (v) => { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch { return 0; } };
