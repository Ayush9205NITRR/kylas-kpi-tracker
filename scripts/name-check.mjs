#!/usr/bin/env node
/* HOW KYLAS HOLDS A CONTACT'S NAME AND NOTES. Read-only. (Started as the name check.)
 *
 *   node --env-file=.env.local scripts/name-check.mjs --contact 5363366 [--contact <id> ...]
 *
 * Ayush, 2026-10-18: Kylas' contact form shows "POC Name: Dua" for a contact
 * the console calls "Samarth Dua". The save splits a name on its last space
 * (fields.mjs splitName): "Samarth Dua" -> firstName "Samarth", lastName "Dua",
 * because Kylas requires a lastName. If this account's form has one name box
 * labelled "POC Name" it is showing lastName only, and firstName is stored but
 * not displayed. This prints both halves as Kylas holds them, and how the
 * account defines the two fields, so that is settled by reading and not by
 * guessing. Nothing is written.
 */
import { createClient } from "./kylas.mjs";
/* The second question, 2026-10-18: the push wrote the remarks block, Kylas answered
   200, and a read-back showed remarks null. So where does a note live on this
   account? The field definitions and the record, side by side, answer it. */

const env = process.env;
if (!env.KYLAS_KEY) { console.error("KYLAS_KEY is not set"); process.exit(1); }
const ids = process.argv.flatMap((a, i, all) => (a === "--contact" && all[i + 1] ? [all[i + 1]] : []));
const kylas = createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });

const r = await kylas.raw("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
const list = Array.isArray(r) ? r : r?.content || r?.data || [];
console.log("\nTHE NAME FIELDS, as this Kylas account defines them");
console.log("  name           label            type         active  required  standard");
const NOTE = /remark|note|comment/i;
for (const f of list.filter((x) => /^(salutation|salutationName|firstName|lastName)$/.test(x.name || "") || NOTE.test(`${x.name} ${x.displayName}`))) {
  const yes = (v) => (v === true ? "yes" : v === false ? "no" : "?");
  console.log(`  ${String(f.name).padEnd(14)} ${String(f.displayName || "").padEnd(16)} ${String(f.type || "").padEnd(12)} ${yes(f.active).padEnd(7)} ${yes(f.required).padEnd(9)} ${yes(f.standard)}`);
}
if (!list.some((x) => x.name === "firstName")) console.log("  (no firstName in this account's field list)");

for (const id of ids) {
  try {
    const c = await kylas.contact(id);
    console.log(`\nCONTACT ${id}`);
    console.log(`  firstName  ${JSON.stringify(c.firstName ?? null)}`);
    console.log(`  lastName   ${JSON.stringify(c.lastName ?? null)}`);
    console.log(`  together   ${JSON.stringify([c.firstName, c.lastName].filter(Boolean).join(" "))}`);
    /* WHERE DOES A NOTE LIVE? Every place on the record that could hold one. */
    const peek = (v) => JSON.stringify(typeof v === "string" ? v.slice(0, 160) + (v.length > 160 ? "…" : "") : v ?? null);
    console.log(`  top-level keys: ${Object.keys(c).join(", ")}`);
    for (const k of Object.keys(c).filter((k) => NOTE.test(k))) console.log(`  ${k.padEnd(18)} ${peek(c[k])}`);
    for (const [k, v] of Object.entries(c.customFieldValues || {}).filter(([k]) => NOTE.test(k)))
      console.log(`  customFieldValues.${k}  ${peek(v)}`);
  } catch (e) { console.log(`\nCONTACT ${id}: could not read — ${e.message.slice(0, 100)}`); }
}
console.log("");
