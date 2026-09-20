/* Where the screens get their data.
 *
 * One interface, two implementations: Supabase when it is configured, and a
 * small fixture when it is not, so the app runs on a laptop with no keys.
 *
 * The fixture is NOT the prototype's makeSample(). That generated 760 invented
 * companies and shipped them to anyone who opened the file, which is the
 * placeholder-mistaken-for-data failure Ayush asked to be rid of. This is six
 * rows, obviously fake, and the banner says so in the same words whether or not
 * anybody reads it. */
import type { Company, DayNumber, RungDate } from "../rules/ladder";
import { dayNumber, today } from "../rules/ladder";
import type { Person } from "../rules/grouping";

export type Contact = {
  id: string; companyId: string; name: string; designation: string;
  phone: string; email: string; lastCall: DayNumber | null; stage: string;
};

export type Research = Record<string, string> & { updatedAt?: string; updatedByEmail?: string };

export type FocusStatus = "focus" | "normal" | "depri";
export type Focus = {
  companyId: string; status: Exclude<FocusStatus, "normal">;
  reason: string; note: string; ownerName: string;
  setByEmail: string; setAt: string;
};

export type Snapshot = {
  companies: Company[];
  people: Record<string, Person>;
  focus: Record<string, Focus>;
  research: Record<string, Research>;
  /** null when nothing has ever synced. */
  syncedAt: string | null;
  /** "supabase" or "fixture" — the banner is not allowed to guess. */
  origin: "supabase" | "fixture";
};

export interface Source {
  load(): Promise<Snapshot>;
  contactsOf(companyId: string): Promise<Contact[]>;
  setFocus(companyId: string, status: FocusStatus, reason?: string, note?: string): Promise<void>;
  saveResearch(companyId: string, r: Research): Promise<void>;
  syncNow(): Promise<void>;
}

/* ── the fixture ─────────────────────────────────────────────────────── */

const T = today();
const d = (back: number): DayNumber => T - back;
const rung = (on: DayNumber, source: RungDate extends null ? never : "airtable" | "observed" | "seeded" = "airtable"): RungDate =>
  ({ on, source });
const NONE: Company["rungs"] = [null, null, null, null, null, null];
const r = (...pairs: [number, DayNumber, "airtable" | "seeded"][]): Company["rungs"] => {
  const out = [...NONE] as Company["rungs"];
  for (const [i, on, s] of pairs) out[i] = rung(on, s);
  return out;
};

const FIXTURE: Snapshot = {
  origin: "fixture",
  syncedAt: null,
  people: {
    "Rubal Sansanwal": { name: "Rubal Sansanwal", role: "Business Development Associate", active: true },
    "Priya Deshmukh": { name: "Priya Deshmukh", role: "Business Development Associate", active: true },
    "Enout Super Admin": { name: "Enout Super Admin", role: "Sales Manager", active: true },
  },
  focus: {},
  research: {},
  companies: [
    { id: "1776620", name: "seats", owner: "Rubal Sansanwal", stage: "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS",
      source: "Apollo", lastCall: d(2), discoveryMode: "Virtual", sqlMeetingMode: "", rca: "",
      rungs: r([0, d(40), "airtable"], [1, d(26), "airtable"], [2, d(9), "airtable"]) },
    { id: "1773706", name: "vincitlabs", owner: "Rubal Sansanwal", stage: "MQL_MARKETING_QUALIFIED_LEAD",
      source: "LinkedIn", lastCall: d(11), discoveryMode: "", sqlMeetingMode: "", rca: "",
      rungs: r([0, d(31), "airtable"], [1, d(11), "airtable"]) },
    { id: "903", name: "Shorehouse Retail", owner: "Priya Deshmukh", stage: "SQL_SALES_QUALIFIED_LEAD",
      source: "Referral", lastCall: d(4), discoveryMode: "In person", sqlMeetingMode: "In person", rca: "",
      rungs: r([0, d(70), "airtable"], [1, d(55), "airtable"], [2, d(38), "airtable"],
               [3, d(20), "airtable"], [4, d(12), "airtable"], [5, d(5), "airtable"]) },
    { id: "1778327", name: "Kritsnam Analytics", owner: "Priya Deshmukh", stage: "CNC_COULD_NOT_CONNECT_2",
      source: "Apollo", lastCall: d(48), discoveryMode: "", sqlMeetingMode: "", rca: "",
      rungs: r([0, d(48), "seeded"]) },
    { id: "1772963", name: "Anvaya Labs", owner: "Priya Deshmukh", stage: "YET_TO_BE_MINED",
      source: "Apollo", lastCall: null, discoveryMode: "", sqlMeetingMode: "", rca: "", rungs: [...NONE] as Company["rungs"] },
    { id: "1783663", name: "Meghdoot Cloud", owner: "Rubal Sansanwal", stage: "CLOSING_LOOPS_LOW_VALUE",
      source: "Lost Deals", lastCall: d(120), discoveryMode: "On call", sqlMeetingMode: "", rca: "Budget not approved",
      rungs: r([0, d(140), "airtable"], [1, d(130), "airtable"], [2, d(120), "airtable"]) },
  ],
};

const FIXTURE_CONTACTS: Record<string, Contact[]> = {
  "1776620": [
    { id: "112936", companyId: "1776620", name: "Hema Bharathi", designation: "Founder's Office",
      phone: "+91 98765 01234", email: "hema@seats.example", lastCall: d(2), stage: "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS" },
    { id: "112937", companyId: "1776620", name: "Shipra Gupta", designation: "Head of People",
      phone: "+91 98111 22233", email: "shipra@seats.example", lastCall: d(19), stage: "MQL_MARKETING_QUALIFIED_LEAD" },
  ],
};

class FixtureSource implements Source {
  private snap: Snapshot = structuredClone(FIXTURE);
  async load() { return structuredClone(this.snap); }
  async contactsOf(id: string) { return FIXTURE_CONTACTS[id] || []; }
  async setFocus(companyId: string, status: FocusStatus, reason = "", note = "") {
    const co = this.snap.companies.find((c) => c.id === companyId);
    if (status === "normal") delete this.snap.focus[companyId];
    else this.snap.focus[companyId] = {
      companyId, status, reason, note, ownerName: co?.owner || "",
      setByEmail: "you@enout.in", setAt: new Date().toISOString(),
    };
  }
  async saveResearch(companyId: string, r: Research) {
    this.snap.research[companyId] = { ...r, updatedAt: new Date().toISOString(), updatedByEmail: "you@enout.in" };
  }
  async syncNow() { throw new Error("Not connected to Supabase — nothing to sync."); }
}

/* Chosen once, at module load, so no screen has to wonder which it is. */
export const source: Source = new FixtureSource();

export { dayNumber };
