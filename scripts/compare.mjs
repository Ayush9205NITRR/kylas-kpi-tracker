/* DO THE TWO LANES GIVE THE SAME ANSWER?
 *
 * Gate 3 answers every read twice and compares. What makes that useful rather
 * than noisy is knowing what is NOT a difference — and every rule below is
 * here because without it the harness would report drift on every row of a
 * perfectly correct copy, and be switched off within a week.
 *
 *   ORDER, where order is not the answer. Airtable returns companies in
 *   record order; SQL returns them in insert order. The console sorts them
 *   itself, so the two lists are the same answer. Compared by key.
 *
 *   ORDER INSIDE A LIST. ARRAYJOIN follows link order, group_concat follows
 *   ours. ["Hema","Shipra"] and ["Shipra","Hema"] are the same set of names.
 *
 *   PRECISION. A rollup sum arrives as 120 from one side and 120.0 from the
 *   other.
 *
 *   BLANK. Airtable omits an empty field; the copy returns "" or null or 0
 *   depending on the column. They mean the same thing and are compared as
 *   such.
 *
 *   TIME TO THE SECOND. Two systems formatting the same instant.
 *
 * What is NOT forgiven: a value present on one side and absent on the other,
 * a number that differs by more than rounding, a name that is not in both
 * lists. Those are the answers a BD would act on.
 */

const blank = (v) => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0);

const isInstant = (v) => typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);

/* `path` is only for the report; the rules are driven by the values. */
export function sameValue(a, b, path = "") {
  if (blank(a) && (blank(b) || b === 0)) return true;
  if (blank(b) && (blank(a) || a === 0)) return true;
  if (blank(a) || blank(b)) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    const la = Array.isArray(a) ? a : [a], lb = Array.isArray(b) ? b : [b];
    if (la.length !== lb.length) return false;
    /* Sorted: these are sets of names, and which order they came back in is
       an accident of how each side stores links. */
    const sa = [...la].map(String).sort(), sb = [...lb].map(String).sort();
    return sa.every((x, i) => sameValue(x, sb[i], path));
  }

  if (typeof a === "object" && typeof b === "object") return !diff(a, b, path).length;

  if (isInstant(a) && isInstant(b)) {
    const ta = Date.parse(a), tb = Date.parse(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return Math.abs(ta - tb) < 1000;
  }
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "")
    return Math.abs(na - nb) < 1e-6;
  return String(a) === String(b);
}

/* Every field where two objects disagree, as dotted paths. */
export function diff(a, b, path = "") {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    const va = a?.[k], vb = b?.[k];
    if (va && vb && typeof va === "object" && typeof vb === "object"
        && !Array.isArray(va) && !Array.isArray(vb)) {
      out.push(...diff(va, vb, p));
    } else if (!sameValue(va, vb, p)) {
      out.push({ field: p, airtable: va, sql: vb });
    }
  }
  return out;
}

/* TWO LISTS OF THE SAME THING, matched by key rather than by position. A row
   present on one side only is a different fault from a row present on both
   that disagrees, and they have different causes — so they are counted
   separately rather than summed into "12 differences". */
export function diffLists(aList, bList, keyOf = (x) => x.id, { sample = 5 } = {}) {
  const byA = new Map((aList || []).map((x) => [String(keyOf(x)), x]));
  const byB = new Map((bList || []).map((x) => [String(keyOf(x)), x]));
  const onlyAirtable = [], onlySql = [], differing = [];
  const fieldCounts = {};
  for (const [k, a] of byA) {
    const b = byB.get(k);
    if (!b) { onlyAirtable.push(k); continue; }
    const d = diff(a, b);
    if (d.length) {
      for (const x of d) fieldCounts[x.field] = (fieldCounts[x.field] || 0) + 1;
      if (differing.length < sample) differing.push({ key: k, fields: d.slice(0, 6) });
      else differing.push({ key: k });
    }
  }
  for (const k of byB.keys()) if (!byA.has(k)) onlySql.push(k);
  return {
    airtable: byA.size, sql: byB.size,
    onlyAirtable: onlyAirtable.length, onlySql: onlySql.length,
    differing: differing.length,
    clean: !onlyAirtable.length && !onlySql.length && !differing.length,
    fieldCounts,
    sampleOnlyAirtable: onlyAirtable.slice(0, sample),
    sampleOnlySql: onlySql.slice(0, sample),
    sampleDiffering: differing.filter((d) => d.fields).slice(0, sample),
  };
}
