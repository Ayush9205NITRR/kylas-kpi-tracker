/* LAST CALL, FROM EVERY CALL KEPT (Ayush, 2026-11-04: "last call sahi nahi").
 *
 * The Call Log keeps 30 days, so after that a company's own rollup forgot the
 * call and the accounts list fell back to Kylas' stale cfLastCalledAtDate —
 * "113d ago" on an account whose call-back was set 32 days ago. The newest of:
 *   console   the Call Log (progress.mjs lastCallAt)
 *   dialler   Kylas call logs in Dialler Calls, kept for good (dialLastAt), and
 *             matched to the company through the contact index for contacts
 *             the base no longer holds
 *   kylas     the company field, last resort
 */
export function lastCallsByCompany(prog = {}, index = null) {
  const out = new Map();
  const bump = (co, at, src) => {
    if (!co || !at) return;
    const h = out.get(co);
    if (!h || String(at) > String(h.at)) out.set(co, { at: String(at), src });
  };
  for (const [co, p] of prog.byCompany || []) { bump(String(co), p?.lastCallAt, "console"); bump(String(co), p?.dialLastAt, "dialler"); }
  if (index?.contacts && prog.dialByContact)
    for (const [kid, at] of prog.dialByContact) bump(String(index.contacts[kid]?.[0] || ""), at, "dialler");
  return out;
}

export function withLastCall(co, calls) {
  const h = calls.get(String(co.id));
  const kylasAt = co.lastCalledAt || null;
  if (h && (!kylasAt || h.at > String(kylasAt))) return { lastCalledAt: h.at, lastCallSource: h.src };
  return kylasAt ? { lastCalledAt: kylasAt, lastCallSource: "kylas" } : { lastCalledAt: null };
}
