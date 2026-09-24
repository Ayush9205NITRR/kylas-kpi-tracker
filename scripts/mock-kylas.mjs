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
  74725: { id: 74725, firstName: "Enout", lastName: "Super Admin",
           email: "crmadmin@enout.in", active: true },
  74726: { id: 74726, firstName: "Priya", lastName: "Deshmukh",
           email: "priya@enout.in", active: true },
  74727: { id: 74727, firstName: "Gone", lastName: "Away",
           email: "gone@enout.in", active: false },
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
/* Mutable, because POST /__hang toggles it without a restart — a restart would
   throw away the contacts the test needs the recovery path to find. */
let hangCreate = process.env.MOCK_HANG_CREATE === "1";
/* POST /__refuse?name=<substring> makes Kylas turn down a create by name. The
   phone rules below cannot express this: the console normalises every number
   before it gets here, so nothing that reaches Kylas fails them, and the branch
   where a create is REFUSED — and the journal must forget the key rather than
   leave an unfinished attempt behind — was otherwise unreachable. */
let refuseName = "";

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
      /* The company picklist "Offsite Timeline (BD - New)". The internal name
         here is invented on purpose: the server must find the field by its
         label, never by a guessed name. */
      cfOffsiteTimelineBdNew: 9103,
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
/* MOCK_MANY=1 gives 260; MOCK_MANY=<n> gives n. Ayush's real account pages
   past 5,000, which is the case that exposed the page cap — so the number has
   to be settable, not a constant that happens to be smaller than the bug. */
if (process.env.MOCK_MANY) {
  const HOW_MANY = process.env.MOCK_MANY === "1" ? 260 : Number(process.env.MOCK_MANY) || 260;
  for (let i = 0; i < HOW_MANY; i++) {
    const id = 200000 + i;
    /* A DISTINCT updatedAt each, one minute apart, because the window crawl
       walks backwards through this field. Identical timestamps across more
       than one page would stall it, and that case deserves its own fixture
       rather than being the accidental default here. */
    COMPANIES[id] = { id, name: `bulk-${String(i).padStart(3, "0")}`,
      ownerId: i % 2 ? 74726 : 74725,
      /* MOCK_SAME_STAMP=1 gives every bulk company ONE timestamp, which is the
         case that stalls a keyset cursor: more rows share the cursor value
         than a page can return, so asking for "older than X" hands back the
         same page for ever. A guard against that is only worth having if it
         has been made to fire. */
      updatedAt: process.env.MOCK_SAME_STAMP === "1"
        ? new Date(Date.UTC(2026, 8, 18, 12, 0)).toISOString()
        : new Date(Date.UTC(2026, 8, 18, 12, 0) - i * 60_000).toISOString(),
      /* MOCK_MANY_SOURCES=<n> spreads the bulk companies over n distinct
         free-text sources, as the real account's hundreds of values are —
         the case that buried the accounts table under a screen of chips. */
      customFieldValues: { cfSourceOfData: process.env.MOCK_MANY_SOURCES
                             ? (i % 5 === 0 ? "Round-Robin" : `Source ${i % Number(process.env.MOCK_MANY_SOURCES)}`)
                             : i % 3 ? "Round-Robin" : "Apollo",
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

/* MOCK_CONTACTS=<n> adds n more, spread across the bulk companies. Four
   contacts cannot tell a fast read path from a slow one — the whole argument
   for reading out of Airtable is about what happens at thousands of rows, and
   that has to be measurable rather than asserted. */
if (process.env.MOCK_CONTACTS) {
  const N = Number(process.env.MOCK_CONTACTS) || 0;
  const coIds = Object.keys(COMPANIES).map(Number);
  for (let i = 0; i < N; i++) {
    CONTACTS.push({
      id: 500000 + i,
      firstName: "Bulk", lastName: `Contact ${i}`,
      ownerId: i % 2 ? 74726 : 74725,
      company: coIds[i % coIds.length],
      designation: "Manager",
      emails: [{ type: "OFFICE", value: `bulk${i}@example.com`, primary: true }],
      phoneNumbers: [{ type: "MOBILE", dialCode: "+91", value: String(9000000000 + i), primary: true }],
      customFieldValues: { cfPipelineStageBd: id("MQL_MARKETING_QUALIFIED_LEAD") },
      updatedAt: new Date(Date.UTC(2026, 8, 17, 12, 0) - i * 1000).toISOString(),
    });
  }
}

let nextId = 900001;
const WRITES = [];
const CALL_LOGS = [];
let recent = [];
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/* MOCK_LATENCY_MS: what a round trip to the real Kylas costs, so a benchmark
   against this mock measures the pipeline and not localhost. Off by default. */
const LATENCY = Number(process.env.MOCK_LATENCY_MS || 0);
createServer(async (req, res) => {
  if (process.env.MOCK_TRACE) console.log(`${Date.now()} ${req.method} ${decodeURIComponent(req.url).slice(0, 90)}`);
  if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
  const url = new URL(req.url, `http://${req.headers.host}`);
  const now = Date.now();
  recent = recent.filter((t) => now - t < 1000);
  recent.push(now);
  /* Roughly what the real thing does to a burst. */
  if (recent.length > 4) return json(res, 429, { message: "Too many requests" });

  if (!req.headers["api-key"]) return json(res, 401, { message: "api-key missing" });

  const p = url.pathname;
  if (p === "/v1/users/me") return json(res, 200, USERS[74725]);
  /* The documented per-id lookup — the floor the client falls back to. */
  const oneUser = p.match(/^\/v1\/users\/(\d+)$/);
  if (oneUser) {
    const u = USERS[Number(oneUser[1])];
    return u ? json(res, 200, u) : json(res, 404, { message: "no such user" });
  }

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
    /* HONOUR THE SORT, and page. Neither was modelled here, so a client that
       walks contacts newest-first and stops at a watermark was being tested
       against a server that returned them in insertion order — it stopped at
       the first old row and silently dropped everything after it.
         MOCK_IGNORE_SORT=1 returns them unsorted on purpose, because a client
       must not take the sort parameter on trust either. */
    if (process.env.MOCK_IGNORE_SORT !== "1")
      out = [...out].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const csize = Math.max(1, Number(url.searchParams.get("size") || 200));
    const cpage = Math.max(0, Number(url.searchParams.get("page") || 0));
    return json(res, 200, { content: out.slice(cpage * csize, cpage * csize + csize).map(withMeta),
                            totalElements: out.length, page: cpage, size: csize });
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

    /* An updatedAt UPPER BOUND, which is how a client walks past the result
       window: page by offset until the window runs out, then ask for the next
       slice by timestamp instead. Only the "less" operator is honoured here —
       a client must not assume a rule it sent was understood, and the one on
       the other side of this checks that the rows really are older.
         MOCK_IGNORE_BOUND=1 accepts the rule and ignores it, which is the
       dangerous case: a silently ignored bound returns the same page forever. */
    const ignore = process.env.MOCK_IGNORE_BOUND === "1";
    for (const r of rules) {
      if (r.field !== "updatedAt" || ignore) continue;
      const cut = Date.parse(r.value);
      if (!Number.isFinite(cut)) return json(res, 400, { message: "Invalid date" });
      if (r.operator === "less") out = out.filter((c) => Date.parse(c.updatedAt || 0) < cut);
      else return json(res, 400, { message: `Unsupported operator ${r.operator}` });
    }

    /* Newest first, as the sort parameter asks. Without this the window crawl
       would be walking an arbitrary order and its "oldest seen" cursor would
       mean nothing. */
    out = [...out].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    /* sort=updatedAt,asc — oldest first, which is how a client reads the far
       end of a result window. MOCK_IGNORE_ASC=1 ignores the direction, so the
       client's check that it really got older rows can be tested. */
    const sortBy = url.searchParams.get("sort") || "";
    if (/updatedAt,asc/i.test(sortBy) && process.env.MOCK_IGNORE_ASC !== "1")
      out.reverse();
    /* id ascending — a second order a client can reach the far end by.
       MOCK_ONLY_ID_ASC=1 honours this and ignores updatedAt,asc, which is the
       account where only a different field gets past the window. */
    if (/^id,(asc|desc)$/i.test(sortBy) && process.env.MOCK_NO_ID_SORT !== "1") {
      out = [...out].sort((a, b) => Number(a.id) - Number(b.id));
      if (/desc$/i.test(sortBy)) out.reverse();
    }
    /* MOCK_NO_BOUND=1 refuses every updatedAt rule, as a search that cannot
       filter on it would. */
    if (process.env.MOCK_NO_BOUND === "1" && rules.some((r) => r.field === "updatedAt"))
      return json(res, 400, { message: "Unsupported field updatedAt" });
    /* A company carries its owner's name in its own idNameStore, same as a
       contact does. Company 903 deliberately has no custom fields at all. */
    const withOwner = (c) => ({ ...c, metaData: { idNameStore: {
      ownerId: { [String(c.ownerId)]: userName(c.ownerId) } } } });

    /* HONOUR page/size. Returning everything at once made the client's
       pagination loop untested — and the real API caps at `size`, which is
       exactly the behaviour that lost 230 of Ayush's companies. */
    const size = Math.max(1, Number(url.searchParams.get("size") || 200));
    const pg = Math.max(0, Number(url.searchParams.get("page") || 0));

    /* A RESULT WINDOW, which is not the same as a page size.
       Ayush's account crawls to exactly 10,000 companies and then returns a
       short page, so the client concludes it reached the end. 10,000 is
       Elasticsearch's default max_result_window, and this endpoint is plainly
       search-backed — the count is a CEILING, not his company count. A search
       result that silently ends while GET /v1/companies/{id} still answers for
       the rows past it is the exact shape of the fault, and it is unreproducible
       without this switch.
         MOCK_SEARCH_CEILING=<n>   nothing past offset n is searchable
       Deliberately NOT applied to the by-id route above: that is the whole
       point — the record exists, the search just cannot reach it. */
    const ceiling = Number(process.env.MOCK_SEARCH_CEILING || 0);
    const window = ceiling > 0 ? out.slice(0, ceiling) : out;
    const slice = window.slice(pg * size, pg * size + size);
    /* totalElements is the TRUE match count even when the window refuses to
       serve those rows — that is how a search index behaves, and it is the
       only thing that tells a client its list is short. Reporting the windowed
       length instead would make the ceiling undetectable, which is the bug
       rather than the fixture. */
    return json(res, 200, { content: slice.map(withOwner),
                            totalElements: out.length, page: pg, size });
  }

  /* Company fields, for the Offsite Timeline picklist that lives on the
     company. Two offsite-looking fields, as an account that replaced one is
     likely to have: the "(BD - New)" one is the live one. */
  if (p === "/v1/entities/company/fields") {
    return json(res, 200, { content: [
      { name: "cfOffsiteTimeline", displayName: "Offsite Timeline (old)", type: "TEXT_FIELD" },
      { name: "cfOffsiteTimelineBdNew", displayName: "Offsite Timeline (BD - New)", type: "PICK_LIST",
        picklist: { picklistValues: [
          { id: 9101, name: "JAN_MAR", displayName: "Jan - Mar" },
          { id: 9102, name: "APR_JUN", displayName: "Apr - Jun" },
          { id: 9103, name: "JUL_SEP", displayName: "Jul - Sep" },
          { id: 9104, name: "OCT_DEC", displayName: "Oct - Dec" },
        ] } },
      { name: "cfBatch", displayName: "Batch", type: "TEXT_FIELD" },
    ] });
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

  /* No list endpoint exists on the real API, which is the whole reason the
     client has a fallback chain. MOCK_USER_LIST=1 pretends one does, so both
     branches are exercisable. */
  if (p === "/v1/users" && process.env.MOCK_USER_LIST === "1")
    return json(res, 200, { content: Object.values(USERS) });
  if (p === "/v1/users") return json(res, 404, { message: "Not Found" });
  if (p === "/v1/search/user") return json(res, 500, { exception: "java.lang.NullPointerException" });

  /* ── writes ──────────────────────────────────────────────────────── */
  /* Kylas validates phone numbers and says almost nothing about why:
       400 {"code":"002008","message":"Invalid Mobile Number.","errorDetails":[]}
     It rejects a `value` that carries its own country code, which is what
     happens when a pasted "+918319585041" is written straight back beside
     dialCode "+91". Reproduced here so the fix cannot silently regress —
     without it this mock accepts a body the real API refuses. */
  const badPhone = (body) => (body.phoneNumbers || []).some((ph) => {
    const v = String(ph?.value ?? "");
    if (/[^\d]/.test(v)) return true;                      /* +, spaces, dashes */
    if (String(ph?.dialCode || "+91") === "+91" && v.length !== 10) return true;
    return false;
  });

  if (p === "/v1/contacts" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    if (badPhone(body))
      return json(res, 400, { code: "002008", message: "Invalid Mobile Number.", errorDetails: [] });
    if (refuseName && `${body.firstName || ""} ${body.lastName || ""}`.includes(refuseName))
      return json(res, 400, { code: "002099", message: "Refused by the test hook.", errorDetails: [] });
    /* updatedAt as well as createdAt. Without it a just-created contact looked
       older than any watermark, so a delta search could never find one — and
       the recovery that leans on a delta was passing only because the company
       roster answered first. */
    const now = new Date().toISOString();
    const made = { id: nextId++, ...body, createdAt: now, updatedAt: now };
    CONTACTS.push(made);
    WRITES.push({ kind: "create", id: made.id, body });
    /* Creates the contact and never answers — MOCK_HANG_CREATE=1, or switched
       on mid-run with POST /__hang?on=1 so a test can arrange it without
       restarting this process and losing the contacts it is holding.
       This is THE failure the save journal exists for and it cannot be faked
       from the client side: a request that times out and a request that was
       never received look identical to the browser, and only one of them has
       already made a contact. Kill the proxy while it waits here and the next
       attempt meets exactly the state a crashed create leaves behind. */
    if (hangCreate) {
      console.log(`  created ${made.id} and HANGING — the reply will never arrive`);
      return true;
    }
    return json(res, 200, made);
  }

  /* A company update. Strict about being sent the WHOLE record, as a PUT
     that replaces it would be: a body without the name is refused rather than
     wiping it, so a client that sends only the changed field fails loudly. */
  const coPut = p.match(/^\/v1\/companies\/(\d+)$/);
  if (coPut && req.method === "PUT") {
    const body = JSON.parse(await text(req));
    if (!COMPANIES[coPut[1]]) return json(res, 404, { message: "no such company" });
    if (!body.name) return json(res, 400, { code: "001001", message: "name is required" });
    COMPANIES[coPut[1]] = { ...COMPANIES[coPut[1]], ...body, updatedAt: new Date().toISOString() };
    WRITES.push({ kind: "company-update", id: Number(coPut[1]), body });
    return json(res, 200, COMPANIES[coPut[1]]);
  }

  const put = p.match(/^\/v1\/contacts\/(\d+)$/);
  if (put && req.method === "PUT") {
    const body = JSON.parse(await text(req));
    if (badPhone(body))
      return json(res, 400, { code: "002008", message: "Invalid Mobile Number.", errorDetails: [] });
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
  if (p === "/__refuse") { refuseName = url.searchParams.get("name") || ""; return json(res, 200, { refuseName }); }
  if (p === "/__hang") { hangCreate = url.searchParams.get("on") === "1"; return json(res, 200, { hangCreate }); }
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
