/* D1 FOR A NODE SCRIPT — the crons and one-off scripts, which run on a laptop
 * and not inside the Worker, so they have no binding. Two ways in, chosen by
 * the environment (createAirtable loads this by itself when STORE=d1):
 *
 *   D1_SQLITE=<file>                            a local SQLite file: dev, tests,
 *                                               a dry run against a copy
 *   CF_ACCOUNT_ID + CF_API_TOKEN + KPI_DB_ID    the real D1, over Cloudflare's
 *                                               HTTP API (token: D1 Edit)
 *
 * Both answer the binding's surface — prepare().bind().all()/first()/run() and
 * batch() — which is all airtable-d1.mjs uses.
 *
 * ONE DIFFERENCE, said out loud: over HTTP, batch() sends the statements as
 * one request but D1's HTTP endpoint does not promise a transaction the way
 * the binding's batch() does. Every batch airtable-d1 sends is a set of
 * independent row writes (or an unlink-then-delete, which is safe to re-run),
 * so a partial batch is a retry, never a corruption.
 */
import { fakeD1 } from "./d1-fake.mjs";
import { sqlSchema } from "./sql-schema.mjs";
import { sqlDerived } from "./sql-derived.mjs";

/* A local file is made usable on open: the DDL is idempotent (CREATE … IF NOT
   EXISTS, views dropped and re-created), so a fresh file and a copy of
   production both come out with every table and view. */
function withSchema(db) {
  let ready = null;
  const ensure = () => (ready ||= db.exec(sqlSchema({ looseSelects: true })).then(() => db.exec(sqlDerived())));
  return {
    prepare: (sql) => {
      const wrap = (params) => ({
        bind: (...p) => wrap(p),
        all: async () => { await ensure(); return db.prepare(sql).bind(...params).all(); },
        first: async (c) => { await ensure(); return db.prepare(sql).bind(...params).first(c); },
        run: async () => { await ensure(); return db.prepare(sql).bind(...params).run(); },
        _sql: sql, _params: params,
      });
      return wrap([]);
    },
    batch: async (list) => { await ensure(); return db.batch(list.map((x) => db.prepare(x._sql).bind(...x._params))); },
    exec: async (t) => { await ensure(); return db.exec(t); },
  };
}

export function d1FromEnv(env = process.env) {
  if (env.D1_SQLITE) return withSchema(fakeD1(env.D1_SQLITE));
  const { CF_ACCOUNT_ID: acct, CF_API_TOKEN: token, KPI_DB_ID: id } = env;
  if (acct && token && id) return d1Http({ accountId: acct, token, databaseId: id });
  throw new Error("STORE=d1 needs D1_SQLITE=<file>, or CF_ACCOUNT_ID + CF_API_TOKEN + KPI_DB_ID.");
}

export function d1Http({ accountId, token, databaseId, apiBase = "https://api.cloudflare.com/client/v4" }) {
  const url = `${apiBase}/accounts/${accountId}/d1/database/${databaseId}/query`;
  async function query(sql, params = []) {
    for (let i = 0; ; i++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise((s) => setTimeout(s, 500 * 2 ** i)); continue; }
      if (!r.ok || j.success === false)
        throw new Error(`D1 ${r.status}: ${(j.errors || []).map((e) => e.message).join("; ") || "query failed"}`);
      return j.result || [];
    }
  }
  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    async all() { const [res] = await query(sql, params); return { results: res?.results || [], success: true, meta: res?.meta || {} }; },
    async first(col) { const row = (await this.all()).results[0] || null; return col ? (row ? row[col] : null) : row; },
    async run() { const [res] = await query(sql, params); return { success: true, meta: res?.meta || {} }; },
    _sql: sql, _params: params,
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      /* Inlined statements (airtable-d1 binds nothing) go as one request. */
      if (list.every((s) => !s._params.length)) {
        const res = await query(list.map((s) => s._sql.replace(/;\s*$/, "")).join(";\n"));
        return res.map(() => ({ success: true }));
      }
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  };
}
