/* HOW WELL DOES THE OFFSITE QUARTER AGREE BETWEEN CONTACT, AIRTABLE AND THE COMPANY?
 *
 * Ayush, 2026-10-16: "Offsite Timeline -> contact <-> company, Airtable to
 * company is it being mapped (error rate to be determined)."
 *
 * THE SHAPE OF THE QUESTION. The quarter an offsite is in is typed on a CONTACT's
 * event row, derived in Airtable, and written to the CONTACT in Kylas by every
 * save and by the nightly push (the Push Log verifies that half). The ACCOUNT
 * has its own offsite field in Kylas that this repo only ever READS — nothing
 * writes a company, by design — so "is Airtable mapped to the company" is a
 * comparison, not a pipeline: of the companies whose contacts say a quarter,
 * how many carry the same one on the company itself?
 *
 * THREE SOURCES, all per company id, each a Set of quarters:
 *   airtable   what the contacts' event rows add up to  (offsiteByCompany)
 *   kylas      the company's own offsite field in Kylas  (kylasOffsite)
 *   list       the team's Company List copy of that field (listOffsite)
 *
 * THE VERDICT PER COMPANY (airtable vs kylas, the pair this is about):
 *   agree          both have a quarter and they are the same set
 *   partial        both have one and they share some but not all
 *   conflict       both have one and share none
 *   onlyAirtable   the contacts say a quarter, the company field is empty
 *                  — the mapping gap: nothing writes the company
 *   onlyKylas      the company says a quarter, no contact does
 *   (a company in neither is not counted)
 *
 * THE RATES, stated so each has an obvious denominator:
 *   mapped      agree / (companies Airtable has a quarter for)
 *   error       (partial + conflict) / (companies BOTH have a quarter for)
 *               — the figure for "how often are they wrong when both speak"
 *   notWritten  onlyAirtable / (companies Airtable has a quarter for)
 * "error" is None when there is no company with both, never 0%: a rate with no
 * denominator is not a good result.
 *
 * Pure. The route and the digest hand it the three maps.
 */
import { OFFSITE_QUARTERS } from "./offsite.mjs";

const norm = (s) => OFFSITE_QUARTERS.filter((q) => s?.has?.(q));
const key = (a) => a.join("+");

export function auditOffsite({ airtable = new Map(), kylas = new Map(), list = new Map() } = {}, { names = new Map(), examples = 8 } = {}) {
  const ids = new Set([...airtable.keys(), ...kylas.keys()].map(String));
  const kinds = { agree: [], partial: [], conflict: [], onlyAirtable: [], onlyKylas: [] };
  for (const id of ids) {
    const a = norm(airtable.get(id)), k = norm(kylas.get(id));
    if (!a.length && !k.length) continue;
    const row = { id, name: names.get(id) || `Company ${id}`, airtable: a, kylas: k, list: norm(list.get(id)) };
    if (a.length && !k.length) kinds.onlyAirtable.push(row);
    else if (!a.length && k.length) kinds.onlyKylas.push(row);
    else if (key(a) === key(k)) kinds.agree.push(row);
    else if (a.some((q) => k.includes(q))) kinds.partial.push(row);
    else kinds.conflict.push(row);
  }
  const n = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.length]));
  const airtableHas = n.agree + n.partial + n.conflict + n.onlyAirtable;
  const both = n.agree + n.partial + n.conflict;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  /* The Company List is a copy of the Kylas field, made by the sync. Where they
     differ the copy is stale or the sync mapped it wrongly — a different fault
     from the one above, so it is counted on its own. */
  let listBoth = 0, listSame = 0;
  for (const id of new Set([...kylas.keys(), ...list.keys()].map(String))) {
    const k = norm(kylas.get(id)), l = norm(list.get(id));
    if (!k.length || !l.length) continue;
    listBoth++; if (key(k) === key(l)) listSame++;
  }
  return {
    companies: { total: ids.size, airtableHas, kylasHas: n.agree + n.partial + n.conflict + n.onlyKylas, both },
    counts: n,
    rates: {
      mapped: pct(n.agree, airtableHas),
      error: pct(n.partial + n.conflict, both),
      notWritten: pct(n.onlyAirtable, airtableHas),
    },
    companyList: { both: listBoth, same: listSame, stale: pct(listBoth - listSame, listBoth) },
    examples: Object.fromEntries(["conflict", "partial", "onlyAirtable"].map((k) => [k, kinds[k].slice(0, examples)])),
  };
}

/* One paragraph for the morning mail. */
export function auditLines(a) {
  if (!a) return [];
  const c = a.companies, n = a.counts, r = a.rates;
  if (!c.airtableHas && !c.kylasHas) return ["  No company has an offsite quarter in Airtable or in Kylas."];
  const pc = (v) => (v == null ? "n/a" : `${v}%`);
  const out = [
    `  ${c.airtableHas} companies have a quarter from their contacts; ${n.agree} carry the same one on the company in Kylas (${pc(r.mapped)}).`,
    `  ${n.onlyAirtable} have none on the company (${pc(r.notWritten)}): nothing writes the company field.`,
    `  Where both have one (${c.both}): ${n.partial + n.conflict} differ, an error rate of ${pc(r.error)}.`,
  ];
  if (a.companyList.both) out.push(`  Company List vs Kylas: ${a.companyList.both - a.companyList.same} of ${a.companyList.both} differ (${pc(a.companyList.stale)}).`);
  return out;
}
