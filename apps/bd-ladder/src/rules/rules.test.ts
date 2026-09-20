import { describe, it, expect } from "vitest";
import { dayNumber, dayOf, kpiRank, tally, stepConversion, seededCount,
         type Company, type RungDate } from "./ladder";
import { range, label, lead, ymd } from "./periods";
import { familyOf, freshnessOf, normMode, isCounted } from "./grouping";

const D = (y: number, m: number, d: number) => dayNumber(y, m - 1, d);
const on = (n: number, source: "airtable" | "observed" | "seeded" = "airtable"): RungDate =>
  ({ on: n, source });
const co = (p: Partial<Company> & { rungs: Company["rungs"] }): Company => ({
  id: "1", name: "co", owner: "Ayush", stage: "MQL_MARKETING_QUALIFIED_LEAD",
  source: "Apollo", lastCall: null, discoveryMode: "", sqlMeetingMode: "", rca: "", ...p,
});
const none = (): Company["rungs"] => [null, null, null, null, null, null];

describe("rung dates", () => {
  it("IST, not UTC — a 9pm Delhi call stays on its own day", () => {
    /* 2026-09-18T21:30 IST is 16:00Z the same day; the trap is a timestamp
       already past midnight UTC, which naive bucketing moves to the 19th. */
    expect(dayOf("2026-09-18T18:30:00Z")).toBe(D(2026, 9, 19));  // 00:00 IST on the 19th
    expect(dayOf("2026-09-18T18:29:00Z")).toBe(D(2026, 9, 18));  // 23:59 IST on the 18th
  });
  it("is null for nothing, and for nonsense", () => {
    expect(dayOf(null)).toBeNull();
    expect(dayOf("soon")).toBeNull();
  });
  it("rank is the highest rung with a real date", () => {
    expect(kpiRank({ rungs: none() })).toBe(-1);
    const r = none(); r[0] = on(10); r[2] = on(20);
    expect(kpiRank({ rungs: r })).toBe(2);
  });
});

describe("the ladder counts movement in the window", () => {
  const r1 = none(); r1[0] = on(D(2026, 3, 4)); r1[1] = on(D(2026, 4, 2));
  const r2 = none(); r2[0] = on(D(2026, 4, 9));
  const rows = [co({ rungs: r1 }), co({ id: "2", rungs: r2 })];

  it("counts a rung only where its own date falls", () => {
    expect(tally(rows, D(2026, 4, 1), D(2026, 4, 30))).toEqual([1, 1, 0, 0, 0, 0]);
  });
  /* THE REGRESSION THE FILL-DOWN USED TO HIDE, and the reason step conversion
     is a cohort. Reached-in-March, right-POC-in-April makes April's raw counts
     read 1 and 1 — and in a month where the March company was the only one, it
     would read 0 reached above 1 right POC. */
  it("a rung crossed in an earlier period is not counted again", () => {
    expect(tally([rows[0]], D(2026, 4, 1), D(2026, 4, 30))).toEqual([0, 1, 0, 0, 0, 0]);
  });
  it("no fill-down: a lone SQL date counts once, not six times", () => {
    const r = none(); r[5] = on(D(2026, 4, 10));
    expect(tally([co({ rungs: r })], D(2026, 4, 1), D(2026, 4, 30)))
      .toEqual([0, 0, 0, 0, 0, 1]);
  });
});

describe("step conversion is a cohort", () => {
  const reachedOnly = none(); reachedOnly[0] = on(D(2026, 4, 3));
  const reachedAndOn = none(); reachedAndOn[0] = on(D(2026, 4, 5)); reachedAndOn[1] = on(D(2026, 5, 20));
  const earlier = none(); earlier[0] = on(D(2026, 3, 2)); earlier[1] = on(D(2026, 4, 4));

  const rows = [co({ rungs: reachedOnly }), co({ id: "2", rungs: reachedAndOn }),
                co({ id: "3", rungs: earlier })];

  it("asks what happened to the companies reached THIS period", () => {
    /* Two reached in April; one of them later got to the right POC. The third
       company reached the right POC in April but was reached in March, so it is
       not in April's cohort — which is exactly why the raw ratio misleads. */
    expect(stepConversion(rows, D(2026, 4, 1), D(2026, 4, 30), 1))
      .toEqual({ cohort: 2, moved: 1, pct: 50 });
  });
  it("counts the move whenever it happened, not only inside the window", () => {
    /* The move is in May. It still counts: the question is what became of the
       cohort, not what happened in April. */
    expect(stepConversion([rows[1]], D(2026, 4, 1), D(2026, 4, 30), 1).pct).toBe(100);
  });
  it("never exceeds 100%, by construction", () => {
    const { cohort, moved } = stepConversion(rows, D(2026, 4, 1), D(2026, 4, 30), 1);
    expect(moved).toBeLessThanOrEqual(cohort);
  });
  it("an empty cohort is not zero percent — it is no answer", () => {
    expect(stepConversion(rows, D(2026, 1, 1), D(2026, 1, 31), 1).pct).toBeNull();
  });
});

describe("periods", () => {
  const T = D(2026, 9, 18);           /* a Friday */
  it("a week starts on Monday", () => {
    expect(ymd(range("week", 0, T, "fy").s)).toEqual([2026, 8, 14]);
  });
  it("the FY runs April to March", () => {
    expect(label("year", 0, T, "fy")).toBe("FY27 · Apr 2026 – Mar 2027");
  });
  it("calendar quarters ARE financial quarters, because April is a boundary", () => {
    expect(label("quarter", 0, T, "fy")).toBe("Q2 FY27 · Jul–Sep");
    expect(label("quarter", 1, T, "fy")).toBe("Q3 FY27 · Oct–Dec");
    expect(label("quarter", 2, T, "fy")).toBe("Q4 FY27 · Jan–Mar");
  });
  it("leads the story sentence the way the reference does", () => {
    expect(lead("month", 0, T, "fy")).toBe("This month so far,");
    expect(lead("month", -1, T, "fy")).toBe("Last month,");
    expect(lead("month", -2, T, "fy")).toBe("In July 2026,");
  });
});

describe("grouping", () => {
  it("uses the declared table, so MQL is a conversation", () => {
    expect(familyOf("MQL_MARKETING_QUALIFIED_LEAD")).toBe("talking");
  });
  it("and the first stage is 'not touched yet', which the regexes missed", () => {
    expect(familyOf("YET_TO_BE_MINED")).toBe("new");
  });
  /* The regexes read NOT_INTERESTED as "interested" and filed a dead account
     under In conversation. The table settles it. */
  it("a closed stage is closed, not talking", () => {
    expect(familyOf("NOT_INTERESTED")).toBe("closed");
  });
  it("the new Active Requirement stages are placed", () => {
    expect(familyOf("ACTIVE_REQUIREMENT_CALL_BOOKED")).toBe("talking");
    expect(familyOf("ACTIVE_REQUIREMENT_CALL_NO_SHOW")).toBe("parked");
  });
  it("an unknown stage still lands somewhere, by the reference's rules", () => {
    expect(familyOf("Discovery Call Rescheduled")).toBe("talking");
    expect(familyOf("Totally New Thing")).toBe("other");
  });

  it("freshness buckets match the reference", () => {
    const t = D(2026, 9, 18);
    expect(freshnessOf(t, t)).toBe("fresh");
    expect(freshnessOf(t - 7, t)).toBe("fresh");
    expect(freshnessOf(t - 8, t)).toBe("warm");
    expect(freshnessOf(t - 30, t)).toBe("warm");
    expect(freshnessOf(t - 31, t)).toBe("cool");
    expect(freshnessOf(t - 91, t)).toBe("cold");
    expect(freshnessOf(null, t)).toBe("never");
  });

  it("normalises whatever was typed as a mode", () => {
    expect(normMode("Google Meet")).toBe("Virtual");
    expect(normMode("Zoom")).toBe("Virtual");
    expect(normMode("In Person")).toBe("In person");
    expect(normMode("office visit")).toBe("In person");
    expect(normMode("Calls")).toBe("On call");
    expect(normMode("WhatsApp")).toBe("Text");
    expect(normMode("carrier pigeon")).toBe("Other");
    expect(normMode("")).toBe("");
  });
  /* The reference matches "office visit", not "office", so a location typed as
     "their office, Pune" falls through to Other. Pinned rather than fixed: the
     prototype is the source of truth and widening the pattern is a decision,
     not a tidy-up. Worth revisiting once real locations are flowing. */
  it("a bare 'office' is Other — a quirk of the reference, pinned not fixed", () => {
    expect(normMode("their office, Pune")).toBe("Other");
  });

  it("counts only active BDAs", () => {
    expect(isCounted({ name: "a", role: "Business Development Associate", active: true })).toBe(true);
    expect(isCounted({ name: "b", role: "BDA", active: true })).toBe(true);
    expect(isCounted({ name: "c", role: "Business Development Associate", active: false })).toBe(false);
    expect(isCounted({ name: "d", role: "Sales Manager", active: true })).toBe(false);
    expect(isCounted(undefined)).toBe(false);
  });
});

describe("seeded rows are countable, so the banner can say how many", () => {
  it("counts a company with any inferred rung", () => {
    const a = none(); a[0] = on(1, "seeded");
    const b = none(); b[0] = on(1, "airtable");
    expect(seededCount([co({ rungs: a }), co({ id: "2", rungs: b })])).toBe(1);
  });
});
