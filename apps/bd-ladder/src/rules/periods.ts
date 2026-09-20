/* Week / month / quarter / year, ported from reference/enout-bd-ladder.html.
   Arithmetic identical to the prototype's range() and label().

   FY quarters need no special casing: the financial year starts in April, which
   is a calendar quarter boundary, so Apr-Jun IS Q1 and Jan-Mar IS Q4 of the
   same FY. The prototype relies on that and so does this. */
import { dayNumber, type DayNumber } from "./ladder";

export type Grain = "week" | "month" | "quarter" | "year";
export type YearMode = "fy" | "cal";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_L = ["January", "February", "March", "April", "May", "June", "July",
                         "August", "September", "October", "November", "December"];

export const ymd = (n: DayNumber): [number, number, number] => {
  const d = new Date(n * 864e5);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
};
/* 0 = Sunday, matching the prototype. Weeks start on Monday. */
const dow = (n: DayNumber) => (((n + 4) % 7) + 7) % 7;

export function range(grain: Grain, off: number, today: DayNumber, fy: YearMode) {
  const [y, m] = ymd(today);
  if (grain === "week") {
    const s = today - ((dow(today) + 6) % 7) + 7 * off;
    return { s, e: s + 6 };
  }
  if (grain === "month") return { s: dayNumber(y, m + off, 1), e: dayNumber(y, m + off + 1, 1) - 1 };
  if (grain === "quarter") {
    const qm = m - (m % 3) + 3 * off;
    return { s: dayNumber(y, qm, 1), e: dayNumber(y, qm + 3, 1) - 1 };
  }
  if (fy === "fy") {
    const sy = (m >= 3 ? y : y - 1) + off;
    return { s: dayNumber(sy, 3, 1), e: dayNumber(sy + 1, 3, 1) - 1 };
  }
  return { s: dayNumber(y + off, 0, 1), e: dayNumber(y + off + 1, 0, 1) - 1 };
}

export function label(grain: Grain, off: number, today: DayNumber, fy: YearMode): string {
  const { s, e } = range(grain, off, today, fy);
  const [sy, sm, sd] = ymd(s);
  const [ey, em, ed] = ymd(e);
  const thisYear = ymd(today)[0];
  if (grain === "week")
    return `${sd} ${MONTHS[sm]} – ${ed} ${MONTHS[em]}${ey !== thisYear ? " " + ey : ""}`;
  if (grain === "month") return `${MONTHS_L[sm]} ${sy}`;
  if (grain === "quarter") {
    if (fy === "fy") {
      const q = ((sm - 3 + 12) % 12) / 3 + 1;
      const year = sm >= 3 ? sy + 1 : sy;
      return `Q${q} FY${String(year).slice(2)} · ${MONTHS[sm]}–${MONTHS[em]}`;
    }
    return `Q${sm / 3 + 1} ${sy} · ${MONTHS[sm]}–${MONTHS[em]}`;
  }
  if (fy === "fy") return `FY${String(ey).slice(2)} · Apr ${sy} – Mar ${ey}`;
  return String(sy);
}

/** "This month so far," / "Last week," — the opening of every story sentence. */
export function lead(grain: Grain, off: number, today: DayNumber, fy: YearMode): string {
  if (off === 0) return `This ${grain} so far,`;
  if (off === -1) return `Last ${grain},`;
  if (grain === "month") return `In ${label(grain, off, today, fy)},`;
  if (grain === "week") return `In the week of ${label(grain, off, today, fy).split(" – ")[0]},`;
  return `In ${label(grain, off, today, fy).split(" · ")[0]},`;
}

export const fmtDay = (n: DayNumber, today: DayNumber): string => {
  const [y, m, d] = ymd(n);
  return `${d} ${MONTHS[m]}${y !== ymd(today)[0] ? " " + y : ""}`;
};
