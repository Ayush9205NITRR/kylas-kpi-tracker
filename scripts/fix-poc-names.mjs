#!/usr/bin/env node
/* PUT EVERY CONTACT'S WHOLE NAME INTO lastName, THE "POC NAME" BOX.
 *
 *   node --env-file=.env.local scripts/fix-poc-names.mjs                  dry run: lists, writes nothing
 *   node --env-file=.env.local scripts/fix-poc-names.mjs --apply --limit 5
 *   node --env-file=.env.local scripts/fix-poc-names.mjs --apply --limit 100
 *
 * Ayush, 2026-11-13: Kylas' contact list shows "POC Name: Bhatt" for Pooja
 * Bhatt. This account's form has one name box and it reads lastName only;
 * saves split the name on the last space (fixed in gen-fields splitName). This
 * moves the existing records: lastName = "first last", firstName cleared.
 *
 * SAFE BY CONSTRUCTION. Each write goes through toKylasContact(..., { base }),
 * the same replace-safe body the console's own save uses: every field the
 * card is silent about is carried from the record just read (test-replace).
 * Each write is read back, and a contact whose phone, email, owner or company
 * changed in the read-back stops the run. Capped by --limit (default 100).
 */
import { createClient, toConsoleContact, toKylasContact, idOf } from "./kylas.mjs";

const env = process.env;
if (!env.KYLAS_KEY) { console.error("KYLAS_KEY is not set"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", 100)) || 100;
const kylas = createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });

const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
const all = (await kylas.contactsChangedSince(null, { fields: ["id", "firstName", "lastName", "updatedAt"] })).contacts;
const todo = all.filter((c) => clean(c.firstName)).map((c) => ({
  id: c.id, first: clean(c.firstName), last: clean(c.lastName),
  /* a half-done earlier run may already hold the whole name in lastName */
  want: clean(c.lastName).toLowerCase().startsWith(clean(c.firstName).toLowerCase() + " ")
    ? clean(c.lastName) : clean(`${clean(c.firstName)} ${clean(c.lastName)}`),
}));
console.log(`${all.length} contacts read · ${todo.length} have a firstName (POC Name shows only the surname)`);
for (const t of todo.slice(0, 15)) console.log(`  ${t.id}  "${t.last}"  ->  "${t.want}"`);
if (todo.length > 15) console.log(`  … ${todo.length - 15} more`);
if (!APPLY) { console.log("\nDry run. Nothing written. Add --apply --limit 5 to fix the first five."); process.exit(0); }

const sig = (r) => JSON.stringify({
  phones: (r.phoneNumbers || []).map((p) => `${p.dialCode}${p.value}`).sort(),
  emails: (r.emails || []).map((e) => String(e.value).toLowerCase()).sort(),
  owner: String(idOf(r.ownerId) ?? ""), company: String(idOf(r.company) ?? ""),
});
let done = 0, failed = 0;
for (const t of todo.slice(0, LIMIT)) {
  try {
    const base = await kylas.contact(t.id);
    const before = sig(base);
    const card = { ...toConsoleContact(base), pocName: t.want };
    await kylas.updateContact(t.id, toKylasContact(card, { base }));
    const after = await kylas.contact(t.id);
    const ok = clean(after.lastName) === t.want && !clean(after.firstName);
    if (sig(after) !== before) {
      console.error(`! ${t.id}: phone/email/owner/company changed on read-back — STOPPING.\n  before ${before}\n  after  ${sig(after)}`);
      process.exit(2);
    }
    console.log(`${ok ? "ok " : "?? "} ${t.id}  "${t.last}" -> "${clean(after.firstName)}|${clean(after.lastName)}"`);
    ok ? done++ : failed++;
  } catch (e) { failed++; console.error(`! ${t.id}: ${e.message.slice(0, 200)}`); }
}
console.log(`\n${done} fixed, ${failed} not, ${Math.max(0, todo.length - LIMIT)} left for the next run.`);
