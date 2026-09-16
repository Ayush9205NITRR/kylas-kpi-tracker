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
 * Read-only for now. Writes come next.
 */
import { createServer } from "node:http";
import { createClient, toConsoleContact, toConsoleCompany } from "./kylas.mjs";

const KEY = process.env.KYLAS_KEY;
const PORT = Number(process.env.PORT || 8787);
if (!KEY) {
  console.error("Set KYLAS_KEY — app.kylas.io/setup/integrations/api-keys/list");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const kylas = createClient(KEY, { log });

/* Owner ids come back on every contact but names do not, and the picker needs
   names. One lookup per owner, remembered for the life of the process. */
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
  for (const c of raw) out.push(toConsoleContact(c, { ownerName: await ownerName(c.ownerId), company }));
  return out;
}

/* The owner dropdown needs names, not ids, and the console cannot invent them.
   Everyone seen so far, so a fetched owner is always selectable. */
const ownerList = () => [...owners.entries()].map(([id, name]) => ({ id, name }));

const routes = {
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
    return { company, contacts, owners: ownerList() };
  },

  /* Session mode: everything this owner holds, ordered in the browser. */
  "/queue": async (url) => {
    const me = await kylas.me();
    const owner = url.searchParams.get("owner") || me?.id;
    const contacts = await mapContacts(await kylas.contactsForOwner(owner));
    log(`queue for owner ${owner} — ${contacts.length} contact(s)`);
    return { owner: String(owner), contacts, owners: ownerList() };
  },

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
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", routes: Object.keys(routes) }));
  }

  try {
    const body = await handler(url);
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
