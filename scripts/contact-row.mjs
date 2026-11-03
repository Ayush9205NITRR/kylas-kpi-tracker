/* ONE KYLAS CONTACT AS AN AIRTABLE ROW — and whether it belongs there at all.
 *
 * Shared by the sync (sync-kylas.mjs), the company fill (fill-companies.mjs)
 * and the prune (prune-contacts.mjs), so the three can never disagree about
 * what a row holds or which contacts the base keeps.
 *
 * WHY NOT EVERY CONTACT (Ayush, 2026-11-03: "it cannot be that we need more
 * than 50K records"). The sync used to copy all ~37,500 Kylas contacts into
 * Airtable, and the plan stops a base at 50,000 records. Most of them were
 * never called, saved or moved. The base now keeps the contacts of WORKED
 * companies only — every contact of such a company, so its card stays whole —
 * and an unworked company's card is read from Kylas, which /company has always
 * done for a company with no contacts in Airtable.
 */
import { toConsoleContact, idOf } from "./kylas.mjs";
import { STAGE_RUNG } from "./stages.mjs";

/* The identity columns the sync owns, and nothing else. */
export const CONTACT_OWNED = ["Kylas Contact ID", "Name", "Designation", "LinkedIn", "Owner",
  "Current Stage", "Previous Stage", "KPI Rank", "KPI Rank At",
  "Company", "Kylas Updated At",
  "Phone", "Phones", "Email", "Emails",
  "Kylas Owner ID", "Salutation", "Source of Data", "Remarks"];

const iso = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? new Date(t).toISOString() : ""; };

/* Past the first rung (YET_TO_BE_MINED = 1) somebody has done something. */
export const movedPastStart = (stage) => (STAGE_RUNG[stage] || 0) > 1;

/* raw: a Kylas contact. prev: what Airtable holds for it ({} if nothing).
   coRec: Map(Kylas company id -> Airtable record id). */
export function contactRow(raw, prev = {}, coRec = new Map()) {
  const c = toConsoleContact(raw, { ownerName: raw.metaData?.idNameStore?.ownerId?.[String(raw.ownerId)] });
  const prevStage = prev["Current Stage"] || "";
  const prevRank = Number(prev["KPI Rank"] || 0);
  const rank = Math.max(prevRank, STAGE_RUNG[c.stage] || 0);
  const f = {
    "Kylas Contact ID": String(c.kid),
    Name: c.pocName || "",
    Designation: c.designation || "",
    LinkedIn: c.linkedin ? (/^https?:/i.test(c.linkedin) ? c.linkedin : "https://" + c.linkedin) : "",
    Owner: c.owner || "",
    /* JSON for the console, a plain string for whoever opens the base. */
    Phones: c.phones?.length ? JSON.stringify(c.phones) : "",
    Phone: c.phones?.length ? `${c.phones[0].cc || ""} ${c.phones[0].value || ""}`.trim() : "",
    Emails: c.emails?.length ? JSON.stringify(c.emails) : "",
    Email: c.emails?.[0]?.value || "",
    "Kylas Owner ID": String(c.ownerId || raw.ownerId || ""),
    Salutation: c.salutation || "",
    "Source of Data": c.source || "",
    Remarks: c.remarks || "",
    "Current Stage": c.stage || "",
    "KPI Rank": rank,
    "Kylas Updated At": iso(raw.updatedAt) || undefined,
  };
  if (rank > prevRank) f["KPI Rank At"] = new Date().toISOString();
  if (prevStage && c.stage && prevStage !== c.stage) f["Previous Stage"] = prevStage;
  const coId = String(c.companyId || idOf(raw.company) || "");
  if (coId && coRec.has(coId)) f.Company = [coRec.get(coId)];

  /* Only owned columns, and a blank never overwrites something already there. */
  const allow = new Set(CONTACT_OWNED);
  const row = {};
  for (const [k, v] of Object.entries(f)) if (allow.has(k) && v !== "" && v !== undefined && v !== null) row[k] = v;
  row["Kylas Contact ID"] = String(c.kid);      /* the merge key survives whatever else does */
  return { row, c, coId, rank, prevStage, prevRank };
}

/* Is this Airtable contact WORKED? Fields as read from the Contacts table. */
export function contactWorked(f = {}) {
  const n = (v) => (Array.isArray(v) ? v.length : Number(v || 0));
  return Number(f["KPI Rank"] || 0) > 1 || movedPastStart(f["Current Stage"])
    || n(f["Call Count"]) > 0 || n(f["Call Log"]) > 0 || n(f["Event Rows"]) > 0
    || n(f["Stage Transitions"]) > 0 || n(f.RCA) > 0
    || !!f["Has Signal"] || !!f["First Worked At"] || !!f["Duplicate Flag"];
}
