#!/usr/bin/env node
/* prune-contacts.mjs and the keep rule, on an in-memory base.
 *
 *   node scripts/test-prune-contacts.mjs
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, restore, plan } from "./prune-contacts.mjs";
import { contactRow, contactWorked } from "./contact-row.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${String(d).slice(0, 200)}`}`); };

/* A base: three companies. A is worked (one contact called), B is on Focus,
   C nobody touched. */
const T = {
  Companies: [{ id: "recA", fields: { "Kylas Company ID": "1" } }, { id: "recB", fields: { "Kylas Company ID": "2" } },
              { id: "recC", fields: { "Kylas Company ID": "3" } }],
  Contacts: [
    { id: "c1", fields: { "Kylas Contact ID": "11", Name: "A-called", Company: ["recA"], "Call Log": ["l1"], "KPI Rank": 6 } },
    { id: "c2", fields: { "Kylas Contact ID": "12", Name: "A-untouched", Company: ["recA"], "KPI Rank": 1 } },
    { id: "c3", fields: { "Kylas Contact ID": "21", Name: "B-untouched", Company: ["recB"] } },
    { id: "c4", fields: { "Kylas Contact ID": "31", Name: "C-untouched", Company: ["recC"], "KPI Rank": 1, Email: "x@c.com" } },
    { id: "c5", fields: { "Kylas Contact ID": "32", Name: "C-untouched-2", Company: ["recC"], Phone: "+91 98" } },
    { id: "c6", fields: { "Kylas Contact ID": "33", Name: "D-has-transition", Company: ["recD"], "Stage Transitions": ["t1"] } },
    { id: "c7", fields: { "Kylas Contact ID": "41", Name: "no-company" } },
  ],
  Focus: [{ id: "f1", fields: { "Kylas Company ID": "2" } }],
  "Call Log": [{ id: "l1", fields: { "Called At": "2026-11-01" } }],
  "Stage Transitions": [{ id: "t1", fields: {} }],
};
const removed = [];
const at = {
  async listAll(table, { fields = [] } = {}) {
    if (!T[table]) throw new Error("NOT_FOUND 404");
    return T[table].map((r) => ({ id: r.id, fields: fields.length ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => fields.includes(k))) : { ...r.fields } }));
  },
  async remove(table, ids) { removed.push(...ids); T[table] = T[table].filter((r) => !ids.includes(r.id)); },
  async upsertMany(table, key, rows) {
    for (const f of rows) T[table].push({ id: `new${T[table].length}`, fields: f });
    return rows;
  },
};

console.log("\n1. the plan");
const p = await plan(at, { log: () => {} });
const dropped = new Set(p.drop.map((r) => r.fields["Kylas Contact ID"]));
ok("a worked company keeps EVERY contact, untouched ones too", !dropped.has("11") && !dropped.has("12"));
ok("a Focus company keeps its contacts", !dropped.has("21"));
ok("an untouched company's contacts go", dropped.has("31") && dropped.has("32"));
ok("a contact with a linked row is never removed", !dropped.has("33"));
ok("a contact with no company and no work goes", dropped.has("41"));

console.log("\n2. dry run, then apply, then undo");
const dir = mkdtempSync(join(tmpdir(), "prune-"));
const lines = [];
const dry = await run({ at, log: (s) => lines.push(s), undoDir: dir });
ok("the dry run deletes nothing and states the new total", !dry.applied && removed.length === 0 && /Records after/.test(lines.join("\n")));
const before = T.Contacts.length;
const r = await run({ at, log: () => {}, apply: true, undoDir: dir });
ok("apply removes exactly the planned rows", r.drop === 3 && T.Contacts.length === before - 3, JSON.stringify(r));
ok("the undo file is written first", readdirSync(dir).some((f) => f.startsWith("prune-undo-")));
await restore({ at, file: r.undo, log: () => {} });
ok("--restore brings them back", T.Contacts.length === before && T.Contacts.some((x) => x.fields.Email === "x@c.com"));
rmSync(dir, { recursive: true, force: true });

console.log("\n3. the rule the sync shares");
ok("a stage past the first rung is worked", contactWorked({ "Current Stage": "CNC_COULD_NOT_CONNECT" }));
ok("YET_TO_BE_MINED with nothing else is not", !contactWorked({ "Current Stage": "YET_TO_BE_MINED", "KPI Rank": 1 }));
const row = contactRow({ id: 5, firstName: "Asha", company: { id: 9 }, ownerId: 7, updatedAt: "2026-11-01T00:00:00Z" },
  {}, new Map([["9", "recX"]])).row;
ok("contactRow links the company and keeps the merge key", row["Kylas Contact ID"] === "5" && row.Company?.[0] === "recX", JSON.stringify(row));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
