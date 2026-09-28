/* The tolerant number parser and the bands computed from it.
 *
 * Every string below is a shape the live Company List holds, or held once.
 * The parser is the only thing standing between "a cell somebody typed by
 * hand" and a screen of 6,000 rows, so the cases that must NOT throw matter
 * as much as the ones that must parse. */
import { num, money, usdText, bandOf, bandLabel, empBand, empFloor,
         REVENUE_BANDS, ROUND_BANDS, UNKNOWN } from "./enrich.mjs";

let pass = 0, fail = 0;
const is = (what, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log("1. the tolerant parser");
is("a plain integer", num(8500000), 8500000);
is("a number, not a string", num(22500000), 22500000);
is("a decimal", num("4.2"), 4.2);
is("indian grouping", num("1,23,456"), 123456);
is("western grouping", num("1,234,567"), 1234567);
is("rupees and crore", num("₹4.2 Cr"), 4.2e7);
is("rupees spelled out", num("Rs. 40 lakh"), 40e5);
is("a bare lakh suffix", num("12L"), 12e5);
is("dollars and millions", num("$100.0M"), 100e6);
is("dollars and billions", num("$1.3B"), 1.3e9);
is("a trailing plus", num("5,000+"), 5000);
is("surrounding space", num("  8500000  "), 8500000);
is("a one-element lookup", num([76033000]), 76033000);
is("a select object", num({ name: "12" }), 12);
is("crore, spelled out", num("2 crores"), 2e7);

console.log("\n2. what does not parse is Unknown, never a crash");
for (const v of ["", "   ", "N/A", "n/a", "NA", "nil", "none", "unknown", "-", "—", null, undefined,
                 {}, [], "abc", "TBD", NaN, Infinity])
  is(`${JSON.stringify(v) ?? String(v)} is null`, num(v), null);

console.log("\n3. zero in a money field means we do not know");
is("money(0) is null", money(0), null);
is("num(0) is still 0", num(0), 0);
is("money of a real amount", money(8305000), 8305000);

console.log("\n4. revenue bands, in dollars, exactly as stored");
const revBand = (usd) => bandOf(REVENUE_BANDS, usd);
/* Nothing is converted. An earlier build turned these into rupees at a fixed
   rate; the rate is gone, so a figure here must land on the band its own
   number says and on no other. */
is("$22.5M is $10–50M", revBand(22500000), "r2");
is("$1.089B is $1B+", revBand(1089000000), "r5");
is("$1M is exactly the bottom of $1–10M", revBand(1e6), "r1");
is("$999,999 is under $1M", revBand(999999), "r0");
is("$76M is $50–100M", revBand(76033000), "r3");
is("$184M is $100M–1B", revBand(184000000), "r4");
is("$100k is <$1M", revBand(1e5), "r0");
is("nothing is Unknown", revBand(null), UNKNOWN);
is("a band's name", bandLabel(REVENUE_BANDS, "r2"), "$10–50M");
is("Unknown has a name too", bandLabel(REVENUE_BANDS, UNKNOWN), "Unknown");

console.log("\n5. latest round bands, in dollars");
is("$8.3M is $1–10M", bandOf(ROUND_BANDS, 8305000), "f1");
is("$100M is $100M+", bandOf(ROUND_BANDS, 100e6), "f4");
is("$500k is <$1M", bandOf(ROUND_BANDS, 5e5), "f0");
is("a round Apollo does not have", bandOf(ROUND_BANDS, money(0)), UNKNOWN);

console.log("\n6. employees arrive banded already");
is("a source band is kept as it is", empBand("51-200"), "51-200");
is("the open-ended top", empBand("10000+"), "10000+");
is("blank is Unknown", empBand(""), UNKNOWN);
is("a lookup array", empBand(["201-500"]), "201-500");
/* "10000+" sorts before "51-200" as text; the row came out backwards once. */
const order = ["10000+", "51-200", "1001-5000", "1-10"].sort((a, b) => empFloor(a) - empFloor(b));
is("ordered by where the band starts", order.join(" "), "1-10 51-200 1001-5000 10000+");
is("Unknown sorts last", empFloor(UNKNOWN), Infinity);

console.log("\n7. how a number is written");
is("billions", usdText(1.3e9), "$1.3B");
is("hundreds of millions lose the decimal", usdText(100e6), "$100M");
is("tens of millions keep one", usdText(8.3e6), "$8.3M");
is("thousands", usdText(500000), "$500K");
is("nothing is written as nothing", usdText(null), "");
/* The parser still understands rupees, because a hand-typed cell in Company
   List may well say "₹4.2 Cr" — it is only the OUTPUT that is dollars now. */
is("a rupee figure still parses", num("₹4.2 Cr"), 4.2e7);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
