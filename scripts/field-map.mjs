/* THE FIELD MAP: WHICH AIRTABLE FIELD GOES INTO WHICH KYLAS FIELD, AND WHETHER
 * THE TYPE STAYS THE SAME ALL THE WAY.
 *
 * Ayush, 2026-10-17: "Field mapper (Airtable ki kaun si field Kylas ki kaunsi
 * field ke saath map hai) — aur data type constant hai (data which is being
 * sent and mapped are constant) — end state to be checked."
 *
 * WHY THIS IS A FILE AND NOT A COMMENT. Before this, the answer to "where does
 * the budget / the call-back / the stage go in Kylas" was spread over
 * toKylasContact, kylas-write-map.mjs, push-kylas.mjs and a table in
 * docs/STATE.md that had to be kept equal to them by hand. A mapping that lives
 * in four places is a mapping nobody can check. This is the one list, as DATA,
 * and everything that wants to know reads it:
 *
 *   - push-kylas.mjs  validates every value against it before it is sent, and
 *                     reads the record back afterwards (the "end state").
 *   - /field-map      resolves it against the live account and says which
 *                     entries have a field in Kylas and which do not.
 *   - the digest      prints the entries that failed.
 *
 * THREE THINGS CAN BE WRONG, AND THEY ARE DIFFERENT THINGS:
 *
 *   UNMAPPED   there is no such field on this Kylas account. The write leaves
 *              the value off the payload and the SAVE STILL SUCCEEDS — nothing
 *              errors, nothing is logged but a line, the value is just gone.
 *              This is the failure that goes unnoticed, so it is the one this
 *              file exists to make loud.
 *   TYPE       the field exists but takes a different kind of value than we
 *              send: a name sent to a picklist that takes ids, a bare date to a
 *              date-time, text to a number. Kylas either refuses the whole
 *              contact (400 that names no field) or answers 200 and stores
 *              nothing. Checked BEFORE the send, so a bad value is held back and
 *              named instead of costing the contact its write.
 *   DROPPED    Kylas answered 200 and the record does not hold the value. Only
 *              a read-back can see this (probe-write.mjs calls it DROPPED).
 *
 * "KIND" IS THE CONSTANT. Every entry declares the kind of value it sends
 * (`sends`). A Kylas field's type is read into the same small vocabulary
 * (kindOfKylas). The map holds when the two are equal; the moment an admin
 * changes a field's type in Kylas settings, or this repo changes what it sends,
 * the entry flips to TYPE and says so.
 */

/* The vocabulary, small on purpose. */
export const KINDS = ["text", "option", "options", "datetime", "date", "number", "lookup", "list"];

/* A Kylas field type, read into a kind. Account types are spelled several ways
   across endpoints (TEXT_FIELD / STRING, PICK_LIST / PICKLIST, DATETIME_PICKER
   / DATE_TIME), so it is matched by shape, not by an exact name. `null` means
   "a type this file does not know", which is reported and never guessed at. */
export function kindOfKylas(type) {
  const t = String(type || "").toUpperCase();
  if (!t) return null;
  if (/MULTI/.test(t) && /PICK|SELECT|LIST/.test(t)) return "options";
  if (/PICK_?LIST|SELECT|RADIO/.test(t)) return "option";
  if (/DATE_?TIME|TIMESTAMP/.test(t)) return "datetime";
  if (/DATE/.test(t)) return "date";
  if (/LOOK_?UP|RELATION|ENTITY/.test(t)) return "lookup";
  if (/NUMBER|DECIMAL|INTEGER|CURRENCY|FLOAT|PERCENT/.test(t)) return "number";
  if (/PHONE|EMAIL/.test(t)) return "list";
  if (/TEXT|STRING|PARAGRAPH|URL|RICH/.test(t)) return "text";
  return null;
}

/* The Airtable column types the registry names, read into the same kinds, for
   the "does the source side even fit" half of the check. A text column feeding
   a picklist is allowed ONLY where the entry says how it is turned into an id
   (`via`), because that is a conversion, not a coincidence. */
export function kindOfAirtable(type) {
  const t = String(type || "");
  if (/^(singleLineText|multilineText|url|email|phoneNumber|richText)$/.test(t)) return "text";
  if (t === "singleSelect") return "option";
  if (t === "multipleSelects") return "options";
  if (t === "dateTime") return "datetime";
  if (t === "date") return "date";
  if (/^(number|currency|percent|rating|count)$/.test(t)) return "number";
  if (t === "multipleRecordLinks") return "lookup";
  if (t === "checkbox") return "boolean";
  return null;
}

/* THE REGISTRY. One entry per datum that leaves for Kylas.
 *
 *   key       stable id, used as the Field Map row's key
 *   via       "save"  — written on every console save (toKylasContact)
 *             "push"  — written by the nightly push (push-kylas.mjs)
 *   airtable  where the value lives in the KPI base
 *   kylas     where it goes:
 *               name     a fixed Kylas field name, or
 *               resolve  a key into kylas-write-map's resolved fields
 *               custom   true for cf* fields (they sit under customFieldValues)
 *   sends     the KIND of value the code sends
 *   how       how the Airtable value becomes the Kylas value, in a sentence
 */
export const FIELD_MAP = [
  { key: "firstName", via: ["save"], label: "First name",
    airtable: { table: "Contacts", field: "Name", type: "singleLineText" },
    kylas: { name: "firstName", entity: "contact" }, sends: "text", how: "first word of Name" },
  { key: "lastName", via: ["save"], label: "Last name",
    airtable: { table: "Contacts", field: "Name", type: "singleLineText" },
    kylas: { name: "lastName", entity: "contact" }, sends: "text", how: "the rest of Name, or Unknown" },
  { key: "designation", via: ["save"], label: "Designation",
    airtable: { table: "Contacts", field: "Designation", type: "singleLineText" },
    kylas: { name: "designation", entity: "contact" }, sends: "text", how: "as is" },
  { key: "linkedin", via: ["save"], label: "LinkedIn",
    airtable: { table: "Contacts", field: "LinkedIn", type: "url" },
    kylas: { name: "linkedin", entity: "contact" }, sends: "text", how: "as is" },
  { key: "emails", via: ["save"], label: "Emails",
    airtable: { table: "Contacts", field: "Emails", type: "multilineText" },
    kylas: { name: "emails", entity: "contact" }, sends: "list", how: "JSON list to [{type, value, primary}], invalid addresses dropped" },
  { key: "phoneNumbers", via: ["save"], label: "Phone numbers",
    airtable: { table: "Contacts", field: "Phones", type: "multilineText" },
    kylas: { name: "phoneNumbers", entity: "contact" }, sends: "list", how: "JSON list to [{type, dialCode, code, value, primary}], national number in value" },
  { key: "company", via: ["save"], label: "Company",
    airtable: { table: "Contacts", field: "Company", type: "multipleRecordLinks" },
    kylas: { name: "company", entity: "contact" }, sends: "lookup", how: "the company's Kylas id, as a number" },
  { key: "ownerId", via: ["save"], label: "Owner",
    airtable: { table: "Contacts", field: "Kylas Owner ID", type: "singleLineText" },
    kylas: { name: "ownerId", entity: "contact" }, sends: "lookup", how: "the owner's Kylas user id, as a number" },
  { key: "remarks", via: ["save"], label: "Remarks",
    airtable: { table: "Contacts", field: "Remarks", type: "multilineText" },
    kylas: { name: "remarks", entity: "contact" }, sends: "text", how: "the console's block, merged between its markers" },
  { key: "stage", via: ["save"], label: "Pipeline stage",
    airtable: { table: "Contacts", field: "Current Stage", type: "singleSelect" },
    kylas: { name: "cfPipelineStageBd", entity: "contact", custom: true }, sends: "option", convert: "option id", how: "stage name to the picklist option's id" },
  { key: "source", via: ["save"], label: "Source of Data",
    airtable: { table: "Contacts", field: "Source of Data", type: "singleLineText" },
    kylas: { name: "cfSourceOfData", entity: "contact", custom: true }, sends: "option", convert: "as typed", how: "sent as the console holds it" },
  { key: "nextCall", via: ["save", "push"], label: "Next call (call-back)",
    airtable: { table: "Contacts", field: "Next Call Date", type: "date" },
    /* A date-only field takes the day; a date-time field takes the instant. Both
       are right, which is why this one names two kinds — see nextCallValue. */
    kylas: { resolve: "nextCall", entity: "contact", custom: true }, sends: ["date", "datetime"], how: "date, or date + time in the associate's zone as an instant" },
  { key: "offsite", via: ["save", "push"], label: "Offsite quarter",
    airtable: { table: "Event Rows", field: "Timeline", type: "multilineText" },
    /* A multi-picklist takes a list of ids, a single picklist one id; offsiteValue sends whichever the field is. */
    kylas: { resolve: "offsite", entity: "contact", custom: true }, sends: ["options", "option"], convert: "option id", how: "quarter derived from the Timeline text, to the option's id" },
  /* The call log is a second Kylas record, and its fields are fixed by the API. */
  { key: "callOutcome", via: ["save"], label: "Call outcome",
    airtable: { table: "Call Log", field: "Outcome", type: "singleSelect" },
    kylas: { name: "outcome", entity: "call-log" }, sends: "text", how: "console outcome to no_answer / connected" },
  { key: "callStart", via: ["save"], label: "Call start",
    airtable: { table: "Call Log", field: "Called At", type: "dateTime" },
    kylas: { name: "startTime", entity: "call-log" }, sends: "datetime", how: "ISO instant" },
  { key: "callType", via: ["save"], label: "Call type",
    airtable: null,
    kylas: { name: "callType", entity: "call-log" }, sends: "text", how: "always \"outgoing\"; not stored in Airtable" },
  { key: "callPhone", via: ["save"], label: "Call phone number",
    airtable: { table: "Contacts", field: "Phone", type: "singleLineText" },
    kylas: { name: "phoneNumber", entity: "call-log" }, sends: "text", how: "the primary number, as E.164" },
  { key: "callNotes", via: ["save"], label: "Call notes",
    airtable: null,
    kylas: { name: "notes", entity: "call-log" }, sends: "list", how: "the note typed on the card, as [{description}]; not stored in Airtable" },
  { key: "callRelated", via: ["save"], label: "Call is about",
    airtable: { table: "Call Log", field: "Contact", type: "multipleRecordLinks" },
    kylas: { name: "relatedTo", entity: "call-log" }, sends: "lookup", how: "{entity: contact, id: the contact's Kylas id}" },
  { key: "callDuration", via: ["save"], label: "Call duration",
    airtable: { table: "Call Log", field: "Duration", type: "number" },
    kylas: { name: "duration", entity: "call-log" }, sends: "text", how: "seconds, as a string (Kylas takes a string)" },
];

/* What a VALUE is, in the same vocabulary. Used on what is about to be sent. */
export function kindOfValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : null;
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (typeof v === "object") return "object";
  return null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/* Does this VALUE fit a field of this kind? `kind` is the Kylas field's kind.
   Returns { ok, why }. The reasons name both sides, because "type mismatch" on
   its own tells nobody which of the two to fix. */
export function checkValue(kind, value, { options = null } = {}) {
  const vk = kindOfValue(value);
  const no = (why) => ({ ok: false, why });
  if (vk === null) return no("there is no value");
  switch (kind) {
    case "text":
      return vk === "string" ? { ok: true } : no(`sent ${vk}, Kylas field is text`);
    case "number":
    case "lookup":
      if (vk === "number") return { ok: true };
      if (vk === "string" && /^\d+$/.test(value.trim())) return { ok: true };
      return no(`sent ${vk === "string" ? `"${String(value).slice(0, 24)}"` : vk}, Kylas field takes a number`);
    case "date":
      return vk === "string" && ISO_DAY.test(value) ? { ok: true }
        : no(`sent ${vk === "string" ? `"${value.slice(0, 24)}"` : vk}, Kylas field takes a day (YYYY-MM-DD)`);
    case "datetime":
      return vk === "string" && ISO_INSTANT.test(value) ? { ok: true }
        : no(`sent ${vk === "string" ? `"${value.slice(0, 24)}"` : vk}, Kylas field takes a date-time instant`);
    case "option":
    case "options": {
      const list = Array.isArray(value) ? value : [value];
      if (kind === "option" && Array.isArray(value)) return no("sent a list, Kylas field takes one option");
      for (const x of list) {
        const xk = kindOfValue(x);
        if (xk !== "number" && !(xk === "string" && /^\d+$/.test(x.trim()))) {
          /* A NAME sent to a picklist. It is reported but, by itself, it is the
             existing save behaviour for Source of Data — so the verdict says
             what was seen and leaves the decision to the caller (`soft`). */
          const known = (options || []).some((o) => String(o.code) === String(x) || String(o.label) === String(x));
          return { ok: false, soft: known, why: `sent ${xk === "string" ? `the name "${String(x).slice(0, 24)}"` : xk}, Kylas picklist takes an option id` };
        }
        if (options && options.length && !options.some((o) => String(o.id) === String(x)))
          return no(`option id ${x} is not one of this field's ${options.length} options`);
      }
      return { ok: true };
    }
    case "list":
      return vk === "array" ? { ok: true } : no(`sent ${vk}, Kylas field takes a list`);
    default:
      return no("this Kylas field's type is not one this map knows");
  }
}

/* ── resolving the registry against a real account ─────────────────────── */

/* kylasFields: [{ name, label, type }] — exactly what handlers.mjs meta()
   serves. writeMap: resolveWriteFields()'s answer ({ nextCall, offsite }).
   picklists:    { [field name]: [{ id, code, label }] }.

   Every row gets a STATUS:
     mapped    the Kylas field exists and its type is the kind we send
     unmapped  no such field on this account
     type      the field exists, with a different kind than we send
     unknown   the field exists, but its type is not one this file reads
     assumed   a core Kylas field the field list does not describe — present by
               definition, type fixed by the API, so it cannot be checked here */
export function resolveFieldMap({ kylasFields = [], writeMap = null, picklists = {} } = {}) {
  const byName = new Map(kylasFields.map((f) => [String(f.name), f]));
  return FIELD_MAP.map((e) => {
    const row = {
      key: e.key, label: e.label, via: e.via.join(" + "), entity: e.kylas.entity,
      airtableTable: e.airtable?.table || "", airtableField: e.airtable?.field || "(constant)", airtableType: e.airtable?.type || "",
      sends: [].concat(e.sends).join(" | "), how: e.how, kylasField: "", kylasType: "", kylasKind: null, status: "", note: "",
    };
    let f = null;
    if (e.kylas.resolve) {
      const r = writeMap?.[e.kylas.resolve] || null;
      f = r ? { name: r.name, label: r.label, type: r.type } : null;
      row.kylasField = f?.name || "";
      row.options = r?.options || [];
    } else {
      row.kylasField = e.kylas.name;
      f = byName.get(e.kylas.name) || null;
      row.options = picklists[e.kylas.name] || [];
    }
    if (e.kylas.resolve && !f) {
      row.status = "unmapped"; row.note = "no field on this Kylas account — the value is left off every write";
      return row;
    }
    if (e.kylas.custom && !f) {
      row.status = "unmapped"; row.note = `${e.kylas.name} is not in this account's field list`;
      return row;
    }
    if (!f) {
      row.status = "assumed"; row.kylasType = "(core field)"; row.kylasKind = [].concat(e.sends)[0];
      row.note = "a core Kylas field; its type is fixed by the API";
      return row;
    }
    row.kylasType = f.type || "";
    row.kylasKind = kindOfKylas(f.type);
    /* A core field the list DOES describe still has to be the kind we send. The
       contact phone and email lists are typed PHONE / EMAIL there, which reads
       as "list", and company is a lookup. */
    if (!row.kylasKind) { row.status = "unknown"; row.note = `Kylas type ${f.type || "(none)"} is not one this map reads`; return row; }
    if (![].concat(e.sends).includes(row.kylasKind)) {
      row.status = "type";
      row.note = `we send ${row.sends}, Kylas field is ${row.kylasKind} (${f.type})`;
      return row;
    }
    row.status = "mapped";
    return row;
  });
}

/* The verdict, in one line per problem. Empty when the map is whole. */
export function problemsOf(rows) {
  return rows.filter((r) => r.status === "unmapped" || r.status === "type" || r.status === "unknown")
    .map((r) => ({ key: r.key, label: r.label, status: r.status, kylasField: r.kylasField, note: r.note }));
}

/* WHAT A SAVE WILL LEAVE OFF, BEFORE IT DOES. The values the card holds that this
   account has no Kylas field for. A save does not fail over this — it is the
   quiet one — so the job row carries the list and the digest counts it.
   `quarters` is what offsiteOf(card) derived. */
export function lackingOnSave(writeMap, card, quarters = []) {
  const out = [];
  if (!writeMap?.nextCall && card?.nextCallDate) out.push("next call");
  if (!writeMap?.offsite && quarters.length) out.push("offsite quarter");
  return out;
}

/* ── the end state ─────────────────────────────────────────────────────── */

/* What the record holds, normalised the way a value we sent is: a picklist
   arrives as {id, name} or an array of them, a number may come back as a
   string. Sorting makes a multi-picklist order-independent. */
const flat = (v) => (Array.isArray(v) ? v.map(flat) : v && typeof v === "object" ? (v.id ?? v.value ?? v) : v);
export function normalise(v) {
  const x = flat(v);
  if (Array.isArray(x)) return x.map((y) => String(y)).sort();
  if (x === null || x === undefined) return null;
  return String(x);
}

/* Did the record keep it? Date-times are compared as instants, because Kylas
   may hand back the same moment spelled differently (+00:00 vs Z, with or
   without milliseconds) and that is not a difference. */
export function holds(sent, got) {
  const a = normalise(sent), b = normalise(got);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a === b) return true;
  if (a && b && ISO_INSTANT.test(a) && ISO_INSTANT.test(b)) {
    const x = Date.parse(a), y = Date.parse(b);
    return Number.isFinite(x) && x === y;
  }
  return false;
}

/* The verdict for one field after a write. */
export function verdict({ sent, got }) {
  if (holds(sent, got)) return { status: "pushed", verified: true };
  const empty = normalise(got) === null || (Array.isArray(normalise(got)) && !normalise(got).length);
  return empty
    ? { status: "dropped", verified: false, why: "Kylas answered OK but the record holds nothing there" }
    : { status: "mismatch", verified: false, why: "Kylas holds a different value than was sent" };
}

/* ── from a terminal ───────────────────────────────────────────────────── */
const isMain = (() => {
  try { return typeof process !== "undefined" && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()); }
  catch { return false; }
})();

if (isMain) {
  /* node --env-file=.env.local scripts/field-map.mjs            # print the map against the live account
     node --env-file=.env.local scripts/field-map.mjs --store    # and write it to the Field Map table */
  const { createClient } = await import("./kylas.mjs");
  const { resolveWriteFields } = await import("./kylas-write-map.mjs");
  const { findOptions } = await import("./kylas-options.mjs");
  const env = process.env;
  if (!env.KYLAS_KEY) { console.error("KYLAS_KEY is not set"); process.exit(1); }
  const kylas = createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });
  const r = await kylas.raw("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
  const list = Array.isArray(r) ? r : r?.content || r?.data || [];
  const picklists = {};
  for (const f of list) { const o = findOptions(f); if (o && (f.name || f.displayName)) picklists[f.name || f.displayName] = o; }
  const fields = list.map((f) => ({ name: f.name, label: f.displayName, type: f.type }));
  const rows = resolveFieldMap({ kylasFields: fields, writeMap: resolveWriteFields(fields, picklists), picklists });
  const w = (s, n) => String(s).padEnd(n);
  console.log(`\n${w("DATUM", 22)}${w("AIRTABLE", 30)}${w("KYLAS FIELD", 26)}${w("TYPE", 16)}STATUS`);
  for (const x of rows)
    console.log(`${w(x.label, 22)}${w(`${x.airtableTable}.${x.airtableField}`, 30)}${w(x.kylasField || "—", 26)}${w(x.kylasType || "—", 16)}${x.status}${x.note ? `  · ${x.note}` : ""}`);
  const bad = problemsOf(rows);
  console.log(bad.length ? `\n${bad.length} problem(s) above.` : "\nEvery datum has a Kylas field of the kind we send.");
  if (process.argv.includes("--store")) {
    const { storeFieldMap } = await import("./push-log.mjs");
    const { createAirtable } = await import("./airtable.mjs");
    if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE) { console.error("--store needs AIRTABLE_PAT and AIRTABLE_BASE"); process.exit(1); }
    const at = createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, { log: () => {} });
    const out = await storeFieldMap(at, rows, { log: (...x) => console.log(...x) });
    console.log(out.stored ? `Field Map: ${out.rows} row(s) written.` : `Field Map not written — ${out.why}`);
  }
  process.exit(bad.length ? 1 : 0);
}
