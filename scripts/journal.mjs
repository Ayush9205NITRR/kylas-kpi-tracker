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
 * WHY IT IS WRITTEN DOWN AND NOT HELD IN MEMORY
 * The failure being defended against is very often the proxy itself dying —
 * that is what makes the reply go missing. Memory that dies with it is memory
 * that is never there when it is needed.
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
 *
 * ── WHY THIS TAKES A STORE RATHER THAN A PATH ─────────────────────────────
 * It used to read one JSON file with node:fs at construction, hold every entry
 * in a Map and rewrite the whole file on each change. That is correct when one
 * process owns one file, and it is the reason the proxy could only run on a
 * machine with a disk of its own.
 *
 * Reading and writing ONE KEY AT A TIME is what makes it portable, and it is
 * also strictly better where it already ran: there is no whole-object
 * read-modify-write, so there is no lost update to reason about if anything
 * ever writes concurrently.
 *
 * THE STORE MUST BE STRONGLY CONSISTENT. An eventually consistent one — Workers
 * KV, say — can answer "absent" for a key that was written a second ago in
 * another location, and two retries of one save would then both create a
 * contact. That is the exact duplicate this file exists to prevent, so see the
 * note in store.mjs and use d1Store, not kvStore.
 */

/* Entries live under a prefix so the journal can share a store with anything
   else without either being able to read the other's keys by accident. */
const K = (key) => `j:${key}`;

export function createJournal(store, { ttlDays = 30, log = () => {} } = {}) {
  const TTL_SECONDS = ttlDays * 86400;

  /* In-flight, in THIS process. Two requests carrying one key at the same
     moment — a double-click, or a drain racing a save — would both find the
     journal empty and both create. The second waits for the first instead.

     THIS IS THE WEAKEST OF THE THREE DEFENCES and the only one that does not
     survive leaving the process, so it is worth naming the other two: the
     journal itself, which does survive, and findExisting() in the proxy, which
     asks Kylas whether the contact is already there. On a runtime where two
     requests can land in two separate instances, this map protects neither of
     them from the other and the journal is doing the work alone. */
  const inflight = new Map();

  async function read(key) {
    const raw = await store.get(K(key));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function write(key, entry, { expires }) {
    try {
      /* Only FINISHED entries expire. An open entry is an unanswered question,
         and age does not answer it — dropping one would send the next retry
         straight to a create for a contact that may well exist. */
      await store.put(K(key), JSON.stringify(entry),
        expires ? { ttlSeconds: TTL_SECONDS } : undefined);
    } catch (e) {
      /* An unwritable journal must not stop the save. It degrades to the
         behaviour from before there was one — a duplicate is possible after a
         lost reply — so it is said out loud rather than swallowed. */
      log(`! save journal not written (${e.message}). A lost reply could duplicate a contact.`);
    }
  }

  return {
    /* What is known about this key. */
    async lookup(key) {
      if (!key) return { state: "absent" };
      const e = await read(key);
      if (!e) return { state: "absent" };
      return e.kid ? { state: "done", kid: String(e.kid), at: e.at }
                   : { state: "open", at: e.at };
    },

    /* About to create. Written BEFORE the POST, so a process that dies during
       it leaves evidence that it tried. AWAIT THIS — the whole guarantee is
       that the record reaches the store first, and a write that is merely
       started is a write that a kill -9 can beat. */
    async open(key) {
      if (!key) return;
      await write(key, { kid: "", at: new Date().toISOString() }, { expires: false });
    },

    /* It exists, and this is its id. */
    async done(key, kid) {
      if (!key || !kid) return;
      await write(key, { kid: String(kid), at: new Date().toISOString() }, { expires: true });
    },

    /* The create was refused, so nothing was made and the key is free again.
       Leaving it open would send every later retry through the Kylas lookup
       for a contact that does not exist. */
    async forget(key) {
      if (!key) return;
      try { await store.delete(K(key)); }
      catch (e) { log(`! save journal entry not cleared (${e.message}).`); }
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

    /* Only for logs and tests — a store is not obliged to enumerate cheaply. */
    async size() {
      try { return (await store.keys()).filter((k) => k.startsWith("j:")).length; }
      catch { return -1; }
    },
  };
}
