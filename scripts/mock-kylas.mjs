#!/usr/bin/env node
/* A stand-in for the Kylas API, returning the shapes the live probe actually
 * observed on 2026-09-16.
 *
 *   node scripts/mock-kylas.mjs                 # listens on 9900
 *   KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x node scripts/proxy.mjs
 *
 * Exists so the proxy, the mapping and the console can be tested end to end
 * without a real key and without touching the real CRM. It deliberately
 * reproduces the awkward parts: stages come back as numeric picklist ids,
 * company as a bare id whose name lives in metaData.idNameStore, custom fields
 * whose values are nothing like the standard picklists, and rate limiting.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 9900);
const stages = JSON.parse(readFileSync(new URL("../docs/stages.json", import.meta.url), "utf8")).stages;
const id = (code) => stages.find((s) => s.code === code).id;

const USERS = {
  74725: { id: 74725, firstName: "Enout", lastName: "Super Admin" },
  74726: { id: 74726, firstName: "Priya", lastName: "Deshmukh" },
};
const userName = (id) => [USERS[id]?.firstName, USERS[id]?.lastName].filter(Boolean).join(" ");

/* Kylas attaches an id -> name table for every lookup on the record. Without
   it the console has only bare ids and shows blanks. */
/* Whether the SEARCH endpoint fills idNameStore for `company` was never
   confirmed against the real API — the probe lost those responses to 429. With
   MOCK_NO_COMPANY_NAMES=1 it does not, which is the case that made the
   companies list read "Company 1776620" instead of a name. The proxy must
   resolve the name by id rather than depend on this. */
const NO_CO_NAMES = process.env.MOCK_NO_COMPANY_NAMES === "1";

const withMeta = (c) => ({
  ...c,
  metaData: { idNameStore: {
    company: c.company && !NO_CO_NAMES ? { [String(c.company?.id ?? c.company)]: COMPANIES[c.company?.id ?? c.company]?.name } : {},
    ownerId: { [String(c.ownerId)]: userName(c.ownerId) },
    cfPipelineStageBd: c.customFieldValues?.cfPipelineStageBd
      ? { [String(c.customFieldValues.cfPipelineStageBd)]:
          (stages.find((s) => s.id === c.customFieldValues.cfPipelineStageBd) || {}).label }
      : {},
  } },
});

const COMPANIES = {
  1776620: {
    id: 1776620, name: "seats", ownerId: 74725,
    customFieldValues: {
      cfBatch: "B-11", cfPipelineStageBd: id("CNC_COULD_NOT_CONNECT"),
      cfSourceOfData: "COLD_CALLING", cfAccountHealthBd: "AMBER",
      cfLastCalledAtDate: "2026-04-17", cfWebsite: "http://www.seats.aero",
    },
  },
  903: { id: 903, name: "Shorehouse Retail", ownerId: 74726, customFieldValues: {} },
  /* Allotted, never worked: no contacts point at it. A companies list derived
     from contacts cannot show this row, which is the whole reason /companies
     searches companies directly. */
  1810449: { id: 1810449, name: "Temp", ownerId: 74725, customFieldValues: {} },
  1778327: {
    id: 1778327, name: "bbb", ownerId: 74725,
    customFieldValues: { cfSourceOfData: "lifetime-MQL-SQL", cfBatch: "B-12" },
  },
};

/* Bulk, so pagination and the owner filter are exercised: 260 companies split
   between two owners means page 0 cannot hold them and a client-side owner
   filter over one page would silently drop most of them. */
if (process.env.MOCK_MANY === "1") {
  for (let i = 0; i < 260; i++) {
    const id = 200000 + i;
    COMPANIES[id] = { id, name: `bulk-${String(i).padStart(3, "0")}`,
      ownerId: i % 2 ? 74726 : 74725,
      customFieldValues: { cfSourceOfData: i % 3 ? "Round-Robin" : "Apollo",
                           cfBatch: `Batch${(i % 2) + 1}` } };
  }
}

/* Stages arrive as ids, not codes — the mapping layer has to cope. */
const CONTACTS = [
  { id: 112936, firstName: "Hema", lastName: "Bharathi", ownerId: 74725,
    /* Search returns company as a bare id with no name — this is what blanked
       the Company field against the live account. */
    company: 1776620, designation: "Founder's Office",
    linkedin: "https://linkedin.com/in/hema-bharathi",
    emails: [{ type: "OFFICE", value: "hema@seats.aero", primary: true }],
    phoneNumbers: [{ type: "MOBILE", dialCode: "+91", code: "IN", value: "9876501234", primary: true }],
    customFieldValues: { cfPipelineStageBd: id("MQL_MARKETING_QUALIFIED_LEAD"), cfSourceOfData: "Round-Robin" },
    updatedAt: "2026-09-15T10:02:00.000Z" },

  { id: 112937, firstName: "Shipra", lastName: "Gupta", ownerId: 74726,
    company: 1776620, designation: "Head of People",
    emails: [{ type: "OFFICE", value: "shipra@seats.aero", primary: true }],
    phoneNumbers: [{ type: "MOBILE", dialCode: "+91", value: "9811122233", primary: true }],
    /* the code rather than the id, since both turn up in the wild */
    customFieldValues: { cfPipelineStageBd: "DISCOVERY_CALL_BOOKED" },
    updatedAt: "2026-09-16T08:40:00.000Z" },

  { id: 38470, firstName: "Devanshi", lastName: "Kalro", ownerId: 74726,
    company: { id: 903, name: "Shorehouse Retail" }, designation: "AVP Marketing",
    emails: [{ type: "OFFICE", value: "d.kalro@shorehouse.example", primary: true }],
    phoneNumbers: [{ type: "MOBILE", dialCode: "+91", value: "9920477103", primary: true }],
    customFieldValues: { cfPipelineStageBd: id("SQL_SALES_QUALIFIED_LEAD") },
    updatedAt: "2026-09-14T11:00:00.000Z" },

  /* No phone, no stage, no company — the console must not fall over. */
  { id: 99001, lastName: "Unknown Person", ownerId: 74725,
    emails: [], phoneNumbers: [], customFieldValues: {},
    updatedAt: "2026-09-01T00:00:00.000Z" },
];

let nextId = 900001;
const WRITES = [];
const CALL_LOGS = [];
let recent = [];
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const now = Date.now();
  recent = recent.filter((t) => now - t < 1000);
  recent.push(now);
  /* Roughly what the real thing does to a burst. */
  if (recent.length > 4) return json(res, 429, { message: "Too many requests" });

  if (!req.headers["api-key"]) return json(res, 401, { message: "api-key missing" });

  const p = url.pathname;
  if (p === "/v1/users/me") return json(res, 200, USERS[74725]);

  const user = p.match(/^\/v1\/users\/(\d+)$/);
  if (user) return USERS[user[1]] ? json(res, 200, USERS[user[1]]) : json(res, 404, { message: "no such user" });

  const co = p.match(/^\/v1\/companies\/(\d+)$/);
  if (co) return COMPANIES[co[1]] ? json(res, 200, COMPANIES[co[1]]) : json(res, 404, { message: "no such company" });

  const ct = p.match(/^\/v1\/contacts\/(\d+)$/);
  /* Method matters: without this check the GET branch also swallows PUTs and
     an update silently does nothing while returning 200. */
  if (ct && req.method === "GET") {
    const hit = CONTACTS.find((c) => String(c.id) === ct[1]);
    return hit ? json(res, 200, withMeta(hit)) : json(res, 404, { message: "no such contact" });
  }

  if (p === "/v1/search/contact" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    const rules = body?.jsonRule?.rules || [];
    /* The real API rejects the schema's own LOOK_UP type here, so hold the
       proxy to what actually works. */
    const bad = rules.find((r) => ["company", "ownerId"].includes(r.field) && r.type !== "long");
    if (bad) return json(res, 400, { message: "Invalid Type" });

    let out = CONTACTS;
    for (const r of rules) {
      /* company arrives either as a bare id or as an object, so match both. */
      if (r.field === "company")
        out = out.filter((c) => Number(c.company?.id ?? c.company) === Number(r.value));
      if (r.field === "ownerId") out = out.filter((c) => c.ownerId === Number(r.value));
    }
    return json(res, 200, { content: out.map(withMeta), totalElements: out.length });
  }

  if (p === "/v1/search/company" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    const rules = body?.jsonRule?.rules || [];

    /* Real Kylas 500s with a bare NullPointerException on this endpoint for
       field lists that are fine on /search/contact. Reproduce it so the
       client's shape-fallback is exercised rather than assumed.
         MOCK_COMPANY_500=fields   reject anything past the lean list
         MOCK_COMPANY_500=owner    reject any server-side ownerId filter
         MOCK_COMPANY_500=all      reject everything but free-text */
    const mode = process.env.MOCK_COMPANY_500 || "";
    const lean = ["id", "name", "ownerId", "customFieldValues", "metaData"];
    const extra = (body.fields || []).filter((f) => !lean.includes(f));
    const npe = () => json(res, 500, { status: 500, error: "Internal Server Error",
      exception: "java.lang.NullPointerException", message: "No message available",
      path: "/v1/search/company" });
    if ((mode === "fields" || mode === "all") && extra.length) return npe();
    if ((mode === "owner" || mode === "all") && rules.some((r) => r.field === "ownerId")) return npe();

    const bad = rules.find((r) => r.field === "ownerId" && r.type !== "long");
    if (bad) return json(res, 400, { message: "Invalid Type" });

    let out = Object.values(COMPANIES);
    for (const r of rules)
      if (r.field === "ownerId") out = out.filter((c) => c.ownerId === Number(r.value));
    /* A company carries its owner's name in its own idNameStore, same as a
       contact does. Company 903 deliberately has no custom fields at all. */
    const withOwner = (c) => ({ ...c, metaData: { idNameStore: {
      ownerId: { [String(c.ownerId)]: userName(c.ownerId) } } } });

    /* HONOUR page/size. Returning everything at once made the client's
       pagination loop untested — and the real API caps at `size`, which is
       exactly the behaviour that lost 230 of Ayush's companies. */
    const size = Math.max(1, Number(url.searchParams.get("size") || 200));
    const pg = Math.max(0, Number(url.searchParams.get("page") || 0));
    const slice = out.slice(pg * size, pg * size + size);
    return json(res, 200, { content: slice.map(withOwner),
                            totalElements: out.length, page: pg, size });
  }

  if (p === "/v1/entities/contact/fields") {
    return json(res, 200, { content: [
      { name: "cfSourceOfData", displayName: "Source of Data", type: "PICK_LIST",
        picklist: { picklistValues: [
          { id: 9001, name: "Round-Robin", displayName: "Round-Robin" },
          { id: 9002, name: "Apollo", displayName: "Apollo" },
          { id: 9003, name: "Referral", displayName: "Referral" },
        ] } },
      { name: "cfPipelineStageBd", displayName: "Pipeline Stage - BD", type: "PICK_LIST",
        picklist: { picklistValues: stages.map((s) => ({ id: s.id, name: s.code, displayName: s.label })) } },
      { name: "designation", displayName: "Designation", type: "TEXT_FIELD" },
    ] });
  }

  /* ── writes ──────────────────────────────────────────────────────── */
  if (p === "/v1/contacts" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    const made = { id: nextId++, ...body, createdAt: new Date().toISOString() };
    CONTACTS.push(made);
    WRITES.push({ kind: "create", id: made.id, body });
    return json(res, 200, made);
  }

  const put = p.match(/^\/v1\/contacts\/(\d+)$/);
  if (put && req.method === "PUT") {
    const body = JSON.parse(await text(req));
    const at = CONTACTS.findIndex((c) => String(c.id) === put[1]);
    if (at < 0) return json(res, 404, { message: "no such contact" });
    CONTACTS[at] = { ...CONTACTS[at], ...body, updatedAt: new Date().toISOString() };
    WRITES.push({ kind: "update", id: Number(put[1]), body });
    return json(res, 200, CONTACTS[at]);
  }

  if (p === "/v1/call-logs/" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    const made = { id: nextId++, ...body };
    CALL_LOGS.push(made);
    WRITES.push({ kind: "calllog", id: made.id, body });
    return json(res, 200, made);
  }

  /* Test hook: what has actually been written, so a test can assert on it. */
  if (p === "/__writes") return json(res, 200, { writes: WRITES, callLogs: CALL_LOGS });
  if (p === "/__reset") { WRITES.length = 0; CALL_LOGS.length = 0; return json(res, 200, { ok: true }); }

  json(res, 404, { message: "not mocked", path: p, method: req.method });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock kylas on http://127.0.0.1:${PORT}`);
  console.log(`  companies ${Object.keys(COMPANIES).join(", ")} · ${CONTACTS.length} contacts · 429s above 4 req/s`);
});

function text(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b || "{}"));
  });
}
