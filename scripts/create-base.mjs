#!/usr/bin/env node
/* Creates the BD KPI base in Airtable from schema.mjs.
 *
 *   node scripts/validate-schema.mjs                       # check first, no network
 *   AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE=wsp... \
 *     node scripts/create-base.mjs --dry-run               # print what would be sent
 *   AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE=wsp... \
 *     node scripts/create-base.mjs                         # do it
 *
 * PAT scopes: schema.bases:write, schema.bases:read.
 * Not idempotent — it builds a new base each run. Delete and re-run to redo.
 */
import { TABLES, FOLLOWUPS } from "./schema.mjs";

const DRY = process.argv.includes("--dry-run");
const PAT = process.env.AIRTABLE_PAT;
const WORKSPACE = process.env.AIRTABLE_WORKSPACE;
const BASE_NAME = process.env.AIRTABLE_BASE_NAME || "Enout BD KPI";

if (!DRY && (!PAT || !WORKSPACE)) {
  console.error("Set AIRTABLE_PAT and AIRTABLE_WORKSPACE (wsp...), or pass --dry-run.");
  process.exit(1);
}

const API = "https://api.airtable.com/v0/meta";
let sent = 0;

async function call(method, path, body) {
  sent++;
  if (DRY) {
    console.log(`\n${method} ${path}`);
    if (body) console.log(JSON.stringify(body, null, 2).split("\n").slice(0, 14).join("\n")
      + (JSON.stringify(body, null, 2).split("\n").length > 14 ? "\n  …" : ""));
    return fakeResponse(path, body);
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  return text ? JSON.parse(text) : {};
}

/* Enough shape for a dry run to walk the same code path as a real one. */
let fakeId = 0;
const fakeResponse = (path, body) => {
  if (path === "/bases")
    return { id: "appDRYRUN0000000", tables: TABLES.map((t) => ({
      id: `tblDRY${String(fakeId++).padStart(11, "0")}`, name: t.name,
      fields: t.fields.map((f) => ({ id: `fldDRY${String(fakeId++).padStart(11, "0")}`, ...f })) })) };
  if (path.endsWith("/tables")) return { tables: dryTables };
  return { id: `fldDRY${String(fakeId++).padStart(11, "0")}`, ...(body || {}) };
};
let dryTables = [];

async function main() {
  console.log(DRY ? `Dry run — nothing will be sent.\n` : `Creating "${BASE_NAME}" in ${WORKSPACE}…`);

  /* ── 1. base and tables ─────────────────────────────────────────── */
  const base = await call("POST", "/bases", { workspaceId: WORKSPACE, name: BASE_NAME, tables: TABLES });
  const tableId = Object.fromEntries(base.tables.map((t) => [t.name, t.id]));
  dryTables = base.tables.map((t) => ({ ...t, fields: [...t.fields] }));
  if (!DRY) console.log(`  base ${base.id}`);

  /* ── 2. follow-up fields, in declared order ─────────────────────── */
  for (const { table, field, reverse } of FOLLOWUPS) {
    const payload = { name: field.name, type: field.type };
    if (field.description) payload.description = field.description;

    if (field.type === "multipleRecordLinks") {
      payload.options = { linkedTableId: tableId[field.options.linkedTable] };
    } else if (field.options) {
      payload.options = { ...field.options };
    }

    const before = field.type === "multipleRecordLinks"
      ? await fieldNames(base.id, tableId[field.options.linkedTable]) : null;

    const made = await call("POST", `/bases/${base.id}/tables/${tableId[table]}/fields`, payload);

    /* Airtable names the reverse link itself. Rename it to what the rollups
       expect, otherwise every rollup travelling back down this link targets a
       field that does not exist under that name. */
    if (field.type === "multipleRecordLinks" && reverse) {
      const target = tableId[field.options.linkedTable];
      const after = await fieldNames(base.id, target);
      const added = after.find((f) => !before.some((b) => b.id === f.id));
      if (!added) {
        console.warn(`  ! could not find the reverse of ${table}.${field.name} on ${field.options.linkedTable}`);
      } else if (added.name !== reverse) {
        await call("PATCH", `/bases/${base.id}/tables/${target}/fields/${added.id}`, { name: reverse });
        if (!DRY) console.log(`  renamed reverse link "${added.name}" -> "${reverse}"`);
      }
      if (DRY) pushDry(target, { id: `fldDRYREV${fieldNamesCount++}`, name: reverse, type: "multipleRecordLinks" });
    }
    if (DRY) pushDry(tableId[table], { id: made.id, name: field.name, type: field.type });
  }

  console.log(DRY
    ? `\nDry run complete — ${sent} request(s) would be sent.`
    : `\nDone. https://airtable.com/${base.id}`);
}

let fieldNamesCount = 0;
const pushDry = (tid, f) => { const t = dryTables.find((x) => x.id === tid); if (t) t.fields.push(f); };

async function fieldNames(baseId, tableId) {
  const r = await call("GET", `/bases/${baseId}/tables`);
  const t = r.tables.find((x) => x.id === tableId);
  return t ? t.fields.map((f) => ({ id: f.id, name: f.name })) : [];
}

main().catch((e) => { console.error("\n" + e.message); process.exit(1); });
