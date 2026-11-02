/* THE AIRTABLE API, ANSWERED FROM D1.
 *
 * Ayush, 2026-11-03: "If I move the data to Cloudflare I want the same system
 * to run without any differences — a plug-and-play module." And then: "why do
 * we need Airtable — writes can be made directly into Cloudflare."
 *
 * So this is not a second data layer with its own idea of what a record is.
 * It is the SAME REST surface the console has always talked to —
 *
 *   GET    /<base>/<Table>?filterByFormula=…&fields[]=…&sort[0][field]=…&pageSize=…&offset=…&maxRecords=…
 *   GET    /<base>/<Table>/<recId>
 *   PATCH  /<base>/<Table>   { performUpsert, records, typecast }   upsert on a key
 *   PATCH  /<base>/<Table>   { records: [{ id, fields }] }          update by id
 *   POST   /<base>/<Table>   { records }                            create
 *   DELETE /<base>/<Table>?records[]=…
 *
 * — answered from the D1 tables that sql-schema.mjs builds, with the computed
 * fields (rollups, formulas) read from the views in sql-derived.mjs. It is
 * plugged in BELOW createAirtable() as its `fetch`, so every caller —
 * syncContact, the report, RCA, focus, dedupe, the crons, the migrations that
 * PATCH by id with at.call() — runs the code it already runs, unchanged.
 *
 * What it reproduces, because callers depend on each of these:
 *   - records are { id: "rec…", createdTime, fields }, with blank fields
 *     OMITTED, an unchecked box omitted, a link as ["rec…"]
 *   - computed fields are read-only: writing one is Airtable's
 *     INVALID_VALUE_FOR_COLUMN
 *   - an unknown field in a write, a projection or a formula is a 422 with
 *     Airtable's error type, so listTolerant / upsertTolerant recover the same
 *   - typecast: "5" is a number, a date-time is normalised, a new select
 *     option is simply accepted (the D1 schema is built with looseSelects)
 *   - paging by an opaque offset, pageSize ≤ 100, maxRecords, sort with blanks
 *     first ascending, as Airtable sorts them
 *   - deleting a parent unlinks its children, as Airtable does, rather than
 *     failing on the foreign key
 *
 * FORMULAS are parsed, not pattern-matched, into SQL. The grammar is the part
 * of Airtable's formula language this code uses — field references, string and
 * number literals, = != > >= < <=, OR, AND, NOT, IF, IS_AFTER, IS_BEFORE,
 * LAST_MODIFIED_TIME, DATETIME_PARSE, TRUE, FALSE, BLANK. Anything else is a
 * 422 naming the function, never a filter that quietly matches nothing.
 * Literals are inlined as escaped SQL, not bound: D1 allows 100 parameters a
 * statement, and an OR of 200 keys is a real request here.
 *
 * COST, because a Worker on the free plan has ~50 subrequests: a read is one
 * query; a write of up to ten records is a lookup, one batch and one read-back.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";
import { tableName, columnName, OWN_ROW_DERIVED } from "./sql-schema.mjs";
import { VIEW_FOR, ROW_VIEW_FOR } from "./sql-derived.mjs";
import { LINKS_BY_TABLE } from "./sql-store.mjs";
import { ensureSchema } from "./d1-schema-sync.mjs";

const qi = (c) => `"${String(c).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

class AtError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
const unknownField = (n) => new AtError(422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${n}"`);

/* ── the model: every Airtable field name → where it lives in SQL ───────── */
const MODELS = new Map();
/* ROLLUPS AIRTABLE RETURNS AS A DAY. On the live base these are defined with a
   date result (no time), so the API answers "2026-11-02", in UTC, not an
   instant — checked field by field on 2026-11-03. The D1 views hold the
   instant; the record carries the day, exactly as Airtable's does. */
const DATE_ONLY = new Set(["Contacts.Last Call At", "Contacts.First Call At", "Contacts.Last Stage Change At",
  "Contacts.First Stage Change At", "Companies.Last Call At", "Companies.First Call At",
  "Companies.First Worked At", "Companies.First Picked At"]);
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/;
/* The reverse link's name on the parent, where it is not the child table's. */
const REVERSE_NAME = {};
/* NO LOOKUP FIELDS. The code filters Event Rows on "Kylas Contact ID (from
   Contact)", but the live base has never had that field (checked 2026-11-03):
   Airtable answers those reads with a 422 that the caller swallows. Answering
   them here would change what a save does, so they fail here too. */
function model(name) {
  if (MODELS.has(name)) return MODELS.get(name);
  const t = TABLES.find((x) => x.name === name);
  if (!t) return null;
  /* The per-row views: a read pays for the rows it returns, not the table. */
  const view = ROW_VIEW_FOR[name] || null;
  /* …and the whole-table views, which compute every aggregate in one pass —
     the faster of the two when the read IS the whole table. */
  /* Measured 2026-11-03 at 35k contacts / 1,000 companies: Companies whole is
     100ms one-pass vs 760ms per-row; Contacts, read in pages, is the other way
     round (1.5s vs 0.6s), because a one-pass view recomputes on every page. */
  const fullView = name === "Companies" ? VIEW_FOR[name] : null;
  const fields = new Map();
  for (const f of t.fields) {
    const col = columnName(f.name);
    fields.set(f.name, { name: f.name, kind: "base", type: f.type, col, expr: `t.${qi(col)}`,
      choices: (f.options?.choices || []).map((c) => c.name) });
  }
  (LINKS_BY_TABLE[name] || []).forEach((l, i) =>
    fields.set(l.name, { name: l.name, kind: "link", type: "link", to: l.to, col: l.col,
      alias: `l${i}`, expr: `t.${qi(l.col)}` }));
  /* REVERSE LINKS, as Airtable lists them on the parent: a company's
     contacts, a contact's event rows, calls, stage changes and RCA rows.
     Read-only here — the console only ever writes a link from the child. */
  for (const t2 of TABLES) for (const l of LINKS_BY_TABLE[t2.name] || []) {
    if (l.to !== name) continue;
    const back = REVERSE_NAME[`${t2.name}.${l.name}`] || t2.name;
    const child = tableName(t2.name);
    fields.set(back, { name: back, kind: "derived", type: "reverse",
      col: null, expr: `(SELECT group_concat(r."airtable_id", ',') FROM (SELECT x."airtable_id" FROM ${qi(child)} x WHERE x.${qi(l.col)} = t."id" ORDER BY x."id") r)` });
  }
  for (const f of FOLLOWUPS) {
    if (f.table !== name || !f.field || f.field.type === "multipleRecordLinks") continue;
    const col = columnName(f.field.name);
    const own = !!OWN_ROW_DERIVED[name]?.[f.field.name];
    fields.set(f.field.name, { name: f.field.name, kind: "derived", type: f.field.type, col,
      expr: own ? `t.${qi(col)}` : `v.${qi(col)}` });
  }
  const m = { name, tbl: tableName(name), view, fullView, fields, primary: t.fields[0].name };
  MODELS.set(name, m);
  return m;
}

/* The FROM clause every read shares: the table, its view if it has computed
   fields, and one join per link so the parent's record id comes back. */
function fromClause(m, whole = false) {
  let s = `FROM ${qi(m.tbl)} t`;
  const view = whole && m.fullView ? m.fullView : m.view;
  if (view) s += ` LEFT JOIN ${qi(view)} v ON v."id" = t."id"`;
  for (const f of m.fields.values())
    if (f.kind === "link") s += ` LEFT JOIN ${qi(model(f.to).tbl)} ${f.alias} ON ${f.alias}."id" = t.${qi(f.col)}`;
  return s;
}
function selectList(m, want) {
  const cols = [`t."id" AS "__id"`, `t."airtable_id" AS "__rid"`, `t."synced_at" AS "__mod"`];
  let i = 0;
  for (const f of m.fields.values()) {
    f.out = `f${i++}`;
    if (want && !want.has(f.name)) continue;
    cols.push(`${f.kind === "link" ? `${f.alias}."airtable_id"` : f.expr} AS ${qi(f.out)}`);
  }
  return cols.join(", ");
}

/* One SQL row → one Airtable record. Blank is absent, as on the real API. */
const isoMs = (v) => { const d = Date.parse(v); return Number.isFinite(d) ? new Date(d).toISOString() : v; };
function toRecord(m, row, want) {
  const fields = {};
  for (const f of m.fields.values()) {
    if (want && !want.has(f.name)) continue;
    const v = row[f.out];
    if (v === null || v === undefined || v === "") continue;
    if (f.kind === "link") { fields[f.name] = [v]; continue; }
    if (f.type === "reverse") { fields[f.name] = String(v).split(","); continue; }
    if (f.type === "checkbox") { if (Number(v) === 1) fields[f.name] = true; continue; }
    if (f.type === "dateTime") { fields[f.name] = isoMs(v); continue; }
    if (f.kind === "derived" && DATE_ONLY.has(`${m.name}.${f.name}`)) { fields[f.name] = isoMs(v).slice(0, 10); continue; }
    if (f.kind === "derived" && typeof v === "string" && INSTANT.test(v)) { fields[f.name] = isoMs(v); continue; }
    fields[f.name] = v;
  }
  return { id: row.__rid, createdTime: isoMs(row.__mod), fields };
}

/* ── formulas ─────────────────────────────────────────────────────────── */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "{") {
      const j = src.indexOf("}", i);
      if (j < 0) throw bad(src, "unclosed {");
      out.push({ t: "field", v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (ch === "'" || ch === '"') {
      let s = "", j = i + 1;
      for (; j < src.length && src[j] !== ch; j++) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[++j]; continue; }
        s += src[j];
      }
      if (j >= src.length) throw bad(src, "unclosed string");
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const op = /^(!=|>=|<=|=|>|<|&)/.exec(src.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    if ("(),".includes(ch)) { out.push({ t: ch }); i++; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0].toUpperCase() }); i += id[0].length; continue; }
    throw bad(src, `unexpected "${ch}"`);
  }
  return out;
}
const bad = (src, why) => new AtError(422, "INVALID_FILTER_BY_FORMULA",
  `The formula for filtering records is invalid: ${why} in ${src.slice(0, 120)}`);

/* A node is { sql, kind: "bool" | "val", type } — type is the Airtable field
   type when the node is a field, so comparisons know text from number. */
const asText = (n) => {
  if (n.kind === "bool") return `(CASE WHEN ${n.sql} THEN '1' ELSE '0' END)`;
  if (n.type === "checkbox") return `(CASE WHEN ${n.sql} = 1 THEN '1' ELSE '' END)`;
  if (n.type === "number" || n.type === "percent" || n.type === "num")
    return `COALESCE(CASE WHEN ${n.sql} = CAST(${n.sql} AS INTEGER) THEN CAST(CAST(${n.sql} AS INTEGER) AS TEXT) ELSE CAST(${n.sql} AS TEXT) END, '')`;
  return `COALESCE(CAST(${n.sql} AS TEXT), '')`;
};
const asNum = (n) => (n.kind === "bool" ? `(CASE WHEN ${n.sql} THEN 1 ELSE 0 END)` : `CAST(COALESCE(${n.sql}, 0) AS REAL)`);
const truthy = (n) => (n.kind === "bool" ? n.sql
  : n.type === "str" ? (n.raw ? "1" : "0")
  : `(${asText(n)} NOT IN ('', '0'))`);
const isNumeric = (n) => ["num", "number", "percent", "checkbox", "derivedNum"].includes(n.type);

export function formulaToSql(m, src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => { const k = toks[p]; if (!k || (t && k.t !== t)) throw bad(src, `expected ${t || "more"}`); p++; return k; };

  function fieldNode(name) {
    const f = m.fields.get(name);
    if (f) {
      if (f.kind === "link") {
        /* A link in a formula reads as the parent's primary field. */
        const pm = model(f.to);
        return { sql: `${f.alias}.${qi(pm.fields.get(pm.primary).col)}`, kind: "val", type: "text" };
      }
      const derivedNum = f.kind === "derived" && !/name|stage|contacts|kylas id|at$/i.test(f.name);
      return { sql: f.expr, kind: "val", type: derivedNum ? "derivedNum" : f.type };
    }
    throw new AtError(422, "INVALID_FILTER_BY_FORMULA", `Unknown field names: ${name.toLowerCase()}`);
  }

  function args() {
    take("(");
    const out = [];
    if (peek()?.t === ")") { p++; return out; }
    for (;;) {
      out.push(expr());
      const k = take();
      if (k.t === ")") return out;
      if (k.t !== ",") throw bad(src, "expected , or )");
    }
  }

  function call(name) {
    const a = args();
    const need = (n) => { if (a.length < n) throw bad(src, `${name} needs ${n} argument(s)`); };
    switch (name) {
      case "OR": return { sql: `(${a.map(truthy).join(" OR ") || "0"})`, kind: "bool" };
      case "AND": return { sql: `(${a.map(truthy).join(" AND ") || "1"})`, kind: "bool" };
      case "NOT": need(1); return { sql: `(NOT ${truthy(a[0])})`, kind: "bool" };
      case "TRUE": return { sql: "1", kind: "bool" };
      case "FALSE": return { sql: "0", kind: "bool" };
      case "BLANK": return { sql: "''", kind: "val", type: "str", raw: "" };
      case "IF": {
        need(2);
        const y = a[1], n = a[2] || { sql: "''", kind: "val", type: "str", raw: "" };
        const v = (x) => (x.kind === "bool" ? `(CASE WHEN ${x.sql} THEN 1 ELSE 0 END)` : x.sql);
        return { sql: `(CASE WHEN ${truthy(a[0])} THEN ${v(y)} ELSE ${v(n)} END)`, kind: "val",
                 type: isNumeric(y) && isNumeric(n) ? "num" : "text" };
      }
      case "LAST_MODIFIED_TIME": return { sql: `t."synced_at"`, kind: "val", type: "dateTime" };
      case "DATETIME_PARSE": need(1); return a[0];
      case "IS_AFTER": case "IS_BEFORE": {
        need(2);
        const op = name === "IS_AFTER" ? ">" : "<";
        return { sql: `(NULLIF(${asText(a[0])}, '') IS NOT NULL AND julianday(${asText(a[0])}) ${op} julianday(${asText(a[1])}))`, kind: "bool" };
      }
      default: throw bad(src, `${name}() is not supported by the D1 store`);
    }
  }

  function primary() {
    const k = take();
    if (k.t === "field") return fieldNode(k.v);
    if (k.t === "str") return { sql: lit(k.v), kind: "val", type: "str", raw: k.v };
    if (k.t === "num") return { sql: String(k.v), kind: "val", type: "num", raw: k.v };
    if (k.t === "(") { const e = expr(); take(")"); return e; }
    if (k.t === "id") return call(k.v);
    throw bad(src, `unexpected ${k.t}`);
  }

  function expr() {
    let left = primary();
    while (peek()?.t === "op") {
      const op = take().v;
      const right = primary();
      if (op === "&") { left = { sql: `(${asText(left)} || ${asText(right)})`, kind: "val", type: "text" }; continue; }
      const sqlOp = op === "=" ? "=" : op === "!=" ? "<>" : op;
      /* Number against number compares numbers; anything with text in it
         compares text, with blank as '' — Airtable's {X} = '' is "is empty". */
      const numeric = (isNumeric(left) && (isNumeric(right) || right.type === "str" && right.raw !== "" && !isNaN(Number(right.raw))))
        || (isNumeric(right) && (left.type === "str" && left.raw !== "" && !isNaN(Number(left.raw))))
        || (op !== "=" && op !== "!=");
      left = numeric
        ? { sql: `(${asNum(left)} ${sqlOp} ${asNum(right)})`, kind: "bool" }
        : { sql: `(${asText(left)} ${sqlOp} ${asText(right)})`, kind: "bool" };
    }
    return left;
  }

  const node = expr();
  if (p !== toks.length) throw bad(src, "trailing input");
  return truthy(node);
}

/* ── writes: one Airtable value → its column, with typecast ───────────── */
function cellIn(f, raw) {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length))
    return f.type === "checkbox" ? 0 : null;
  switch (f.type) {
    case "checkbox": return raw === true || raw === 1 || raw === "true" || raw === "1" || raw === "checked" ? 1 : 0;
    case "number": case "percent": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new AtError(422, "INVALID_VALUE_FOR_COLUMN",
        `Field "${f.name}" cannot accept the provided value`);
      return n;
    }
    case "singleSelect": return typeof raw === "object" ? (raw.name ?? null) : String(raw);
    case "date": {
      const s = String(raw);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const d = Date.parse(s);
      if (!Number.isFinite(d)) throw new AtError(422, "INVALID_VALUE_FOR_COLUMN", `Field "${f.name}" cannot accept the provided value`);
      return new Date(d).toISOString().slice(0, 10);
    }
    case "dateTime": {
      const d = Date.parse(String(raw));
      if (!Number.isFinite(d)) throw new AtError(422, "INVALID_VALUE_FOR_COLUMN", `Field "${f.name}" cannot accept the provided value`);
      return new Date(d).toISOString();
    }
    default: return typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
}

/* A new row's record id: Airtable's shape, so nothing above can tell. */
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function newRecordId() {
  const b = new Uint8Array(14);
  crypto.getRandomValues(b);
  return "rec" + [...b].map((x) => ALNUM[x % ALNUM.length]).join("");
}

/* ── the engine ───────────────────────────────────────────────────────── */
export function airtableOverD1(db, { onQuery = null, maxPageSize = 100, ensure = false, log = () => {} } = {}) {
  /* `ensure`: bring the tables up to the code before the first query of this
     server start (d1-schema-sync.mjs) — three small queries when nothing has changed. */
  let ready = ensure ? null : Promise.resolve();
  const before = () => (ready ||= ensureSchema(db, { log }).catch((e) => { ready = null; throw e; }));
  const all = async (sql) => { await before(); onQuery?.(sql); return (await db.prepare(sql).all()).results || []; };

  async function readByIds(m, ids, want) {
    ids = ids.filter((x) => Number.isFinite(Number(x)) && x !== null && x !== undefined);
    if (!ids.length) return [];
    const rows = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      rows.push(...await all(`SELECT ${selectList(m, want)} ${fromClause(m)} WHERE t."id" IN (${chunk.map(Number).join(",")})`));
    }
    const by = new Map(rows.map((r) => [r.__id, r]));
    return ids.map((id) => by.get(id)).filter(Boolean).map((r) => toRecord(m, r, want));
  }

  async function list(m, sp) {
    const want = sp.getAll("fields[]");
    for (const w of want) if (!m.fields.has(w)) throw unknownField(w);
    const wantSet = want.length ? new Set(want) : null;
    const formula = sp.get("filterByFormula");
    const where = formula ? `WHERE ${formulaToSql(m, formula)}` : "";
    const order = [];
    for (let i = 0; sp.get(`sort[${i}][field]`); i++) {
      const name = sp.get(`sort[${i}][field]`);
      const f = m.fields.get(name);
      if (!f) throw unknownField(name);
      const e = f.kind === "link" ? `${f.alias}."airtable_id"` : f.expr;
      const desc = sp.get(`sort[${i}][direction]`) === "desc";
      /* Blank sorts as smallest, as on Airtable: first ascending, last descending. */
      order.push(`(${e} IS NULL OR ${e} = '') ${desc ? "ASC" : "DESC"}`, `${e} ${desc ? "DESC" : "ASC"}`);
    }
    order.push(`t."id" ASC`);
    /* 100, as Airtable — unless this engine was built for the in-process
       client, which asks for larger pages (createAirtable, D1_PAGE). */
    const size = Math.min(maxPageSize, Math.max(1, Number(sp.get("pageSize") || 100)));
    const max = Number(sp.get("maxRecords") || 0);
    const from = Number(String(atob(sp.get("offset") || "") || "").replace(/\D/g, "") || 0);
    let take = size;
    if (max) take = Math.max(0, Math.min(size, max - from));
    const rows = take
      ? await all(`SELECT ${selectList(m, wantSet)} ${fromClause(m, !formula)} ${where} ORDER BY ${order.join(", ")} LIMIT ${take + 1} OFFSET ${from}`)
      : [];
    const more = rows.length > take && (!max || from + take < max);
    const page = rows.slice(0, take).map((r) => toRecord(m, r, wantSet));
    return { records: page, ...(more ? { offset: btoa(`row${from + take}`) } : {}) };
  }

  /* Field values → { col: value }, checked the way Airtable checks them. */
  async function columnsFor(m, fields) {
    const cols = {};
    const links = [];
    for (const [name, raw] of Object.entries(fields || {})) {
      const f = m.fields.get(name);
      if (!f) throw unknownField(name);
      if (f.kind === "derived") throw new AtError(422, "INVALID_VALUE_FOR_COLUMN",
        `Field "${name}" cannot accept a value because the field is computed`);
      if (f.kind === "link") {
        const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => (typeof x === "object" ? x.id : x)).filter(Boolean);
        links.push({ f, rid: ids[0] ? String(ids[0]) : null });
        continue;
      }
      cols[f.col] = cellIn(f, raw);
    }
    /* Resolve every linked record id in one query per parent table. */
    for (const l of links) {
      if (!l.rid) { cols[l.f.col] = null; continue; }
      const pm = model(l.f.to);
      const hit = await all(`SELECT "id" FROM ${qi(pm.tbl)} WHERE "airtable_id" = ${lit(l.rid)}`);
      if (!hit.length) throw new AtError(422, "ROW_DOES_NOT_EXIST",
        `Record ID ${l.rid} does not exist in table ${l.f.to}`);
      cols[l.f.col] = hit[0].id;
    }
    return cols;
  }

  const insertSql = (m, cols, rid) => {
    const names = ["airtable_id", ...Object.keys(cols)];
    const vals = [lit(rid), ...Object.values(cols).map(sqlVal)];
    return `INSERT INTO ${qi(m.tbl)} (${names.map(qi).join(", ")}) VALUES (${vals.join(", ")})`;
  };
  /* `where` is a row id, or { rid } for a row inserted earlier in the same batch. */
  const updateSql = (m, cols, where) => {
    const set = Object.entries(cols).map(([c, v]) => `${qi(c)} = ${sqlVal(v)}`).concat(`"synced_at" = ${NOW}`);
    const w = typeof where === "object" ? `"airtable_id" = ${lit(where.rid)}` : `"id" = ${Number(where)}`;
    return `UPDATE ${qi(m.tbl)} SET ${set.join(", ")} WHERE ${w}`;
  };

  async function run(sqls) {
    if (!sqls.length) return;
    await before();
    sqls.forEach((s) => onQuery?.(s));
    try {
      if (sqls.length === 1) await db.prepare(sqls[0]).run();
      else await db.batch(sqls.map((s) => db.prepare(s)));
    } catch (e) {
      const msg = String(e.message || e);
      if (/UNIQUE/i.test(msg)) throw new AtError(422, "INVALID_VALUE_FOR_COLUMN", `Duplicate value: ${msg.slice(0, 160)}`);
      if (/CHECK|FOREIGN KEY|NOT NULL/i.test(msg)) throw new AtError(422, "INVALID_VALUE_FOR_COLUMN", msg.slice(0, 200));
      throw e;
    }
  }
  const idsOf = async (m, rids) => {
    if (!rids.length) return [];
    const rows = await all(`SELECT "id", "airtable_id" FROM ${qi(m.tbl)} WHERE "airtable_id" IN (${rids.map(lit).join(",")})`);
    const by = new Map(rows.map((r) => [r.airtable_id, r.id]));
    return rids.map((r) => by.get(r));
  };

  async function upsert(m, body) {
    const key = body.performUpsert.fieldsToMergeOn?.[0];
    const kf = m.fields.get(key);
    if (!kf) throw unknownField(key);
    if (kf.kind !== "base") throw new AtError(422, "INVALID_VALUE_FOR_COLUMN", `Cannot merge on computed field "${key}"`);
    const recs = body.records || [];
    const prepared = [];
    for (const r of recs) prepared.push({ cols: await columnsFor(m, r.fields), want: String(r.fields?.[key] ?? "") });
    const keys = [...new Set(prepared.map((x) => x.want).filter(Boolean))];
    const found = keys.length
      ? await all(`SELECT "id", "airtable_id", CAST(${qi(kf.col)} AS TEXT) AS k FROM ${qi(m.tbl)} WHERE CAST(${qi(kf.col)} AS TEXT) IN (${keys.map(lit).join(",")}) ORDER BY "id"`)
      : [];
    const byKey = new Map();
    for (const f of found) if (!byKey.has(f.k)) byKey.set(f.k, f);
    const sqls = [], order = [], created = [], updated = [];
    for (const x of prepared) {
      const hit = x.want && byKey.get(x.want);
      /* Two records with one new key in one request: the second updates the
         first, as on Airtable — by record id, since the row id is not known yet. */
      if (hit) {
        /* A row with no record id (written by hand, never by the console)
           gets one now, so it can be returned and linked to like any other. */
        if (!hit.airtable_id) { hit.airtable_id = newRecordId(); x.cols.airtable_id = hit.airtable_id; }
        sqls.push(updateSql(m, x.cols, hit.pending ? { rid: hit.airtable_id } : hit.id)); order.push(hit.airtable_id);
        if (!hit.pending) updated.push(hit.airtable_id);
      } else {
        const rid = newRecordId();
        sqls.push(insertSql(m, x.cols, rid)); order.push(rid); created.push(rid);
        if (x.want) byKey.set(x.want, { id: null, airtable_id: rid, pending: true });
      }
    }
    await run(sqls);
    /* Airtable's upsert reply names which records it made and which it found. */
    return { records: await readByIds(m, await idsOf(m, order), null),
             createdRecords: [...new Set(created)], updatedRecords: [...new Set(updated)] };
  }

  async function patchById(m, body) {
    const recs = body.records || [];
    const ids = await idsOf(m, recs.map((r) => String(r.id)));
    const sqls = [];
    for (let i = 0; i < recs.length; i++) {
      if (!ids[i]) throw new AtError(404, "MODEL_ID_NOT_FOUND", `Could not find a record with ID "${recs[i].id}".`);
      sqls.push(updateSql(m, await columnsFor(m, recs[i].fields), ids[i]));
    }
    await run(sqls);
    return readByIds(m, ids, null);
  }

  async function create(m, body) {
    const sqls = [], rids = [];
    for (const r of body.records || []) {
      const rid = newRecordId();
      sqls.push(insertSql(m, await columnsFor(m, r.fields), rid));
      rids.push(rid);
    }
    await run(sqls);
    return readByIds(m, await idsOf(m, rids), null);
  }

  async function remove(m, rids) {
    const ids = (await idsOf(m, rids)).filter(Boolean);
    if (!ids.length) return rids.map((id) => ({ id, deleted: true }));
    const sqls = [];
    /* Airtable unlinks the children of a deleted parent; the foreign key would
       refuse. So unlink first, in the same transaction. */
    for (const t of TABLES) for (const l of LINKS_BY_TABLE[t.name] || [])
      if (l.to === m.name) sqls.push(`UPDATE ${qi(tableName(t.name))} SET ${qi(l.col)} = NULL, "synced_at" = ${NOW} WHERE ${qi(l.col)} IN (${ids.join(",")})`);
    sqls.push(`DELETE FROM ${qi(m.tbl)} WHERE "id" IN (${ids.join(",")})`);
    await run(sqls);
    return rids.map((id) => ({ id, deleted: true }));
  }

  /* The metadata API, enough for a caller choosing fields by name. */
  function meta() {
    return { tables: TABLES.map((t) => {
      const m = model(t.name);
      return { id: `tbl${m.tbl}`, name: t.name, primaryFieldId: `fld${columnName(m.primary)}`,
        fields: [...m.fields.values()].map((f) => ({ id: `fld${f.col}`, name: f.name,
          type: f.kind === "link" ? "multipleRecordLinks" : f.type })) };
    }) };
  }

  /* method + path (after the base id) + body → { status, body } */
  async function handle(method, pathAndQuery, body) {
    const u = new URL(pathAndQuery, "http://d1.local");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "meta") return { status: 200, body: meta() };
    let name = parts.join("/"), single = null;
    const sm = /^(.*)\/(rec[0-9A-Za-z]{14})$/.exec(name);
    if (sm) { name = sm[1]; single = sm[2]; }
    const m = model(name);
    if (!m) return { status: 404, body: { error: { type: "TABLE_NOT_FOUND", message: `Could not find table ${name} in the D1 store` } } };
    try {
      if (method === "GET" && single) {
        const [rec] = await readByIds(m, await idsOf(m, [single]), null);
        return rec ? { status: 200, body: rec } : { status: 404, body: { error: { type: "NOT_FOUND" } } };
      }
      if (method === "GET") return { status: 200, body: await list(m, u.searchParams) };
      if (method === "DELETE") return { status: 200, body: { records: await remove(m, u.searchParams.getAll("records[]")) } };
      if (method === "PATCH" && body?.performUpsert) return { status: 200, body: await upsert(m, body) };
      if (method === "PATCH" || method === "PUT") return { status: 200, body: { records: await patchById(m, body || {}) } };
      if (method === "POST") return { status: 200, body: { records: await create(m, body || {}) } };
      return { status: 405, body: { error: { type: "METHOD_NOT_ALLOWED" } } };
    } catch (e) {
      if (e instanceof AtError) return { status: e.status, body: { error: { type: e.type, message: e.message } } };
      throw e;
    }
  }

  /* A drop-in for fetch(), so createAirtable() can be pointed at D1 with no
     other change: `${API}/${baseId}/${Table}?…` → handle(). */
  async function fetchLike(url, init = {}) {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    /* [v0,] base, Table…  or  [v0,] meta, bases, base, tables */
    let rest = parts[0] === "v0" ? parts.slice(1) : parts;
    rest = rest[0] === "meta" ? rest : rest.slice(1);
    const out = await handle((init.method || "GET").toUpperCase(), "/" + rest.join("/") + u.search,
      init.body ? JSON.parse(init.body) : null);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }

  return { handle, fetch: fetchLike, model };
}

const sqlVal = (v) => (v === null || v === undefined ? "NULL"
  : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL")
  : lit(v));
