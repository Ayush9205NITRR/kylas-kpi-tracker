/* The small amount of state the proxy keeps outside Airtable, behind one
 * interface so the same handlers run on a laptop and on a Cloudflare Worker.
 *
 * There are exactly two things:
 *
 *   save journal    which saves have already created a contact in Kylas.
 *                   Correctness-critical — see journal.mjs.
 *   company shape   which /v1/search/company body this account accepts.
 *                   A cache. Losing it costs 1.35s on the next cold start.
 *
 * THE INTERFACE IS PER KEY, NOT WHOLE-FILE, and that is the point of this file
 * rather than passing a path around. The journal used to load one JSON object,
 * hold it in a Map and rewrite the whole thing on every change. On a laptop
 * that is correct, because one process owns the file. On Workers it is not:
 * there is no single process, isolates come and go between requests, and two
 * of them doing read-modify-write on one blob lose each other's entries. A
 * per-key interface has no lost update to reason about.
 *
 *   get(key)                 -> string | null
 *   put(key, value, { ttlSeconds })
 *   delete(key)
 *   keys()                   -> string[]      (best effort; only used to sweep)
 *
 * Values are strings. Callers serialise. That keeps every backend's contract
 * identical rather than each one inventing its own idea of what a value is.
 */

/* ── a laptop ────────────────────────────────────────────────────────────
   One JSON file, rewritten whole via a temp file and a rename, because a
   crash mid-write must not leave a truncated file that reads as "nothing was
   ever created". Held in memory between calls: one process owns this file, so
   the copy in hand cannot go stale behind its back. */
export function fileStore(fileUrl, { log = () => {} } = {}) {
  let mem = null;                         /* key -> { v, exp } */
  let fs = null;

  async function node() {
    if (!fs) fs = await import("node:fs");
    return fs;
  }

  async function load() {
    if (mem) return mem;
    mem = new Map();
    try {
      const { readFileSync } = await node();
      const raw = JSON.parse(readFileSync(fileUrl, "utf8"));
      for (const [k, v] of Object.entries(raw.entries || {})) mem.set(k, v);
    } catch { /* first run, or unreadable — an empty store is a correct one */ }
    return mem;
  }

  async function flush() {
    const now = Date.now();
    for (const [k, v] of mem) if (v.exp && v.exp < now) mem.delete(k);
    try {
      const { writeFileSync, renameSync } = await node();
      const tmp = new URL(fileUrl.href + ".tmp");
      writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(mem) }));
      renameSync(tmp, fileUrl);
    } catch (e) {
      /* An unwritable store must not stop the save. It degrades to the
         behaviour from before there was one, so it is said out loud rather
         than swallowed. */
      log(`! ${fileUrl.pathname.split("/").pop()} not written (${e.message}).`);
    }
  }

  return {
    kind: "file",
    async get(key) {
      const m = await load();
      const e = m.get(key);
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) { m.delete(key); return null; }
      return e.v;
    },
    async put(key, value, { ttlSeconds } = {}) {
      const m = await load();
      m.set(key, { v: String(value), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
      await flush();
    },
    async delete(key) {
      const m = await load();
      if (!m.delete(key)) return;
      await flush();
    },
    async keys() { return [...(await load()).keys()]; },
  };
}

/* ── Cloudflare KV ───────────────────────────────────────────────────────
   Right for the company shape and wrong for the journal, and the difference
   matters enough to say here rather than in a commit message.

   KV is EVENTUALLY CONSISTENT. A write is visible in the region that made it
   almost at once, and elsewhere within about a minute. For a cached probe
   result that is irrelevant — the worst case is probing twice. For the
   journal it is not: two retries of one save, seconds apart, landing in two
   colos could both read "absent" and both create a contact, which is the
   precise failure the journal exists to prevent. Use d1Store for that. */
export function kvStore(ns) {
  return {
    kind: "kv",
    async get(key) { return ns.get(key); },
    async put(key, value, { ttlSeconds } = {}) {
      /* KV rejects an expirationTtl under 60s. Rounding up is better than
         letting a short TTL throw on a write the caller cannot retry. */
      await ns.put(key, String(value),
        ttlSeconds ? { expirationTtl: Math.max(60, Math.round(ttlSeconds)) } : undefined);
    },
    async delete(key) { await ns.delete(key); },
    async keys() { return (await ns.list()).keys.map((k) => k.name); },
  };
}

/* ── Cloudflare D1 ───────────────────────────────────────────────────────
   Strongly consistent, which is what the journal needs. One table, created on
   first use so deploying needs no migration step:

     CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)

   Expiry is enforced on read rather than by a sweeper, because a row nobody
   reads costs nothing and a sweeper is another scheduled thing to go wrong. */
export function d1Store(db) {
  let ready = null;
  const init = () => (ready ||= db.prepare(
    "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)").run());
  return {
    kind: "d1",
    async get(key) {
      await init();
      const row = await db.prepare("SELECT v, exp FROM kv WHERE k = ?").bind(key).first();
      if (!row) return null;
      if (row.exp && row.exp < Date.now()) {
        await db.prepare("DELETE FROM kv WHERE k = ?").bind(key).run();
        return null;
      }
      return row.v;
    },
    async put(key, value, { ttlSeconds } = {}) {
      await init();
      await db.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) " +
                       "ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp")
        .bind(key, String(value), ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0).run();
    },
    async delete(key) {
      await init();
      await db.prepare("DELETE FROM kv WHERE k = ?").bind(key).run();
    },
    async keys() {
      await init();
      const r = await db.prepare("SELECT k FROM kv").all();
      return (r.results || []).map((x) => x.k);
    },
  };
}

/* ── tests ───────────────────────────────────────────────────────────────
   So a suite can exercise the journal without a filesystem or a network. */
export function memoryStore() {
  const m = new Map();
  return {
    kind: "memory",
    async get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) { m.delete(key); return null; }
      return e.v;
    },
    async put(key, value, { ttlSeconds } = {}) {
      m.set(key, { v: String(value), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
    },
    async delete(key) { m.delete(key); },
    async keys() { return [...m.keys()]; },
  };
}
