/* The funnel, ported from reference/enout-bd-ladder.html.
 *
 * Every rule here exists in that file and behaves the same way, with ONE
 * deliberate exception, recorded because a silent divergence from the
 * reference is the thing most likely to make these numbers wrong:
 *
 *   THE FILL-DOWN IS GONE. The prototype backfilled a missing lower rung with
 *   the next higher rung's date, so a company whose only date was SQL counted
 *   at all six rungs on that one day and read as 100% conversion at every
 *   step. Ayush, 2026-09-19: count only real dates. A rung with no date is not
 *   a rung that happened.
 */

export const RUNGS = [
  { name: "Companies reached", short: "Reached" },
  { name: "Right POC connected", short: "Right POC" },
  { name: "Successful discovery call", short: "Discovery" },
  { name: "SQL meeting booked", short: "SQL booked" },
  { name: "SQL meeting done", short: "SQL done" },
  { name: "SQL", short: "SQL" },
] as const;

export const KPI_LABELS = [
  "Not reached", "Reached", "Right POC", "Discovery done",
  "SQL booked", "SQL done", "SQL",
] as const;

/* A rung date, and where it came from. The prototype had no such thing — every
   date was equally trustworthy because a human had typed it into a spreadsheet.
   With the console as the source, most companies have never been worked, so
   their rungs are inferred from the stage they happen to be sitting on. That is
   a guess, it is the majority case on day one, and the screen has to be able to
   say so. */
export type RungSource = "airtable" | "observed" | "seeded";
export type RungDate = { on: DayNumber; source: RungSource } | null;

/** Days since the epoch, UTC. The whole app counts in these. */
export type DayNumber = number;

export type Company = {
  id: string;                 /* Kylas company id — the :id in the route */
  name: string;
  owner: string;
  stage: string;
  source: string;             /* cf_sourceofdata */
  lastCall: DayNumber | null;
  rungs: [RungDate, RungDate, RungDate, RungDate, RungDate, RungDate];
  discoveryMode: string;
  sqlMeetingMode: string;
  rca: string;
};

export const dayNumber = (y: number, m: number, d: number): DayNumber =>
  Math.floor(Date.UTC(y, m, d) / 864e5);

/** An ISO date or timestamp to a day number, in IST. Kylas and Airtable both
    return UTC instants; a call logged at 9pm in Delhi is the next day in UTC,
    and bucketing it there moves it into the wrong week. */
export function dayOf(iso: string | null | undefined): DayNumber | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ist = new Date(t + 5.5 * 3600_000);
  return dayNumber(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

export const today = (now = Date.now()): DayNumber => {
  const ist = new Date(now + 5.5 * 3600_000);
  return dayNumber(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
};

/** The highest rung with a real date. -1 when nothing has happened. */
export function kpiRank(c: Pick<Company, "rungs">): number {
  for (let i = 5; i >= 0; i--) if (c.rungs[i]) return i;
  return -1;
}

/** Counts per rung for one period, for the companies passed in.
    A rung counts where its date falls inside the window — the same event
    counting the prototype does, and the reason the ladder is a record of
    movement rather than a cohort. */
export function tally(companies: Company[], from: DayNumber, to: DayNumber): number[] {
  const out = [0, 0, 0, 0, 0, 0];
  for (const c of companies)
    for (let i = 0; i < 6; i++) {
      const r = c.rungs[i];
      if (r && r.on >= from && r.on <= to) out[i]++;
    }
  return out;
}

/** How many of this period's arrivals at rung i-1 have since reached rung i.
 *
 *  NOT counts[i] / counts[i-1]. Ayush, 2026-09-19 chose this: two independently
 *  windowed counts do not divide into a conversion, and their ratio can exceed
 *  100% whenever a company crossed the lower rung in an earlier period — which
 *  reads as a broken screen. This asks the question a BD lead actually asks:
 *  of the companies we reached this month, how many got to the right POC?
 *  Monotone by construction, because the numerator is a subset.
 */
export function stepConversion(
  companies: Company[], from: DayNumber, to: DayNumber, i: number,
): { cohort: number; moved: number; pct: number | null } {
  if (i < 1 || i > 5) throw new Error(`no step into rung ${i}`);
  let cohort = 0, moved = 0;
  for (const c of companies) {
    const lower = c.rungs[i - 1];
    if (!lower || lower.on < from || lower.on > to) continue;
    cohort++;
    if (c.rungs[i]) moved++;
  }
  return { cohort, moved, pct: cohort ? Math.round((moved / cohort) * 100) : null };
}

export const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0);

/** Only companies whose rungs were measured. Used for the banner count, so the
    screen can say how much of what it is showing is inferred. */
export const seededCount = (companies: Company[]): number =>
  companies.filter((c) => c.rungs.some((r) => r?.source === "seeded")).length;
