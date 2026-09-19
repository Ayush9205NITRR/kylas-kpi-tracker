/* A record of which saves have already created a contact in Kylas.
 *
 * THE GAP THIS CLOSES
 * The outbox retries a save the proxy never answered. "Never answered" covers
 * two very different things and the browser cannot tell them apart:
 *
 *   the request never arrived            nothing was created — retry
 *   the request arrived and the REPLY    the contact EXISTS — a retry creates
 *     was lost (proxy killed mid-POST,     it a second time
 *     laptop slept, cable out)
 *
 * The console's `fetch` rejects identically in both cases, so the queued job
 * still carries no Kylas id and the drain POSTs again. Kylas has no idempotency
 * header and no unique constraint on a contact, so it accepts the duplicate
 * happily. Two records, two owners' worth of call history split across them,
 * and the associate finds out weeks later.
 *
 * The fix is that the side which knows must remember: the proxy writes down
 * that it is ABOUT to create a contact for a given key, and what id it got.
 * A repeat of that key never creates a second one.
 *
 * WHY A FILE AND NOT A Map
 * The failure being defended against is very often the proxy itself dying —
 * that is what makes the reply go missing. Memory that dies with it is memory
 * that is never there when it is needed. This is small, written rarely (only
 * on a create, ~3% of calls) and read once at startup.
 *
 * WHAT A KEY IS
 * Supplied by the caller. The console mints an `lid` for every contact it
 * invents, stable across retries of the same save and different for two
 * different POCs — which is exactly the property needed, and which the phone
 * number does not have (a shared landline would merge two real people).
 *
 * THREE STATES, and the middle one is the whole point:
 *
 *   absent    no attempt has been made       -> create
 *   open      an attempt STARTED and never   -> we do not know. Ask Kylas
 *             finished                          before creating.
 *   done      an attempt finished, id known  -> never create; update that id
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function createJournal(fileUrl, { ttlDays = 30, log = () => {} } = {}) {
  const TTL = ttlDays * 86400000;
  /* key -> { kid, at }   kid "" means open */
  let mem = new Map();
  let dirty = false;

  try {
    const raw = JSON.parse(readFileSync(fileUrl, "utf8"));
    for (const [k, v] of Object.entries(raw.entries || {})) mem.set(k, v);
    const open = [...mem.values()].filter((e) => !e.kid).length;
    log(`save journal: ${mem.size} key(s) remembered` + (open ? `, ${open} unfinished` : ""));
  } catch { /* first run, or unreadable — an empty journal is a correct one */ }

  /* Written whole. It is a few hundred bytes and rewriting it is far cheaper
     than reasoning about a partially appended line after a kill -9. Via a temp
     file and a rename so a crash mid-write cannot leave a truncated journal
     that reads as "nothing was ever created". */
  function flush() {
    if (!dirty) return;
    const cutoff = Date.now() - TTL;
    /* Old entries are dropped, but only ones that FINISHED. An open entry is
       an unanswered question, and age does not answer it. */
    for (const [k, v] of mem) if (v.kid && Date.parse(v.at || "") < cutoff) mem.delete(k);
    const tmp = new URL(fileUrl.href + ".tmp");
    try {
      writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(mem) }));
      renameSync(tmp, fileUrl);
      dirty = false;
    } catch (e) {
      /* An unwritable journal must not stop the save. It degrades to the old
         behaviour — a duplicate is possible after a lost reply — so it is said
         out loud rather than swallowed. */
      log(`! save journal not written (${e.message}). A lost reply could duplicate a contact.`);
    }
  }

  /* In-flight, in THIS process. Two requests carrying one key at the same
     moment — a double-click, or a drain racing a save — would both find the
     journal empty and both create. The second waits for the first instead. */
  const inflight = new Map();

  return {
    /* What is known about this key. */
    lookup(key) {
      if (!key) return { state: "absent" };
      const e = mem.get(key);
      if (!e) return { state: "absent" };
      return e.kid ? { state: "done", kid: String(e.kid), at: e.at }
                   : { state: "open", at: e.at };
    },
    /* About to create. Written BEFORE the POST, so a process that dies during
       it leaves evidence that it tried. */
    open(key) {
      if (!key) return;
      mem.set(key, { kid: "", at: new Date().toISOString() });
      dirty = true;
      flush();
    },
    /* It exists, and this is its id. */
    done(key, kid) {
      if (!key || !kid) return;
      mem.set(key, { kid: String(kid), at: new Date().toISOString() });
      dirty = true;
      flush();
    },
    /* The create was refused, so nothing was made and the key is free again.
       Leaving it open would send every later retry through the Kylas lookup
       for a contact that does not exist. */
    forget(key) {
      if (!key || !mem.has(key)) return;
      mem.delete(key);
      dirty = true;
      flush();
    },
    /* Serialises the whole save for one key. A CHAIN, not "wait for the one I
       found": three at once must run one after another, and two of them each
       waiting on the same first one would still overlap with each other. */
    async once(key, fn) {
      if (!key) return fn();
      const prev = inflight.get(key) || Promise.resolve();
      const p = prev.then(() => fn(), () => fn());
      inflight.set(key, p);
      try { return await p; }
      finally { if (inflight.get(key) === p) inflight.delete(key); }
    },
    get size() { return mem.size; },
  };
}
