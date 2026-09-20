/* Families, freshness, modes and who counts — from the prototype, with the
   stage table the repo already generates taking over where it can. */
import stages from "../../../../docs/stages.json";
import type { DayNumber } from "./ladder";

/* ── families ──────────────────────────────────────────────────────────
   The prototype guessed the group from the stage NAME with regular
   expressions, and on the real 26 stages that misses: six of them land in
   "Other stages — not grouped yet", MQL among them, and "Not touched yet"
   catches nothing at all. Worse, run against stage CODES rather than labels,
   /interested/ matches NOT_INTERESTED and files a dead account under
   "In conversation".

   docs/stages.json now carries the mapping explicitly, so a known stage is
   looked up rather than pattern-matched. The regexes stay as the fallback for
   a stage Kylas has but the table does not — a new stage should land somewhere
   sensible on the day it appears, not wait for a deploy. */
export const FAMILIES = (stages.families as Family[]).map(({ key, label, hint }) => ({ key, label, hint }));

type Family = { key: string; label: string; hint: string; stages: string[] };

const FAMILY_OF: Record<string, string> = Object.fromEntries(
  (stages.families as Family[]).flatMap((f) => f.stages.map((code) => [code, f.key])),
);
const LABEL_OF: Record<string, string> = Object.fromEntries(
  (stages.stages as { code: string; label: string }[]).map((s) => [s.code, s.label]),
);

const FAM_RULES: [string, RegExp][] = [
  ["closed", /not interested|not relevant|lost|budget|in-?house|exit|dead|junk|invalid|dnd|disqualif/i],
  ["parked", /holding|delay|no.?show|low value|later|nurture|future|on hold/i],
  ["talking", /right poc|discovery|awaiting|to be sql|interested|follow/i],
  ["qualified", /sql|proposal|negotiat|won|active pipeline/i],
  ["trying", /cnc|not connected|call ?back|wrong|gatekeeper|busy|no answer|ringing|switched off|not reachable|voicemail/i],
  ["new", /^new$|untouched|not contacted|fresh/i],
];

export function familyOf(stage: string): string {
  if (FAMILY_OF[stage]) return FAMILY_OF[stage];
  /* Unknown stage: fall back to the reference's rules, and match on the LABEL,
     never the code — that is what they were written against. */
  const hay = LABEL_OF[stage] || stage || "";
  for (const [key, re] of FAM_RULES) if (re.test(hay)) return key;
  return "other";
}

export const stageLabel = (code: string): string => LABEL_OF[code] || code;

/* ── freshness ─────────────────────────────────────────────────────────── */
export const FRESH = [
  { k: "fresh", label: "Called ≤ 7 days", cls: "f-fresh" },
  { k: "warm", label: "8–30 days", cls: "f-warm" },
  { k: "cool", label: "31–90 days", cls: "f-cool" },
  { k: "cold", label: "90+ days", cls: "f-cold" },
  { k: "never", label: "Never called", cls: "f-never" },
] as const;
export type Freshness = (typeof FRESH)[number]["k"];

export function freshnessOf(lastCall: DayNumber | null, today: DayNumber): Freshness {
  if (lastCall == null) return "never";
  const age = today - lastCall;
  return age <= 7 ? "fresh" : age <= 30 ? "warm" : age <= 90 ? "cool" : "cold";
}

/* ── mode of meeting ───────────────────────────────────────────────────
   Airtable stores one of four exact strings, but this also has to cope with
   whatever a human typed into a meeting location, so the prototype's
   normaliser is kept whole. */
export const MODES = ["In person", "Virtual", "On call", "Text"] as const;

export function normMode(v: string | null | undefined): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/person|physical|f2f|offline|office visit|in-person/i.test(s)) return "In person";
  if (/virtual|zoom|meet|teams|video|online/i.test(s)) return "Virtual";
  if (/call|phone|tele/i.test(s)) return "On call";
  if (/text|whatsapp|email|chat|sms|mail/i.test(s)) return "Text";
  return "Other";
}

/* ── who the funnel counts ─────────────────────────────────────────────
   Active, and a role naming a Business Development Associate. Everything on
   the dashboard is scoped to these people. */
const BDA_RE = /business development associate|\bbda\b/i;

export type Person = { name: string; role: string; active: boolean };

export const isCounted = (p: Person | undefined): boolean =>
  !!(p && p.active && BDA_RE.test(p.role || ""));
