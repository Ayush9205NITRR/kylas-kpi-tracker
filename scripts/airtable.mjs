/* Airtable client and the write path.
 *
 * This is the authoritative write: Airtable holds the granular data and is what
 * the KPIs are computed from. The Kylas write beside it is a mirror for anyone
 * reading the contact in the CRM.
 *
 * Everything goes through one queue. Airtable allows 5 requests a second per
 * base, and a save touches up to five tables.
 */
import { STAGE_RUNG, STAGE_LABEL, EXIT_STAGES } from "./stages.mjs";

/* Overridable so the mock can stand in during tests. */
const API = process.env.AIRTABLE_BASE_URL || "https://api.airtable.com/v0";
const GAP = Number(process.env.AIRTABLE_GAP || 220);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAirtable(pat, baseId, { log = () => {} } = {}) {
  let chain = Promise.resolve();
/* A rejected promise must not stay in the chain: `chain.then(...)` off a
   rejected chain rejects with the ORIGINAL error, so one failed request would
   make every later one fail with the same stale message for the life of the
   process. The chain keeps only the timing, never the outcome. */
  const queue = (fn) => {
    const run = chain.then(() => sleep(GAP)).then(fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  async function call(method, path, body, tries = 4) {
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
    });
  }

  const t = (name) => "/" + encodeURIComponent(name);

  return {
    call,

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
    async listAll(table, { formula = "", fields = [], pageSize = 100, maxPages = 40 } = {}) {
      const out = [];
      let offset = "";
      for (let p = 0; p < maxPages; p++) {
        const q = [`pageSize=${pageSize}`,
                   formula ? `filterByFormula=${encodeURIComponent(formula)}` : "",
                   ...fields.map((f) => `fields[]=${encodeURIComponent(f)}`),
                   offset ? `offset=${encodeURIComponent(offset)}` : ""].filter(Boolean).join("&");
        const r = await call("GET", `${t(table)}?${q}`);
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

  /* 1 · company */
  let companyRec = null;
  if (c.companyId) {
    companyRec = await at.upsert("Companies", "Kylas Company ID", {
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
    "Current Stage": c.stage || "",
    "Previous Stage": prev?.fields?.["Current Stage"] && prev.fields["Current Stage"] !== c.stage
      ? prev.fields["Current Stage"] : (prev?.fields?.["Previous Stage"] || ""),
    "Vendor Info": c.vendorInfo || "",
    "Mode of Meeting": c.modeOfMeeting || "",
    "Service Offering": !!c.serviceOffering,
    /* Set once and never unset, so Phone Picked cannot regress. */
    "Ever Picked": !!prev?.fields?.["Ever Picked"] || computed > 0,
    "KPI Rank": rank,
    "Pending Create": !!c.pendingCreate,
    Flagged: !!c.flagged,
    "Exit Reason": EXIT_STAGES.includes(c.stage) ? c.stage : "",
  };
  if (rankRose) fields["KPI Rank At"] = new Date().toISOString();
  if (companyRec) fields.Company = [companyRec.id];
  for (const k of Object.keys(fields)) if (fields[k] === "") delete fields[k];
  fields["Kylas Contact ID"] = String(c.kid || "");

  /* 3 · the contact */
  const contactRec = await at.upsert("Contacts", "Kylas Contact ID", fields);
  wrote.push("contact");
  if (!contactRec) throw new Error("Airtable did not return the contact record");

  /* 4 · event rows, matched on the key the overlay assigns */
  const rows = rowsOf(c).filter((r) => r.rowKey);
  for (const r of rows) {
    await at.upsert("Event Rows", "Row Key", {
      "Row Key": r.rowKey,
      Period: r.period,
      "Event Type": r.eventType || "",
      Budget: r.budget || "",
      Timeline: r.timeline || "",
      Pax: r.pax || "",
      Remarks: r.remarks || "",
      Contact: [contactRec.id],
    });
  }
  /* A row deleted in the console must go here too, or a stale one keeps
     counting toward Right POC forever. */
  if (c.kid) {
    const held = await at.list("Event Rows", `{Kylas Contact ID (from Contact)} = '${esc(c.kid)}'`).catch(() => []);
    const keep = new Set(rows.map((r) => r.rowKey));
    const stale = held.filter((h) => h.fields["Row Key"] && !keep.has(h.fields["Row Key"])).map((h) => h.id);
    if (stale.length) { await at.remove("Event Rows", stale); wrote.push(`removed ${stale.length} stale row(s)`); }
  }
  if (rows.length) wrote.push(`${rows.length} event row(s)`);

  /* 5 · the call, append-only and idempotent on its key */
  if (call) {
    const key = `${call.at}-${c.kid || c.pocName}`;
    await at.upsert("Call Log", "Key", {
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
    await at.upsert("Stage Transitions", "Key", {
      Key: `${c.kid || c.pocName}-${at_}`,
      "From Stage": from,
      "To Stage": c.stage,
      "Changed At": at_,
      Owner: c.owner || "",
      Source: "Console",
      Contact: [contactRec.id],
    });
    wrote.push(`transition ${STAGE_LABEL[from] || from || "new"} -> ${STAGE_LABEL[c.stage] || c.stage}`);
  }

  log(`airtable: ${wrote.join(", ")}`);
  return { recordId: contactRec.id, rank, rankRose, rightPOC: hasSignal(c), discovery: isComplete(c), wrote };
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
