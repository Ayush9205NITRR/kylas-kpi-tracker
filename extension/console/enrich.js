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
 * The BD team sizes accounts in crores, so revenue is converted on the way
 * out and shown in rupees; funding is left in dollars, which is how funding
 * is talked about anyway. ONE rate, here, named — see USD_INR.
 *
 * BANDS ARE COMPUTED, NEVER STORED. Nobody types "₹50–100 Cr" into a field:
 * the raw number is the record, the band is a function of it, and a band that
 * was typed once is a band that is wrong the day the number changes.
 */
(function (global) {
  /* The rupee value of a dollar. Apollo's figures are USD; the revenue column
     and its bands are rupees, because that is the unit the team sizes
     accounts in. Change it HERE and every column, band and count moves
     together — it is deliberately not read from anywhere, because a live rate
     would mean yesterday's screenshot and today's screen disagree for a
     reason nobody can see. */
  const USD_INR = 88;

  const CR = 1e7, LAKH = 1e5;                       /* rupees */
  const M = 1e6, B = 1e9;                           /* dollars */

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
  const REVENUE_BANDS = [                            /* rupees */
    { key: "r0", label: "<₹10 Cr",        min: 0 },
    { key: "r1", label: "₹10–50 Cr",      min: 10 * CR },
    { key: "r2", label: "₹50–100 Cr",     min: 50 * CR },
    { key: "r3", label: "₹100–500 Cr",    min: 100 * CR },
    { key: "r4", label: "₹500–1,000 Cr",  min: 500 * CR },
    { key: "r5", label: "₹1,000 Cr+",     min: 1000 * CR },
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
  function inrText(rupees) {
    if (rupees === null || rupees === undefined || !Number.isFinite(rupees)) return "";
    const a = Math.abs(rupees);
    if (a >= CR) return `₹${trim(rupees / CR, a >= 100 * CR ? 0 : 1)} Cr`;
    if (a >= LAKH) return `₹${trim(rupees / LAKH, 1)} L`;
    return `₹${trim(rupees, 0)}`;
  }
  function usdText(dollars) {
    if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return "";
    const a = Math.abs(dollars);
    if (a >= B) return `$${trim(dollars / B, 1)}B`;
    if (a >= M) return `$${trim(dollars / M, a >= 100 * M ? 0 : 1)}M`;
    if (a >= 1e3) return `$${trim(dollars / 1e3, 0)}K`;
    return `$${trim(dollars, 0)}`;
  }
  const toInr = (usd) => (usd === null || usd === undefined ? null : usd * USD_INR);

  global.Enrich = { USD_INR, num, money, toInr, inrText, usdText,
                    REVENUE_BANDS, ROUND_BANDS, UNKNOWN, bandOf, bandLabel, empBand, empFloor };
})(typeof window !== "undefined" ? window : globalThis);
