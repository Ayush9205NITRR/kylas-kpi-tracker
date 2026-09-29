/* WHICH KYLAS FIELD IS WHICH, RESOLVED AT RUNTIME.
 *
 * Two things the console has always known and never written back: the
 * call-back an associate promised, and the quarter the offsite is in. Both
 * live in custom fields, and a custom field's name is whatever the Kylas admin
 * typed — `cfNextCallDate`, `cfCallBackOn`, `cfOffsiteTimelineBdNew`. Hardcode
 * one and the write either silently does nothing or fails the whole save with
 * a 400 that names neither the field nor the rule.
 *
 * So nothing is hardcoded. The contact field list is already fetched and
 * cached for the picklists the console renders (handlers.mjs `metaShared`),
 * and these functions pick the right field out of it by what it IS: a date
 * field whose label talks about the next call, a picklist whose label talks
 * about the offsite timeline. If the account has no such field, the value is
 * left off the payload — the save is not failed over it, and /enrich-status
 * says which fields were found so it is visible rather than silent.
 *
 * THE QUARTER IS MATCHED BY READING THE OPTION, NOT BY ITS SPELLING. The
 * picklist may say "Jul - Sep", "Q3 (Jul-Sep)" or "JUL_SEP"; offsite.js
 * already turns any of those into one of the four buckets, so the option whose
 * label derives JUL_SEP is the option for JUL_SEP. One parser, both directions.
 */
import { OFFSITE_QUARTERS, quartersOf } from "./offsite.mjs";

/* A field's two names and its type, whatever shape the list arrives in. */
const nameOf = (f) => String(f?.name || "");
const labelOf = (f) => String(f?.label || f?.displayName || f?.name || "");
const typeOf = (f) => String(f?.type || "").toUpperCase();
const both = (f) => `${labelOf(f)} ${nameOf(f)}`;

const isDate = (f) => /DATE/.test(typeOf(f));
const isPick = (f) => /PICK_?LIST|SELECT|MULTI/.test(typeOf(f));
export const isMulti = (f) => /MULTI/.test(typeOf(f)) || /ARRAY|LIST_OF/.test(typeOf(f));

/* Highest score wins, and 0 means "not this field". Written as scores rather
   than a regex chain because several fields can match loosely — an account
   with both `cfNextCallDate` and `cfLastCalledAtDate` must not get the second. */
function scoreNextCall(f) {
  const t = both(f).toLowerCase();
  if (!isDate(f)) return 0;
  if (/last\s*call|called\s*at|previous/.test(t)) return 0;   /* the opposite field */
  let s = 0;
  if (/next\s*call/.test(t)) s += 10;
  if (/call\s*back|callback/.test(t)) s += 8;
  if (/follow\s*up/.test(t)) s += 5;
  if (/next/.test(t)) s += 2;
  if (!s) return 0;
  /* A date-time field can hold the time the associate promised; a plain date
     cannot, so where both exist the richer one wins. */
  if (/TIME/.test(typeOf(f))) s += 1;
  return s;
}

function scoreOffsite(f) {
  const t = both(f).toLowerCase();
  if (!isPick(f)) return 0;
  if (!/off\s*-?\s*site/.test(t)) return 0;
  let s = 10;
  if (/timeline|quarter|when|period/.test(t)) s += 4;
  if (isMulti(f)) s += 1;          /* an offsite can be named for two quarters */
  return s;
}

const best = (fields, score) => (fields || [])
  .map((f) => ({ f, s: score(f) })).filter((x) => x.s > 0)
  .sort((a, b) => b.s - a.s)[0]?.f || null;

/* fields:    [{ name, label, type }] as handlers.mjs meta() returns them
   picklists: { [field name]: [{ id, code, label }] } from the same place */
export function resolveWriteFields(fields, picklists = {}) {
  const nextCall = best(fields, scoreNextCall);
  const offsite = best(fields, scoreOffsite);
  const withOpts = (f) => (f ? { name: nameOf(f), label: labelOf(f), type: typeOf(f),
                                 multi: isMulti(f), options: picklists[nameOf(f)] || [] } : null);
  return { nextCall: withOpts(nextCall), offsite: withOpts(offsite) };
}

/* ── the values ────────────────────────────────────────────────────────── */

/* The call-back, as the field can hold it. A date-only field takes the day;
   a date-time field takes the instant, which means the associate's timezone
   has to be applied — 10:00 promised in Delhi is 04:30Z, and sending 10:00Z
   moves every call-back five and a half hours later. */
export function nextCallValue(field, date, time, tzMin = 330) {
  const d = String(date || "").trim();
  if (!field || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  if (!/TIME/.test(field.type)) return d;
  const t = /^\d{1,2}:\d{2}/.test(String(time || "").trim()) ? String(time).trim() : "09:00";
  const [hh, mm] = t.split(":");
  const localMs = Date.parse(`${d}T${hh.padStart(2, "0")}:${mm.slice(0, 2)}:00Z`);
  if (!Number.isFinite(localMs)) return d;
  return new Date(localMs - tzMin * 60000).toISOString();
}

/* Which option of the picklist means this quarter. The option is READ with the
   same parser the console reads free text with, so the spelling does not
   matter — only what it means. */
export function optionForQuarter(options, quarter) {
  for (const o of options || []) {
    const text = `${o.label || ""} ${o.code || ""}`.replace(/_/g, " ");
    if (String(o.code || "").toUpperCase() === quarter) return o;
    if (quartersOf(text).includes(quarter)) return o;
  }
  return null;
}

/* What to send for a set of quarters. An option Kylas does not offer is left
   out rather than sent as text: a picklist takes ids, and a value it does not
   know fails the whole contact write, not just this field. */
export function offsiteValue(field, quarters) {
  if (!field || !quarters?.length) return undefined;
  const picked = [];
  for (const q of OFFSITE_QUARTERS) {
    if (!quarters.includes(q)) continue;
    const o = optionForQuarter(field.options, q);
    if (o) picked.push(o.id ?? o.code ?? o.label);
  }
  if (!picked.length) return undefined;
  return field.multi ? picked : picked[0];
}

/* Everything the map can add to a contact write, as customFieldValues. Empty
   when the account has neither field, which is the case this must survive. */
export function extraCustomFields(map, c, { tzMin = 330, quarters = [] } = {}) {
  const out = {};
  const nc = nextCallValue(map?.nextCall, c?.nextCallDate, c?.nextCallTime, tzMin);
  if (nc !== undefined) out[map.nextCall.name] = nc;
  const off = offsiteValue(map?.offsite, quarters);
  if (off !== undefined) out[map.offsite.name] = off;
  return out;
}

/* For /enrich-status and the probe: what was found, in one line each. */
export function describeWriteMap(map) {
  const one = (k, f) => `${k}: ${f ? `${f.label} (${f.name}, ${f.type}${f.multi ? ", multi" : ""}` +
    `${f.options?.length ? `, ${f.options.length} options` : ""})` : "no field on this account"}`;
  return [one("next call", map?.nextCall), one("offsite timeline", map?.offsite)];
}
