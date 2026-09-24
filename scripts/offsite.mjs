/* Offsite Timeline, derived from the Past / Now event rows. The rules live
 * once, in extension/console/offsite.js, which the console loads as a script;
 * this is the same file for the Worker and the tests. */
import "../extension/console/offsite.js";

export const { OFFSITE_QUARTERS, LABEL: OFFSITE_LABEL, quartersOf, isOffsiteRow, offsiteOf } = globalThis.Offsite;
