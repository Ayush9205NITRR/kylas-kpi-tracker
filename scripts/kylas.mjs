/* Kylas client: queueing, retries, and the mapping between their record shapes
   and the console's. Shared by the proxy and any script that needs it. */
import { STAGE_ID } from "./stages.mjs";

const BASE = process.env.KYLAS_BASE || "https://api.kylas.io";
/* Kylas throttles hard — a burst of 8 drew three 429s and even sequential calls
   a few hundred ms apart were refused. Everything funnels through one queue. */
const GAP = Number(process.env.KYLAS_GAP || 450);

const CODE_BY_ID = Object.fromEntries(Object.entries(STAGE_ID).map(([code, id]) => [String(id), code]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(key, { log = () => {} } = {}) {
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

  /* The schema calls company and ownerId LOOK_UP, but the query builder rejects
     that and wants "long". Confirmed live — see docs/kylas-picklists.md. */
  const rule = (field, value, type = "long", operator = "equal") =>
    ({ condition: "AND", valid: true,
       rules: [{ id: field, field, type, input: "select", operator, value }] });

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
       assigned but never worked. */
    async companiesForOwner(ownerId, size = 200) {
      const r = await call("POST", `/v1/search/company?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: COMPANY_FIELDS, jsonRule: rule("ownerId", Number(ownerId)) });
      return rows(r);
    },

    async companies(size = 200) {
      const r = await call("POST", `/v1/search/company?sort=updatedAt,desc&page=0&size=${size}`,
        { fields: COMPANY_FIELDS });
      return rows(r);
    },

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
  const parts = String(c.pocName || "").trim().split(/\s+/);
  const body = {
    firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : undefined,
    lastName: parts.length > 1 ? parts.at(-1) : (parts[0] || "Unknown"),
    designation: c.designation || undefined,
    linkedin: c.linkedin || undefined,
    emails: (c.emails || []).filter((e) => e.value?.trim())
      .map((e) => ({ type: e.type || "OFFICE", value: e.value.trim(), primary: !!e.primary })),
    phoneNumbers: (c.phones || []).filter((p) => p.value?.trim())
      .map((p) => ({ type: p.type || "MOBILE", dialCode: p.cc || "+91",
                     value: p.value.trim(), primary: !!p.primary })),
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
  const number = phone ? String(phone.value || "").trim() : "";
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
    phones: (c.phoneNumbers || []).map((p, i) => ({
      type: pick(p.type, "MOBILE"), cc: pick(p.dialCode, "+91"),
      value: pick(p.value, "") || "", primary: p.primary ?? i === 0,
    })),

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
  return {
    id: String(pick(co?.id, "") ?? ""),
    name: pick(co?.name, "") || "",
    stage: stageCode(cf.cfPipelineStageBd),
    lastCalledAt: pick(cf.cfLastCalledAtDate, null),
    accountHealth: pick(cf.cfAccountHealthBd, null),
    source: stageCode(cf.cfSourceOfData),
    batch: pick(cf.cfBatch, null),
    website: pick(cf.cfWebsite, co?.website, null),
  };
}
