#!/usr/bin/env node
/* LINK CONTACTS THAT WERE SAVED WITHOUT THEIR COMPANY.
 *
 * Ayush, 2026-11-03: curebay's Anshika Mahapatra was saved by Muskan on
 * 22 Oct, yet the account read "Not worked · last call 208d ago". The Contacts
 * row had the call (Call Count 1) but no Company link, so the account's
 * rollups never saw it. The save path now fills the company from Kylas when
 * the card had none (handlers.mjs, airtableLeg); this repairs the rows written
 * before that.
 *
 *   node --env-file=.env.local scripts/link-orphan-contacts.mjs           # dry run
 *   node --env-file=.env.local scripts/link-orphan-contacts.mjs --apply
 *   … --apply --all     every unlinked contact, not only the worked ones
 *
 * For every Contacts row with a Kylas id and no Company: read the contact in
 * Kylas, take its company, upsert that company (by Kylas Company ID) and link
 * the contact to it. A contact Kylas has no company for is listed, not touched.
 */
import { pathToFileURL } from "node:url";
import { createAirtable, listTolerant, upsertTolerant } from "./airtable.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (v) => (v && typeof v === "object" ? (v.id ?? v.value) : v);

export async function run({ env = process.env, log = console.log, apply = false, all = false } = {}) {
  const KEY = env.KYLAS_KEY, BASE = env.KYLAS_BASE || "https://api.kylas.io";
  if (!KEY) throw new Error("Set KYLAS_KEY.");
  if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE) throw new Error("Set AIRTABLE_PAT and AIRTABLE_BASE.");
  const at = createAirtable(env.AIRTABLE_PAT, env.AIRTABLE_BASE, {
    log: () => {}, ...(env.AIRTABLE_BASE_URL ? { apiUrl: env.AIRTABLE_BASE_URL } : {}) });
  /* Retried: a rate limit, a Kylas 5xx and a dropped connection are all
     temporary — the 2026-11-03 --all run lost 89 of 16,209 to them. A 404 or
     403 is an answer, not a hiccup, and is not retried. */
  const kylas = async (path, t = 0) => {
    let r;
    try { r = await fetch(`${BASE}${path}`, { headers: { "api-key": KEY }, signal: AbortSignal.timeout(20_000) }); }
    catch (e) {
      if (t < 5) { await sleep(1000 * 2 ** t); return kylas(path, t + 1); }
      throw e;
    }
    if ((r.status === 429 || r.status >= 500) && t < 6) { await sleep(500 * 2 ** t); return kylas(path, t + 1); }
    if (!r.ok) throw Object.assign(new Error(`GET ${path} -> ${r.status}`), { status: r.status });
    return r.json();
  };

  /* Filtered here, not by formula: a link field nobody has filled yet is
     unknown to a formula on some bases. */
  const rows = (await listTolerant(at, "Contacts", {
    fields: ["Kylas Contact ID", "Name", "Owner", "Call Count", "KPI Rank", "Company"], pageSize: 100, maxPages: 5000 }))
    .filter((r) => r.fields?.["Kylas Contact ID"] && !(r.fields?.Company || []).length)
    /* ~35,000 rows have no link (2026-11-03) — almost all imported and never
       touched. By default only the ones that count: a logged call, or a rung
       above the first. --all does every one (about 2–3 hours at Kylas' rate). */
    .filter((r) => all || Number(r.fields?.["Call Count"] || 0) > 0 || Number(r.fields?.["KPI Rank"] || 0) > 1);
  const worked = rows.filter((r) => Number(r.fields?.["Call Count"] || 0) > 0).length;
  log(`${rows.length} contact(s) with no Company link · ${worked} of them have a logged call`);

  let linked = 0, noCompany = 0, failed = 0;
  const whyFailed = new Map();
  const companyRec = new Map();
  for (const r of rows) {
    const kid = String(r.fields["Kylas Contact ID"]);
    try {
      const c = await kylas(`/v1/contacts/${kid}`);
      const cid = idOf(c?.company) ?? c?.companyId;
      if (!cid) { noCompany++; log(`  -  ${kid} ${r.fields.Name || ""}: no company in Kylas either`); continue; }
      const cname = (c?.metaData?.idNameStore?.company || {})[cid] || (typeof c.company === "object" ? c.company.name : "") || "";
      log(`  ${apply ? "✓" : "→"}  ${kid} ${String(r.fields.Name || "").padEnd(24)} → company ${cid} ${cname}`);
      if (apply) {
        let rec = companyRec.get(String(cid));
        if (!rec) {
          rec = (await upsertTolerant(at, "Companies", "Kylas Company ID", {
            "Kylas Company ID": String(cid), ...(cname ? { Name: cname } : {}) })).rec;
          companyRec.set(String(cid), rec);
        }
        await upsertTolerant(at, "Contacts", "Kylas Contact ID", { "Kylas Contact ID": kid, Company: [rec.id] });
      }
      linked++;
    } catch (e) {
      failed++;
      const why = e.status ? `Kylas ${e.status}` : String(e.message).slice(0, 40);
      whyFailed.set(why, (whyFailed.get(why) || 0) + 1);
      log(`  !  ${kid}: ${String(e.message).slice(0, 120)}`);
    }
    await sleep(250);
  }
  log(`\n${apply ? "linked" : "would link"} ${linked} · no company in Kylas ${noCompany} · failed ${failed}`);
  if (failed) log(`why they failed: ${[...whyFailed].map(([k, n]) => `${k} ×${n}`).join(" · ")}` +
                  `\nRun the same command again — it picks up only the contacts still unlinked.`);
  if (!apply) log("Nothing was written. Re-run with --apply.");
  return { total: rows.length, worked, linked, noCompany, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ apply: process.argv.includes("--apply"), all: process.argv.includes("--all") })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
