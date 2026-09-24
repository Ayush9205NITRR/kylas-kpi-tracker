/* Saves, answered as soon as they are safe rather than when Kylas and Airtable
 * have both finished with them.
 *
 * WHY. A save is three Kylas requests and five Airtable writes, each behind
 * its API's rate limit — about three and a half seconds on the live network,
 * every one of the 200 calls an associate logs a day, with the row showing
 * "syncing" throughout. None of that time is this server working; it is
 * waiting its turn at two APIs. So the save is written here first (one D1
 * insert, strongly consistent, milliseconds), the console is told it is
 * safe, and the Kylas and Airtable half runs behind the reply.
 *
 * WHAT "SAFE" MEANS. The job row is durable before the reply is sent. If the
 * background run is cut off — the runtime recycles, Kylas is down — the job is
 * still there, and the five-minute maintenance run picks it up again. The
 * console's own outbox remains for the case where THIS server cannot be
 * reached at all.
 *
 * ONE CONTACT, ONE AT A TIME, IN ORDER. Two saves of the same new contact must
 * not run side by side: both would find no Kylas id and both would create one.
 * The save journal already stops that within one run, but two runs on two
 * instances could each be first to look. So a job only starts when every
 * earlier job for the same contact has finished — the check is part of the
 * same UPDATE that claims it, so two instances cannot both win it.
 *
 * FAILURE. A rejection (400/404/409/422: the data is wrong) is final and is
 * reported back; retrying would earn the same answer for ever. Anything else
 * — a timeout, a 5xx, a cut-off run — is retried with backoff, and gives up
 * after RETRIES tries, reported the same way. The console shows either on the
 * row, as it always has.
 */

const RETRY_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3];
const LEASE_MS = 3 * 60 * 1000;          /* a run longer than this is presumed dead */
const KEEP_MS = 7 * 24 * 3600 * 1000;    /* finished jobs, kept this long to be asked about */

export function createSaveQueue({ db, log = () => {}, now = () => Date.now() }) {
  if (!db) throw new Error("the save queue needs a D1 binding");
  let schema = null;
  const ready = () => (schema ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS save_jobs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL,
      body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      tries INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS save_jobs_due ON save_jobs (state, due_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS save_jobs_key ON save_jobs (key, seq)"),
  ]).catch((e) => { schema = null; throw e; }));

  async function enqueue(key, body) {
    await ready();
    const id = crypto.randomUUID();
    const t = now();
    await db.prepare("INSERT INTO save_jobs (id, key, body, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, key, JSON.stringify(body), t, t, t).run();
    return id;
  }

  /* Takes the job if it is due, nobody holds it, and nothing earlier for the
     same contact is unfinished. One statement, so it is atomic. */
  async function claim(id) {
    await ready();
    const t = now();
    const r = await db.prepare(
      "UPDATE save_jobs SET state = 'running', lease_until = ?, tries = tries + 1, updated_at = ? " +
      "WHERE id = ? AND ((state = 'queued' AND due_at <= ?) OR (state = 'running' AND lease_until < ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM save_jobs p WHERE p.key = save_jobs.key AND p.seq < save_jobs.seq " +
      "AND p.state IN ('queued', 'running'))")
      .bind(t + LEASE_MS, t, id, t, t).run();
    if (!(r.meta?.changes > 0)) return null;
    return db.prepare("SELECT * FROM save_jobs WHERE id = ?").bind(id).first();
  }

  async function finish(id, result) {
    await db.prepare("UPDATE save_jobs SET state = 'done', result = ?, error = NULL, lease_until = 0, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(result), now(), id).run();
  }

  async function fail(job, e) {
    /* Only a verdict on the DATA is final. 429 is "slow down", 408 a timeout,
       and 401/403 a key somebody can fix — all worth trying again. */
    const final = [400, 404, 409, 422].includes(e.status);
    const giveUp = final || job.tries >= RETRY_MS.length + 1;
    const error = JSON.stringify({ message: e.message, status: e.status || null, problems: e.problems || null });
    if (giveUp) {
      await db.prepare("UPDATE save_jobs SET state = 'dead', error = ?, lease_until = 0, updated_at = ? WHERE id = ?")
        .bind(error, now(), job.id).run();
      log(`! save ${job.id} ${final ? "rejected" : `gave up after ${job.tries} tries`}: ${e.message}`);
    } else {
      const wait = RETRY_MS[Math.min(job.tries - 1, RETRY_MS.length - 1)];
      await db.prepare("UPDATE save_jobs SET state = 'queued', due_at = ?, error = ?, lease_until = 0, updated_at = ? WHERE id = ?")
        .bind(now() + wait, error, now(), job.id).run();
      log(`! save ${job.id} failed (try ${job.tries}), again in ${Math.round(wait / 60e3)} min: ${e.message}`);
    }
  }

  /* The next job waiting on this contact, now that one has finished. */
  async function nextFor(key) {
    const r = await db.prepare(
      "SELECT id FROM save_jobs WHERE key = ? AND state = 'queued' AND due_at <= ? ORDER BY seq LIMIT 1")
      .bind(key, now()).first();
    return r?.id || null;
  }

  /* Run one job, then whatever it was holding up for the same contact. */
  async function run(id, perform) {
    let next = id;
    while (next) {
      const job = await claim(next);
      if (!job) return;
      try {
        const result = await perform(JSON.parse(job.body));
        await finish(job.id, result);
      } catch (e) {
        await fail(job, e);
        return;                           /* later saves wait behind the retry */
      }
      next = await nextFor(job.key);
    }
  }

  /* Everything that is due, oldest first — for the maintenance run. Bounded,
     so one run cannot spend its whole allowance on a backlog. */
  async function drain(perform, { max = 40, budgetMs = 8 * 60 * 1000 } = {}) {
    await ready();
    const started = now();
    const r = await db.prepare(
      "SELECT id FROM save_jobs WHERE (state = 'queued' AND due_at <= ?) OR (state = 'running' AND lease_until < ?) " +
      "ORDER BY seq LIMIT ?").bind(now(), now(), max).all();
    let ran = 0;
    for (const { id } of r.results || []) {
      if (now() - started > budgetMs) break;
      await run(id, perform);
      ran++;
    }
    /* Old finished jobs have been answered; they only need keeping long
       enough for a console that was closed to ask. */
    await db.prepare("DELETE FROM save_jobs WHERE state IN ('done', 'dead') AND updated_at < ?")
      .bind(now() - KEEP_MS).run();
    return { due: (r.results || []).length, ran };
  }

  async function status(ids) {
    await ready();
    const out = {};
    for (const id of ids.slice(0, 50)) {
      const j = await db.prepare("SELECT id, state, tries, result, error, due_at FROM save_jobs WHERE id = ?").bind(id).first();
      out[id] = j ? {
        state: j.state === "running" ? "queued" : j.state,
        tries: j.tries,
        result: j.result ? JSON.parse(j.result) : null,
        error: j.error ? JSON.parse(j.error) : null,
        retryAt: j.state === "queued" && j.tries ? new Date(j.due_at).toISOString() : null,
      } : { state: "unknown" };
    }
    return out;
  }

  async function backlog() {
    await ready();
    const r = await db.prepare("SELECT state, COUNT(*) AS n FROM save_jobs GROUP BY state").all();
    return Object.fromEntries((r.results || []).map((x) => [x.state, x.n]));
  }

  return { enqueue, run, drain, status, backlog };
}
