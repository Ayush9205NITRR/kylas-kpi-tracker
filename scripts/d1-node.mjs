/* D1 FOR A NODE SCRIPT — the crons and one-off scripts, which run on a laptop
 * and not inside the Worker, so they have no binding. Two ways in, chosen by
 * the environment (createAirtable loads this by itself when STORE=d1):
 *
 *   D1_SQLITE=<file>                            a local SQLite file: dev, tests,
 *                                               a dry run against a copy
 *   CF_ACCOUNT_ID + CF_API_TOKEN + KPI_DB_ID    the real D1, over Cloudflare's
 *                                               HTTP API (token: D1 Edit)
 *   CF_ACCOUNT_ID + CF_WRANGLER_LOGIN=1 + KPI_DB_ID
 *                                               the same, on the laptop's own
 *                                               `npx wrangler login` — no token
 *                                               to make (wrangler-login.mjs)
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
  /* The login first: an old CF_API_TOKEN line may belong to another account. */
  if (acct && id && env.CF_WRANGLER_LOGIN === "1") {
    const spec = "./wrangler-login.mjs";        /* a variable, so no bundler pulls node:child_process into the Worker */
    const login = import(spec);
    return d1Http({ accountId: acct, databaseId: id,
      token: async () => (await login).wranglerToken(),
      refresh: async () => (await login).refreshWranglerToken() });
  }
  if (acct && token && id) return d1Http({ accountId: acct, token, databaseId: id });
  throw new Error("STORE=d1 needs D1_SQLITE=<file>, or CF_ACCOUNT_ID + KPI_DB_ID with CF_API_TOKEN (or CF_WRANGLER_LOGIN=1).");
}

/* token: a string, or an async function (the wrangler login, which expires
   hourly). refresh: called once when Cloudflare refuses the token, then the
   request is tried again with whatever token() now returns. */
export function d1Http({ accountId, token, databaseId, refresh = null, apiBase = "https://api.cloudflare.com/client/v4" }) {
  const url = `${apiBase}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const bearer = typeof token === "function" ? token : async () => token;
  async function query(sql, params = []) {
    let refreshed = false;
    for (let i = 0; ; i++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise((s) => setTimeout(s, 500 * 2 ** i)); continue; }
      if ((r.status === 401 || r.status === 403) && refresh && !refreshed) { refreshed = true; await refresh(); continue; }
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
  /* CAN ONE REQUEST CARRY SEVERAL STATEMENTS? Cloudflare documents it for the
     query endpoint but it is checked here, once, on a scratch table, rather
     than trusted: two inserts in one request, then a count. If the answer is
     not 2, every batch goes statement by statement — slower, never wrong. */
  let multi = null;
  async function multiOk() {
    if (multi !== null) return multi;
    try {
      await query(`CREATE TABLE IF NOT EXISTS "_batch_probe" (x INTEGER)`);
      await query(`DELETE FROM "_batch_probe"; INSERT INTO "_batch_probe" VALUES (1); INSERT INTO "_batch_probe" VALUES (2)`);
      const [r] = await query(`SELECT COUNT(*) AS n FROM "_batch_probe"`);
      multi = Number(r?.results?.[0]?.n) === 2;
    } catch { multi = false; }
    return multi;
  }
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      /* Inlined statements (airtable-d1 binds nothing) go as one request. */
      if (list.every((s) => !s._params.length) && await multiOk()) {
        const res = await query(list.map((s) => s._sql.replace(/;\s*$/, "")).join(";\n"));
        return res.map(() => ({ success: true }));
      }
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
    multiStatement: multiOk,
  };
}
