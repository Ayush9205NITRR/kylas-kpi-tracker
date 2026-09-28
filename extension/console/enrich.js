/* THE ENRICHMENT NUMBERS, AND THE BANDS COMPUTED FROM THEM.
 *
 * Revenue, employees, funding and the priority score come from the team's
 * Company Database (Company List), which is fed by Apollo. This file is the
 * one place that says what those values mean, so the server, the console's
 * columns and the console's filters cannot disagree about whether a company
 * is a ₹100 Cr account.
 *
 * WHAT APOLLO ACTUALLY GIVES US. `annual_revenue`, `total_funding` and the
 * latest round amount arrive as plain integers in **US dollars** — Apollo
 * stores one number and a printed form beside it ("100M"), and the number is
 * always USD whatever country the company is in. So 22500000 is $22.5M, not
 * ₹2.25 Cr, and reading it as rupees would put every Indian account about
 * eighty-five times too low.
 *
 * SHOWN IN DOLLARS, AS IT IS STORED (Ayush, 2026-09-28). An earlier build
 * converted revenue to rupees at a fixed rate so the bands could be written
 * in crores. It is gone: a rate baked into the code is wrong the week after
 * it is written, and two people reading the same account on different builds
 * would have seen different numbers for it. Nothing is converted now, so
 * nothing can drift — the screen shows what the record holds.
 *
 * BANDS ARE COMPUTED, NEVER STORED. Nobody types "$10–50M" into a field: the
 * raw number is the record, the band is a function of it, and a band that was
 * typed once is a band that is wrong the day the number changes.
 */
(function (global) {
  const M = 1e6, B = 1e9;                           /* dollars */
  const CR = 1e7, LAKH = 1e5;                       /* rupees — parsing only, see num() */

  /* Suffixes, longest first so "crore" is not read as "c" then "rore". */
  const UNITS = [
    [/^(crores?|cr)\b/i, CR], [/^(lakhs?|lacs?|l)\b/i, LAKH],
    [/^(billions?|bn|b)\b/i, B], [/^(millions?|mn|m)\b/i, M],
    [/^(thousands?|k)\b/i, 1e3], [/^(trillions?|tn|t)\b/i, 1e12],
  ];
  const BLANK = /^(n\/?a|na|nil|none|unknown|-|—|null|undefined|\?)$/i;

  /* Tolerant on purpose. Every one of these shapes is in the live data or was
     in it at some point: "₹4.2 Cr", "1,23,456" (Indian grouping), "$100.0M",
     "12L", "5,000+", " 8500000 ", "", "N/A", and a lookup that arrives as a
     one-element array. Anything that does not parse comes back null, which
     the filters show as Unknown — it never throws, because one odd cell must
     not take a screen of 6,000 rows down with it. */
  function num(v) {
    if (Array.isArray(v)) { for (const x of v) { const n = num(x); if (n !== null) return n; } return null; }
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "object") return num(v.value ?? v.name ?? "");
    let s = String(v).trim();
    if (!s || BLANK.test(s)) return null;
    /* Currency marks, spaces and a trailing "more than" are noise here. */
    s = s.replace(/^(rs\.?|inr|usd|₹|\$)\s*/i, "").replace(/\+$/, "").trim();
    const m = s.match(/^-?[\d,]*\.?\d+/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    const rest = s.slice(m[0].length).trim();
    for (const [re, mult] of UNITS) if (re.test(rest)) return n * mult;
    return n;
  }

  /* A money field where zero means "we do not know", not "zero rupees".
     Apollo writes 0 into Latest Funding Amount for a company it has no round
     for, and a column of ₹0 reads as a fact when it is an absence. */
  const money = (v) => { const n = num(v); return n ? n : null; };

  /* ── bands ──────────────────────────────────────────────────────────
     Each is { key, label, min } with min in the field's own unit, read as
     "at least this". Ordered small to large; `bandOf` walks from the top. */
  /* Six bands, in dollars, on the round numbers people actually say. The
     original spec wrote these in crores; at any plausible rate those edges
     land on figures like "$5.7M", which is not a band anybody asks for. */
  const REVENUE_BANDS = [                            /* dollars */
    { key: "r0", label: "<$1M",        min: 0 },
    { key: "r1", label: "$1–10M",      min: 1 * M },
    { key: "r2", label: "$10–50M",     min: 10 * M },
    { key: "r3", label: "$50–100M",    min: 50 * M },
    { key: "r4", label: "$100M–1B",    min: 100 * M },
    { key: "r5", label: "$1B+",        min: 1 * B },
  ];
  const ROUND_BANDS = [                              /* dollars */
    { key: "f0", label: "<$1M",      min: 0 },
    { key: "f1", label: "$1–10M",    min: 1 * M },
    { key: "f2", label: "$10–50M",   min: 10 * M },
    { key: "f3", label: "$50–100M",  min: 50 * M },
    { key: "f4", label: "$100M+",    min: 100 * M },
  ];
  const UNKNOWN = "unknown";

  function bandOf(bands, n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
    for (let i = bands.length - 1; i >= 0; i--) if (n >= bands[i].min) return bands[i].key;
    return UNKNOWN;
  }
  const bandLabel = (bands, key) =>
    key === UNKNOWN ? "Unknown" : (bands.find((b) => b.key === key)?.label || key);

  /* EMPLOYEES COMES BANDED ALREADY. The Company List holds "51-200",
     "1001-5000", "10000+" — Apollo's own buckets, not a count — so there is
     no number here to band. The chips are those buckets as they are, ordered
     by where each one starts rather than alphabetically ("10000+" sorts
     before "51-200" as text, which is how that row first came out backwards). */
  function empBand(v) {
    const s = String(Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
    if (!s || BLANK.test(s)) return UNKNOWN;
    return s;
  }
  const empFloor = (key) => (key === UNKNOWN ? Infinity : (num(key.split(/[-–]/)[0]) ?? Infinity));

  /* ── how a number is written ────────────────────────────────────────
     Short enough to sit in a table cell, and never more precision than the
     estimate behind it deserves: Apollo's revenue is a guess to one or two
     significant figures, so "₹323 Cr" and not "₹322.78 Cr". */
  const trim = (n, dp) => Number(n.toFixed(dp)).toLocaleString("en-IN");
  function usdText(dollars) {
    if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return "";
    const a = Math.abs(dollars);
    if (a >= B) return `$${trim(dollars / B, 1)}B`;
    if (a >= M) return `$${trim(dollars / M, a >= 100 * M ? 0 : 1)}M`;
    if (a >= 1e3) return `$${trim(dollars / 1e3, 0)}K`;
    return `$${trim(dollars, 0)}`;
  }
  global.Enrich = { num, money, usdText,
                    REVENUE_BANDS, ROUND_BANDS, UNKNOWN, bandOf, bandLabel, empBand, empFloor };
})(typeof window !== "undefined" ? window : globalThis);
