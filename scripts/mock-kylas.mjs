#!/usr/bin/env node
/* A stand-in for the Kylas API, returning the shapes the live probe actually
 * observed on 2026-09-16.
 *
 *   node scripts/mock-kylas.mjs                 # listens on 9900
 *   KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x node scripts/proxy.mjs
 *
 * Exists so the proxy, the mapping and the console can be tested end to end
 * without a real key and without touching the real CRM. It deliberately
 * reproduces the awkward parts: stages come back as numeric picklist ids, the
 * company is a nested object, and a burst of requests is rate limited.
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
};

/* Stages arrive as ids, not codes — the mapping layer has to cope. */
const CONTACTS = [
  { id: 112936, firstName: "Hema", lastName: "Bharathi", ownerId: 74725,
    /* Search returns company as a bare id with no name — this is what blanked
       the Company field against the live account. */
    company: 1776620, designation: "Founder's Office",
    linkedin: "https://linkedin.com/in/hema-bharathi",
    emails: [{ type: "OFFICE", value: "hema@seats.aero", primary: true }],
    phoneNumbers: [{ type: "MOBILE", dialCode: "+91", code: "IN", value: "9876501234", primary: true }],
    customFieldValues: { cfPipelineStageBd: id("MQL_MARKETING_QUALIFIED_LEAD"), cfSourceOfData: "LINKEDIN" },
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
  if (ct) {
    const hit = CONTACTS.find((c) => String(c.id) === ct[1]);
    return hit ? json(res, 200, hit) : json(res, 404, { message: "no such contact" });
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
    return json(res, 200, { content: out, totalElements: out.length });
  }

  json(res, 404, { message: "not mocked", path: p });
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
