/* RE-ASSIGNMENT AS A BACKGROUND JOB.
 *
 * Ayush, 2026-10-29: allotting from the console "is not scalable" — the work ran
 * inside the request, the tab had to stay open, and a 429 or a closed tab left a
 * batch half done. Now Start only WRITES THE JOB (a few D1 rows, milliseconds)
 * and the moves run behind it:
 *
 *   - the console, while its panel is open, asks POST /allot-jobs/step again and
 *     again — each a fresh invocation with its own request allowance — and
 *   - the every-minute maintenance run drains whatever is left when nobody is
 *     watching, so closing the tab only slows it down.
 *
 * ONE ROW PER ACCOUNT (kind "company": the contacts go first, then the account,
 * then its owner is read back — reassign.mjs allotOne) or per contact batch
 * (kind "contacts": only those contacts, the company stays where it is).
 *
 * WHAT MAKES IT SAFE TO RE-RUN. Each item is claimed by one atomic UPDATE (two
 * instances cannot both run it); a claim that dies is taken again when its lease
 * runs out; an item whose records are already on the target owner is done with
 * no write (allotOne skips them); a newer job for the same account supersedes a
 * queued older one, so two admins cannot make an account ping-pong. Done means
 * READ BACK on the new owner — a 200 from Kylas is never taken for it.
 *
 * FAILURE. Kylas refusing on the data ("Invalid owner." — the record sits on a
 * deactivated user, a 404) is final and says why. 429, 5xx, timeouts and
 * "Too many subrequests" are retried with back-off, up to TRIES times.
 */
const BACKOFF_MS = [20e3, 60e3, 3 * 60e3, 10 * 60e3, 30 * 60e3];
const TRIES = BACKOFF_MS.length + 1;
const LEASE_MS = 2 * 60 * 1000;
const KEEP_MS = 14 * 24 * 3600 * 1000;

export const TRANSIENT = /\b(429|5\d\d)\b|timed? ?out|timeout|aborted|network|ECONN|Too many subrequests|fetch failed|throttl/i;
export const isTransient = (e) => (e?.status ? e.status === 429 || e.status >= 500 || e.status === 408 : TRANSIENT.test(String(e?.message || e)));

export function createAllotJobs({ db, log = () => {}, now = () => Date.now() }) {
  if (!db) throw new Error("allot jobs need a D1 binding");
  let schema = null;
  const ready = () => (schema ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS allot_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, by_name TEXT, total INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS allot_items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, kind TEXT NOT NULL,
      company_id TEXT NOT NULL, to_id TEXT NOT NULL, contact_ids TEXT,
      state TEXT NOT NULL DEFAULT 'queued', tries INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      result TEXT, error TEXT, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS allot_items_due ON allot_items (state, due_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS allot_items_job ON allot_items (job_id, state)"),
    db.prepare("CREATE INDEX IF NOT EXISTS allot_items_co ON allot_items (company_id, kind, state)"),
  ]).catch((e) => { schema = null; throw e; }));

  /* items: [{ companyId, to, contactIds? }]. Returns at once — nothing here
     talks to Kylas. */
  async function create({ kind = "company", by = "", items = [] }) {
    await ready();
    const list = items.map((x) => ({ co: String(x.companyId ?? x.company ?? ""), to: String(x.to ?? x.ownerId ?? ""),
                                     cids: Array.isArray(x.contactIds) ? x.contactIds.map(String) : null }))
      .filter((x) => /^\d+$/.test(x.co) && /^\d+$/.test(x.to));
    if (!list.length) throw Object.assign(new Error("nothing to re-assign"), { status: 400 });
    const id = crypto.randomUUID();
    const t = now();
    const stmts = [db.prepare("INSERT INTO allot_jobs (id, kind, by_name, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, kind, by, list.length, t, t)];
    for (const x of list) {
      /* The newest instruction for an account wins: an older job still waiting
         on it is told so rather than run afterwards. */
      stmts.push(db.prepare("UPDATE allot_items SET state = 'superseded', updated_at = ? WHERE company_id = ? AND kind = ? AND state = 'queued'")
        .bind(t, x.co, kind));
      stmts.push(db.prepare("INSERT INTO allot_items (job_id, kind, company_id, to_id, contact_ids, due_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, kind, x.co, x.to, x.cids ? JSON.stringify(x.cids) : null, t, t));
    }
    for (let i = 0; i < stmts.length; i += 300) await db.batch(stmts.slice(i, i + 300));
    log(`allot job ${id.slice(0, 8)}: ${list.length} ${kind === "company" ? "account(s)" : "contact batch(es)"} queued by ${by || "?"}`);
    return { id, total: list.length };
  }

  async function claim(jobId) {
    const t = now();
    const pick = await db.prepare(
      "SELECT seq FROM allot_items WHERE ((state = 'queued' AND due_at <= ?) OR (state = 'running' AND lease_until < ?))" +
      (jobId ? " AND job_id = ?" : "") + " ORDER BY seq LIMIT 1")
      .bind(...(jobId ? [t, t, jobId] : [t, t])).first();
    if (!pick) return null;
    const r = await db.prepare(
      "UPDATE allot_items SET state = 'running', lease_until = ?, tries = tries + 1, updated_at = ? " +
      "WHERE seq = ? AND ((state = 'queued' AND due_at <= ?) OR (state = 'running' AND lease_until < ?))")
      .bind(t + LEASE_MS, t, pick.seq, t, t).run();
    if (!(r.meta?.changes > 0)) return claim(jobId);      /* somebody else took it — next one */
    return db.prepare("SELECT * FROM allot_items WHERE seq = ?").bind(pick.seq).first();
  }

  async function finish(item, state, result, error = null) {
    await db.prepare("UPDATE allot_items SET state = ?, result = ?, error = ?, lease_until = 0, updated_at = ? WHERE seq = ? AND state = 'running'")
      .bind(state, result ? JSON.stringify(result) : null, error, now(), item.seq).run();
  }

  async function failed(item, e) {
    const msg = String(e?.message || e).slice(0, 200);
    if (isTransient(e) && item.tries < TRIES) {
      const wait = BACKOFF_MS[Math.min(item.tries - 1, BACKOFF_MS.length - 1)];
      await db.prepare("UPDATE allot_items SET state = 'queued', due_at = ?, error = ?, lease_until = 0, updated_at = ? WHERE seq = ? AND state = 'running'")
        .bind(now() + wait, msg, now(), item.seq).run();
      return "retry";
    }
    await finish(item, "failed", null, msg);
    return "failed";
  }

  /* perform(item) -> { ok, why?, transient?, ...detail }. Runs items until the
     budget or `max` is spent. */
  async function drain(perform, { jobId = null, max = 4, budgetMs = 20000 } = {}) {
    await ready();
    const started = now();
    let ran = 0, done = 0, fail = 0, retry = 0;
    while (ran < max && now() - started < budgetMs) {
      const item = await claim(jobId);
      if (!item) break;
      ran++;
      try {
        const r = await perform({ ...item, contactIds: item.contact_ids ? JSON.parse(item.contact_ids) : null });
        if (r?.ok) { await finish(item, "done", r); done++; }
        else if (r?.transient) { const k = await failed(item, Object.assign(new Error(r.why || "try again"), { status: 503 })); k === "retry" ? retry++ : fail++; }
        else { await finish(item, "failed", r, String(r?.why || "not moved").slice(0, 200)); fail++; }
      } catch (e) {
        const k = await failed(item, e);
        k === "retry" ? retry++ : fail++;
      }
    }
    return { ran, done, failed: fail, retry };
  }

  async function status(jobId) {
    await ready();
    const job = await db.prepare("SELECT * FROM allot_jobs WHERE id = ?").bind(jobId).first();
    if (!job) return null;
    const counts = Object.fromEntries(((await db.prepare(
      "SELECT state, COUNT(*) n FROM allot_items WHERE job_id = ? GROUP BY state").bind(jobId).all()).results || [])
      .map((r) => [r.state, Number(r.n)]));
    const fails = ((await db.prepare(
      "SELECT company_id, to_id, error FROM allot_items WHERE job_id = ? AND state = 'failed' ORDER BY seq LIMIT 200").bind(jobId).all()).results || [])
      .map((r) => ({ companyId: r.company_id, to: r.to_id, why: r.error || "" }));
    /* Per person and the latest few, for the console's progress panel. */
    const perTo = {};
    for (const r of ((await db.prepare("SELECT to_id, state, COUNT(*) n FROM allot_items WHERE job_id = ? GROUP BY to_id, state")
      .bind(jobId).all()).results || [])) {
      const o = (perTo[r.to_id] ||= { total: 0, done: 0, failed: 0 });
      o.total += Number(r.n); if (r.state === "done") o.done += Number(r.n); if (r.state === "failed") o.failed += Number(r.n);
    }
    const recent = ((await db.prepare(
      "SELECT company_id, to_id, state, result FROM allot_items WHERE job_id = ? AND state IN ('done', 'failed', 'running') ORDER BY updated_at DESC, seq DESC LIMIT 6")
      .bind(jobId).all()).results || []).map((r) => {
      let moved = null; try { moved = JSON.parse(r.result || "null")?.contactsMoved ?? null; } catch (_) {}
      return { companyId: r.company_id, to: r.to_id, state: r.state, contacts: moved };
    });
    const contacts = Number((await db.prepare(
      "SELECT COALESCE(SUM(json_extract(result, '$.contactsMoved')), 0) n FROM allot_items WHERE job_id = ? AND state = 'done'")
      .bind(jobId).first())?.n || 0);
    const sum = (k) => counts[k] || 0;
    const left = sum("queued") + sum("running");
    return { id: job.id, kind: job.kind, by: job.by_name, total: Number(job.total), createdAt: job.created_at,
             done: sum("done"), failed: sum("failed"), superseded: sum("superseded"), cancelled: sum("cancelled"),
             queued: sum("queued"), running: sum("running"), left, finished: left === 0, failures: fails,
             perTo, recent, contacts, updatedAt: job.updated_at };
  }

  async function list(limit = 10) {
    await ready();
    const rows = (await db.prepare("SELECT id FROM allot_jobs ORDER BY created_at DESC LIMIT ?").bind(limit).all()).results || [];
    const out = [];
    for (const r of rows) out.push(await status(r.id));
    return out;
  }

  async function cancel(jobId) {
    await ready();
    const r = await db.prepare("UPDATE allot_items SET state = 'cancelled', updated_at = ? WHERE job_id = ? AND state = 'queued'")
      .bind(now(), jobId).run();
    return { cancelled: r.meta?.changes || 0 };
  }

  async function retry(jobId) {
    await ready();
    const r = await db.prepare("UPDATE allot_items SET state = 'queued', tries = 0, due_at = ?, error = NULL, updated_at = ? WHERE job_id = ? AND state = 'failed'")
      .bind(now(), now(), jobId).run();
    return { requeued: r.meta?.changes || 0 };
  }

  async function sweep() {
    await ready();
    const old = now() - KEEP_MS;
    await db.prepare("DELETE FROM allot_items WHERE job_id IN (SELECT id FROM allot_jobs WHERE created_at < ?)").bind(old).run();
    await db.prepare("DELETE FROM allot_jobs WHERE created_at < ?").bind(old).run();
  }

  return { create, drain, status, list, cancel, retry, sweep, ready };
}

/* ONE ITEM, the same for the server and the tests: the move, then the verdict
   the queue acts on — done only when everything read back on the target;
   "transient" when what stopped it was the API being busy, not the data. */
export async function performItem({ kylas, item, apiUser = "" }) {
  const { allotOne, allotContacts } = await import("./reassign.mjs");
  const r = item.kind === "contacts"
    ? await allotContacts({ kylas, companyId: item.company_id, contactIds: item.contactIds, to: item.to_id, apiUser })
    : await allotOne({ kylas, id: item.company_id, to: item.to_id, leaveActive: false, apiUser, verifyContacts: true });
  const partial = r.ok && r.contactsFailed?.length;
  const ok = r.ok && !partial;
  const why = r.why || (partial ? `${r.contactsFailed.length} contact(s) not moved — ${r.contactsFailed[0].why}` : "");
  const busy = TRANSIENT.test(why) || (r.contactsFailed || []).some((f) => TRANSIENT.test(f.why));
  return { ...r, ok, why, transient: !ok && busy };
}
