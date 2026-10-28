#!/usr/bin/env node
/* open-accounts.mjs — a picked account stays open until SQL.   node scripts/test-open-accounts.mjs */
import { needOf, openOf } from "./open-accounts.mjs";
import { accountProgress } from "./progress.mjs";
let pass = 0, fail = 0;
const ok = (w, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${!c && d ? `  — ${d}` : ""}`); };
const P = (o) => ({ rung: 0, calls: 1, dialCalls: 0, contacts: 1, exited: 0, right: false, discovery: false, done: false, ...o });
ok("never called is not open", needOf(P({ calls: 0 })) === null);
ok("called by the Kylas dialler only still counts as picked", needOf(P({ calls: 0, dialCalls: 2 })) === "right");
ok("called, no Right POC → needs Right POC", needOf(P({ rung: 6 })) === "right");
ok("Right POC → needs discovery", needOf(P({ right: true, rung: 13 })) === "discovery");
ok("successful discovery → needs SQL", needOf(P({ right: true, discovery: true })) === "sql");
ok("an SQL meeting booked with no data row still needs SQL", needOf(P({ rung: 23 })) === "sql");
ok("SQL reached → not open", needOf(P({ rung: 26 })) === null && needOf(P({ done: true })) === null);
ok("every contact closed → not open", needOf(P({ contacts: 2, exited: 2 })) === null);
ok("one of two closed is still open", needOf(P({ contacts: 2, exited: 1 })) === "right");
const o = openOf(P({ calls: 1, dialCalls: 1, firstCallAt: "2026-10-10T05:00:00Z", dialFirstAt: "2026-10-08T05:00:00Z",
                     lastCallAt: "2026-10-20T05:00:00Z", dialLastAt: "2026-10-22T05:00:00Z" }));
ok("first and last call take both sources", o.firstCallAt.startsWith("2026-10-08") && o.lastCallAt.startsWith("2026-10-22") && o.calls === 2, JSON.stringify(o));
/* end to end through accountProgress: Has Signal / Has Complete Row */
const companies = [{ id: "c1", fields: { "Kylas Company ID": "1" } }, { id: "c2", fields: { "Kylas Company ID": "2" } }];
const contacts = [{ id: "p1", fields: { Company: ["c1"], "Current Stage": "CONNECT_LATER", "Has Signal": 1 } },
                  { id: "p2", fields: { Company: ["c2"], "Current Stage": "CNC_COULD_NOT_CONNECT" } }];
const calls = [{ fields: { Contact: ["p1"], "Called At": "2026-10-20T05:00:00Z" } }, { fields: { Contact: ["p2"], "Called At": "2026-10-21T05:00:00Z" } }];
const { byCompany } = accountProgress({ companies, contacts, calls, today: "2026-10-28" });
ok("progress reads Has Signal into right", needOf(byCompany.get("1")) === "discovery" && needOf(byCompany.get("2")) === "right",
   `${needOf(byCompany.get("1"))} ${needOf(byCompany.get("2"))}`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
