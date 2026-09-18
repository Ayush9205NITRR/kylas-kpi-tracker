/* Kylas client: queueing, retries, and the mapping between their record shapes
   and the console's. Shared by the proxy and any script that needs it. */
import { STAGE_ID } from "./stages.mjs";
import { splitPhone, ISO_OF, checkEmail, splitName, e164 } from "./fields.mjs";

const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
/* Kylas throttles hard — a burst of 8 drew three 429s and even sequential calls
   a few hundred ms apart were refused. Everything funnels through one queue. */
const GAP = Number(process.env.KYLAS_GAP || 450);

const CODE_BY_ID = Object.fromEntries(Object.entries(STAGE_ID).map(([code, id]) => [String(id), code]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(key, { log = () => {}, shapeHint = "", onShape = () => {} } = {}) {
  let chain = Promise.resolve();

/* A rejected promise must not stay in the chain: `chain.then(...)` off a
   rejected chain rejects with the ORIGINAL error, so one failed request would
   make every later one fail with the same stale message for the life of the
   process. The chain keeps only the timing, never the outcome. */
  const call = (method, path, body) => {
    const run = chain.then(() => sleep(GAP)).then(() => attempt(method, path, body));
    chain = run.then(() => {}, () => {});
    return run;
  };

  async function attempt(method, path, body, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "api-key": key, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 429) {
        const wait = 1200 * 2 ** i;
        log(`429 on ${path}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
    const err = new Error(`${method} ${path} -> still rate limited after ${tries} tries`);
    err.status = 429;
    throw err;
  }

  const rows = (o) => (Array.isArray(o) ? o : o?.content || o?.data || []);

  /* The search fields the console actually needs. */
  /* Search returns ONLY what is asked for, so anything missing here comes back
     blank in the console even though Kylas holds it. */
  /* Search returns ONLY what is asked for, so anything missing here comes back
     blank in the console even though Kylas holds it. metaData carries the
     id -> name map for every lookup on the record, which is where company and
     owner names come from. */
  const CONTACT_FIELDS = ["id", "firstName", "lastName", "salutation", "ownerId",
    "company", "companyName", "designation", "department", "emails", "phoneNumbers",
    "linkedin", "remarks", "customFieldValues", "metaData", "createdAt", "updatedAt"];

  /* Same rule as contacts: search returns only what it is asked for, and
     metaData carries the owner id -> name map so the list can show an owner
     without a request per company. */
  const COMPANY_FIELDS = ["id", "name", "ownerId", "website", "phoneNumbers", "emails",
    "customFieldValues", "metaData", "createdAt", "updatedAt"];
  /* Exactly what the probe proved this endpoint returns, plus metaData for the
     owner name. Anything beyond this is what the 500 is suspected to be about. */
  const COMPANY_LEAN = ["id", "name", "ownerId", "customFieldValues", "metaData"];

  /* The schema calls company and ownerId LOOK_UP, but the query builder rejects
     that and wants "long". Confirmed live — see docs/kylas-picklists.md. */
  const rule = (field, value, type = "long", operator = "equal") =>
    ({ condition: "AND", valid: true,
       rules: [{ id: field, field, type, input: "select", operator, value }] });

  /* The shape /v1/search/company will accept, discovered at runtime.
     Ordered cheapest-and-most-useful first: a server-side owner filter with
     the full field list, then progressively less, ending at "ask for the bare
     minimum and filter in memory". Each entry says whether the server did the
     filtering, because if it did not we must do it ourselves or every associate
     sees the whole account. */
  const freeText = (v = "") => ({ condition: "AND", valid: true, rules: [
    { id: "multi_field", field: "multi_field", type: "multi_field",
      input: "multi_field", operator: "multi_field", value: v }] });

  const COMPANY_SHAPES = [
    { name: "ownerId/long + full fields",
      body: (o) => ({ fields: COMPANY_FIELDS, jsonRule: rule("ownerId", o) }), filtered: true },
    { name: "ownerId/long + lean fields",
      body: (o) => ({ fields: COMPANY_LEAN, jsonRule: rule("ownerId", o) }), filtered: true },
    { name: "ownerId/integer + lean fields",
      body: (o) => ({ fields: COMPANY_LEAN, jsonRule: rule("ownerId", o, "integer") }), filtered: true },
    /* Proven by the probe on 2026-09-16, so it is the reliable floor. It cannot
       filter, hence filtered:false. */
    { name: "free-text + lean fields, filtered here",
      body: () => ({ fields: COMPANY_LEAN, jsonRule: freeText("") }), filtered: false },
    { name: "lean fields, no rule",
      body: () => ({ fields: COMPANY_LEAN }), filtered: false },
  ];
  /* Remembered once one works. A hint from the caller lets a restarted proxy
     skip the probe entirely: three shapes fail on this account and each costs
     a full rate-limit gap, so the probe alone was 1.35s of every cold start
     after the first ever run. */
  let companyShape = shapeHint ? COMPANY_SHAPES.find((s) => s.name === shapeHint) || null : null;
  if (companyShape) log(`company search: using remembered shape "${companyShape.name}"`);

  /* PAGINATED. One page of 200 was not "the companies allotted to you", it was
     "the 200 most recently updated companies in the account" — and when the
     winning shape cannot filter server-side, the owner filter then ran over
     just those 200. On an account with 250+ companies that showed 19 of
     Arshdeep's and silently dropped the rest. Keep asking until a short page
     comes back. */
  const PAGE = 200;
  const MAX_PAGES = 25;            /* 5,000 companies — a stop, not a target */

  async function searchCompany(size, ownerId) {
    const mine = (list) => (ownerId == null ? list
      : list.filter((c) => Number(c.ownerId ?? c.owner?.id) === Number(ownerId)));

    /* Settle the shape on page 0, then reuse it for the rest. The remembered
       shape goes first and the rest stay behind it: a hint from a previous run
       is a shortcut, never a commitment, so a stale hint (a different account,
       or Kylas fixing the endpoint) costs one failed call rather than the whole
       view. */
    /* A shape that filters server-side cannot be used when there is nobody to
       filter BY. With ownerId null it would send a rule asking for owner
       "null" and Kylas answers with an empty page — so the Everyone view came
       back empty rather than with the account. It is masked on this account
       today only because those three shapes 500 here anyway; the day Kylas
       fixes that endpoint the team dashboard would silently go blank. */
    const usable = ownerId == null ? COMPANY_SHAPES.filter((s) => !s.filtered) : COMPANY_SHAPES;
    const tries = companyShape && usable.includes(companyShape)
      ? [companyShape, ...usable.filter((s) => s !== companyShape)]
      : usable;
    let shape = null, first = null, last;
    for (const s of tries) {
      try {
        first = rows(await call("POST", page(0), s.body(ownerId)));
        if (companyShape !== s) { log(`company search: "${s.name}" works`); onShape(s.name); }
        companyShape = shape = s;
        break;
      } catch (e) {
        last = e;
        /* Only a rejected REQUEST is worth trying another shape for. A 401, a
           429 or a network failure says nothing about the body, and retrying
           four variants would just spend the rate limit. */
        if (![400, 404, 500].includes(e.status)) throw e;
        log(`company search: "${s.name}" -> ${e.status}, trying the next shape`);
      }
    }
    if (!shape) throw new Error(`/v1/search/company rejected every known shape. Last: ${last?.message}`);

    const all = [...first];
    /* A page shorter than we asked for is the last one. */
    for (let p = 1; first.length === PAGE && p < MAX_PAGES; p++) {
      const next = rows(await call("POST", page(p), shape.body(ownerId)));
      all.push(...next);
      if (next.length < PAGE) break;
      first = next;
    }
    if (all.length >= PAGE) log(`company search: ${all.length} across ${Math.ceil(all.length / PAGE)} page(s)`);

    /* Server-side filtering is only trustworthy when the shape claims it. */
    const out = shape.filtered && ownerId != null ? all : mine(all);
    /* De-dupe: pages are sorted by updatedAt, and a record updated mid-scan can
       land on two of them. */
    const seen = new Set();
    return out.filter((c) => { const k = String(c.id); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  const page = (n) => `/v1/search/company?sort=updatedAt,desc&page=${n}&size=${PAGE}`;

  return {
    raw: call,
    me: () => call("GET", "/v1/users/me"),
    user: (id) => call("GET", `/v1/users/${id}`),
    company: (id) => call("GET", `/v1/companies/${id}`),

    async contactsForCompany(companyId, size = 100) {
      const r = await call("POST", `/v1/search/contact?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: CONTACT_FIELDS, jsonRule: rule("company", Number(companyId)) });
      return rows(r);
    },

    async contactsForOwner(ownerId, size = 100) {
      const r = await call("POST", `/v1/search/contact?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: CONTACT_FIELDS, jsonRule: rule("ownerId", Number(ownerId)) });
      return rows(r);
    },

    /* "Companies allotted to me" is the company's OWN owner field, not "a
       company where I own a contact" — confirmed by Ayush 2026-09-17. The two
       give different lists, and only this one shows a company that has been
       assigned but never worked.

       /v1/search/company is undocumented and brittle: asking for the same
       field list that works on contacts returns
       500 java.lang.NullPointerException. Rather than guess at the one true
       shape, try candidates in order and keep the first that answers — the
       same tactic the probe used to settle the contact-company filter. The
       winner is remembered, so this costs one extra request per process at
       most, and the log names it so it can be pinned later. */
    async companiesForOwner(ownerId, size = 200) {
      return searchCompany(size, Number(ownerId));
    },

    async companies(size = 200) {
      return searchCompany(size, null);
    },

    /* Which shape won, for the /companies?keys=1 diagnostic. */
    companyShapeName: () => companyShape?.name || "not yet determined",

    contact: (id) => call("GET", `/v1/contacts/${id}`),

    createContact: (body) => call("POST", "/v1/contacts", body),
    updateContact: (id, body) => call("PUT", `/v1/contacts/${id}`, body),
    createCallLog: (body) => call("POST", "/v1/call-logs/", body),
  };
}

/* ── writing ───────────────────────────────────────────────────────── */

export const MARK_A = "--- BD CONSOLE (auto, do not edit below) ---";
export const MARK_B = "--- END ---";

/* Rewrite only between the markers. Anything a human typed above them is
   theirs and must survive, so the block is replaced rather than the field. */
export function mergeRemarks(existing, block) {
  const before = String(existing || "").split(MARK_A)[0].replace(/\s+$/, "");
  if (!block) return before;
  return `${before}${before ? "\n\n" : ""}${MARK_A}\n${block}\n${MARK_B}`;
}

const line = (label, value) => (value ? `${label.padEnd(10)} ${value}` : null);
const row = (r) => [r.eventType, r.budget, r.timeline, r.pax].filter(Boolean).join(" | ");

/* What a Kylas user sees on the record. Readable, not parsed back — the numbers
   come from Airtable, this is context for whoever opens the contact. */
export function renderRemarks(c, { stageLabel } = {}) {
  const rows = (list, label) => (list || []).map((r) => row(r)).filter(Boolean)
    .map((t, i) => line(i ? "" : label, t)).filter(Boolean);
  const out = [
    line("Stage", stageLabel || c.stage),
    line("Owner", c.owner),
    line("Next call", [c.nextCallDate, c.nextCallTime].filter(Boolean).join(" ")),
    ...rows(c.past, "Past"),
    ...rows(c.current, "Current"),
    line("Vendor", c.vendorInfo),
    line("Mode", c.modeOfMeeting),
    line("Offering", c.serviceOffering ? "pitched on this call" : ""),
    line("Notes", (c.current || []).map((r) => r.remarks).filter(Boolean).join(" · ")),
  ].filter(Boolean);
  return out.join("\n");
}

/* The console's shape back into Kylas'. Only fields Kylas owns — the overlay's
   own data lives in Airtable and in the remarks block. */
export function toKylasContact(c, { remarks } = {}) {
  const { firstName, lastName } = splitName(c.pocName);
  const body = {
    firstName: firstName || undefined,
    lastName: lastName || "Unknown",
    designation: c.designation || undefined,
    linkedin: c.linkedin || undefined,
    emails: (c.emails || []).map((e) => ({ e, r: checkEmail(e.value) }))
      .filter(({ r }) => r.ok)
      .map(({ e, r }) => ({ type: e.type || "OFFICE", value: r.value, primary: !!e.primary })),
    /* Kylas wants the NATIONAL number in `value` and the country in `dialCode`.
       Anything else — "+918319585041", a pasted "0 8319 585041" — comes back as
       400 002008 "Invalid Mobile Number", which names neither the field nor the
       rule. splitPhone puts every form into the one shape Kylas accepts, so a
       PUT also repairs a record that was stored wrong earlier. */
    phoneNumbers: (c.phones || []).map((p) => ({ p, s: splitPhone(p.value, p.cc) }))
      .filter(({ s }) => s.value)
      .map(({ p, s }) => ({ type: p.type || "MOBILE", dialCode: s.cc || "+91",
                            code: ISO_OF[s.cc || "+91"] || undefined,
                            value: s.value, primary: !!p.primary })),
    customFieldValues: {},
  };
  if (c.companyId) body.company = Number(c.companyId);
  if (c.ownerId) body.ownerId = Number(c.ownerId);
  if (remarks !== undefined) body.remarks = remarks;

  /* A picklist is set by value id, never by code. */
  const stageId = STAGE_ID[c.stage];
  if (stageId) body.customFieldValues.cfPipelineStageBd = stageId;
  if (c.source) body.customFieldValues.cfSourceOfData = c.source;
  if (!Object.keys(body.customFieldValues).length) delete body.customFieldValues;

  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/* Kylas' own call-log vocabulary, which is not the console's. */
const OUTCOME = { "No answer": "no_answer", "Wrong POC": "connected",
                  "Right POC": "connected", "Discovery": "connected" };

export function toKylasCallLog(c, call) {
  const phone = (c.phones || []).find((p) => p.primary) || (c.phones || [])[0];
  /* The log wants the number as it would be dialled, so E.164 and not whatever
     shape the field happens to hold. */
  const number = phone ? e164(phone) : "";
  return {
    outcome: OUTCOME[call.outcome] || "connected",
    callType: "outgoing",
    startTime: call.at || new Date().toISOString(),
    duration: String(call.duration || 0),
    phoneNumber: number,
    notes: call.note ? [{ description: call.note }] : undefined,
    relatedTo: { entity: "contact", id: Number(c.kid), phoneNumber: number },
  };
}

/* ── mapping ───────────────────────────────────────────────────────────
   Kylas shapes are not fully documented and vary by endpoint, so every
   accessor below tolerates more than one form rather than assuming one. A
   wrong guess here shows up as a blank field, not a crash. */

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
export const idOf = (v) => (v && typeof v === "object" ? pick(v.id, v.value) : v);
const nameOf = (v) => (v && typeof v === "object" ? pick(v.name, v.displayName, v.label) : undefined);

/* Kylas ships a lookup table with every record:
     metaData.idNameStore.company  = { "1770964": "renewbuy" }
     metaData.idNameStore.ownerId  = { "74752": "Rubal Sansanwal" }
   Reading it is both more accurate and cheaper than resolving ids with extra
   requests, which matters against a tight rate limit. */
export function lookupName(record, field, id) {
  const store = record?.metaData?.idNameStore?.[field];
  if (!store || id === undefined || id === null || id === "") return undefined;
  return store[String(id)];
}

/* A stage can come back as the code, the numeric id, or an object. */
export function stageCode(v) {
  const raw = v && typeof v === "object" ? pick(v.name, v.code, v.id, v.value) : v;
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw);
  return CODE_BY_ID[s] || s;
}

export function toConsoleContact(c, { ownerName, company } = {}) {
  const cf = c.customFieldValues || {};
  const companyId = pick(idOf(c.company), company?.id, "");
  const ownerId = pick(c.ownerId, "");
  const name = [pick(c.salutationName), pick(c.firstName), pick(c.lastName)].filter(Boolean).join(" ").trim();
  return {
    kid: String(pick(c.id, "") ?? ""),
    salutation: pick(stageCode(c.salutation), "") || "",
    pocName: name || pick(c.name, ""),
    /* Company arrives as a bare id. The name is in metaData; failing that, the
       caller knows which company it asked for. */
    company: pick(lookupName(c, "company", companyId), nameOf(c.company), c.companyName,
                  company?.name, "") || "",
    companyId: String(companyId ?? ""),
    linkedin: pick(c.linkedin, "") || "",
    designation: pick(c.designation, c.department, "") || "",

    emails: (c.emails || []).map((e, i) => ({
      type: pick(e.type, "OFFICE"), value: pick(e.value, "") || "",
      primary: e.primary ?? i === 0,
    })),
    /* Normalised on the way IN as well: a record already stored with the
       country code inside `value` would otherwise display as +91+918319..., and
       the first save of it would fail. */
    phones: (c.phoneNumbers || []).map((p, i) => {
      const s = splitPhone(pick(p.value, "") || "", pick(p.dialCode, "+91"));
      return { type: pick(p.type, "MOBILE"), cc: s.cc || "+91",
               value: s.value, primary: p.primary ?? i === 0 };
    }),

    stage: stageCode(pick(cf.cfPipelineStageBd, c.cfPipelineStageBd)),
    stageLabel: lookupName(c, "cfPipelineStageBd", pick(cf.cfPipelineStageBd, c.cfPipelineStageBd)) || "",
    source: stageCode(pick(cf.cfSourceOfData, c.cfSourceOfData)),
    nextCallDate: "", nextCallTime: "",
    remarks: pick(c.remarks, "") || "",
    offsiteTimeline: "",
    owner: pick(lookupName(c, "ownerId", ownerId), ownerName, c.ownerName, "") || "",
    ownerId: String(ownerId ?? ""),

    /* Overlay-owned, so Kylas has nothing to say about them yet. */
    past: [], current: [],
    vendorInfo: "", serviceOffering: false, modeOfMeeting: "",
    done: false, flagged: false,

    _kylas: { updatedAt: c.updatedAt, createdAt: c.createdAt },
  };
}

export function toConsoleCompany(co) {
  const cf = co?.customFieldValues || {};
  /* `name` is the key on both GET /v1/companies/{id} and the search endpoint.
     companyName is kept only because contacts use it, and one mapper reading
     both shapes is cheaper than two. When 38 companies rendered as their own
     ids the cause was not the response at all — views.rollup() seeded rows with
     a truthy "Company <id>" placeholder that its own !empty guard then refused
     to overwrite. Check the mapping before blaming the API. */
  const id = pick(co?.id, "") ?? "";
  const name = pick(co?.name, co?.companyName, "") || "";
  return {
    id: String(id),
    name,
    stage: stageCode(cf.cfPipelineStageBd),
    lastCalledAt: pick(cf.cfLastCalledAtDate, null),
    accountHealth: pick(cf.cfAccountHealthBd, null),
    source: stageCode(cf.cfSourceOfData),
    batch: pick(cf.cfBatch, null),
    website: pick(cf.cfWebsite, co?.website, null),
  };
}
