#!/usr/bin/env node
/* IS THE FULL NAME IN KYLAS, AND WHICH PART DOES THE FORM SHOW? Read-only.
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

const env = process.env;
if (!env.KYLAS_KEY) { console.error("KYLAS_KEY is not set"); process.exit(1); }
const ids = process.argv.flatMap((a, i, all) => (a === "--contact" && all[i + 1] ? [all[i + 1]] : []));
const kylas = createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });

const r = await kylas.raw("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
const list = Array.isArray(r) ? r : r?.content || r?.data || [];
console.log("\nTHE NAME FIELDS, as this Kylas account defines them");
console.log("  name           label            type         active  required  standard");
for (const f of list.filter((x) => /^(salutation|salutationName|firstName|lastName)$/.test(x.name || ""))) {
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
  } catch (e) { console.log(`\nCONTACT ${id}: could not read — ${e.message.slice(0, 100)}`); }
}
console.log("");
