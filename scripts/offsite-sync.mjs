/* THE COMPANY'S OFFSITE QUARTER = WHAT ITS CONTACTS SAY, ADDED TO WHAT IT HAS.
 *
 * Ayush, 2026-10-27, on the digest's audit (52 companies with a quarter from
 * their contacts, 22 of them different on the company in Kylas): "contact se
 * uthao aur company ke existing mein usko add kar do". So the rule is a UNION —
 * nothing that is on the company is removed, the contacts' quarters are added.
 *
 * Pure. offsite-to-company.mjs does the reading and the writing.
 */
import { OFFSITE_QUARTERS } from "./offsite.mjs";
import { offsiteFrom, offsiteValue } from "./kylas-write-map.mjs";

const inOrder = (set) => OFFSITE_QUARTERS.filter((q) => set.has(q));
const sameSet = (a, b) => a.length === b.length && a.every((q, i) => q === b[i]);

/* field: the company's offsite field { name, type, multi, options };
   raw: what customFieldValues holds now; fromContacts: Set/array of quarters.
   -> { status, existing, target, add, value }
   status: same | add | single-cannot-hold | nothing (contacts name no quarter that
   the field has an option for) */
export function planCompany(field, raw, fromContacts) {
  const existing = offsiteFrom(field, raw);
  const want = new Set([...(fromContacts || [])].filter((q) => OFFSITE_QUARTERS.includes(q)));
  if (!want.size) return { status: "nothing", existing, target: existing, add: [], value: undefined };
  const target = inOrder(new Set([...existing, ...want]));
  const add = target.filter((q) => !existing.includes(q));
  if (sameSet(existing, target)) return { status: "same", existing, target, add: [], value: undefined };
  /* A single-select holds one quarter. Adding to it would REPLACE what is there,
     which is not what was asked — so it is reported, never written. */
  if (!field?.multi && target.length > 1) return { status: "single-cannot-hold", existing, target, add, value: undefined };
  const value = offsiteValue(field, target);
  /* An option the account does not offer cannot be sent; saying "add" and
     sending less than the target would be a lie. */
  if (value === undefined || (Array.isArray(value) ? value.length : 1) !== target.length)
    return { status: "no-option", existing, target, add, value: undefined };
  return { status: "add", existing, target, add, value };
}
