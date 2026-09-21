/* Airtable client and the write path.
 *
 * This is the authoritative write: Airtable holds the granular data and is what
 * the KPIs are computed from. The Kylas write beside it is a mirror for anyone
 * reading the contact in the CRM.
 *
 * Everything goes through one queue. Airtable allows 5 requests a second per
 * base, and a save touches up to five tables.
 */
import { STAGE_RUNG, STAGE_LABEL, EXIT_STAGES, NOT_CONNECTED, MILESTONE } from "./stages.mjs";
import { gateFor } from "./rca.mjs";

/* Overridable so the mock can stand in during tests. */
const API = process.env.AIRTABLE_BASE_URL || "https://api.airtable.com/v0";
const GAP = Number(process.env.AIRTABLE_GAP || 220);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAirtable(pat, baseId, { log = () => {} } = {}) {
  /* The promise chain that used to pace this is gone, replaced by the pump
     below. Its hazard is not: a rejected job must never poison the ones behind
     it, which the pump handles by settling each job in its own try/catch
     rather than by threading results through a shared promise. */
  /* WAIT ONLY FOR THE REMAINDER. This slept GAP before EVERY request, whether
     or not anything had just been sent — so a proxy that had been idle for
     minutes still paid 220ms before its first read, and a save's seven
     Airtable writes paid 1540ms of sleep before a single packet left. The rate
     limit is "5 requests a second", which is a floor on the INTERVAL between
     requests, not a toll on each one.

     So: sleep only for whatever is left of GAP since the last request actually
     went out. Identical pacing under load, nothing at all when idle. */
  let lastAt = 0;

  /* WRITES JUMP THE QUEUE. One queue is not negotiable — Airtable's 5 req/s is
     per BASE, so two queues pacing at GAP each would be 10 req/s and would
     simply collect 429s — but the ORDER within it is ours, and
     first-come-first-served was the wrong choice.

     The report cache is four full table crawls. On a base with 2,000 call rows
     that is twenty pages, and every page is a request in this queue. A save
     landing while one runs used to wait behind ALL of it: seven writes stuck
     behind twenty reads, which is why some saves took three times as long as
     others for no reason the associate could see.

     A save is somebody waiting. A cache refresh is nobody waiting. Reads go to
     the back, writes to the front, one pacer over both — so the rate limit is
     respected exactly as it was. */
  /* THREE TIERS, NOT TWO. hi is a save; lo is a read somebody is waiting for;
     bg is a whole-table crawl that nothing on screen is blocked on.

     Two was not enough. The Research table is a crawl, and it is kicked off by
     the console on the first account it opens — which is exactly when /company
     is in flight, and /company is the read the BD is actually waiting for. One
     queue at 5 req/s meant a twenty-page crawl sat in front of it. Measured on
     the mock, cold: /company 2279ms with the crawl alongside it, 622ms
     without. Ayush, 2026-09-21: "the system is still experiencing noticeable
     latency… especially while making calls."

     The tier is the call site's to declare, because only the call site knows
     whether anybody is waiting. Writes stay urgent by construction. */
  const hi = [], lo = [], bg = [];
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (hi.length || lo.length || bg.length) {
        const job = hi.length ? hi.shift() : lo.length ? lo.shift() : bg.shift();
        const wait = Math.max(0, GAP - (Date.now() - lastAt));
        if (wait) await sleep(wait);
        lastAt = Date.now();
        /* Settling a job must never break the pump — an escaping throw here
           would abandon everything still queued behind it, which is the same
           hazard the old `chain` comment above describes in its own terms. */
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      }
    } finally { pumping = false; }
  }
  const queue = (fn, tier = "lo") => new Promise((resolve, reject) => {
    (tier === "hi" ? hi : tier === "bg" ? bg : lo).push({ fn, resolve, reject });
    pump();
  });

  async function call(method, path, body, tries = 4, tier = "") {
    return queue(async () => {
      for (let i = 0; i < tries; i++) {
        const res = await fetch(`${API}/${baseId}${path}`, {
          method,
          headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if (res.status === 429) { const w = 1000 * 2 ** i; log(`airtable 429, waiting ${w}ms`); await sleep(w); continue; }
        if (!res.ok) {
          const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        return text ? JSON.parse(text) : null;
      }
      throw new Error(`${method} ${path} -> still rate limited`);
    /* Anything that is not a GET is somebody's save. No call site has to know
       about this, which is the point: a write added later is urgent by
       construction rather than by remembering to say so. A read may ask to go
       last; nothing can ask to jump a write. */
    }, method !== "GET" ? "hi" : (tier === "bg" ? "bg" : "lo"));
  }

  const t = (name) => "/" + encodeURIComponent(name);

  return {
    call,
    /* So callers outside this factory can say something in the same voice —
       listTolerant needs to report a missing column and had nowhere to say it. */
    log,

    /* Airtable's own upsert: match on a field, update if found, create if not.
       Cheaper and race-free compared with select-then-write. */
    async upsert(table, mergeOn, fields) {
      const r = await call("PATCH", t(table), {
        performUpsert: { fieldsToMergeOn: [mergeOn] },
        records: [{ fields }],
        typecast: true,
      });
      return r?.records?.[0] || null;
    },

    /* The same upsert, ten records per request. One-at-a-time is right for a
       console save (one contact) and wrong for a sync: a first backfill of
       5,000 contacts at one request each, with the rate-limit gap between
       them, is well over an hour of sleeping. Ten per call is Airtable's
       documented batch size. Returns the records, in request order. */
    async upsertMany(table, mergeOn, list) {
      const out = [];
      for (let i = 0; i < list.length; i += 10) {
        const r = await call("PATCH", t(table), {
          performUpsert: { fieldsToMergeOn: [mergeOn] },
          records: list.slice(i, i + 10).map((fields) => ({ fields })),
          typecast: true,
        });
        (r?.records || []).forEach((x) => out.push(x));
      }
      return out;
    },

    async find(table, formula) {
      const r = await call("GET", `${t(table)}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`);
      return r?.records?.[0] || null;
    },

    async list(table, formula, max = 100) {
      const q = formula ? `&filterByFormula=${encodeURIComponent(formula)}` : "";
      const r = await call("GET", `${t(table)}?maxRecords=${max}${q}`);
      return r?.records || [];
    },

    /* EVERY record, following Airtable's offset. list() caps at one page, which
       is fine for the event rows of one contact and silently wrong for a table
       of 250 companies — the same class of mistake as asking Kylas for page 0
       and calling it "everything allotted to you".

       `fields` is not an optimisation: a company row carries ~30 computed
       fields and we want a named handful, so asking for them by name also
       documents which ones the dashboard depends on. */
    /* `tier: "bg"` marks a crawl nobody is waiting for, so its pages queue
       behind every interactive read instead of in front of them. Per PAGE,
       deliberately: a twenty-page crawl that yielded only between crawls would
       still block the first read behind its first page. */
    async listAll(table, { formula = "", fields = [], pageSize = 100, maxPages = 40, tier = "" } = {}) {
      const out = [];
      let offset = "";
      for (let p = 0; p < maxPages; p++) {
        const q = [`pageSize=${pageSize}`,
                   formula ? `filterByFormula=${encodeURIComponent(formula)}` : "",
                   ...fields.map((f) => `fields[]=${encodeURIComponent(f)}`),
                   offset ? `offset=${encodeURIComponent(offset)}` : ""].filter(Boolean).join("&");
        const r = await call("GET", `${t(table)}?${q}`, undefined, 4, tier);
        (r?.records || []).forEach((x) => out.push(x));
        offset = r?.offset || "";
        if (!offset) break;
      }
      return out;
    },

    async create(table, records) {
      const out = [];
      for (let i = 0; i < records.length; i += 10) {
        const r = await call("POST", t(table), { records: records.slice(i, i + 10).map((fields) => ({ fields })), typecast: true });
        (r?.records || []).forEach((x) => out.push(x));
      }
      return out;
    },

    async remove(table, ids) {
      for (let i = 0; i < ids.length; i += 10) {
        const q = ids.slice(i, i + 10).map((id) => `records[]=${encodeURIComponent(id)}`).join("&");
        await call("DELETE", `${t(table)}?${q}`);
      }
    },
  };
}

/* ── writing to a base that is one repair behind ─────────────────────── */
/* THE SAME RULE AS listTolerant, FOR THE WRITE SIDE, and it matters more here.
   A read that fails shows stale numbers; a WRITE that fails loses the call.
   Airtable rejects a whole record for one field name the table does not have,
   so the day `Phones` was added to syncContact, every save against a base that
   had not been repaired died at step 3 — before the event rows, before the call
   log, before the transition. The associate's afternoon of dialling went into
   the outbox as a 422, which the outbox correctly refuses to retry, and the
   only visible symptom was a contact card that came back empty.

   A column this base has never had cannot hold anything worth losing the rest
   of the save over. Drop the name Airtable objected to and send the record
   again. Airtable names ONE field per rejection, hence the loop; the merge key
   is never droppable, because without it the upsert has nothing to match on and
   would create a duplicate rather than update.

   Returns { rec, dropped } so the caller can say what it gave up — silently
   writing less than it was asked to is how a missing column survives for
   months. */
const unknownField = (e) =>
  /UNKNOWN_FIELD_NAME/.test(e?.message || "")
    ? (/Unknown field name:\s*\\?"([^"\\]+)/.exec(e.message)?.[1] || "")
    : "";

export async function upsertTolerant(at, table, mergeOn, fields) {
  let send = fields;
  const dropped = [];
  for (let i = 0; i <= Object.keys(fields).length; i++) {
    try {
      return { rec: await at.upsert(table, mergeOn, send), dropped };
    } catch (e) {
      const which = unknownField(e);
      /* Not a missing column, or one we did not send (so dropping it would
         loop for ever), or the key the upsert matches on — all of those are
         real failures and belong to the caller. */
      if (!which || which === mergeOn || !(which in send)) throw e;
      const { [which]: _gone, ...rest } = send;
      send = rest;
      dropped.push(which);
    }
  }
  throw new Error(`${table}: gave up dropping unknown fields (${dropped.join(", ")})`);
}

/* ── the rules, stated once ─────────────────────────────────────────── */
const filled = (v) => String(v || "").trim() !== "";
const rowsOf = (c) => [
  ...(c.past || []).map((r) => ({ ...r, period: "Past" })),
  ...(c.current || []).map((r) => ({ ...r, period: "Current" })),
];
/* Right POC: any of budget | timeline | pax on any row. Event type is not
   signal — see docs/kpi-spec.md §5. */
const hasSignal = (c) => rowsOf(c).some((r) => filled(r.budget) || filled(r.timeline) || filled(r.pax));
const isComplete = (c) => rowsOf(c).some((r) => filled(r.budget) && filled(r.timeline) && filled(r.pax));
const esc = (v) => String(v || "").replace(/'/g, "\\'");

/* ── the write ──────────────────────────────────────────────────────── */
/* One console save becomes up to five Airtable writes. Ordered so the links
   resolve: company, then contact, then everything hanging off the contact. */
export async function syncContact(at, contact, call, { log = () => {} } = {}) {
  const c = contact;
  const wrote = [];
  /* Columns this base does not have, collected across every table so the save
     reports them once instead of per write. */
  const missing = new Set();
  const put = async (table, mergeOn, fields) => {
    const { rec, dropped } = await upsertTolerant(at, table, mergeOn, fields);
    dropped.forEach((f) => missing.add(`${table}.${f}`));
    return rec;
  };

  /* 1 · company */
  let companyRec = null;
  if (c.companyId) {
    companyRec = await put("Companies", "Kylas Company ID", {
      "Kylas Company ID": String(c.companyId),
      Name: c.company || `Company ${c.companyId}`,
      /* Carried so the dashboard can attribute this company without going back
         to Kylas for it. Only written when known — an upsert with a blank owner
         would wipe one that an earlier save got right. */
      ...(c.owner ? { Owner: c.owner } : {}),
    });
    wrote.push("company");
  }

  /* 2 · the contact's existing rank, because the rank may only ever rise */
  let prev = null;
  if (c.kid) prev = await at.find("Contacts", `{Kylas Contact ID} = '${esc(c.kid)}'`);
  const prevRank = Number(prev?.fields?.["KPI Rank"] || 0);
  const computed = STAGE_RUNG[c.stage] || 0;
  const rank = Math.max(prevRank, computed);
  const rankRose = rank > prevRank;

  const fields = {
    "Kylas Contact ID": String(c.kid || ""),
    Name: c.pocName || "",
    Designation: c.designation || "",
    LinkedIn: c.linkedin ? (/^https?:/i.test(c.linkedin) ? c.linkedin : "https://" + c.linkedin) : "",
    Owner: c.owner || "",
    /* THE CONSOLE READS THESE BACK AND ITS OWN SAVE WAS NOT WRITING THEM.
       Once reads moved to Airtable, a contact saved from the console came back
       with phones: [] and emails: [] — so the card had no number to dial and
       the save gate blocked on "Phone number". The associate could not log the
       next call on a contact they had just logged one on, and the number was
       gone from the console's view until the nightly sync put it back.
       Written in exactly the shape sync-kylas.mjs uses so the reader parses
       one thing, not two.
       "Kylas Updated At" is deliberately NOT here: it is the sync's watermark,
       meaning "as of this Kylas updatedAt", and a console save is not that.
       Writing it would move the watermark past records the sync has not seen
       and skip them for ever. */
    Phones: c.phones?.length ? JSON.stringify(c.phones) : "",
    Phone: c.phones?.length ? `${c.phones[0].cc || ""} ${c.phones[0].value || ""}`.trim() : "",
    Emails: c.emails?.length ? JSON.stringify(c.emails) : "",
    Email: c.emails?.[0]?.value || "",
    Salutation: c.salutation || "",
    "Kylas Owner ID": String(c.ownerId || ""),
    "Source of Data": c.source || "",
    Remarks: c.remarks || "",
    "Current Stage": c.stage || "",
    "Previous Stage": prev?.fields?.["Current Stage"] && prev.fields["Current Stage"] !== c.stage
      ? prev.fields["Current Stage"] : (prev?.fields?.["Previous Stage"] || ""),
    "Vendor Info": c.vendorInfo || "",
    "Mode of Meeting": c.modeOfMeeting || "",
    "Service Offering": !!c.serviceOffering,
    /* NOT `computed > 0`. Every stage has a rung above zero — Could Not Connect
       is 6 — so that set Ever Picked for a contact nobody ever spoke to, and
       Companies.Phone Picked is IF({Ever Picked} = 1, 1, 0). The result was a
       headline funnel rung reading 100%: every company ever DIALLED counted as
       having answered.
       docs/kpi-spec.md §4 is explicit — "picked when the pipeline stage is not
       Could Not Connect", and the summary table row reads "stage ever != CNC".
       NOT_CONNECTED, not CNC_LADDER: the console's own copy of this rule also
       excludes the never-touched stage, and two implementations of one rule
       that disagree on an edge is how this got wrong in the first place. One
       generated definition, used by both.
       Set once and never unset, so a contact who answered and was later
       disqualified does not stop having answered. */
    "Ever Picked": !!prev?.fields?.["Ever Picked"]
      || (!!c.stage && !NOT_CONNECTED.includes(c.stage)),
    /* THE SAME FLOOR, for the two rungs that never had one. hasSignal and
       isComplete read the rows this save is sending, so a contact that has
       just qualified is latched on the save that qualifies it — and a later
       save that removes the rows finds the flag already true and OR's it back
       in. Which is the point: one mis-tapped chip can no longer walk the
       funnel backwards. See schema.mjs for the cost of this. */
    "Ever Right POC": !!prev?.fields?.["Ever Right POC"] || hasSignal(c),
    "Ever Discovery": !!prev?.fields?.["Ever Discovery"] || isComplete(c),
    "KPI Rank": rank,
    /* DERIVED, not copied. The console sets pendingCreate when it invents a
       contact offline and never clears it on the object it sends — the proxy
       creates the contact in Kylas and calls this with `{ ...c, kid }`, so the
       flag arrived true alongside a real Kylas id. The row then read "not in
       Kylas yet" for a contact that plainly was, for ever, because nothing
       downstream ever unsets it. Having the id IS the answer to the question
       this field asks, so ask it rather than trusting the caller's stale
       memory of it. Same failure as Exit Reason: a transient flag that could
       be set and not cleared. */
    "Pending Create": !!c.pendingCreate && !c.kid,
    Flagged: !!c.flagged,
    "Exit Reason": EXIT_STAGES.includes(c.stage) ? c.stage : "",
  };
  if (rankRose) fields["KPI Rank At"] = new Date().toISOString();

  /* FIRST WORKED, FIRST PICKED — written once and then left alone for ever.
     These are what the funnel's bottom two rungs are counted from, so a later
     save moving them would move a company between periods retrospectively and
     change a month that had already been reported.

     Dated from the CALL, not from now: a queued save that drains tomorrow
     belongs to the day the call happened, which is the whole reason the outbox
     carries `call.at`. */
  const firstAt = call?.at || new Date().toISOString();
  if (!prev?.fields?.["First Worked At"] && call) fields["First Worked At"] = firstAt;
  /* Picked is the same test Ever Picked uses — not a no-answer stage — so the
     two can never disagree about whether somebody spoke to this contact. */
  if (!prev?.fields?.["First Picked At"] && !!c.stage && !NOT_CONNECTED.includes(c.stage))
    fields["First Picked At"] = firstAt;
  /* AND THE SAME STAMP FOR THE TWO RUNGS IN THE MIDDLE. These latch off the
     SAME tests as Ever Right POC / Ever Discovery above — hasSignal(c) and
     isComplete(c), reading the rows this save is sending — so the flag and its
     date can never disagree about when it happened. Without this the report
     had to date them from KPI Rank At, which only moves when the stage moves;
     a contact who gave you a budget and stayed on the same stage had the flag
     set and no date, and the ladder cannot count an arrival it cannot place.
     See schema.mjs for the full account. */
  if (!prev?.fields?.["First Right POC At"] && hasSignal(c))
    fields["First Right POC At"] = firstAt;
  if (!prev?.fields?.["First Discovery At"] && isComplete(c))
    fields["First Discovery At"] = firstAt;
  if (companyRec) fields.Company = [companyRec.id];
  /* Dropping blanks protects USER-ENTERED fields: a value absent from this
     save is not an instruction to wipe what somebody typed last time. */
  for (const k of Object.keys(fields)) if (fields[k] === "") delete fields[k];
  /* But Exit Reason is DERIVED from the stage, not entered, so it has to track
     the stage in both directions. Dropped along with the other blanks, it could
     be set and never cleared: a contact marked Not Interested who later
     re-engaged stayed flagged as exited for ever, on a field whose whole job is
     to say where they stopped. Assigned after the blank pass, so "" is written
     rather than skipped. */
  fields["Exit Reason"] = EXIT_STAGES.includes(c.stage) ? c.stage : "";
  fields["Kylas Contact ID"] = String(c.kid || "");

  /* 3 · the contact */
  const contactRec = await put("Contacts", "Kylas Contact ID", fields);
  wrote.push("contact");
  if (!contactRec) throw new Error("Airtable did not return the contact record");

  /* 4 · event rows, matched on the key the overlay assigns */
  const rows = rowsOf(c).filter((r) => r.rowKey);
  for (const r of rows) {
    await put("Event Rows", "Row Key", {
      "Row Key": r.rowKey,
      Period: r.period,
      "Event Type": r.eventType || "",
      Budget: r.budget || "",
      Timeline: r.timeline || "",
      Pax: r.pax || "",
      Remarks: r.remarks || "",
      /* Blank on every live row, which is what makes Restore work: the row
         comes back in `rows`, this upsert runs, and the tombstone clears. */
      "Removed At": "",
      Contact: [contactRec.id],
    });
  }
  /* A row the console no longer holds must stop counting toward Right POC —
     but MARKING it does that just as well as deleting it did, and deleting it
     destroyed the only copy of the budget, timeline and pax somebody typed.
     One mis-tapped chip took all three with it, and nothing else in this base
     or in Kylas keeps them: Call Log carries no event fields and the remarks
     block is rewritten on this same save.

     So: set Removed At. Has Any Signal and Is Complete gate on it, so the
     arithmetic is identical to the delete it replaces, and the row can be
     restored with everything on it. A row the console sends back has its
     Removed At cleared by the upsert loop above, which writes every live row
     unconditionally. */
  /* ONLY WHEN SOMETHING WAS ACTUALLY REMOVED. This listed every Event Row the
     contact has on EVERY save, to find rows the console no longer holds — a
     whole round trip, on every call, to discover nothing almost every time.

     The console now says so directly: it keeps removed rows in `removed`
     rather than dropping them, so an absent-or-empty list means there is
     nothing to mark and nothing to look for. `undefined` is the old console
     talking, and that one still gets the read — dropping it there would leave
     its removals counting toward Right POC for ever, which is the bug the
     stale pass exists to prevent. */
  const removedHere = c.removed;
  const mayHaveStale = removedHere === undefined || removedHere.length > 0;
  if (c.kid && mayHaveStale) {
    const held = await at.list("Event Rows", `{Kylas Contact ID (from Contact)} = '${esc(c.kid)}'`).catch(() => []);
    const keep = new Set(rows.map((r) => r.rowKey));
    const stale = held.filter((h) => h.fields["Row Key"] && !keep.has(h.fields["Row Key"])
                                  && !h.fields["Removed At"]);
    /* Through the same tolerant upsert the live rows use, keyed on Row Key.
       An upsert PATCH writes only the fields it is given, so this marks the
       row without touching the values it is there to protect — and on a base
       that has not been repaired yet, upsertTolerant drops the unknown column
       and reports it rather than failing the save. */
    const stamp = new Date().toISOString();
    for (const h of stale)
      await put("Event Rows", "Row Key", { "Row Key": h.fields["Row Key"], "Removed At": stamp });
    if (stale.length) wrote.push(`marked ${stale.length} row(s) removed`);
  }
  if (rows.length) wrote.push(`${rows.length} event row(s)`);

  /* 5 · the call, append-only and idempotent on its key */
  if (call) {
    const key = `${call.at}-${c.kid || c.pocName}`;
    await put("Call Log", "Key", {
      Key: key,
      "Called At": call.at,
      Outcome: call.outcome || "",
      Duration: call.duration ?? 0,
      "Duration Source": call.durationSource || "none",
      Owner: c.owner || "",
      "Stage Set": c.stage || "",
      "Created Here": !!call.createdHere,
      Contact: [contactRec.id],
    });
    wrote.push("call log");
  }

  /* 6 · the transition, only when the stage actually moved */
  const from = prev?.fields?.["Current Stage"] || "";
  if (from !== c.stage && c.stage) {
    const at_ = call?.at || new Date().toISOString();
    await put("Stage Transitions", "Key", {
      Key: `${c.kid || c.pocName}-${at_}`,
      "From Stage": from,
      "To Stage": c.stage,
      "Changed At": at_,
      Owner: c.owner || "",
      Source: "Console",
      /* The mode as it stands on this save, frozen onto the move. The contact
         keeps only the latest one, so without this the discovery call and the
         SQL meeting are indistinguishable the moment a second mode is entered. */
      Mode: c.modeOfMeeting || "",
      Contact: [contactRec.id],
    });
    wrote.push(`transition ${STAGE_LABEL[from] || from || "new"} -> ${STAGE_LABEL[c.stage] || c.stage}`);
  }

  /* Said EVERY save, not once at startup: this is the line that tells whoever
     is watching the proxy why a field they can see in the console is not in the
     base. It is also the only trace, because the save itself succeeded. */
  if (missing.size)
    log(`! this base has no ${[...missing].join(", ")} — saved without ${missing.size === 1 ? "it" : "them"}. Run repair-base.mjs.`);

  /* THIS SAVE JUST INVALIDATED THE READ CACHES BELOW. Held caches are what
     make opening an account fast; a save that does not clear them is what
     makes an associate reopen the company they just saved and be shown it
     without their own call. The write side has to know about them — nobody
     else can, because nobody else knows a write happened. */
  dropReadCaches();

  log(`airtable: ${wrote.join(", ")}`);
  return { recordId: contactRec.id, rank, rankRose, rightPOC: hasSignal(c), discovery: isComplete(c),
           wrote, missing: [...missing] };
}

/* ── the read ───────────────────────────────────────────────────────── */
/* THE KPI FIELDS THE DASHBOARD DEPENDS ON, named.
 *
 * Until now the dashboard recomputed every one of these in the browser from
 * Kylas data, so the same rules existed twice — once as the Airtable formulas
 * in scripts/schema.mjs, once as JavaScript in views.js — and only the browser
 * copy was ever on screen. They can drift, and they did: the browser copy was
 * crediting a successful discovery to a meeting that only existed in the diary.
 *
 * Airtable is the definition now. This list is the contract between the two. */
export const KPI_FIELDS = [
  /* "Owner" was here and is NOT a field on the Companies table — the company's
     owner lives in Kylas, not in the KPI store. Airtable rejects a fields[]
     entry it does not recognise, so ONE wrong name failed the whole read, every
     KPI fell back to the browser, and the console showed the amber
     "Airtable unavailable" badge. test-kpi-fields.mjs now checks this list
     against the schema, so a name that does not exist cannot ship again. */
  "Kylas Company ID", "Name", "Owner",
  /* the ladder */
  "KPI Rank", "KPI Stage", "KPI Stage At",
  /* the funnel, one flag each — every one an Airtable formula */
  "Reached", "Phone Picked", "Right POC", "Successful Discovery",
  "SQL Meeting Booked", "SQL Meeting Done", "SQL",
  /* the names behind the flags, which is what a manager actually asks for */
  "Right POC Contacts", "Discovery Contacts",
  "Contact Count", "Last Call At", "Call Count", "Talk Seconds",
];

const flag = (v) => v === 1 || v === true || v === "1";

/* Every company Airtable knows, keyed by Kylas company id.
 *
 * Keyed on the Kylas id and not on Airtable's own record id, because the join
 * the console can make is the Kylas one — it has never seen an Airtable
 * record id and should not need to. */
export async function readCompanyKpis(at, { log = () => {} } = {}) {
  /* Asking for named fields is how the dependency stays documented, but one
     name Airtable does not recognise fails the ENTIRE read — which is how a
     single stale entry took every KPI off the dashboard. Falling back to "give
     me everything" costs bandwidth and keeps the numbers on screen, which is
     the right trade the one time it matters. */
  let recs;
  try {
    recs = await at.listAll("Companies", { fields: KPI_FIELDS });
  } catch (e) {
    if (!/UNKNOWN_FIELD_NAME|INVALID_FILTER|422/i.test(e.message)) throw e;
    log(`! airtable rejected the KPI field list (${e.message.slice(0, 120)})`);
    log(`  reading every field instead — run scripts/test-kpi-fields.mjs to find the bad name`);
    recs = await at.listAll("Companies");
  }
  const byKylasId = new Map();
  let skipped = 0;
  for (const r of recs) {
    const f = r.fields || {};
    const id = String(f["Kylas Company ID"] || "").trim();
    /* A company with no Kylas id cannot be joined to anything the console
       holds. Counted rather than dropped silently — it means a row was created
       by hand in Airtable, which is worth knowing about. */
    if (!id) { skipped++; continue; }
    byKylasId.set(id, {
      name: f.Name || "",
      owner: f.Owner || "",
      rank: Number(f["KPI Rank"] || 0),
      stage: f["KPI Stage"] || "",
      stageAt: f["KPI Stage At"] || "",
      reached: flag(f.Reached),
      picked: flag(f["Phone Picked"]),
      right: flag(f["Right POC"]),
      discovery: flag(f["Successful Discovery"]),
      booked: flag(f["SQL Meeting Booked"]),
      done: flag(f["SQL Meeting Done"]),
      sql: flag(f.SQL),
      /* ARRAYJOIN gives "Hema Bharathi, Shipra Gupta" — split back so the
         console never has to parse a display string. */
      rightNames: String(f["Right POC Contacts"] || "").split(",").map((x) => x.trim()).filter(Boolean),
      discoveryNames: String(f["Discovery Contacts"] || "").split(",").map((x) => x.trim()).filter(Boolean),
      contacts: Number(f["Contact Count"] || 0),
      lastCalledAt: String(f["Last Call At"] || "").slice(0, 10),
      calls: Number(f["Call Count"] || 0),
      talkSeconds: Number(f["Talk Seconds"] || 0),
    });
  }
  log(`airtable kpis: ${byKylasId.size} compan${byKylasId.size === 1 ? "y" : "ies"}`
      + (skipped ? ` (${skipped} with no Kylas id, skipped)` : ""));
  return byKylasId;
}

/* ── READING THE CONSOLE OUT OF AIRTABLE ────────────────────────────────
 * The console used to fetch every contact and company from Kylas on the way
 * in. That path is slow, rate limited, and stops at a result window that hid a
 * third of Ayush's account without saying so. Once the nightly sync keeps
 * Airtable current, the same questions are far better answered here.
 *
 * These build the SAME shape scripts/kylas.mjs builds, field for field — the
 * console must not be able to tell which side answered, or every consumer
 * grows a branch and the two drift. Where Airtable holds more than Kylas does
 * (the event rows, the flags an associate set) that is carried too, so a fresh
 * browser on a new machine opens a contact fully populated instead of blank.
 *
 * NOTHING HERE FALLS BACK ON ITS OWN. A caller that gets nothing decides what
 * that means; an empty answer dressed up as a real one is the fault this whole
 * project keeps running into.
 */
const jsonOr = (v, dflt) => {
  if (!v) return dflt;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : dflt; }
  catch { return dflt; }
};

/* Event Rows -> the console's past/current arrays. */
function eventRows(rows) {
  const past = [], current = [];
  for (const r of rows) {
    const f = r.fields || {};
    const row = { rowKey: f["Row Key"] || "", eventType: f["Event Type"] || "",
                  budget: f.Budget || "", timeline: f.Timeline || "",
                  pax: f.Pax || "", remarks: f.Remarks || "" };
    (f.Period === "Past" ? past : current).push(row);
  }
  return { past, current };
}

export function toConsoleContactFromAirtable(rec, { company, events } = {}) {
  const f = rec?.fields || {};
  const { past, current } = eventRows(events || []);
  return {
    kid: String(f["Kylas Contact ID"] || ""),
    salutation: f.Salutation || "",
    pocName: f.Name || "",
    company: company?.name || "",
    companyId: company?.id ? String(company.id) : "",
    linkedin: f.LinkedIn || "",
    designation: f.Designation || "",
    emails: jsonOr(f.Emails, f.Email ? [{ type: "OFFICE", value: f.Email, primary: true }] : []),
    phones: jsonOr(f.Phones, []),
    stage: f["Current Stage"] || "",
    stageLabel: STAGE_LABEL[f["Current Stage"]] || "",
    source: f["Source of Data"] || "",
    nextCallDate: "", nextCallTime: "",
    remarks: f.Remarks || "",
    offsiteTimeline: "",
    owner: f.Owner || "",
    ownerId: String(f["Kylas Owner ID"] || ""),
    /* Airtable HAS these, unlike Kylas. A first load on a new machine gets the
       associate's own work back instead of an empty card. */
    past, current,
    vendorInfo: f["Vendor Info"] || "",
    serviceOffering: !!f["Service Offering"],
    modeOfMeeting: f["Mode of Meeting"] || "",
    done: false,
    flagged: !!f.Flagged,
    exitReason: f["Exit Reason"] || "",
    _airtable: { recordId: rec.id, rank: Number(f["KPI Rank"] || 0),
                 updatedAt: f["Kylas Updated At"] || "" },
  };
}

/* ONE MISSING COLUMN MUST NOT FAIL THE WHOLE READ.
   Airtable rejects a projection naming any field the table does not have, and
   it rejects the entire request rather than the one name — so a base that is
   one repair-base behind makes the console's queue read fail outright. It
   degrades to Kylas because of the fallback, which means the flip silently
   does not happen and the only trace is a truncated line in a log.
   Ask again without the projection instead: more bytes, still an answer. */
export async function listTolerant(at, table, opts) {
  try {
    return await at.listAll(table, opts);
  } catch (e) {
    if (!/UNKNOWN_FIELD_NAME/.test(e.message)) throw e;
    const which = /Unknown field name:\s*\\?"([^"\\]+)/.exec(e.message)?.[1] || "one it asked for";
    at.log?.(`! ${table} has no field "${which}" — reading every field instead. Run repair-base.`);
    const { fields, ...rest } = opts || {};
    return at.listAll(table, rest);
  }
}

const CONTACT_READ_FIELDS = [
  "Kylas Contact ID", "Name", "Salutation", "Designation", "LinkedIn", "Owner",
  "Kylas Owner ID",
  "Phone", "Phones", "Email", "Emails", "Source of Data", "Remarks",
  "Current Stage", "KPI Rank", "Kylas Updated At",
  "Vendor Info", "Mode of Meeting", "Service Offering", "Flagged", "Exit Reason",
  "Company",
];

/* Event rows for a set of contacts, in ONE read rather than one per contact.
   A company of 30 contacts would otherwise be 30 requests behind the rate
   limit gap before the console could paint anything.

   AND CACHED, for the same reason the contact scan beside it is. This scanned
   the WHOLE Event Rows table on every company open and every queue read —
   sixty pages on a busy base, every single time an associate clicked an
   account, for rows that had not changed since the click before. It was the
   largest remaining cost in /company. Dropped by dropReadCaches() on every
   save, so a row you just wrote is never missing from the account you reopen.

   Split from the filter on purpose: the scan does not depend on WHICH contacts
   are wanted, so readCompany can start it in parallel with the contact read
   rather than after it. */
const EVENTS = { at: 0, rows: null, inflight: null, gen: 0 };

async function allEventRows(at, tier = "") {
  if (EVENTS.rows && Date.now() - EVENTS.at < SCAN_TTL) return EVENTS.rows;
  /* One flight. Two company opens a moment apart would otherwise start two
     identical sixty-page crawls and pace each other into the rate limit. */
  if (!EVENTS.inflight) {
    /* THE GENERATION, not just a timestamp. A crawl in the air when a save
       lands was started BEFORE that write, so its rows are stale — but it
       resolves afterwards and would stamp EVENTS.at with the time it finished,
       which reads as fresh. The next person to open that account would be
       shown it without the row they had just typed, and a re-open would not
       fix it for thirty seconds. So a flight only publishes if nothing has
       invalidated the cache since it started; its caller still gets the rows
       it fetched, which is correct for the read that asked. */
    const gen = EVENTS.gen;
    EVENTS.inflight = listTolerant(at, "Event Rows", {
      fields: ["Row Key", "Period", "Event Type", "Budget", "Timeline", "Pax", "Remarks", "Contact"],
      pageSize: 100, maxPages: 60, tier,
    }).then((rows) => {
      if (EVENTS.gen === gen) { EVENTS.at = Date.now(); EVENTS.rows = rows; }
      return rows;
    }).finally(() => { EVENTS.inflight = null; });
  }
  return EVENTS.inflight;
}

const eventsByContact = (all, recordIds) => {
  const want = new Set(recordIds);
  const by = new Map();
  for (const r of all) {
    const owner = (r.fields?.Contact || [])[0];
    if (!owner || !want.has(owner)) continue;
    if (!by.has(owner)) by.set(owner, []);
    by.get(owner).push(r);
  }
  return by;
};

async function eventsFor(at, recordIds) {
  if (!recordIds.length) return new Map();
  return eventsByContact(await allEventRows(at), recordIds);
}

/* CACHED, because it was being rebuilt per request. Reading ONE contact was
   scanning the whole Companies table plus the whole Event Rows table — three
   full scans to answer a question about one row, which made the Airtable path
   measurably SLOWER than the Kylas path it was meant to replace (1140ms vs
   918ms on the queue, 677 vs 461 on a contact). The company list only changes
   when the sync runs, so it is worth holding. */
const IDX = { at: 0, byRec: null, byKid: null };
const IDX_TTL = Number(process.env.AIRTABLE_INDEX_TTL_MS || 60_000);

async function companyIndex(at, fresh, tier = "") {
  if (!fresh && IDX.byRec && Date.now() - IDX.at < IDX_TTL)
    return { byRec: IDX.byRec, byKid: IDX.byKid };
  const rows = await at.listAll("Companies",
    { fields: ["Kylas Company ID", "Name", "Owner"], pageSize: 100, maxPages: 200, tier });
  const byRec = new Map(), byKid = new Map();
  for (const r of rows) {
    const co = { id: String(r.fields?.["Kylas Company ID"] || ""),
                 name: r.fields?.Name || "", owner: r.fields?.Owner || "", recordId: r.id };
    byRec.set(r.id, co);
    if (co.id) byKid.set(co.id, co);
  }
  IDX.at = Date.now(); IDX.byRec = byRec; IDX.byKid = byKid;
  return { byRec, byKid };
}

/* One contact by its Kylas id. Returns null when Airtable does not hold it —
   never a blank contact carrying only the id, which is what made a contact
   page look like a real empty record. */
export async function readContact(at, kid) {
  const rec = await at.find("Contacts", `{Kylas Contact ID} = '${esc(kid)}'`);
  if (!rec) return null;
  /* This contact's rows only — the same filter syncContact already uses. The
     bulk scan below is for a whole queue and is the wrong tool for one card. */
  const [{ byRec }, events] = await Promise.all([
    companyIndex(at),
    at.list("Event Rows", `{Kylas Contact ID (from Contact)} = '${esc(kid)}'`, 50).catch(() => []),
  ]);
  const co = byRec.get((rec.fields?.Company || [])[0]) || null;
  return toConsoleContactFromAirtable(rec, { company: co, events });
}

/* Whether this base has the rollup that makes a company's contacts findable
   server-side. Learned from the first rejection and remembered. */
let noCompanyRollup = false;

/* THE WHOLE CONTACTS TABLE, briefly held.
   Only the fallback above uses it, and only on a base without the rollup — but
   that is the base Ayush is actually running, and without this, opening five
   accounts in a row scanned every contact five times. Every one of those scans
   returns the same rows: the table changes when somebody saves, not between
   two clicks a second apart.

   Short, because the queue beside it is live data and an associate who saves a
   contact and reopens its company should not be shown the version from before.
   Thirty seconds is longer than a double-click and shorter than a call. */
const SCAN = { at: 0, rows: null };
const SCAN_TTL = Number(process.env.AIRTABLE_SCAN_TTL_MS || 30_000);

/* Called by syncContact, which is the only thing in this module that writes.
   Both caches are of rows a save can change — the contact itself, and the
   company it may have just created. */
export function dropReadCaches() {
  SCAN.at = 0; SCAN.rows = null;
  IDX.at = 0; IDX.byRec = null; IDX.byKid = null;
  /* The event rows too — a save writes them, and an associate who reopens the
     account they just saved must not be shown it without the row they typed.
     Bumping the generation also disowns any crawl already in the air, which
     started before this write; see allEventRows. */
  EVENTS.at = 0; EVENTS.rows = null; EVENTS.gen++;
}
async function allContacts(at, tier = "") {
  if (SCAN.rows && Date.now() - SCAN.at < SCAN_TTL) return SCAN.rows;
  const rows = await listTolerant(at, "Contacts",
    { fields: CONTACT_READ_FIELDS, pageSize: 100, maxPages: 200, tier });
  SCAN.at = Date.now(); SCAN.rows = rows;
  return rows;
}

/* The three scans /company and /queue are built from, filled before anybody
   asks. Called once at proxy start: the first account opened in the morning
   used to pay for all three while somebody watched it, and that click is the
   one an associate judges the console by.

   tier "bg" throughout — nobody is waiting for a warm-up, and it must not sit
   in front of the first real read if one arrives mid-flight. One caveat worth
   stating plainly: a /company arriving while the event crawl is still in the
   air JOINS that flight rather than starting a second, so it inherits
   background pacing for the remainder of it. That is still the better of the
   two — a second identical sixty-page crawl would pace against the first and
   both would finish later — and it only applies in the seconds after boot. */
export async function warmAccountReads(at) {
  await Promise.all([companyIndex(at, false, "bg"), allContacts(at, "bg"), allEventRows(at, "bg")]);
}

/* Every contact at one company, plus the company itself. */
export async function readCompany(at, companyKid) {
  /* THE EVENT SCAN DOES NOT DEPEND ON WHICH CONTACTS WE WANT — it reads the
     whole table and the filtering happens here. It used to be awaited LAST, so
     a company open was three round trips nose to tail: index, then contacts,
     then events. Started here it overlaps both, and on a warm cache it has
     already resolved by the time anything needs it.

     Errors are picked up at the await below; this is only the head start. */
  const eventsSoon = allEventRows(at).catch((e) => e);
  const { byKid } = await companyIndex(at);
  const co = byKid.get(String(companyKid));
  if (!co) return null;
  /* Server-side when the base has the rollup, in memory when it does not.
     THE FALLBACK HAS TO CATCH, NOT CHECK FOR EMPTY. This was written to fall
     back "if the field does not exist", but tested `recs.length` — and Airtable
     does not answer a formula naming a missing field with zero rows, it answers
     with INVALID_FILTER_BY_FORMULA. The fallback was unreachable, the whole
     read threw, and every company open fell through to Kylas after paying for
     the failed request. Run repair-base to get the fast path. */
  let recs = null;
  /* ASKED ONCE PER PROCESS, not once per company. A base either has the rollup
     or it does not, and that does not change between two clicks — but this was
     paying for the rejection again on every single account opened, which on a
     rate-limited API is a full round trip of pure waiting before the slow path
     even starts. Ayush's log shows the same "asking Kylas" line three times in
     two minutes for exactly this. */
  if (!noCompanyRollup) {
    try {
      recs = await listTolerant(at, "Contacts",
        { formula: `{Company Kylas ID} = '${esc(companyKid)}'`,
          fields: CONTACT_READ_FIELDS, pageSize: 100, maxPages: 20 });
    } catch (e) {
      if (!/INVALID_FILTER_BY_FORMULA|UNKNOWN_FIELD_NAME|422/i.test(e.message)) throw e;
      noCompanyRollup = true;
      at.log?.(`  Contacts has no "Company Kylas ID" rollup — scanning instead, for the rest of this session. Run repair-base.`);
    }
  }
  const rows = recs?.length ? recs
    : (await allContacts(at)).filter((r) => (r.fields?.Company || [])[0] === co.recordId);
  /* The head start, collected. A rejection was caught into the value above so
     it could not become an unhandled rejection while nothing was awaiting it;
     it is rethrown here, where the caller is listening. */
  const all = await eventsSoon;
  if (all instanceof Error) throw all;
  const events = eventsByContact(all, rows.map((r) => r.id));
  return {
    company: { id: co.id, name: co.name, owner: co.owner },
    contacts: rows.map((r) => toConsoleContactFromAirtable(r,
      { company: co, events: events.get(r.id) || [] })),
  };
}

/* The dialling queue: every contact, optionally narrowed to one owner. */
export async function readQueue(at, owner) {
  /* The contact scan and the company index do not depend on each other, and
     the client serialises requests behind its rate-limit gap anyway — but
     asking for them together lets it pipeline instead of waiting out a full
     round trip before even starting the second. */
  /* All three together, for the same reason: the event scan reads the whole
     table and narrows here, so it never needed to wait for the contact list.

     allContacts, NOT a fresh listTolerant of the same table with the same
     projection — which is what this was. A second, uncached copy of the
     identical crawl: /queue paid 2.6s on a 900-contact base for rows the cache
     next to it already held, every time, and it is the screen the console
     opens on. */
  const [rows, { byRec }, all] = await Promise.all([
    allContacts(at),
    companyIndex(at),
    allEventRows(at),
  ]);
  const mine = owner && owner !== "all"
    ? rows.filter((r) => String(r.fields?.Owner || "") === String(owner)) : rows;
  const events = eventsByContact(all, mine.map((r) => r.id));
  return mine.map((r) => toConsoleContactFromAirtable(r, {
    company: byRec.get((r.fields?.Company || [])[0]) || null,
    events: events.get(r.id) || [],
  }));
}

/* ── THE DASHBOARD'S COMPANY LIST, WITHOUT A JOIN ───────────────────────
 * /companies used to crawl every company out of Kylas and then join each one
 * to an Airtable row by Kylas company id. That join is where the funnel kept
 * reading zero: the crawl stopped at a result window, so the ids it held and
 * the ids Airtable held did not overlap, and the dashboard said "no company
 * matched Airtable" without being able to say why.
 *
 * Read from here and there is nothing to join. The company row and its KPI
 * formulas are the same record — a company cannot fail to match itself. The
 * whole class of fault disappears rather than being diagnosed better.
 */
const COMPANY_READ_FIELDS = [
  "Kylas Company ID", "Name", "Owner", "Kylas Owner ID", "Kylas Stage",
  "Source of Data", "Batch", "Account Health", "Website", "Last Called At",
  "Kylas Updated At",
];

export async function readCompanies(at) {
  /* Two projections rather than one: KPI_FIELDS is checked against the schema
     by test-kpi-fields, and the mirror columns are new. Asking for them
     together would mean one missing name costs both halves. */
  const [base, kpis] = await Promise.all([
    listTolerant(at, "Companies", { fields: COMPANY_READ_FIELDS, pageSize: 100, maxPages: 200 }),
    readCompanyKpis(at).catch(() => new Map()),
  ]);
  return base.map((r) => {
    const f = r.fields || {};
    const id = String(f["Kylas Company ID"] || "");
    return {
      id,
      /* The Airtable record id as well as the Kylas one. Contacts and
         transitions link to a company by RECORD, so anything joining those
         back to a company needs both halves of the identity. */
      recordId: r.id,
      name: f.Name || (id ? `Company ${id}` : ""),
      stage: f["Kylas Stage"] || "",
      lastCalledAt: f["Last Called At"] || null,
      accountHealth: f["Account Health"] || null,
      source: f["Source of Data"] || "",
      batch: f.Batch || null,
      website: f.Website || null,
      owner: f.Owner || "",
      ownerId: String(f["Kylas Owner ID"] || ""),
      /* Attached, not joined. */
      kpi: kpis.get(id) || null,
      _airtable: { updatedAt: f["Kylas Updated At"] || "" },
    };
  });
}

/* ── THE FOUR RUNGS THAT ARE NOT STAGE MOVES ───────────────────────────
   Companies worked, phone picked, right POC and discovery do not have
   transition rows: nothing in Kylas changes when somebody writes down a
   budget. They are DATA becoming true on a contact, so the report takes them
   as `signals` — and a signal needs a date, because a rung with no date cannot
   be placed in a week or a month and is dropped.

   THE FIELDS TO READ, kept beside the function that reads them so a field
   added to one is not missing from the other. That divergence is exactly how
   this broke: First Right POC At was not read, so it could not be used.

   WHY THE FALLBACK CHAIN. Rows written before First Right POC At existed have
   the flag and no stamp, and dropping them would make the fix look like a
   regression — the rung would go from wrong to empty. So:
     1. the stamp, when the writer set it;
     2. KPI Rank At, what the proxy used to use — right whenever the stage
        moved on the same save, which is the common case for old rows;
     3. First Worked At / First Picked At — the contact was certainly a right
        POC no earlier than the first time anybody called them.
   Each step is a worse answer than the one above it and none invents a date
   out of nothing. A row with no date anywhere is reported in `undated` rather
   than silently discarded, because "we hold this and cannot count it" is a
   thing somebody needs to be told. */
export const SIGNAL_READ_FIELDS = [
  "Name", "Owner", "Is Right POC", "Is Discovery", "KPI Rank At", "Company",
  "First Worked At", "First Picked At", "First Right POC At", "First Discovery At",
];

export function contactSignals(rows = []) {
  const signals = [];
  const undated = [];
  for (const r of rows) {
    const f = r.fields || {};
    /* A contact with no company link is a company of one — dropping it would
       lose the rung, and an account nobody has linked is still an account
       somebody worked. Same rule as the transitions above. */
    const company = (f.Company || [])[0] || r.id;
    const owner = f.Owner;
    if (f["First Worked At"])
      signals.push({ at: f["First Worked At"], owner, company, metric: "worked" });
    if (f["First Picked At"])
      signals.push({ at: f["First Picked At"], owner, company, metric: "picked" });

    const fallback = f["KPI Rank At"] || f["First Worked At"] || f["First Picked At"] || "";
    const add = (metric, stamp) => {
      const at = stamp || fallback;
      if (at) signals.push({ at, owner, company, metric, dated: stamp ? "stamp" : "fallback" });
      else undated.push({ contact: r.id, name: f.Name || "", metric });
    };
    if (f["Is Right POC"]) add("right", f["First Right POC At"]);
    if (f["Is Discovery"]) add("discovery", f["First Discovery At"]);
  }
  return { signals, undated };
}

/* ── RCA: which accounts owe an explanation ────────────────────────────
   The whole computation is here rather than in the console, because it decides
   what somebody is asked to account for and that must not depend on which
   browser tab is open. The console is told; it does not work it out.

   Two reads: every contact's rung and arrival date, and every RCA row already
   written. A contact that has answered is not asked again — but one whose
   answer is stale because it has since moved on is not asked either, because
   gateFor only fires while it is still stuck. */
const RCA_READ_FIELDS = [
  "Kylas Contact ID", "Name", "Owner", "KPI Rank", "KPI Rank At",
  "Has Signal", "Has Complete Row", "Current Stage", "Company",
];

export async function readRcaDue(at, { owner = "", now = Date.now(), log = () => {} } = {}) {
  const [contacts, asked] = await Promise.all([
    listTolerant(at, "Contacts", { fields: RCA_READ_FIELDS, pageSize: 100, maxPages: 400 }),
    listTolerant(at, "RCA", { fields: ["Key", "Gate", "Reason", "Answered At"],
                              pageSize: 100, maxPages: 200 }).catch(() => []),
  ]);
  /* Answered, by key. An unanswered row is one we asked and nobody replied to,
     which is still due — the question does not go away because it was posed. */
  const answered = new Set(asked.filter((r) => r.fields?.Reason)
                                .map((r) => String(r.fields?.Key || "")));

  const out = [];
  for (const r of contacts) {
    const f = r.fields || {};
    const kid = String(f["Kylas Contact ID"] || "");
    if (!kid) continue;
    if (owner && String(f.Owner || "") !== owner) continue;
    /* The same rungs the funnel uses, read from the base's own formulas rather
       than recomputed here — Has Signal IS Right POC, Has Complete Row IS a
       successful discovery. Booked is a stage floor. */
    const rank = Number(f["KPI Rank"] || 0);
    const hit = gateFor({
      rankAt: f["KPI Rank At"] || "",
      right: Number(f["Has Signal"] || 0) === 1,
      discovery: Number(f["Has Complete Row"] || 0) === 1,
      booked: rank >= MILESTONE.sqlMeetingBooked.floor,
      done: rank >= MILESTONE.sqlMeetingDone.floor,
      sql: rank >= MILESTONE.sql.floor,
      reached: rank > 0,
      picked: rank > 0,
    }, now);
    if (!hit) continue;
    const key = `${kid}|${hit.gate}`;
    if (answered.has(key)) continue;
    out.push({ key, kid, recordId: r.id, name: f.Name || kid, owner: f.Owner || "",
               gate: hit.gate, days: hit.days, since: hit.since,
               stage: f["Current Stage"] || "" });
  }
  /* Longest stuck first. The oldest stall is both the least likely to be
     remembered and the most likely to be dead, so it is the one worth asking
     about before the answer is lost entirely. */
  out.sort((a, b) => b.days - a.days);
  log(`rca: ${out.length} contact(s) owe a reason`);
  return out;
}

/* Recording an answer. Upserted on the key, so a revised answer replaces the
   first rather than adding a second — and a row is never deleted, because
   "asked, never answered" is itself worth being able to count. */
export async function writeRcaAnswer(at, { key, kid, recordId, gate, reason, note,
                                           since, days, owner, by }) {
  const fields = {
    Key: key,
    Gate: gate,
    "Asked At": new Date().toISOString(),
    Reason: reason,
    Note: note || "",
    "Answered At": new Date().toISOString(),
    "Answered By": by || "",
    Owner: owner || "",
  };
  if (since) fields["Stuck Since"] = since;
  if (Number.isFinite(days)) fields["Stuck Days"] = days;
  if (recordId) fields.Contact = [recordId];
  return at.upsert("RCA", "Key", fields);
}

/* ── the team roster ───────────────────────────────────────────────────
   Who the funnel counts. Read on every report; edited from the console.

   A MISSING ROW IS NOT "EXCLUDED". An empty Team table means nobody has said
   who the team is yet, and answering "then nobody counts" would blank the
   dashboard for every base that has not set one up — including, on the day this
   ships, all of them. Unknown means counted, and the console says so. */
export async function readTeam(at) {
  const rows = await listTolerant(at, "Team",
    { fields: ["Name", "Role", "In Funnel", "Note"], pageSize: 100, maxPages: 20 }).catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    name: String(r.fields?.Name || "").trim(),
    role: r.fields?.Role || "",
    inFunnel: !!r.fields?.["In Funnel"],
    note: r.fields?.Note || "",
  })).filter((p) => p.name);
}

/* Returns a predicate, so every caller asks the same question the same way.
   `known` is the set of names the roster has an opinion about — a name it has
   never heard of is counted, per the rule above. */
export function counter(team) {
  const known = new Map(team.map((p) => [p.name, p.inFunnel]));
  return (name) => {
    const n = String(name || "").trim();
    if (!n) return false;                 /* an unattributed row is nobody's */
    return known.has(n) ? known.get(n) : true;
  };
}

export async function writeTeam(at, people) {
  const rows = people.filter((p) => String(p.name || "").trim()).map((p) => ({
    Name: String(p.name).trim(),
    Role: p.role || "",
    "In Funnel": !!p.inFunnel,
    Note: p.note || "",
    "Updated At": new Date().toISOString(),
  }));
  if (!rows.length) return [];
  return at.upsertMany("Team", "Name", rows);
}

/* The reasons a BD may give for dropping an account, and the research fields,
   declared once and sent to whatever is drawing the form. A console shipping a
   reason this base has never heard of is a rejected write, so the list travels
   with the API rather than being copied into the UI. From
   reference/enout-bd-ladder.html. */
export const DEPRI_REASONS = ["No event budget this year", "Too small / not a fit",
  "Events handled in-house", "Locked in with another agency",
  "Can't reach the right POC", "Timing — revisit next quarter", "Other"];

export const RESEARCH_FIELDS = [
  { k: "industry", l: "Industry" },
  { k: "size", l: "Employees", o: ["", "1–50", "51–200", "201–500", "501–1,000", "1,001–5,000", "5,000+"] },
  { k: "hq", l: "HQ city" },
  { k: "offices", l: "Other offices", ph: "Cities / plants / regional offices" },
  { k: "funding", l: "Funding / ownership", ph: "Series C, Mar 2026 · listed · family-owned" },
  { k: "revenue", l: "Revenue band", ph: "₹100–500 Cr" },
  { k: "events", l: "Known events", ph: "Annual offsite in Goa, dealer meet in Jaipur…", long: 1 },
  { k: "season", l: "Event season", ph: "Q3 FY27 / Oct–Dec" },
  { k: "decides", l: "Who decides events", ph: "CHRO, Admin head, Marketing" },
  { k: "vendor", l: "Current agency", ph: "Name, or 'none found'" },
  { k: "trigger", l: "Recent trigger", ph: "Funding, new office, hiring spree, award", long: 1 },
  { k: "links", l: "Website / LinkedIn" },
  { k: "v", l: "V-score", half: 1 },
  { k: "w", l: "W-score", half: 1 },
  { k: "notes", l: "Research notes", long: 1 },
];

/* ── the ladder app's own two tables ──────────────────────────────────
   Focus and Research are the only things in this base that Kylas knows nothing
   about: one is what a BD decided to chase, the other is what they found out
   before calling. Both are keyed on the Kylas company id, so they join to
   everything else without a lookup. */

export async function readFocus(at) {
  const rows = await listTolerant(at, "Focus",
    { fields: ["Kylas Company ID", "Company Name", "Status", "Reason", "Note",
               "Owner", "Set By", "Set At"], pageSize: 100, maxPages: 60 }).catch(() => []);
  const out = {};
  for (const r of rows) {
    const id = String(r.fields?.["Kylas Company ID"] || "").trim();
    if (!id || !r.fields?.Status) continue;
    out[id] = {
      companyId: id,
      companyName: r.fields["Company Name"] || "",
      status: r.fields.Status,
      reason: r.fields.Reason || "",
      note: r.fields.Note || "",
      ownerName: r.fields.Owner || "",
      setByEmail: r.fields["Set By"] || "",
      setAt: r.fields["Set At"] || "",
    };
  }
  return out;
}

/* The fifteen research fields, as the column names this base uses. The ladder
   app speaks the reference's keys, so the mapping lives here and only here —
   two spellings of "decides events" in two files is how a form silently stops
   saving one of its boxes. */
export const RESEARCH_COLUMNS = {
  industry: "Industry", size: "Employees", hq: "HQ City", offices: "Other Offices",
  funding: "Funding", revenue: "Revenue Band", events: "Known Events",
  season: "Event Season", decides: "Decides Events", vendor: "Current Agency",
  trigger: "Recent Trigger", links: "Links", v: "V Score", w: "W Score",
  notes: "Research Notes",
};

export async function readResearch(at) {
  /* tier "bg": nobody is looking at a research panel while this runs — it is
     prefetched so the panel is instant WHEN they look — so its pages must not
     sit in front of the /company read somebody is waiting on. */
  const rows = await listTolerant(at, "Research",
    { fields: ["Kylas Company ID", ...Object.values(RESEARCH_COLUMNS), "Updated By", "Updated At"],
      pageSize: 100, maxPages: 60, tier: "bg" }).catch(() => []);
  const out = {};
  for (const r of rows) {
    const id = String(r.fields?.["Kylas Company ID"] || "").trim();
    if (!id) continue;
    const row = {};
    for (const [key, col] of Object.entries(RESEARCH_COLUMNS)) row[key] = r.fields?.[col] || "";
    row.updatedAt = r.fields?.["Updated At"] || "";
    row.updatedByEmail = r.fields?.["Updated By"] || "";
    out[id] = row;
  }
  return out;
}

/* ── THE RESEARCH THAT WAS ALREADY THERE ───────────────────────────────
   Ayush, 2026-09-21: "the research section should be taken from airtable"
   + a link to app55PsyRKqkf2CAQ / tbl2Jje9EBC4Cqydw, "every company id has a
   research section".

   That is a DIFFERENT base from the KPI one, filled by whatever process
   enriches their accounts, and it is not ours to write to. So it is read-only
   enrichment shown beside the console's own fifteen fields, never merged into
   them: a BD's own note and a scraped funding figure are different kinds of
   fact and a screen that blurs them is worse than two blocks.

   NOTHING HERE IS GUESSED FROM A SPELLING I CANNOT SEE. I have no access to
   that base, so every column name below is matched loosely — case, spacing,
   punctuation and the "no." / "number of" business all normalise away — and
   the key column is DETECTED rather than assumed. If detection fails the
   status says exactly what it found instead of quietly returning nothing,
   because "no research" and "I could not find the id column" look identical
   on screen and are completely different problems.

   RESEARCH_KEY_FIELD overrides the detection if their column is named
   something no heuristic would guess. */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const SOURCE_RESEARCH_FIELDS = [
  { k: "apollo", l: "LinkedIn (Apollo)", link: 1,
    names: ["linkedin appollo", "linkedin apollo", "linkedin", "apollo"] },
  { k: "boolean", l: "Boolean post link", link: 1,
    names: ["boolean post link", "boolean post", "boolean link", "boolean"] },
  { k: "fundTotal", l: "Total funding", names: ["total funding"] },
  { k: "fundLast", l: "Latest funding amount", names: ["latest funding amount", "last funding amount"] },
  { k: "fundType", l: "Latest funding type", names: ["latest funding type", "last funding type"] },
  { k: "srcConcat", l: "Source", names: ["source concatenate", "source concat", "source"] },
  { k: "pipeline", l: "Account pipeline stage", names: ["account pipeline stage", "pipeline stage", "account stage"] },
  { k: "revenue", l: "Annual revenue", names: ["annual revenue", "revenue"] },
  { k: "employees", l: "Employees (Kylas)",
    names: ["no of employees kylas", "no of employees", "number of employees", "employees kylas", "employees"] },
  { k: "revPerEmp", l: "Revenue per employee",
    names: ["at rev per employee", "rev per employee", "revenue per employee"] },
];

/* The column holding the Kylas company id, found rather than assumed. Name
   first, because a column called "Kylas Company ID" is not ambiguous. Failing
   that, the column whose values actually look like the ids we hold — which is
   the only test that survives someone calling it "Account Ref". */
export function detectKeyField(rows, knownIds = []) {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.fields || {})))];
  const byName = names.find((n) => /^kylas\s*company\s*id$/.test(norm(n).replace(/\s+/g, " ")))
    || names.find((n) => norm(n) === "company id")
    || names.find((n) => /\bkylas\b/.test(norm(n)) && /\bid\b/.test(norm(n)));
  if (byName) return { field: byName, how: "name" };

  const known = new Set(knownIds.map((x) => String(x)));
  if (!known.size) return { field: "", how: "none" };
  let best = "", hits = 0;
  for (const n of names) {
    let k = 0;
    for (const r of rows) if (known.has(String(r.fields?.[n] ?? "").trim())) k++;
    if (k > hits) { hits = k; best = n; }
  }
  /* One coincidental match is not evidence. Three is a column. */
  return hits >= Math.min(3, known.size) ? { field: best, how: `values (${hits} matched)` }
                                         : { field: "", how: "none" };
}

export async function readSourceResearch(at, table, { knownIds = [], log = () => {} } = {}) {
  /* NO PROJECTION. Asking for names I cannot verify is how the whole read
     fails on one wrong string — and the names are the thing being discovered
     here, so there is nothing to ask for yet. */
  let rows;
  try {
    rows = await at.listAll(table, { pageSize: 100, maxPages: 200, tier: "bg" });
  } catch (e) {
    return { rows: {}, status: { ok: false, error: e.message.slice(0, 200), table } };
  }
  if (!rows.length) return { rows: {}, status: { ok: true, table, rows: 0, note: "the table is empty" } };

  const override = process.env.RESEARCH_KEY_FIELD || "";
  const key = override ? { field: override, how: "RESEARCH_KEY_FIELD" }
                       : detectKeyField(rows, knownIds);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.fields || {})))];
  if (!key.field) {
    log(`! could not find the company-id column in ${table}. Columns: ${columns.join(", ").slice(0, 300)}`);
    return { rows: {}, status: { ok: false, table, rows: rows.length, columns,
                                 error: "no company-id column found — set RESEARCH_KEY_FIELD" } };
  }

  /* Each wanted field to a real column on this table, once, by normalised
     name. Longest match wins so "latest funding amount" is not taken by the
     looser "total funding" alternative of another key. */
  const map = {};
  const taken = new Set();
  for (const f of SOURCE_RESEARCH_FIELDS) {
    const hit = f.names
      .map((want) => columns.find((c) => norm(c) === want && !taken.has(c)))
      .find(Boolean)
      || columns.find((c) => !taken.has(c) && f.names.some((want) => norm(c).includes(want)));
    if (hit) { map[f.k] = hit; taken.add(hit); }
  }

  const out = {};
  for (const r of rows) {
    const id = String(r.fields?.[key.field] ?? "").trim();
    if (!id) continue;
    const row = {};
    for (const [k, col] of Object.entries(map)) {
      const v = r.fields?.[col];
      /* Airtable hands back numbers, arrays (a multi-select or a link) and
         objects (an attachment) as well as strings. The panel shows text. */
      row[k] = v == null ? ""
        : Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x.name || x.url || "" : x)).filter(Boolean).join(", ")
        : typeof v === "object" ? String(v.name || v.url || "")
        : String(v);
    }
    out[id] = row;
  }
  return { rows: out, status: { ok: true, table, rows: rows.length, keyed: Object.keys(out).length,
                                keyField: key.field, keyHow: key.how,
                                mapped: map, columns,
                                unmapped: SOURCE_RESEARCH_FIELDS.filter((f) => !map[f.k]).map((f) => f.l) } };
}

export async function writeResearch(at, companyId, companyName, values, who = "") {
  const fields = { "Kylas Company ID": String(companyId), "Company Name": companyName || "",
                   "Updated By": who, "Updated At": new Date().toISOString() };
  for (const [key, col] of Object.entries(RESEARCH_COLUMNS))
    fields[col] = String(values?.[key] ?? "").trim();
  const { rec, dropped } = await upsertTolerant(at, "Research", "Kylas Company ID", fields);
  return { rec, dropped };
}

/* Setting focus is TWO writes and the second one is the important one. The
   Focus row is the current state, which an overwrite is supposed to replace;
   Focus History is append-only, and it is the only thing that can answer "who
   dropped this account, and what did they say at the time" once somebody has
   picked it back up. Written history-first: a crash between the two leaves a
   recorded decision that the current state has not caught up with, which is
   recoverable. The other order loses the decision. */
export async function writeFocus(at, { companyId, companyName, status, reason = "", note = "",
                                       ownerName = "", setBy = "", previous = "normal" }) {
  const nowIso = new Date().toISOString();
  const id = String(companyId);

  await upsertTolerant(at, "Focus History", "Key", {
    Key: `${id}-${nowIso}`,
    "Kylas Company ID": id,
    "From Status": previous || "normal",
    "To Status": status,
    Reason: reason, Note: note, Owner: ownerName, "Set By": setBy,
    "Changed At": nowIso,
  }).catch(() => ({}));            /* history is best-effort; the state is not */

  if (status === "normal") {
    /* Taken off the list entirely. The row goes; the history keeps it. */
    const hit = await at.find("Focus", `{Kylas Company ID} = '${esc(id)}'`).catch(() => null);
    if (hit) await at.remove("Focus", [hit.id]);
    return { cleared: true, at: nowIso };
  }

  const { dropped } = await upsertTolerant(at, "Focus", "Kylas Company ID", {
    "Kylas Company ID": id,
    "Company Name": companyName || "",
    Status: status,
    Reason: status === "depri" ? reason : "",
    Note: note,
    Owner: ownerName,
    "Set By": setBy,
    "Set At": nowIso,
  });
  return { cleared: false, at: nowIso, dropped };
}

/* What the last sync managed, so the console can say how complete this mirror
   is instead of implying it is the whole account. */
export async function readSyncState(at) {
  try {
    const r = await at.find("Schema Migrations", `{Key} = 'last-sync'`);
    if (!r) return null;
    const note = JSON.parse(r.fields?.Note || "{}");
    return { at: r.fields?.["Applied At"] || note.at || "", ...note };
  } catch { return null; }
}
