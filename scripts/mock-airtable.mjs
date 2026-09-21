#!/usr/bin/env node
/* A stand-in for the Airtable REST API, enough to exercise the write path.
 *
 *   node scripts/mock-airtable.mjs               # listens on 9901
 *   AIRTABLE_BASE_URL=http://127.0.0.1:9901 ...  # point airtable.mjs at it
 *
 * Supports what the writer and the migrations use: upsert (PATCH with
 * performUpsert), update by record id (plain PATCH), select with
 * filterByFormula, pageSize/offset paging, fields[] projection and delete.
 * Rate limits above 5 requests a second, like the real thing.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 9901);
const TABLES = {};                    // name -> [{id, fields}]
const WRITES = [];
let nextId = 1;

const rec = () => "rec" + String(nextId++).padStart(14, "0");

/* MOCK_AIRTABLE_SEED=<file.json> pre-loads rows, e.g.
     { "Companies": [ { "Kylas Company ID": "1776620", "Right POC": 1 } ] }
   The read path needs rows carrying the FORMULA fields, and this stand-in does
   not evaluate Airtable formulas — reimplementing them here would be testing a
   second implementation rather than the one that ships. Seeding the answers
   tests what actually changed: the read, the join on Kylas company id, and what
   the view does with it. */
function seed() {
  const path = process.env.MOCK_AIRTABLE_SEED;
  if (!path) return;
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const [name, list] of Object.entries(data))
    for (const fields of list) TABLES[name] = (TABLES[name] || []).concat([{ id: rec(), fields }]);
  console.log(`  seeded ${Object.entries(data).map(([k, v]) => `${v.length} ${k}`).join(", ")}`);
}
seed();
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

/* PER BASE, which is how Airtable's limit actually works — "5 requests per
   second per base". Counting globally made this mock lie about the one thing
   it exists to simulate: the console reads its KPI base and the enrichment
   base through two separate clients, each correctly pacing itself at 5 req/s,
   which against one global counter looked like a 429 storm. Two seconds of
   spurious backoff on every cold start, charged to whichever request happened
   to be in flight — and I spent a measurement run blaming the wrong thing.

   The rows themselves stay one shared map; this stand-in has no notion of
   separate bases and does not need one. It is the PACING that has to be
   faithful, because that is what the client is written against. */
const recent = new Map();     // baseId -> timestamps within the last second
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const now = Date.now();
  const forBase = url.pathname.split("/").filter(Boolean).filter((s) => s !== "v0")[0] || "-";
  const seen = (recent.get(forBase) || []).filter((t) => now - t < 1000);
  seen.push(now);
  recent.set(forBase, seen);
  if (seen.length > 5) return json(res, 429, { error: { type: "RATE_LIMIT_REACHED" } });

  if (!/^Bearer /.test(req.headers.authorization || "")) return json(res, 401, { error: "unauthorized" });

  /* Accept the path with or without the real API's /v0 prefix, so pointing a
     client here needs only the host swapped. */
  let parts = url.pathname.split("/").filter(Boolean);     // [v0,] baseId, tableName
  if (parts[0] === "v0") parts = parts.slice(1);

  /* The metadata API — enough of it for a caller that asks the base what it
     holds before naming fields in a projection. NAMES ONLY: this stand-in has
     no schema of its own, so it reports the shape of the rows it was seeded
     with and calls every type singleLineText. Enough to choose fields by, not
     a substitute for verify-base.mjs against the real base.

     PLUS MOCK_AIRTABLE_COLUMNS=Contacts.First Right POC At[,Contacts.X], which
     declares a column that EXISTS AND IS EMPTY. Deriving the schema from the
     rows gave this stand-in the same blind spot as the code it was meant to
     test: Airtable omits an empty field from a record entirely, so a column
     created and never written appears nowhere in the data — and a check of the
     shape `name in record.fields` calls it missing. That is the state of every
     column the moment repair-base adds it, and it is what stopped
     migrate-first-qualified dead on a base that was perfectly fine. A mock
     that cannot represent "declared but empty" cannot catch it. */
  if (parts[0] === "meta" && parts[1] === "bases" && parts[3] === "tables") {
    const declared = new Map();
    for (const spec of (process.env.MOCK_AIRTABLE_COLUMNS || "").split(",")) {
      const [t, ...rest] = spec.trim().split(".");
      if (!t || !rest.length) continue;
      declared.set(t, (declared.get(t) || []).concat(rest.join(".")));
    }
    const names = new Set([...Object.keys(TABLES), ...declared.keys()]);
    return json(res, 200, {
      tables: [...names].map((tname) => ({
        id: "tbl" + tname.replace(/\W/g, ""),
        name: tname,
        fields: [...new Set([
          ...(TABLES[tname] || []).flatMap((r) => Object.keys(r.fields)),
          ...(declared.get(tname) || []),
        ])].map((f) => ({ id: "fld" + f.replace(/\W/g, ""), name: f, type: "singleLineText" })),
      })),
    });
  }

  if (parts.length < 2) {
    if (!/^\/__/.test(url.pathname)) console.log(`404 ${req.method} ${url.pathname} parts=${JSON.stringify(parts)}`);
    if (url.pathname === "/__writes") return json(res, 200, { writes: WRITES, tables: TABLES });
    if (url.pathname === "/__reset") { WRITES.length = 0; for (const k of Object.keys(TABLES)) delete TABLES[k]; return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "not found" });
  }
  const name = decodeURIComponent(parts.slice(1).join("/"));

  /* MOCK_AIRTABLE_404=<table>[,<table>] makes those tables absent.
     This stand-in CREATES a table on first touch, which is convenient for the
     writer and useless for testing what happens when a table is genuinely
     missing — and "the table is missing" is exactly the case that must stop a
     data migration, because it has nowhere to record that it ran. */
  const absent = (process.env.MOCK_AIRTABLE_404 || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (absent.includes(name))
    return json(res, 404, { error: { type: "TABLE_NOT_FOUND", message: `Table "${name}" not found` } });

  /* MOCK_AIRTABLE_NOFIELD=Contacts.Phones[,Companies.Batch] makes those columns
     absent from the WRITE path.
     This stand-in stores whatever it is given, which is convenient and is also
     exactly the way it was kinder than production: a real base rejects the
     WHOLE record for one field name it does not have, and that is how a base
     one repair-base behind lost a whole afternoon of saves — syncContact died
     at the contact, before the event rows, the call log and the transition.
     A stand-in that accepts any name cannot test the writer's recovery from
     that, so this reproduces the rejection, one field at a time, exactly as
     Airtable reports it. */
  const noField = (process.env.MOCK_AIRTABLE_NOFIELD || "").split(",")
    .map((x) => x.trim()).filter(Boolean);
  const absentField = (fields) => {
    if (!noField.length) return "";
    return Object.keys(fields || {}).find((f) => noField.includes(`${name}.${f}`)) || "";
  };

  const rows = table(name);

  if (req.method === "GET") {
    const formula = url.searchParams.get("filterByFormula");
    const all = Object.values(TABLES).flat();

    /* A FORMULA NAMING A FIELD THIS TABLE DOES NOT HAVE IS A 422, not an empty
       result. This stand-in used to resolve `{X (from Link)}` by hand, which
       made it MORE capable than Airtable and hid a real bug for weeks:
       readCompany filtered on a lookup field nothing ever created, so on every
       real base the read threw and every company open fell back to Kylas. Here
       it quietly worked.
       Only checked where there are rows — a table created on first touch has no
       fields to know about yet. */
    if (formula && rows.length) {
      const named = [...formula.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const known = new Set(rows.flatMap((r) => Object.keys(r.fields)));
      const bad = named.find((f) => !known.has(f) && !/ \(from .+\)$/.test(f));
      if (bad) return json(res, 422, { error: { type: "INVALID_FILTER_BY_FORMULA",
        message: `Unknown field names: ${bad}` } });
      /* A lookup is only resolvable if the LINK it travels is real. */
      const lk = named.map((f) => / \(from (.+)\)$/.exec(f)?.[1]).filter(Boolean)
        .find((via) => !known.has(via));
      if (lk) return json(res, 422, { error: { type: "INVALID_FILTER_BY_FORMULA",
        message: `Unknown field names: ${lk}` } });
    }
    const hits = formula ? rows.filter((r) => matches(r, formula, all)) : rows;

    /* HONOUR pageSize AND offset. Returning everything in one response left the
       client's pagination loop untested — the same way this mock once ignored
       Kylas' page/size and hid the bug that lost 230 companies. Airtable's
       offset is an opaque token; a row index serves, and being opaque is the
       point, so the client cannot treat it as a number. */
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 100)));
    const max = Number(url.searchParams.get("maxRecords") || 0);
    const from = Number(Buffer.from(url.searchParams.get("offset") || "", "base64")
      .toString("utf8").replace(/\D/g, "") || 0);
    const limited = max ? hits.slice(0, max) : hits;
    const page = limited.slice(from, from + size);
    const next = from + size < limited.length
      ? Buffer.from(`row${from + size}`, "utf8").toString("base64") : "";

    /* fields[] — the real API returns ONLY the named fields. Honoured so a
       caller that forgets to ask for a field it uses fails here rather than in
       production. */
    const want = url.searchParams.getAll("fields[]");
    /* An unknown name in a projection fails the WHOLE request with a 422 on
       the real API — it is not an empty column. Reproduced here because a
       stand-in that accepts any name lets a script ship asking a live base for
       a field it has never had, which is exactly how audit-stages.mjs went out
       asking Contacts for a "Company Name" that lives on Companies.
       Only checked where there are rows: a table this mock created on first
       touch has no fields to know about yet. */
    if (rows.length) {
      const known = new Set(rows.flatMap((r) => Object.keys(r.fields)));
      const bad = want.find((f) => !known.has(f));
      if (bad) return json(res, 422,
        { error: { type: "UNKNOWN_FIELD_NAME", message: `Unknown field name: "${bad}"` } });
    }
    const trim = (r) => (want.length
      ? { id: r.id, fields: Object.fromEntries(Object.entries(r.fields).filter(([k]) => want.includes(k))) }
      : r);

    return json(res, 200, { records: page.map(trim), ...(next ? { offset: next } : {}) });
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

  /* Checked before any of the write branches, because Airtable checks the
     names before it does anything: a rejected record is not half-written. */
  for (const r of body.records || []) {
    const bad = absentField(r.fields);
    if (bad) return json(res, 422,
      { error: { type: "UNKNOWN_FIELD_NAME", message: `Unknown field name: "${bad}"` } });
  }

  /* PATCH by record id — how a migration updates existing rows, as opposed to
     the writer's upsert-on-a-key below. Unsupported here until now, so
     migrate-ladder.mjs could not be tested against this stand-in at all. */
  if (req.method === "PATCH" && !body.performUpsert) {
    const out = [];
    for (const r of body.records || []) {
      const hit = rows.find((x) => x.id === r.id);
      if (!hit) return json(res, 404, { error: { type: "MODEL_ID_NOT_FOUND", message: `no record ${r.id}` } });
      hit.fields = { ...hit.fields, ...r.fields };
      WRITES.push({ kind: "patch", table: name, id: hit.id, fields: r.fields });
      out.push(hit);
    }
    return json(res, 200, { records: out });
  }

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
  console.log(`  upsert / select / delete · 429s above 5 req/s PER BASE · /__writes /__reset`);
});

function text(req) {
  return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
}
