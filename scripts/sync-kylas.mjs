#!/usr/bin/env node
/* Kylas -> Airtable, nightly.
 *
 *   KYLAS_KEY=... AIRTABLE_PAT=pat... AIRTABLE_BASE=app... \
 *     node scripts/sync-kylas.mjs                  # DRY RUN, prints the plan
 *   ... node scripts/sync-kylas.mjs --apply        # actually write
 *   ... node scripts/sync-kylas.mjs --full         # ignore the watermark
 *   ... node scripts/sync-kylas.mjs --since 2026-09-01T00:00:00Z
 *   ... node scripts/sync-kylas.mjs --limit 500    # stop after N of each
 *
 * A cron at 01:00 and again at 13:00 is what Ayush asked for: "the only
 * information dump is happening twice a day between airtable and kylas".
 *
 * WHAT THIS IS FOR
 * The console is moving to read from Airtable rather than from Kylas, because
 * Kylas' search endpoint is slow, rate limited, and stops at a result window
 * that silently hid a third of the account. This is the job that keeps
 * Airtable worth reading.
 *
 * THE ONE RULE THAT MATTERS
 * Kylas owns IDENTITY. The console owns the CALL.
 * This job writes only the identity columns, listed in KYLAS_OWNED below, and
 * never the ones an associate fills in. A nightly job that wrote the whole
 * record would flatten the event rows, the flags and the KPI ladder every
 * night at one in the morning, and the damage would be a day old before
 * anybody noticed. So the field list here is a whitelist, not an exclusion
 * list: a column added to the schema later is NOT synced until somebody says
 * it should be.
 *
 * THE LADDER STILL ONLY RISES
 * A stage moved directly in Kylas has to reach the report, so the stage IS
 * synced. But KPI Rank is taken as MAX(held, incoming) exactly as a console
 * save does it, and a real move writes a Stage Transition row marked
 * "Kylas sync" so the period report counts it and can tell it apart from a
 * stage an associate set on a call.
 */
import { createClient, toConsoleContact, toConsoleCompany, idOf } from "./kylas.mjs";
import { createAirtable } from "./airtable.mjs";
import { STAGE_RUNG } from "./stages.mjs";


/* Callable, so the same sync runs from a terminal and from a scheduled Worker.
   Everything it needs arrives as arguments — see scripts/handlers.mjs for why
   reading process.env at module scope is what welds code to one runtime. */
export async function run({ env = {}, log = () => {}, apply = false, full = false, limit = 0, since = "" } = {}) {
  const APPLY = apply, FULL = full, LIMIT = Number(limit || 0);
  const KEY = env.KYLAS_KEY;
    const PAT = env.AIRTABLE_PAT;
    const BASE = env.AIRTABLE_BASE;
    /* THROWN, NOT EXITED. There is no process to exit inside a scheduled Worker,
       and calling process.exit there would take down whatever else that instance
       was doing. The caller decides what a misconfiguration means for it. */
    if (!KEY) throw new Error("Set KYLAS_KEY.");
    if (!PAT || !BASE) throw new Error("Set AIRTABLE_PAT and AIRTABLE_BASE (app...).");

    const kylas = createClient(KEY, {
      log: (m) => log("  kylas:", m),
      ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}),
      ...(env.KYLAS_GAP ? { gap: Number(env.KYLAS_GAP) } : {}),
    });
    const at = createAirtable(PAT, BASE, {
      log: (m) => log("  airtable:", m),
      ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}),
      ...(env.AIRTABLE_GAP ? { gap: Number(env.AIRTABLE_GAP) } : {}),
    });

  /* The identity columns, and nothing else. See the header. */
  const KYLAS_OWNED = {
    Companies: ["Kylas Company ID", "Name", "Owner", "Kylas Updated At",
                "Kylas Owner ID", "Kylas Stage", "Source of Data", "Batch",
                "Account Health", "Website", "Last Called At"],
    Contacts: ["Kylas Contact ID", "Name", "Designation", "LinkedIn", "Owner",
               "Current Stage", "Previous Stage", "KPI Rank", "KPI Rank At",
               "Company", "Kylas Updated At",
               "Phone", "Phones", "Email", "Emails",
               "Kylas Owner ID", "Salutation", "Source of Data", "Remarks"],
  };

  /* ENFORCED, not just documented. KYLAS_OWNED started out as a comment listing
     which columns this job may write, which is worth exactly nothing the day
     somebody adds a field to the payload and forgets. Every row goes through
     here, so a column that is not on the list cannot reach Airtable however it
     got into the object — and a blank never overwrites something already there. */
  function onlyOwned(table, f) {
    const allow = new Set(KYLAS_OWNED[table] || []);
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      if (!allow.has(k)) continue;
      if (v === "" || v === undefined || v === null) continue;
      out[k] = v;
    }
    return out;
  }

  const iso = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? new Date(t).toISOString() : ""; };

  /* ── the watermark ──────────────────────────────────────────────────────
     Read back out of the base rather than kept in a file beside it. The newest
     "Kylas Updated At" IS the answer to "what have we already got", it survives
     a lost machine, and two people running the cron cannot disagree about it. */
  async function watermark(table, field) {
    if (FULL) return "";
    /* An explicit starting point, for re-running a window by hand. A caller's
       option rather than something read off argv, because there is no argv in
       a scheduled Worker. */
    if (since) return iso(since);
    /* listTolerant, and the fallback matters more here than anywhere else.
       The watermark is read from a column a base that has never had
       repair-base.mjs run on it does not have — and Airtable answers a
       projection naming a missing field with a 422, not an empty page. Left
       as listAll, that 422 killed the whole run, every night, on exactly the
       base most likely to be behind. A missing watermark is not an error: it
       means "we have nothing yet", which is a full pull. */
    let rows;
    try {
      rows = await at.listAll(table, { fields: [field], pageSize: 100, maxPages: 200 });
    } catch (e) {
      if (!/UNKNOWN_FIELD_NAME|INVALID_FILTER|422/i.test(e.message)) throw e;
      log(`  ! ${table} has no "${field}" — treating this as a full pull. Run repair-base.mjs.`);
      return "";
    }
    let newest = "";
    for (const r of rows) {
      const v = iso(r.fields?.[field]);
      if (v && v > newest) newest = v;
    }
    return newest;
  }

  /* ── companies ─────────────────────────────────────────────────────────── */
  async function syncCompanies() {
    const since = await watermark("Companies", "Kylas Updated At");
    log(`\ncompanies — ${since ? `changed since ${since}` : "FULL pull (no watermark yet)"}`);

    /* The company crawl has no since-filter of its own, so it is filtered here.
       That is honest rather than wasteful: the crawl is cached and shared, and
       the expensive part of a nightly run is the writes, not the read. */
    const all = await kylas.companies();
    const search = kylas.lastCompanySearch?.() || {};
    if (search.truncated)
      log(`  ! the Kylas list is INCOMPLETE — ${search.total} of ${search.reportedTotal}. ` +
          `Companies missing from it will not reach Airtable.`);

    /* OLDEST FIRST. The watermark is the newest "Kylas Updated At" in the
       base, and Kylas hands the list newest first — so a run cut short after
       writing the newest rows set the watermark past everything it had not
       reached, and the next run skipped the rest for good. A first full pull is
       exactly the run most likely to be cut short. Written in ascending order,
       an interrupted run leaves the watermark where it actually stopped. */
    const changed = all.filter((c) => !since || iso(c.updatedAt) > since)
      .sort((a, b) => iso(a.updatedAt).localeCompare(iso(b.updatedAt)));
    const rows = (LIMIT ? changed.slice(0, LIMIT) : changed).map((c) => {
      /* The same mapper the console path uses, so the mirror cannot disagree
         with a live read about what a company's stage or source IS. */
      const m = toConsoleCompany(c);
      return {
        "Kylas Company ID": String(c.id),
        Name: m.name || `Company ${c.id}`,
        Owner: c.metaData?.idNameStore?.ownerId?.[String(c.ownerId)] || "",
        "Kylas Owner ID": String(c.ownerId ?? ""),
        "Kylas Stage": m.stage || "",
        "Source of Data": m.source || "",
        Batch: m.batch || "",
        "Account Health": m.accountHealth || "",
        Website: m.website || "",
        "Last Called At": m.lastCalledAt || "",
        "Kylas Updated At": iso(c.updatedAt) || undefined,
      };
    }).map((f) => onlyOwned("Companies", f));

    log(`  ${all.length} in Kylas · ${changed.length} changed · ${rows.length} to write`);
    if (!rows.length) return { seen: all.length, written: 0 };
    if (!APPLY) {
      for (const r of rows.slice(0, 5)) log(`    would upsert ${r["Kylas Company ID"]} ${r.Name}`);
      if (rows.length > 5) log(`    ... and ${rows.length - 5} more`);
      return { seen: all.length, written: 0 };
    }
    const done = await at.upsertMany("Companies", "Kylas Company ID", rows);
    log(`  wrote ${done.length}`);
    return { seen: all.length, written: done.length };
  }

  /* ── contacts ──────────────────────────────────────────────────────────── */
  async function syncContacts() {
    const since = await watermark("Contacts", "Kylas Updated At");
    log(`\ncontacts — ${since ? `changed since ${since}` : "FULL pull (no watermark yet)"}`);

    const { contacts, stalled } = await kylas.contactsChangedSince(since);
    if (stalled)
      log(`  ! the contact crawl stalled — some records could not be reached and are NOT here.`);

    const want = LIMIT ? contacts.slice(0, LIMIT) : contacts;
    if (!want.length) { log("  nothing changed"); return { seen: 0, written: 0, moved: 0 }; }

    /* What Airtable already holds for these, so the ladder can only rise and a
       stage move can be told from a stage restated. One read of the whole table
       beats one lookup per contact: 5,000 finds at the rate-limit gap is half an
       hour, the full read is a few seconds. */
    const held = new Map();
    for (const r of await at.listAll("Contacts",
          { fields: ["Kylas Contact ID", "Current Stage", "KPI Rank"], pageSize: 100, maxPages: 200 }))
      held.set(String(r.fields?.["Kylas Contact ID"] || ""), r.fields || {});

    /* Company links are by Airtable record id, so the ids have to be resolved
       before the contacts are written. */
    const coRec = new Map();
    for (const r of await at.listAll("Companies",
          { fields: ["Kylas Company ID"], pageSize: 100, maxPages: 200 }))
      coRec.set(String(r.fields?.["Kylas Company ID"] || ""), r.id);

    const rows = [];
    const moves = [];
    let unlinked = 0, firstSeen = 0;
    for (const raw of want) {
      const c = toConsoleContact(raw, {
        ownerName: raw.metaData?.idNameStore?.ownerId?.[String(raw.ownerId)],
      });
      const prev = held.get(String(c.kid)) || {};
      const prevStage = prev["Current Stage"] || "";
      const prevRank = Number(prev["KPI Rank"] || 0);
      const rank = Math.max(prevRank, STAGE_RUNG[c.stage] || 0);

      const f = {
        "Kylas Contact ID": String(c.kid),
        Name: c.pocName || "",
        Designation: c.designation || "",
        LinkedIn: c.linkedin ? (/^https?:/i.test(c.linkedin) ? c.linkedin : "https://" + c.linkedin) : "",
        Owner: c.owner || "",
        /* JSON for the console, a plain string for whoever opens the base.
           Both from the same mapped value, written together, every time. */
        Phones: c.phones?.length ? JSON.stringify(c.phones) : "",
        Phone: c.phones?.length
          ? `${c.phones[0].cc || ""} ${c.phones[0].value || ""}`.trim() : "",
        Emails: c.emails?.length ? JSON.stringify(c.emails) : "",
        Email: c.emails?.[0]?.value || "",
        "Kylas Owner ID": String(c.ownerId || raw.ownerId || ""),
        Salutation: c.salutation || "",
        "Source of Data": c.source || "",
        Remarks: c.remarks || "",
        "Current Stage": c.stage || "",
        "KPI Rank": rank,
        "Kylas Updated At": iso(raw.updatedAt) || undefined,
      };
      if (rank > prevRank) f["KPI Rank At"] = new Date().toISOString();
      if (prevStage && c.stage && prevStage !== c.stage) f["Previous Stage"] = prevStage;

      const coId = String(c.companyId || idOf(raw.company) || "");
      if (coId && coRec.has(coId)) f.Company = [coRec.get(coId)];
      else if (coId) unlinked++;

      const row = onlyOwned("Contacts", f);
      /* The merge key survives the filter whatever else does — an upsert without
         it would CREATE a duplicate rather than update. */
      row["Kylas Contact ID"] = String(c.kid);
      rows.push(row);

      /* A MOVE NEEDS A BEFORE. Two cases were being treated as one:

           prevStage set, and different   a change we can see happened  -> a move
           prevStage empty                the first time we ever saw it -> NOT a move

         The second looked harmless and is not. The period report counts FIRST
         ARRIVALS at each milestone, so a first backfill writing "new -> current
         rung" for every contact would land the entire book in the funnel at
         once, dated wherever their updatedAt happens to fall — thousands of
         arrivals in one week, a "best week ever" that never happened, on the
         dashboard Ayush asked to be motivating. An initial state is not an
         event. We record the stage and wait for it to move. */
      if (c.stage && prevStage && prevStage !== c.stage) {
        const atISO = iso(raw.updatedAt) || new Date().toISOString();
        moves.push({
          kid: String(c.kid),
          Key: `${c.kid}-${atISO}`,
          "From Stage": prevStage,
          "To Stage": c.stage,
          "Changed At": atISO,
          Owner: c.owner || "",
          Source: "Kylas sync",
        });
      } else if (c.stage && !prevStage) {
        firstSeen++;
      }
    }

    log(`  ${want.length} changed · ${rows.length} to write · ${moves.length} stage move(s)` +
        (firstSeen ? ` · ${firstSeen} seen for the first time (stage recorded, no funnel event)` : "") +
        (unlinked ? ` · ${unlinked} with a company not yet in Airtable` : ""));
    if (!APPLY) {
      for (const r of rows.slice(0, 5)) log(`    would upsert ${r["Kylas Contact ID"]} ${r.Name || "(no name)"}`);
      if (rows.length > 5) log(`    ... and ${rows.length - 5} more`);
      for (const m of moves.slice(0, 5)) log(`    would log move ${m["From Stage"] || "new"} -> ${m["To Stage"]}`);
      return { seen: want.length, written: 0, moved: 0 };
    }

    /* Oldest first, for the reason given at the companies. */
    rows.sort((a, b) => String(a["Kylas Updated At"] || "").localeCompare(String(b["Kylas Updated At"] || "")));
    const done = await at.upsertMany("Contacts", "Kylas Contact ID", rows);
    log(`  wrote ${done.length}`);
    /* The transition rows carry the contact link, which needs the ids that write
       just returned. Keyed on Key, so a re-run of the same sync is a no-op. */
    if (moves.length) {
      const byKid = new Map(done.map((r) => [String(r.fields?.["Kylas Contact ID"] || ""), r.id]));
      /* The contact id travels on the move, rather than being parsed back out of
         `Key`. The key is `${kid}-${timestamp}` and the timestamp is full of
         dashes, so splitting on "-" works only while contact ids never contain
         one — a silent dependency on someone else's id format. */
      const toWrite = moves.map(({ kid, ...f }) =>
        (byKid.has(kid) ? { ...f, Contact: [byKid.get(kid)] } : f));
      await at.upsertMany("Stage Transitions", "Key", toWrite);
      log(`  wrote ${moves.length} transition(s)`);
    }
    return { seen: want.length, written: done.length, moved: moves.length };
  }

  /* ── run ───────────────────────────────────────────────────────────────── */
  const started = Date.now();
  log(APPLY ? "Kylas -> Airtable sync" : "Kylas -> Airtable sync — DRY RUN, nothing will be written");
  log(`base ${BASE}${FULL ? " · FULL" : ""}${LIMIT ? ` · limit ${LIMIT}` : ""}`);

  /* WHAT THE MIRROR IS WORTH, recorded in the mirror.
     Once the dashboard reads companies from Airtable it can no longer see
     whether the crawl that filled it was complete — and a short mirror with
     nothing saying so is the same silent-incompleteness fault as the 10,000-row
     list that claimed to be an account. The run writes down what it managed, in
     the table that already exists for exactly this kind of note, and the proxy
     passes it to the console. */
  async function recordRun(co, ct) {
    const search = kylas.lastCompanySearch?.() || {};
    const note = {
      at: new Date().toISOString(),
      companies: { seen: co.seen, written: co.written },
      contacts: { seen: ct.seen, written: ct.written, moves: ct.moved },
      kylas: {
        reportedTotal: search.reportedTotal ?? null,
        served: search.total ?? null,
        short: search.short || 0,
        truncated: !!search.truncated,
      },
      full: FULL, limit: LIMIT || null,
    };
    if (!APPLY) { log(`\nwould record: ${JSON.stringify(note.kylas)}`); return; }
    try {
      await at.upsert("Schema Migrations", "Key", {
        Key: "last-sync", "Applied At": note.at, Note: JSON.stringify(note),
      });
    } catch (e) {
      /* Not fatal: the data is synced either way. But say it, because the
         dashboard will now be reporting a freshness it cannot verify. */
      log(`! could not record the run (${e.message.slice(0, 80)}) — the dashboard ` +
          `will not know how complete this mirror is`);
    }
  }

    const co = await syncCompanies();
    const ct = await syncContacts();
    await recordRun(co, ct);
    const seconds = (Date.now() - started) / 1000;
    log(`\n${APPLY ? "done" : "dry run done"} in ${seconds.toFixed(1)}s — ` +
        `companies ${co.written}/${co.seen}, contacts ${ct.written}/${ct.seen}, moves ${ct.moved}`);
    if (!APPLY) log("Nothing was written. Re-run with --apply.");
    /* Returned rather than printed, so a scheduled run has something to record
       and a test has something to assert on. */
    return { companies: co, contacts: ct, seconds };

}

/* ── the command line ────────────────────────────────────────────────────
   Only when this file is the program being run, so importing it costs
   nothing. `process` is checked for rather than assumed: this module is also
   loaded in runtimes that have no such thing. */
const isMain = (() => {
  try {
    return typeof process !== "undefined" && process.argv?.[1]
      && import.meta.url.endsWith(process.argv[1].split("/").pop());
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv;
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : undefined; };
  try {
    await run({
      env: process.env,
      log: (...a) => console.log(...a),
      apply: argv.includes("--apply"),
      full: argv.includes("--full"),
      limit: Number(arg("limit") || 0),
      since: arg("since") || "",
    });
  } catch (e) {
    console.error(`\nsync failed: ${e.message}`);
    process.exit(1);
  }
}
