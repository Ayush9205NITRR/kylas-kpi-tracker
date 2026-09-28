/* The enrichment numbers and their bands. The rules live once, in
 * extension/console/enrich.js, which the console loads as a script; this is
 * the same file for the Worker and the tests. */
import "../extension/console/enrich.js";

export const { USD_INR, num, money, toInr, inrText, usdText,
               REVENUE_BANDS, ROUND_BANDS, UNKNOWN, bandOf, bandLabel, empBand, empFloor } = globalThis.Enrich;
