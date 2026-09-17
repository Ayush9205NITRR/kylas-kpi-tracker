#!/usr/bin/env node
/* The fetch side of the proxy.
 *
 *   KYLAS_KEY=... node scripts/proxy.mjs
 *   KYLAS_KEY=... PORT=8787 node scripts/proxy.mjs
 *
 * Runs on your machine; the extension talks to it at http://127.0.0.1:8787.
 * The API key lives here, in one process, rather than in every associate's
 * browser. The same handlers deploy to a Cloudflare Worker unchanged — only the
 * server shell below is node-specific.
 *
 * Reads and writes. A write is: create or update the contact, rewrite the
 * marker block inside its remarks, and append a native Kylas call log.
 */
import { createServer } from "node:http";
import { createClient, toConsoleContact, toConsoleCompany, lookupName,
         toKylasContact, toKylasCallLog, renderRemarks, mergeRemarks } from "./kylas.mjs";
import { STAGE_ID, STAGE_LABEL } from "./stages.mjs";
import { createAirtable, syncContact } from "./airtable.mjs";

const KEY = process.env.KYLAS_KEY;
const PORT = Number(process.env.PORT || 8787);
if (!KEY) {
  console.error("Set KYLAS_KEY — app.kylas.io/setup/integrations/api-keys/list");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const kylas = createClient(KEY, { log });

/* Airtable is optional: without a PAT the proxy still reads and writes Kylas,
   and each save reports that the Airtable half was skipped rather than failing.
   That way a missing token degrades the KPIs, not the dialling. */
const AT_PAT = process.env.AIRTABLE_PAT;
const AT_BASE = process.env.AIRTABLE_BASE;
const airtable = AT_PAT && AT_BASE ? createAirtable(AT_PAT, AT_BASE, { log }) : null;
/* Say so either way. On a fresh install the absence of a warning is not a
   signal anyone can act on — it reads the same as a line that never printed. */
if (airtable) log(`airtable: ${AT_BASE}`);
else log("airtable: not configured (set AIRTABLE_PAT and AIRTABLE_BASE) — KPIs will not be written");

/* Most records carry their own owner name in metaData.idNameStore, so this is
   a fallback for the ones that do not — and every avoided request is one fewer
   against a tight rate limit. */
const owners = new Map();
async function ownerName(id) {
  if (!id) return "";
  const k = String(id);
  if (!owners.has(k)) {
    try {
      const u = await kylas.user(k);
      owners.set(k, [u?.firstName, u?.lastName].filter(Boolean).join(" ") || k);
    } catch {
      owners.set(k, k);   // a failed lookup should not fail the whole fetch
    }
  }
  return owners.get(k);
}

async function mapContacts(raw, company) {
  const out = [];
  for (const c of raw) {
    const known = lookupName(c, "ownerId", c.ownerId);
    if (known && c.ownerId) owners.set(String(c.ownerId), known);
    out.push(toConsoleContact(c, { ownerName: known || (await ownerName(c.ownerId)), company }));
  }
  return out;
}

/* The owner dropdown needs names, not ids, and the console cannot invent them.
   Everyone seen so far, so a fetched owner is always selectable. */
const ownerList = () => [...owners.entries()].map(([id, name]) => ({ id, name }));

/* Picklists, read once. The console cannot know what an account's custom
   fields offer, and a hardcoded list quietly renders real values as blank. */
let metaCache = null;
async function meta() {
  if (metaCache) return metaCache;
  const r = await kylas.raw("GET",
    "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
  const fields = Array.isArray(r) ? r : r?.content || r?.data || [];
  const picklists = {};
  for (const f of fields) {
    const key = f.name || f.displayName;
    const values = findOptions(f);
    if (key && values) picklists[key] = values;
  }
  metaCache = { picklists, fields: fields.map((f) => ({ name: f.name, label: f.displayName, type: f.type })) };
  log(`picklists: ${Object.keys(picklists).join(", ") || "none"}`);
  return metaCache;
}

/* Option arrays are nested differently per field type, so look for the shape
   rather than guessing at key names. */
function findOptions(field, depth = 0) {
  if (!field || depth > 4) return null;
  if (Array.isArray(field)) {
    if (field.length && field.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
      return field.map((x) => ({ id: x.id, code: x.name || x.displayName, label: x.displayName || x.name }));
    for (const x of field) { const hit = findOptions(x, depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof field === "object")
    for (const k of Object.keys(field)) { const hit = findOptions(field[k], depth + 1); if (hit) return hit; }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b || "{}"));
    req.on("error", reject);
  });
}

const routes = {
  "/meta": async () => meta(),

  "/health": async () => {
    const me = await kylas.me();
    return { ok: true, user: { id: me?.id, name: [me?.firstName, me?.lastName].filter(Boolean).join(" ") } };
  },

  /* Everything the console needs when it opens on a company page: the company
     itself, and its contacts already in console shape. */
  "/company": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) throw Object.assign(new Error("id is required"), { status: 400 });
    const [co, raw] = [await kylas.company(id), await kylas.contactsForCompany(id)];
    const company = toConsoleCompany(co);
    const contacts = await mapContacts(raw, company);
    log(`company ${id} — ${contacts.length} contact(s)`);
    return { company, contacts, owners: ownerList(), picklists: (await meta()).picklists };
  },

  /* Session mode: everything this owner holds, ordered in the browser. */
  "/queue": async (url) => {
    const me = await kylas.me();
    const owner = url.searchParams.get("owner") || me?.id;
    const contacts = await mapContacts(await kylas.contactsForOwner(owner));
    log(`queue for owner ${owner} — ${contacts.length} contact(s)`);
    return { owner: String(owner), contacts, owners: ownerList() };
  },

  /* One save from the console becomes up to three Kylas calls. Ordered so that
     a failure part-way leaves the contact correct rather than half-written:
     the record first, then its call log. */
  "/save": async (url, req) => {
    const body = JSON.parse(await readBody(req));
    const c = body.contact;
    if (!c) throw Object.assign(new Error("contact is required"), { status: 400 });

    /* The block is for a human reading the record, so use the name they know. */
    const stageLabel = STAGE_LABEL[c.stage] || c.stage || "";
    const result = { kid: c.kid || null, created: false, wrote: [] };

    /* Remarks: read what is there first so a human's own text survives. */
    let existing = "";
    if (c.kid) {
      try { existing = (await kylas.contact(c.kid))?.remarks || ""; }
      catch { /* a failed read should not block the write */ }
    }
    const remarks = mergeRemarks(existing, renderRemarks(c, { stageLabel }));
    const payload = toKylasContact(c, { remarks });

    if (!c.kid) {
      const made = await kylas.createContact(payload);
      result.kid = String(made?.id ?? "");
      result.created = true;
      result.wrote.push("created contact");
      log(`created contact ${result.kid} (${c.pocName})`);
    } else {
      await kylas.updateContact(c.kid, payload);
      result.wrote.push("updated contact");
      log(`updated contact ${c.kid} (${c.pocName})`);
    }

    /* Airtable is the authoritative store, so a failure here is reported to the
       console rather than swallowed — the associate needs to know the KPI data
       did not land, even though Kylas did. */
    if (airtable) {
      try {
        result.airtable = await syncContact(airtable, { ...c, kid: result.kid }, body.call, { log });
      } catch (e) {
        result.airtableError = e.message;
        log(`! airtable for ${result.kid}: ${e.message}`);
      }
    } else {
      result.airtableSkipped = true;
    }

    if (body.call && result.kid) {
      try {
        await kylas.createCallLog(toKylasCallLog({ ...c, kid: result.kid }, body.call));
        result.wrote.push("logged call");
      } catch (e) {
        /* The contact is already saved; losing the call log is recoverable and
           must not make the associate think the save failed. */
        result.callLogError = e.message;
        log(`! call log for ${result.kid}: ${e.message}`);
      }
    }
    return result;
  },

  /* Whether each half of the write is configured, so the console can say so
     rather than looking like it saved everywhere. */
  "/targets": async () => ({ kylas: true, airtable: !!airtable, base: AT_BASE || null }),

  "/contact": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) throw Object.assign(new Error("id is required"), { status: 400 });
    const c = await kylas.contact(id);
    return { contact: toConsoleContact(c, { ownerName: await ownerName(c?.ownerId) }), raw: c };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  /* A localhost dev proxy with no secrets in its responses; the extension's
     origin is a generated id, so echoing is simpler than allow-listing. */
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", routes: Object.keys(routes) }));
  }

  try {
    const body = await handler(url, req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (e) {
    const status = e.status || 502;
    log(`! ${url.pathname} ${status} ${e.message}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, "127.0.0.1", () => {
  log(`proxy on http://127.0.0.1:${PORT}`);
  log(`routes: ${Object.keys(routes).join("  ")}`);
});
