/* OFFSITE TIMELINE, DERIVED. Nobody types it: it is read out of the Timeline
 * an associate already wrote on the Past / Now event rows — "Q3", "Feb 2026",
 * "Oct–Nov", "Q4 FY27" — and turned into the quarters of the calendar year,
 * the same four buckets Kylas' "Offsite Timeline (BD - New)" field uses.
 *
 * Which rows: an offsite row ("Employee offsites", anything saying offsite)
 * and a row with no event type yet. A product launch in March says nothing
 * about when the offsite is.
 *
 * Past rows count as much as Now: an offsite held in February last year is
 * the best guess for this year's.
 *
 * Quarters: "Q1".."Q4" alone are calendar quarters, matching the buckets.
 * With "FY" anywhere in the text they are the Indian financial year, whose Q1
 * is April–June. Text that names no month or quarter ("soon", "not decided")
 * derives nothing — it is still on the card, word for word.
 *
 * ONE COPY, for both runtimes: the console loads this file as a script
 * (window.Offsite) and the Worker imports it through scripts/offsite.mjs. No
 * imports, no DOM — plain JS that runs in either.
 */
(function (global) {
  const OFFSITE_QUARTERS = ["JAN_MAR", "APR_JUN", "JUL_SEP", "OCT_DEC"];

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthAt = (w) => MONTHS.indexOf(String(w).slice(0, 3).toLowerCase());
  /* Whole month names or their short forms only — "decided", "marketing" and
     "junior" are not months. "may" only where it cannot be the verb. */
  const MONTH_RE = /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|may(?!\s+(?:be|not|have|happen|go|do|plan|take|want|come|also|or|get|need)\b))\b/g;

  function quartersOf(text) {
    const t = String(text || "").toLowerCase();
    if (!t.trim()) return [];
    const q = new Set();
    const fy = /\bfy\b|\bfy\s*\d|financial|fiscal/.test(t);
    const month = (m) => q.add(OFFSITE_QUARTERS[Math.floor(m / 3)]);
    /* Q1..Q4, calendar or financial */
    for (const [, n] of t.matchAll(/\bq\s*([1-4])\b/g)) {
      const i = Number(n) - 1;
      q.add(OFFSITE_QUARTERS[fy ? (i + 1) % 4 : i]);
    }
    /* H1 / H2 */
    for (const [, n] of t.matchAll(/\bh\s*([12])\b/g)) {
      const first = (Number(n) - 1) * 2 + (fy ? 1 : 0);
      q.add(OFFSITE_QUARTERS[first % 4]); q.add(OFFSITE_QUARTERS[(first + 1) % 4]);
    }
    /* Month names, and ranges between them: "Oct–Dec", "dec to feb". */
    const words = [...t.matchAll(MONTH_RE)];
    for (let i = 0; i < words.length; i++) {
      const a = monthAt(words[i][1]);
      month(a);
      const next = words[i + 1];
      if (next) {
        const between = t.slice(words[i].index + words[i][0].length, next.index);
        if (/^\s*(-|–|—|to|till|until|through)\s*$/.test(between)) {
          const b = monthAt(next[1]);
          for (let m = a; m !== b; m = (m + 1) % 12) month(m);
        }
      }
    }
    /* 2026-02, 02/2026, 15/02/2026 */
    for (const [, m] of t.matchAll(/\b20\d\d-(0[1-9]|1[0-2])\b/g)) month(Number(m) - 1);
    for (const [, m] of t.matchAll(/\b(?:\d{1,2}[/.-])?(0?[1-9]|1[0-2])[/.-]20\d\d\b/g)) month(Number(m) - 1);
    return OFFSITE_QUARTERS.filter((k) => q.has(k));
  }

  const isOffsiteRow = (r) => {
    const type = String(r?.eventType || "").trim().toLowerCase();
    return !type || type.includes("offsite") || type.includes("off-site");
  };

  /* Every quarter a contact's offsite rows name, Past and Now together. */
  function offsiteOf(c) {
    const q = new Set();
    for (const r of [...(c?.past || []), ...(c?.current || [])])
      if (isOffsiteRow(r)) for (const k of quartersOf(r.timeline)) q.add(k);
    return OFFSITE_QUARTERS.filter((k) => q.has(k));
  }

  const LABEL = { JAN_MAR: "Jan–Mar", APR_JUN: "Apr–Jun", JUL_SEP: "Jul–Sep", OCT_DEC: "Oct–Dec" };
  global.Offsite = { OFFSITE_QUARTERS, LABEL, quartersOf, isOffsiteRow, offsiteOf };
})(typeof window !== "undefined" ? window : globalThis);
