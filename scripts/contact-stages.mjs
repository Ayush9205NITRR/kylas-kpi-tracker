/* EVERY ACCOUNT'S STAGE, FROM ITS CONTACTS — ALL OF THEM.
 *
 * Ayush, 2026-10-09: "Account stage galat hai... har account ke contact mein
 * aao aur usme joh higher status hai usko pick karo... Not Interested vale CNC
 * mein dale hue hai."
 *
 * The account stage was calculated from contacts only for accounts somebody
 * had SAVED a contact for through the console — those live in the KPI base,
 * and progress.mjs read them. That is a few hundred of 17,925. Every other
 * account fell back to the COMPANY record's own "Pipeline Stage - BD" in
 * Kylas, which nobody keeps current — the board's own comment called it
 * "not a calculation... it goes stale the moment a POC moves". So the board
 * filed most of the account by a field that was wrong, and the Not Interested
 * accounts sat in CNC because that is what the company record still said.
 *
 * It was wrong in a second way too. The company field is a DIFFERENT picklist
 * from the contact one, with different ids, and stageCode() only knows the
 * contact ids — so a company marked SQL came through as a bare number, matched
 * no rung, and drew a column reading "SQL (Sales Qualified Lead) · rung 0 of
 * 26". SQL is rung 26.
 *
 * So this keeps a small index of EVERY Kylas contact — which company it
 * belongs to and what stage it is at — and an account's stage is the highest
 * rung among its contacts. Kylas is the system of record, so it is read from
 * there and not from the KPI base, which holds only what the console wrote and
 * which test-scale-airtable showed cannot hold the whole account anyway.
 *
 * Pure: no I/O. handlers.mjs owns the crawl, the storage and the schedule.
 */
import { STAGE_RUNG } from "./stages.mjs";

const rungOf = (code) => STAGE_RUNG[code] || 0;

/* An empty index. `contacts` maps a contact id to [companyId, stageCode,
   updatedAtMs] — arrays rather than objects because there are tens of
   thousands of them and the keys would be most of the bytes. */
export function emptyIndex() {
  return { v: 1, builtAt: 0, watermark: "", contacts: {} };
}

/* Fold a page of Kylas contacts into the index. A contact already held is
   overwritten only by a copy at least as new, so a delta that overlaps the
   last one cannot put an older stage back. Returns how many changed. */
export function applyContacts(index, contacts, { companyOf, stageOf, stampOf }) {
  let changed = 0;
  for (const c of contacts || []) {
    const id = c?.id == null ? "" : String(c.id);
    if (!id) continue;
    const co = String(companyOf(c) || "");
    const st = String(stageOf(c) || "");
    const at = Number(stampOf(c)) || 0;
    const had = index.contacts[id];
    if (had && had[2] > at) continue;
    if (!had || had[0] !== co || had[1] !== st) changed++;
    index.contacts[id] = [co, st, at];
    if (at) {
      const iso = new Date(at).toISOString();
      if (iso > index.watermark) index.watermark = iso;
    }
  }
  return changed;
}

/* A contact the console itself just saved. Same rule as a delta, stamped now:
   the save is newer than anything the last crawl could have seen, so it wins
   until a later crawl brings back something newer still. This is what makes
   the board move the moment an associate saves, rather than at the next
   crawl. */
export function noteSaved(index, { id, companyId, stage, at = Date.now() }) {
  if (!id || !companyId) return false;
  return applyContacts(index, [{ id, companyId, stage, at }], {
    companyOf: (c) => c.companyId, stageOf: (c) => c.stage, stampOf: (c) => c.at,
  }) > 0;
}

/* Per company: the highest-rung stage among its contacts, and how many
   contacts it has. A contact with no stage at all still counts towards `n` —
   the account has a POC, nobody has staged them yet — but cannot set the
   stage. */
export function byCompany(index) {
  const out = new Map();
  for (const [co, st] of Object.values(index.contacts)) {
    if (!co) continue;
    let e = out.get(co);
    if (!e) out.set(co, (e = { stage: "", rung: 0, n: 0 }));
    e.n++;
    const r = rungOf(st);
    if (r > e.rung) { e.rung = r; e.stage = st; }
  }
  return out;
}

/* Two answers for the same account — the index's, from Kylas, and the KPI
   base's, from progress.mjs — and the higher wins.

   Why both, rather than the index alone: progress.mjs reads KPI Rank, which
   only ever rises (Ayush, 2026-09-29: "make the label follow the rung" — a
   POC who reached Discovery and was later re-dialled to a no-answer has still
   been to Discovery). The index holds where each contact is NOW. For an
   account the console has worked, the KPI base's floor is the rule Ayush
   asked for; for the other seventeen thousand, the index is all there is.
   Highest-wins is the same instruction applied to both. */
export function higher(a, b) {
  const ra = a?.stage ? (a.rung || rungOf(a.stage)) : 0;
  const rb = b?.stage ? (b.rung || rungOf(b.stage)) : 0;
  if (!ra && !rb) return null;
  return rb > ra ? { stage: b.stage, rung: rb } : { stage: a.stage, rung: ra };
}
