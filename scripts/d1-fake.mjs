/* A stand-in for a Cloudflare D1 binding, over real SQLite (node:sqlite), so
 * the suites can run the mirror's actual SQL instead of a pretend store.
 *
 *   import { fakeD1 } from "./d1-fake.mjs";
 *   const db = fakeD1();            // in memory; share it between "instances"
 *
 * Only what the code here uses: prepare().bind().all()/first()/run(), and
 * batch() as ONE transaction — which is the property the mirror's generation
 * swap relies on, so it is honoured rather than approximated. It is not a test
 * of D1; the real one is exercised by `wrangler dev --local` (docs/STATE.md).
 */
import { DatabaseSync } from "node:sqlite";

export function fakeD1(path = ":memory:") {
  const sql = new DatabaseSync(path);
  let queries = 0;
  const plain = (row) => (row ? { ...row } : null);

  function statement(text, params = []) {
    const exec = (fn) => { queries++; return fn(sql.prepare(text)); };
    return {
      bind: (...p) => {
        /* D1's own limit, which SQLite's is far above — a statement that
           passes here with 101 parameters would fail on the real thing. */
        if (p.length > 100) throw new Error(`D1 allows 100 bound parameters, got ${p.length}`);
        return statement(text, p);
      },
      async all() {
        const rows = exec((s) => s.all(...params)).map(plain);
        return { results: rows, success: true, meta: { rows_read: rows.length } };
      },
      async first(col) {
        const row = plain(exec((s) => s.get(...params)));
        return col ? (row ? row[col] : null) : row;
      },
      async run() {
        const r = exec((s) => s.run(...params));
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      _sync: () => exec((s) => s.run(...params)),
    };
  }

  return {
    prepare: (text) => statement(text),
    async batch(stmts) {
      sql.exec("BEGIN");
      try {
        const out = stmts.map((st) => { st._sync(); return { success: true }; });
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(text) { sql.exec(text); return { count: 1 }; },
    /* For a test to count how much it cost. */
    queries: () => queries,
  };
}
