/* THE CHECK THAT WOULD HAVE CAUGHT THE PICKED-UP FAULT ON DAY ONE.
 *
 * check-kpi-data.mjs recomputes every Companies rollup from the contacts
 * underneath it and compares. This exercises it against hand-built rows — no
 * network, no base — because the cases worth testing are the ones a real base
 * is not supposed to contain.
 *
 * The fixture is the live base of 2026-09-29 in miniature: contacts that have
 * picked up, a company whose Ever Picked rollup is blank anyway (Airtable does
 * not compute MAX over checkboxes), and a Phone Picked reading 0 because it
 * was pointed at that rollup.
 *
 * Run: node scripts/test-kpi-data.mjs
 */
import { checkKpiData, KNOWN_DEAD, INVARIANTS } from "./check-kpi-data.mjs";

let pass = 0, fail = 0;
const is = (what, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const ok = (what, cond, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
};

/* A stand-in for the Airtable client: checkKpiData only ever lists. */
const client = (tables) => ({ listAll: async (t) => tables[t] || [] });

const PICKED = "2026-09-20T09:30:00.000Z";
const CALLED = "2026-09-27T11:00:00.000Z";

/* Two contacts at one company, one of whom picked up; one company with nobody
   who has. Everything derived is correct unless a case below breaks it. */
const fixture = (bend = {}) => {
  const contacts = [
    { id: "recC1", fields: { Name: "Hema", Company: ["recA"], "Ever Picked": true,
        "First Picked At": PICKED, "Last Call At": CALLED, "First Call At": PICKED,
        "Call Count": 3, "Right POC Name": "Hema", "Discovery Name": "" } },
    { id: "recC2", fields: { Name: "Shipra", Company: ["recA"],
        "Last Call At": CALLED, "First Call At": CALLED, "Call Count": 1,
        "Right POC Name": "", "Discovery Name": "" } },
    { id: "recC3", fields: { Name: "Vikas", Company: ["recB"],
        "Last Call At": CALLED, "First Call At": CALLED, "Call Count": 2,
        "Right POC Name": "", "Discovery Name": "" } },
  ];
  const companies = [
    { id: "recA", fields: { Name: "Acme", Contacts: ["recC1", "recC2"],
        "Contact Count": 2, "Call Count": 4, "Last Call At": CALLED, "First Call At": PICKED,
        "First Picked At": PICKED, "Ever Picked": 1, "Right POC Contacts": "Hema",
        Reached: 1, "Phone Picked": 1, "Right POC": 1, ...(bend.recA || {}) } },
    { id: "recB", fields: { Name: "Borax", Contacts: ["recC3"],
        "Contact Count": 1, "Call Count": 2, "Last Call At": CALLED, "First Call At": CALLED,
        Reached: 1, ...(bend.recB || {}) } },
  ];
  return { Companies: companies, Contacts: contacts };
};
const run = (bend) => checkKpiData(client(fixture(bend)), { log: () => {} });
const find = (out, name) => out.findings.find((f) => f.name === name);

console.log("1. a base that computes what it says it computes");
const good = await run();
ok("clean", good.clean, JSON.stringify(good.faults, null, 1));
is("both companies read", good.counted.Companies, 2);
is("and their contacts", good.counted.Contacts, 3);

console.log("\n2. THE LIVE FAULT: Ever Picked blank on every company");
/* Airtable returns blank for MAX over a set of checkboxes. The rollup is
   declared, the type is right, the meta API reports no aggregation at all —
   so nothing that compares the base to the schema can see this. */
const dead = await run({ recA: { "Ever Picked": undefined } });
const ep = find(dead, "Ever Picked");
ok("it is found", !!ep, "no finding for Ever Picked");
is("...as dead, not drifted", ep?.kind, "dead");
is("...on every row", ep?.checked, 2);
is("...where one should be set", ep?.wantSet, 1);
ok("...and named as a known dead rollup", !!ep?.known && ep.known === KNOWN_DEAD["Companies.Ever Picked"]);
ok("...so it does not by itself fail the check — nothing reads it", dead.clean,
  JSON.stringify(dead.faults, null, 1));

console.log("\n3. ...and what it broke: Phone Picked 0 on all 98 companies");
/* The fault that actually cost the numbers: a formula reading the dead rollup
   instead of First Picked At. Detected per row, against its own input. */
const pp = await run({ recA: { "Ever Picked": undefined, "Phone Picked": 0 } });
const inv = find(pp, "Phone Picked");
ok("it is found", !!inv, "no finding for Phone Picked");
is("...as an invariant break", inv?.kind, "invariant");
is("...against the field it is defined from", inv?.from, "First Picked At");
is("...on the one company it is wrong for", inv?.differ, 1);
ok("...and the check fails", !pp.clean);
ok("...with an example naming the company", /Acme/.test(inv?.examples?.[0] || ""), inv?.examples?.[0]);

console.log("\n4. a rollup that is wrong on some rows, not all, is drift");
/* Usually a link that never got written rather than a broken field, and it
   wants a different fix, so it is reported differently. */
const drift = await run({ recA: { "Call Count": 3 } });
const cc = find(drift, "Call Count");
is("kind", cc?.kind, "drift");
is("on one of two rows", cc?.differ, 1);
is("...while the other still agrees", cc?.checked, 2);
ok("...and it fails the check", !drift.clean);

console.log("\n5. blank and zero are the same statement");
/* Airtable omits an empty formula result rather than sending 0, so a check
   that treated the two differently would report every quiet company. */
const zero = await run({ recB: { Reached: undefined, "Phone Picked": undefined } });
ok("an omitted 0 is not a fault", !find(zero, "Phone Picked"));
/* Reached IS set on recB in the fixture, and Last Call At with it, so
   dropping it is a real break — the opposite direction of case 3. */
is("but an omitted 1 is", find(zero, "Reached")?.kind, "invariant");

console.log("\n6. name order in a joined list is not part of the answer");
const order = await run({ recA: { "Right POC Contacts": "Hema" } });
ok("one name", !find(order, "Right POC Contacts"));
const two = fixture();
two.Contacts[1].fields["Right POC Name"] = "Shipra";
two.Companies[0].fields["Right POC Contacts"] = "Shipra, Hema";
const outTwo = await checkKpiData(client(two), { log: () => {} });
ok("reversed", !find(outTwo, "Right POC Contacts"), JSON.stringify(find(outTwo, "Right POC Contacts")));

console.log("\n7. the invariants restate formulas that exist");
/* If a formula is renamed and this list is not, the check silently stops
   checking it — so every invariant must name a field the schema declares. */
const { FOLLOWUPS } = await import("./schema.mjs");
for (const i of INVARIANTS) {
  const has = (n) => FOLLOWUPS.some((f) => f.table === i.table && f.field?.name === n);
  ok(`${i.table}.${i.field} is a field in the schema`, has(i.field));
  ok(`...and so is ${i.from}`, has(i.from));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
