#!/usr/bin/env node
/* A stand-in for the Airtable REST API, enough to exercise the write path.
 *
 *   node scripts/mock-airtable.mjs               # listens on 9901
 *   AIRTABLE_BASE_URL=http://127.0.0.1:9901 ...  # point airtable.mjs at it
 *
 * Supports the three things the writer uses: upsert (PATCH with performUpsert),
 * select with filterByFormula, and delete. Rate limits above 5 requests a
 * second, like the real thing.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 9901);
const TABLES = {};                    // name -> [{id, fields}]
const WRITES = [];
let nextId = 1;

const rec = () => "rec" + String(nextId++).padStart(14, "0");
const table = (name) => (TABLES[name] = TABLES[name] || []);
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/* Only the shapes the writer actually sends:
     {Field} = 'value'     and    {Lookup (from Link)} = 'value'   */
function matches(row, formula, all) {
  /* IS_AFTER({Field}, 'yyyy-mm-dd') — used by /snapshots to fetch a window of
     frozen days. Without it every date filter matched nothing and the endpoint
     looked broken while actually being unsupported by the stand-in. */
  const after = formula.match(/^IS_AFTER\(\{([^}]+)\},\s*'(.*)'\)$/i);
  if (after) {
    const [, field, when] = after;
    const v = String(row.fields[field] ?? "");
    return v !== "" && v.slice(0, 10) > when.slice(0, 10);
  }

  const m = formula.match(/^\{([^}]+)\}\s*=\s*'(.*)'$/);
  if (!m) return false;
  const [, field, want] = m;
  const lookup = field.match(/^(.+) \(from (.+)\)$/);
  if (lookup) {
    /* Resolve the lookup by hand: follow the link, read the field. */
    const [, target, via] = lookup;
    const ids = row.fields[via] || [];
    return ids.some((id) => all.some((r) => r.id === id && String(r.fields[target] ?? "") === want));
  }
  return String(row.fields[field] ?? "") === want.replace(/\\'/g, "'");
}

let recent = [];
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const now = Date.now();
  recent = recent.filter((t) => now - t < 1000);
  recent.push(now);
  if (recent.length > 5) return json(res, 429, { error: { type: "RATE_LIMIT_REACHED" } });

  if (!/^Bearer /.test(req.headers.authorization || "")) return json(res, 401, { error: "unauthorized" });

  /* Accept the path with or without the real API's /v0 prefix, so pointing a
     client here needs only the host swapped. */
  let parts = url.pathname.split("/").filter(Boolean);     // [v0,] baseId, tableName
  if (parts[0] === "v0") parts = parts.slice(1);
  if (parts.length < 2) {
    if (!/^\/__/.test(url.pathname)) console.log(`404 ${req.method} ${url.pathname} parts=${JSON.stringify(parts)}`);
    if (url.pathname === "/__writes") return json(res, 200, { writes: WRITES, tables: TABLES });
    if (url.pathname === "/__reset") { WRITES.length = 0; for (const k of Object.keys(TABLES)) delete TABLES[k]; return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "not found" });
  }
  const name = decodeURIComponent(parts.slice(1).join("/"));
  const rows = table(name);

  if (req.method === "GET") {
    const formula = url.searchParams.get("filterByFormula");
    const max = Number(url.searchParams.get("maxRecords") || 100);
    const all = Object.values(TABLES).flat();
    const out = (formula ? rows.filter((r) => matches(r, formula, all)) : rows).slice(0, max);
    return json(res, 200, { records: out });
  }

  if (req.method === "DELETE") {
    const ids = url.searchParams.getAll("records[]");
    for (const id of ids) {
      const at = rows.findIndex((r) => r.id === id);
      if (at > -1) { WRITES.push({ kind: "delete", table: name, id }); rows.splice(at, 1); }
    }
    return json(res, 200, { records: ids.map((id) => ({ id, deleted: true })) });
  }

  const body = JSON.parse(await text(req) || "{}");

  if (req.method === "PATCH" && body.performUpsert) {
    const key = body.performUpsert.fieldsToMergeOn[0];
    const out = [];
    for (const r of body.records || []) {
      const want = String(r.fields[key] ?? "");
      const hit = rows.find((x) => String(x.fields[key] ?? "") === want && want !== "");
      if (hit) {
        hit.fields = { ...hit.fields, ...r.fields };
        WRITES.push({ kind: "update", table: name, id: hit.id, fields: r.fields });
        out.push(hit);
      } else {
        const made = { id: rec(), fields: { ...r.fields } };
        rows.push(made);
        WRITES.push({ kind: "create", table: name, id: made.id, fields: r.fields });
        out.push(made);
      }
    }
    return json(res, 200, { records: out });
  }

  if (req.method === "POST") {
    const out = (body.records || []).map((r) => {
      const made = { id: rec(), fields: { ...r.fields } };
      rows.push(made);
      WRITES.push({ kind: "create", table: name, id: made.id, fields: r.fields });
      return made;
    });
    return json(res, 200, { records: out });
  }

  json(res, 405, { error: "not mocked", method: req.method });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock airtable on http://127.0.0.1:${PORT}`);
  console.log(`  upsert / select / delete · 429s above 5 req/s · /__writes /__reset`);
});

function text(req) {
  return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
}
