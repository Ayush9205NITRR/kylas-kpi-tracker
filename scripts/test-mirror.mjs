#!/usr/bin/env node
/* Does the D1 copy of Airtable answer reads correctly, and stay correct?
 *
 *   node scripts/test-mirror.mjs
 *
 * Real SQL over real SQLite (d1-fake.mjs), a mock Airtable that rate-limits and
 * tracks modification times, and TWO mirror instances over one database — the
 * shape of two Cloudflare isolates. What matters is not that it is fast (it is
 * a Map), but that it never serves something Airtable would not: a write one
 * instance made and the other cannot see, a row deleted that lives on, a
 * rebuild that is seen half-finished.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createAirtable, readCompany, readQueue, readTeam } from "./airtable.mjs";
import { createMirror, mirrored, simpleFilter, MIRROR_TABLES } from "./mirror.mjs";
import { fakeD1 } from "./d1-fake.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9911;
const API = `http://127.0.0.1:${PORT}`;

/* A small base with every table the copy holds, and one it does not — plus a
   contact that lacks a field the copy asks for, so the build has to drop it. */
const SEED = "/tmp/test-mirror-seed.json";
const seed = {
  Companies: [
    { "Kylas Company ID": "100", Name: "Acme", Owner: "Asha", "Kylas Owner ID": "7", "KPI Rank": 3 },
    { "Kylas Company ID": "200", Name: "Globex", Owner: "Ravi", "Kylas Owner ID": "8", "KPI Rank": 1 },
  ],
  Contacts: Array.from({ length: 130 }, (_, i) => ({
    "Kylas Contact ID": String(1000 + i), Name: `Person ${i}`, Owner: i % 2 ? "Asha" : "Ravi",
    "Current Stage": "CNC", "KPI Rank": 1, "Company Kylas ID": i < 5 ? "100" : "200",
  })),
  "Event Rows": [{ "Row Key": "r1", Period: "Current", "Event Type": "Offsite", Budget: "8L" }],
  "Call Log": [{ "Called At": "2026-09-20T10:00:00.000Z", Owner: "Asha", Outcome: "Connected" }],
  "Call Rollup": [{ Day: "2026-08-01", Owner: "Asha", Outcome: "Connected", Calls: 4 }],
  "Stage Transitions": [{ "Changed At": "2026-09-20T10:00:00.000Z", Owner: "Asha", "To Stage": "CNC" }],
  Team: [{ Name: "Asha", Role: "BDA", "In Funnel": true }],
  Focus: [{ "Kylas Company ID": "100", Status: "focus" }],
  Research: [{ "Kylas Company ID": "100", Industry: "Pharma" }],
  "Daily Snapshot": [{ Date: "2026-09-20", Owner: "Asha", Dials: 10 }],
};
writeFileSync(SEED, JSON.stringify(seed));

const mock = spawn("node", ["scripts/mock-airtable.mjs"], {
  cwd: REPO, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), MOCK_AIRTABLE_SEED: SEED, MOCK_AIRTABLE_404: "RCA" },
});
const done = () => { try { mock.kill("SIGKILL"); } catch {} };
process.on("exit", done);
for (let i = 0; ; i++) {
  try { await fetch(`${API}/__reads`, { headers: { Authorization: "Bearer x" } }); break; }
  catch { if (i > 40) throw new Error("mock never came up"); await sleep(200); }
}
const reads = async () => {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/__reads`, { headers: { Authorization: "Bearer x" } });
    if (r.ok) return (await r.json()).reads;
    await sleep(250);
  }
  throw new Error("no read count");
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const lines = [];
const log = (...a) => lines.push(a.join(" "));
const db = fakeD1();
/* Two instances. checkMs 0 so "within a second or two" is "now" here. */
const A = createMirror({ db, log, checkMs: 0 });
const B = createMirror({ db, log, checkMs: 0 });
const client = (m) => createAirtable("pat", "appT", { apiUrl: API, gap: 0, log, onWrite: m ? m.written : null });
const rawA = client(A), rawB = client(B);
const atA = mirrored(rawA, A), atB = mirrored(rawB, B);
/* Somebody editing the base by hand: writes that tell nobody. */
const outsider = client(null);
const settle = () => Promise.all([...A.pending(), ...B.pending()]);

console.log("\n1. before anything is built, reads go to Airtable");
let r0 = await reads();
const early = await atA.listAll("Contacts", { fields: ["Name", "Owner"] });
check("an unbuilt table still answers", early.length === 130, `${early.length} rows`);
check("…from Airtable", (await reads()) > r0);
/* But not page after page: until the copy exists, a request may read only a
   few pages of a table directly. Past that it says the copy is coming rather
   than making a hundred requests in one Cloudflare invocation. */
const tight = mirrored(rawA, A, { directPages: 1 });
let refused = null;
try { await tight.listAll("Contacts", { fields: ["Name"] }); } catch (e) { refused = e; }
check("a big unbuilt table is refused with 'still copying', not read page by page",
      refused?.status === 503 && refused?.building === true, refused?.message?.slice(0, 70));
check("a small one is still read directly", (await tight.listAll("Team", { fields: ["Name"] })).length === 1);

console.log("\n2. the scheduled job builds every table");
const built = await A.maintain(rawA);
const status = await A.status();
check("every mirrored table is built", status.every((s) => s.built), JSON.stringify(status.filter((s) => !s.built)));
check("with the right number of rows", status.find((s) => s.table === "Contacts").rows === 130);
check("a table the base does not have is built empty, not an error",
      built.find((b) => b.table === "RCA")?.rows === 0, JSON.stringify(built.find((b) => b.table === "RCA")));
check("a field the base lacks is dropped and said so, not fatal",
      lines.some((l) => /has no field/.test(l)), lines.filter((l) => /has no field/.test(l)).slice(0, 1).join(""));

console.log("\n3. reads come from the copy");
r0 = await reads();
const viaA = await atA.listAll("Contacts", { fields: ["Kylas Contact ID", "Name", "Owner"] });
const viaB = await atB.listAll("Contacts", { fields: ["Kylas Contact ID", "Name", "Owner"] });
check("instance A reads all 130 with no Airtable request", viaA.length === 130 && (await reads()) === r0);
check("instance B — a cold one — reads the same, still none", viaB.length === 130 && (await reads()) === r0);
const direct = await outsider.listAll("Contacts", { fields: ["Kylas Contact ID", "Name", "Owner"] });
const key = (l) => JSON.stringify(l.map((r) => [r.id, r.fields]));
check("and exactly what Airtable holds, in Airtable's order", key(viaA) === key(direct));
check("a projection returns only the fields asked for",
      viaA.every((r) => Object.keys(r.fields).every((f) => ["Kylas Contact ID", "Name", "Owner"].includes(f))));
r0 = await reads();
const acme = await readCompany(atB, "100");
check("a company card is served from the copy, by the {Field} = 'x' filter",
      acme?.contacts?.length === 5 && (await reads()) === r0, `${acme?.contacts?.length} contacts, ${(await reads()) - r0} reads`);
const q = await readQueue(atB, "Asha");
check("the queue too", q.length === 65 && (await reads()) === r0, `${q.length}`);
check("a table it does not hold still goes to Airtable",
      (await atA.listAll("Daily Snapshot", { fields: ["Date"] })).length === 1 && (await reads()) > r0);

console.log("\n4. a write through one instance is seen by the other");
const stampBefore = await B.stamp(["Contacts"]);
const made = await rawA.upsert("Contacts", "Kylas Contact ID",
  { "Kylas Contact ID": "9999", Name: "New Person", Owner: "Asha" });
const seenA = (await atA.listAll("Contacts", { fields: ["Name"] })).some((r) => r.id === made.id);
check("the writer sees it at once, before D1 has it", seenA);
await settle();
r0 = await reads();
const seenB = (await atB.listAll("Contacts", { fields: ["Name"] })).find((r) => r.id === made.id);
check("the other instance sees it, with no Airtable read", seenB?.fields?.Name === "New Person" && (await reads()) === r0);
check("and the version it keys results on has moved", (await B.stamp(["Contacts"])) !== stampBefore);
await rawA.call("PATCH", "/Contacts", { records: [{ id: made.id, fields: { Name: "Renamed" } }] });
await settle();
check("an update travels the same way",
      (await atB.listAll("Contacts", { fields: ["Name"] })).find((r) => r.id === made.id)?.fields.Name === "Renamed");
await rawA.remove("Contacts", [made.id]);
await settle();
check("a delete removes it from both",
      !(await atA.listAll("Contacts", { fields: ["Name"] })).some((r) => r.id === made.id) &&
      !(await atB.listAll("Contacts", { fields: ["Name"] })).some((r) => r.id === made.id));

console.log("\n5. edits made outside this server");
const victim = direct[0];
await outsider.call("PATCH", "/Contacts", { records: [{ id: victim.id, fields: { Name: "Edited By Hand" } }] });
const stillOld = (await atA.listAll("Contacts", { fields: ["Name"] })).find((r) => r.id === victim.id);
check("are not seen until the next delta (by design)", stillOld.fields.Name !== "Edited By Hand");
r0 = await reads();
const d = await A.maintain(rawA, { deltaEveryMs: 0 });
const deltaReads = (await reads()) - r0;
check("the delta finds it", (await atB.listAll("Contacts", { fields: ["Name"] }))
      .find((r) => r.id === victim.id)?.fields.Name === "Edited By Hand", JSON.stringify(d.find((x) => x.table === "Contacts")));
check("and costs one request per table, not a crawl", deltaReads <= Object.keys(MIRROR_TABLES).length,
      `${deltaReads} requests for ${Object.keys(MIRROR_TABLES).length} tables`);
const idle = await A.maintain(rawA);
check("inside the interval it asks Airtable nothing", idle.length === 0, JSON.stringify(idle));

console.log("\n6. what only a rebuild can see");
await outsider.remove("Contacts", [victim.id]);
await A.maintain(rawA, { deltaEveryMs: 0 });
check("a row deleted by hand survives a delta (Airtable reports no deletions)",
      (await atB.listAll("Contacts", { fields: ["Name"] })).some((r) => r.id === victim.id));
const genBefore = (await A.status()).find((s) => s.table === "Contacts").version;
await A.maintain(rawA, { rebuild: true, only: ["Contacts"] });
check("and is gone after the rebuild",
      !(await atB.listAll("Contacts", { fields: ["Name"] })).some((r) => r.id === victim.id));
check("which swapped in a new generation", (await A.status()).find((s) => s.table === "Contacts").version !== genBefore);
const rows = await db.prepare("SELECT COUNT(*) AS n FROM mirror_rows WHERE tbl = 'Contacts'").first();
check("and cleared the old one out of D1", rows.n === 129, `${rows.n} rows held`);

console.log("\n7. formulas and rollups, read back after a save");
const acmeRec = direct.find((r) => r.fields["Kylas Contact ID"] === "1001");
await outsider.call("PATCH", "/Companies", { records: [{ id: (await outsider.listAll("Companies",
  { fields: ["Kylas Company ID"] })).find((r) => r.fields["Kylas Company ID"] === "100").id,
  fields: { "KPI Rank": 9 } }] });
const coRec = (await atA.listAll("Companies", { fields: ["Kylas Company ID", "KPI Rank"] }))
  .find((r) => r.fields["Kylas Company ID"] === "100");
await A.refetch(rawA, "Companies", [coRec.id]);
await settle();
check("a refetched record replaces the copy (how a save picks up rollups)",
      (await atB.listAll("Companies", { fields: ["Kylas Company ID", "KPI Rank"] }))
        .find((r) => r.id === coRec.id)?.fields["KPI Rank"] === 9);
check("readTeam, which goes through listTolerant, is served too", (await readTeam(atB)).length === 1);
void acmeRec;

console.log("\n8. the filter the copy will and will not answer");
check("{Field} = 'value'", !!simpleFilter("{Company Kylas ID} = '100'"));
check("an escaped quote", simpleFilter("{Name} = 'O\\'Brien'")?.test({ Name: "O'Brien" }) === true);
check("anything else is left to Airtable", simpleFilter("AND({A}='1',{B}='2')") === null &&
      simpleFilter("IS_AFTER({Date}, '2026-01-01')") === null);

console.log("\n9. only one builder at a time");
const [b1, b2] = await Promise.all([A.build(rawA, "Team"), B.build(rawB, "Team")]);
check("a second build of the same table stands aside", [b1, b2].filter((b) => b.skipped).length === 1,
      JSON.stringify([b1, b2]));

console.log(`\n${pass} passed, ${fail} failed`);
done();
process.exit(fail ? 1 : 0);
