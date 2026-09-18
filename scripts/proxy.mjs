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
import { createClient, toConsoleContact, toConsoleCompany, lookupName, idOf,
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

/* Same story for companies, and it matters more. A contact's company arrives as
   a bare id; the name is only in metaData.idNameStore — and whether the SEARCH
   endpoint populates that for `company` was never confirmed (the probe lost
   those responses to 429). When it does not, every contact from /queue has a
   blank company, and the companies list falls back to "Company 1776620".
   Resolving by id removes the dependency either way. Cached, so a queue of 100
   contacts across 30 companies costs 30 requests once, not 100 every fetch. */
const companyNames = new Map();
async function companyName(id) {
  if (!id) return "";
  const k = String(id);
  if (!companyNames.has(k)) {
    try {
      const co = await kylas.company(k);
      companyNames.set(k, co?.name || "");
    } catch {
      companyNames.set(k, "");   // a failed lookup must not fail the whole fetch
    }
  }
  return companyNames.get(k);
}

async function mapContacts(raw, company) {
  /* Seed the cache with the company we were asked about, and with every name
     the payloads did carry, so the resolve loop below has less to do. */
  if (company?.id && company.name) companyNames.set(String(company.id), company.name);
  for (const c of raw) {
    const id = idOf(c.company);
    const known = lookupName(c, "company", id);
    if (id && known) companyNames.set(String(id), known);
  }

  const out = [];
  for (const c of raw) {
    const known = lookupName(c, "ownerId", c.ownerId);
    if (known && c.ownerId) owners.set(String(c.ownerId), known);
    const mapped = toConsoleContact(c, { ownerName: known || (await ownerName(c.ownerId)), company });
    /* The name may still be missing — fetch it rather than let the console
       render an id where a human expects a company. */
    if (mapped.companyId && !mapped.company) mapped.company = await companyName(mapped.companyId);
    out.push(mapped);
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

  /* The companies list and the dashboards. Companies allotted to an owner are
     the ones whose OWN owner field is that person — not the ones where they
     happen to own a contact. Deriving the list from contacts, as the console
     used to, silently hides every company that has been assigned but not yet
     worked, which is exactly the list an associate needs at the start of a day.
     ?owner= for one person, ?owner=all for the team view. */
  "/companies": async (url) => {
    const want = url.searchParams.get("owner");
    const me = await kylas.me();
    const all = want === "all";
    const owner = all ? null : (want || me?.id);

    const raw = all ? await kylas.companies() : await kylas.companiesForOwner(owner);

    /* ?keys=1 reports the shape this account's company search actually returns,
       WITHOUT the values — enough to find where a missing field lives, safe to
       paste. Guessing at key names is how the name came back blank for 38
       companies in the first place. */
    if (url.searchParams.get("keys")) {
      const first = raw[0] || {};
      return {
        count: raw.length,
        shape: kylas.companyShapeName?.() || "unknown",
        topLevelKeys: Object.keys(first).sort(),
        customFieldKeys: Object.keys(first.customFieldValues || {}).sort(),
        idNameStoreKeys: Object.keys(first.metaData?.idNameStore || {}).sort(),
        nameLikeValues: Object.fromEntries(Object.entries(first)
          .filter(([k, v]) => /name|title|company/i.test(k) && typeof v !== "object")
          .map(([k, v]) => [k, typeof v])),
      };
    }
    const companies = [];
    for (const co of raw) {
      const known = lookupName(co, "ownerId", co.ownerId);
      if (known && co.ownerId) owners.set(String(co.ownerId), known);
      /* Seed the name cache too — the contact mapper then never has to fetch
         a company whose name already came back on this list. */
      if (co?.id && co?.name) companyNames.set(String(co.id), co.name);
      companies.push({
        ...toConsoleCompany(co),
        owner: known || (await ownerName(co.ownerId)) || "",
        ownerId: String(co.ownerId ?? ""),
      });
    }
    log(`companies for ${all ? "all owners" : owner} — ${companies.length}`);
    /* The picklists too. The companies LIST page never calls /company, so
       without them the console's SOURCES stayed empty there and the Source
       filter could only offer values it happened to see in the loaded rows.
       meta() is cached, so this is free after the first call. */
    return { owner: all ? "all" : String(owner), companies, owners: ownerList(),
             picklists: (await meta()).picklists };
  },

  /* The frozen daily numbers, for the trend chart. Read from Airtable, which
     is where the day/week/month history lives — the browser's own snapshots
     only hold call outcomes, not the company-level funnel, so a conversion
     trend cannot be computed locally. */
  "/snapshots": async (url) => {
    if (!airtable) return { snapshots: [], reason: "Airtable is not configured" };
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") || 60)));
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const rows = await airtable.list("Daily Snapshot", `IS_AFTER({Date}, '${since}')`, 400);
    const snapshots = rows.map((r) => r.fields)
      .filter((f) => f.Date)
      .sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
    log(`snapshots since ${since} — ${snapshots.length}`);
    return { snapshots, since };
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

const server = createServer(async (req, res) => {
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
});

/* A port clash is the most common thing that happens when restarting this, and
   an unhandled 'error' event dumps a Node stack trace that names neither the
   cause nor the fix. Worse: the OLD process keeps serving, so the console still
   works — on stale code, with whatever key that process started with. That is
   how an expired key looked like a broken key for half an hour. */
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`\nPort ${PORT} is already taken — an older proxy is still running.`);
  console.error(`It will keep answering the extension with the code and key it started with,`);
  console.error(`so the console may look broken in ways that have nothing to do with your setup.\n`);
  console.error(`Stop it and start again:`);
  console.error(`  kill $(lsof -t -iTCP:${PORT} -sTCP:LISTEN)`);
  console.error(`  source .env.local && node scripts/proxy.mjs\n`);
  console.error(`Or run this one somewhere else:`);
  console.error(`  PORT=${PORT + 1} node scripts/proxy.mjs`);
  console.error(`then click the offline badge in the console and point it at that address.\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`proxy on http://127.0.0.1:${PORT}`);
  log(`routes: ${Object.keys(routes).join("  ")}`);
});
