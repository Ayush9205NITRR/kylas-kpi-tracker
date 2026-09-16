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

  const call = (method, path, body) =>
    (chain = chain.then(() => sleep(GAP)).then(() => attempt(method, path, body)));

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
  const CONTACT_FIELDS = ["id", "firstName", "lastName", "salutation", "ownerId",
    "company", "companyName", "designation", "department", "emails", "phoneNumbers",
    "linkedin", "remarks", "customFieldValues", "createdAt", "updatedAt"];

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

    contact: (id) => call("GET", `/v1/contacts/${id}`),
  };
}

/* ── mapping ───────────────────────────────────────────────────────────
   Kylas shapes are not fully documented and vary by endpoint, so every
   accessor below tolerates more than one form rather than assuming one. A
   wrong guess here shows up as a blank field, not a crash. */

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
const idOf = (v) => (v && typeof v === "object" ? pick(v.id, v.value) : v);
const nameOf = (v) => (v && typeof v === "object" ? pick(v.name, v.displayName, v.label) : undefined);

/* A stage can come back as the code, the numeric id, or an object. */
export function stageCode(v) {
  const raw = v && typeof v === "object" ? pick(v.name, v.code, v.id, v.value) : v;
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw);
  return CODE_BY_ID[s] || s;
}

export function toConsoleContact(c, { ownerName, company } = {}) {
  const cf = c.customFieldValues || {};
  const name = [pick(c.salutationName), pick(c.firstName), pick(c.lastName)].filter(Boolean).join(" ").trim();
  return {
    kid: String(pick(c.id, "") ?? ""),
    salutation: pick(stageCode(c.salutation), "") || "",
    pocName: name || pick(c.name, ""),
    /* Search often returns company as a bare id with no name. The caller knows
       the company it asked for, so fall back to that rather than showing a
       blank next to a contact that plainly has one. */
    company: pick(nameOf(c.company), c.companyName, company?.name, "") || "",
    companyId: String(pick(idOf(c.company), company?.id, "") ?? ""),
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
    source: stageCode(pick(cf.cfSourceOfData, c.cfSourceOfData)),
    nextCallDate: "", nextCallTime: "",
    remarks: pick(c.remarks, "") || "",
    offsiteTimeline: "",
    owner: pick(ownerName, c.ownerName, "") || "",
    ownerId: String(pick(c.ownerId, "") ?? ""),

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
