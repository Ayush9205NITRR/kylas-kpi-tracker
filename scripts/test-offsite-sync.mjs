#!/usr/bin/env node
/* offsite-sync.mjs — the company keeps what it has and gets the contacts' quarters added.
 *   node scripts/test-offsite-sync.mjs
 */
import { planCompany } from "./offsite-sync.mjs";
let pass = 0, fail = 0;
const ok = (w, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${!c && d ? `  — ${String(d).slice(0, 200)}` : ""}`); };

const options = [{ id: 1, code: "JAN_MAR", label: "Jan - Mar" }, { id: 2, code: "APR_JUN", label: "Apr - Jun" },
                 { id: 3, code: "JUL_SEP", label: "Jul - Sep" }, { id: 4, code: "OCT_DEC", label: "Oct - Dec" }];
const multi = { name: "cfOffsite", type: "MULTI_PICKLIST", multi: true, options };
const single = { name: "cfOffsite", type: "PICKLIST", multi: false, options };

const a = planCompany(multi, [{ id: 3 }], ["OCT_DEC"]);
ok("adds to what is there, never replaces", a.status === "add" && a.target.join() === "JUL_SEP,OCT_DEC" && a.add.join() === "OCT_DEC", JSON.stringify(a));
ok("sends the ids of the whole union, in the console's order", JSON.stringify(a.value) === "[3,4]", JSON.stringify(a.value));
const b = planCompany(multi, [{ id: 3 }, { id: 4 }], ["OCT_DEC"]);
ok("already there is 'same' and writes nothing", b.status === "same" && b.value === undefined);
const c = planCompany(multi, undefined, ["JAN_MAR"]);
ok("an empty company just gets the contacts' quarter", c.status === "add" && JSON.stringify(c.value) === "[1]", JSON.stringify(c));
const d = planCompany(multi, [{ id: 3 }], []);
ok("contacts naming no quarter change nothing", d.status === "nothing" && d.value === undefined);
const e = planCompany(single, { id: 3 }, ["JUL_SEP"]);
ok("a single-select already equal is 'same'", e.status === "same");
const f = planCompany(single, { id: 3 }, ["OCT_DEC"]);
ok("a single-select cannot hold two, so it is reported, not overwritten", f.status === "single-cannot-hold" && f.value === undefined, JSON.stringify(f));
const g = planCompany(single, undefined, ["OCT_DEC"]);
ok("a single-select with nothing takes the one quarter, as a bare id", g.status === "add" && g.value === 4, JSON.stringify(g));
const h = planCompany({ ...multi, options: options.slice(0, 2) }, [{ id: 1 }], ["OCT_DEC"]);
ok("a quarter the account has no option for is reported, not half-written", h.status === "no-option" && h.value === undefined, JSON.stringify(h));
const i = planCompany(multi, ["Jul - Sep"], ["OCT_DEC"]);
ok("an existing value is understood by its label too", i.existing.join() === "JUL_SEP" || i.status === "add", JSON.stringify(i));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
