/* Talks to the local proxy, which holds the Kylas key and the Airtable PAT.
 *
 * Ayush, 2026-09-20: Airtable, not Supabase — "this is an extension using so
 * many different things will lead to a lot of friction while being deployed".
 * He is right, and the friction was going to be structural rather than
 * incidental: a second database, a second auth system, a second migration
 * path and a second set of secrets, for data that already lives in the base
 * the console writes to every save.
 *
 * So there is no second backend. This app is another client of the same proxy
 * the extension uses, and the schema it reads is created by the same
 * repair-base.mjs. Nothing here knows a key, exactly as nothing in the console
 * does.
 */
import type { Company, RungDate } from "../rules/ladder";
import { dayOf } from "../rules/ladder";
import type { Person } from "../rules/grouping";
import type { Contact, Focus, FocusStatus, Research, Snapshot, Source } from "./source";

const DEFAULT_BASE = "http://127.0.0.1:8787";
const base = (import.meta.env.VITE_PROXY_URL as string | undefined) || DEFAULT_BASE;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `the proxy returned ${res.status}`);
  return payload as T;
}

type LadderCompany = {
  id: string; name: string; owner: string; stage: string; source: string;
  lastCall: string | null;
  rungs: ({ at: string; source: "airtable" | "observed" | "seeded" } | null)[];
};
type LadderResponse = {
  configured: boolean;
  error?: string;
  companies: LadderCompany[];
  team: { name: string; role: string; inFunnel: boolean; counted: boolean }[];
  focus: Record<string, Focus>;
  research: Record<string, Research>;
  syncedAt: string | null;
};

export class ProxySource implements Source {
  async load(): Promise<Snapshot> {
    const r = await req<LadderResponse>("/ladder");
    if (!r.configured)
      throw new Error(r.error || "The proxy has no Airtable credentials, so there are no numbers to show.");

    const companies: Company[] = r.companies.map((c) => ({
      id: c.id,
      name: c.name,
      owner: c.owner,
      stage: c.stage,
      source: c.source,
      lastCall: dayOf(c.lastCall),
      /* The proxy sends instants; the app counts in IST days, because a call
         logged at 9pm in Delhi belongs to that day and not the next one. */
      rungs: c.rungs.map((x) => {
        if (!x) return null;
        const on = dayOf(x.at);
        return on == null ? null : ({ on, source: x.source } as RungDate);
      }) as Company["rungs"],
      discoveryMode: "",
      sqlMeetingMode: "",
      rca: "",
    }));

    /* `counted` is the proxy's answer, and it is authoritative — the roster
       override lives in the base, not in this browser. `active` carries it so
       the reference's isCounted() keeps working unchanged for a person the
       roster has never heard of. */
    const people: Record<string, Person> = {};
    for (const p of r.team) people[p.name] = { name: p.name, role: p.role, active: p.counted };

    return {
      companies, people,
      focus: r.focus || {},
      research: r.research || {},
      syncedAt: r.syncedAt,
      origin: "proxy",
    };
  }

  async contactsOf(companyId: string): Promise<Contact[]> {
    const r = await req<{ contacts?: { kid: string; pocName: string; designation: string;
                                       phones?: { cc: string; value: string }[];
                                       emails?: { value: string }[];
                                       lastCallAt?: string; stage?: string }[] }>(
      `/company?id=${encodeURIComponent(companyId)}`);
    return (r.contacts || []).map((c) => ({
      id: String(c.kid),
      companyId,
      name: c.pocName || "",
      designation: c.designation || "",
      phone: c.phones?.[0] ? `${c.phones[0].cc || ""} ${c.phones[0].value || ""}`.trim() : "",
      email: c.emails?.[0]?.value || "",
      lastCall: dayOf(c.lastCallAt),
      stage: c.stage || "",
    }));
  }

  async setFocus(companyId: string, status: FocusStatus, reason = "", note = "",
                 extra: { companyName?: string; ownerName?: string; previous?: FocusStatus } = {}) {
    await req("/focus", {
      method: "POST",
      body: JSON.stringify({ companyId, status, reason, note, ...extra }),
    });
  }

  async saveResearch(companyId: string, values: Research) {
    await req("/research", {
      method: "POST",
      body: JSON.stringify({ companyId, values }),
    });
  }

  async syncNow() {
    await req("/ladder?fresh=1");
  }
}
