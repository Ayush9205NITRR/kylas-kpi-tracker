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
import { createAirtable, listTolerant, upsertManyTolerant } from "./airtable.mjs";
import { createClient } from "./kylas.mjs";

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
  const fail = (kid, e) => {
    failed++;
    const why = e.status ? `Kylas ${e.status}` : String(e.message).slice(0, 40);
    whyFailed.set(why, (whyFailed.get(why) || 0) + 1);
    log(`  !  ${kid}: ${String(e.message).slice(0, 120)}`);
  };

  /* FAST PATH (2026-11-03): ONE crawl of every Kylas contact's company — about
     200 contacts a request — instead of one request and a quarter-second pause
     per contact, and the Airtable writes ten to a request. 18,000 contacts went
     from ~3 hours to minutes. A contact the crawl did not return is still
     looked up one by one below, so nothing is skipped. */
  const want = new Set(rows.map((r) => String(r.fields["Kylas Contact ID"])));
  const fromCrawl = new Map();
  if (rows.length > 20) {
    log(`reading every contact's company from Kylas in one pass…`);
    const client = createClient(KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });
    const crawl = await client.contactsChangedSince(null, { fields: ["id", "company", "metaData", "updatedAt"] });
    for (const c of crawl.contacts || []) {
      const kid = String(c.id);
      if (!want.has(kid)) continue;
      const cid = idOf(c.company) ?? c.companyId;
      const cname = (c?.metaData?.idNameStore?.company || {})[cid] || (typeof c.company === "object" ? c.company?.name : "") || "";
      fromCrawl.set(kid, { cid: cid ? String(cid) : "", cname });
    }
    log(`  Kylas answered for ${fromCrawl.size} of the ${rows.length}`);
  }

  /* Anything the crawl missed: the old way, one by one. */
  for (const r of rows) {
    const kid = String(r.fields["Kylas Contact ID"]);
    if (fromCrawl.has(kid)) continue;
    try {
      const c = await kylas(`/v1/contacts/${kid}`);
      const cid = idOf(c?.company) ?? c?.companyId;
      const cname = (c?.metaData?.idNameStore?.company || {})[cid] || (typeof c?.company === "object" ? c.company.name : "") || "";
      fromCrawl.set(kid, { cid: cid ? String(cid) : "", cname });
    } catch (e) { fail(kid, e); }
    await sleep(250);
  }

  const plan = [];
  for (const r of rows) {
    const kid = String(r.fields["Kylas Contact ID"]);
    const k = fromCrawl.get(kid);
    if (!k) continue;                                   /* failed above */
    if (!k.cid) { noCompany++; log(`  -  ${kid} ${r.fields.Name || ""}: no company in Kylas either`); continue; }
    plan.push({ kid, name: r.fields.Name || "", ...k });
  }
  plan.slice(0, apply ? 20 : 40).forEach((p) => log(`  ${apply ? "✓" : "→"}  ${p.kid} ${String(p.name).padEnd(24)} → company ${p.cid} ${p.cname}`));
  if (plan.length > (apply ? 20 : 40)) log(`  … and ${plan.length - (apply ? 20 : 40)} more`);

  if (apply && plan.length) {
    /* every company once, ten to a request */
    const cos = [...new Map(plan.map((p) => [p.cid, p])).values()];
    const companyRec = new Map();
    for (let i = 0; i < cos.length; i += 100) {
      const part = cos.slice(i, i + 100);
      try {
        const { recs } = await upsertManyTolerant(at, "Companies", "Kylas Company ID",
          part.map((p) => ({ "Kylas Company ID": p.cid, ...(p.cname ? { Name: p.cname } : {}) })));
        recs.forEach((rec) => companyRec.set(String(rec.fields?.["Kylas Company ID"]), rec.id));
      } catch (e) { part.forEach((p) => fail(`company ${p.cid}`, e)); }
      log(`  companies ${Math.min(i + 100, cos.length)} / ${cos.length}`);
    }
    /* then every contact's link, ten to a request */
    for (let i = 0; i < plan.length; i += 100) {
      const part = plan.slice(i, i + 100).filter((p) => companyRec.has(p.cid));
      try {
        await upsertManyTolerant(at, "Contacts", "Kylas Contact ID",
          part.map((p) => ({ "Kylas Contact ID": p.kid, Company: [companyRec.get(p.cid)] })));
        linked += part.length;
      } catch (e) { part.forEach((p) => fail(p.kid, e)); }
      if ((i / 100) % 10 === 0 || i + 100 >= plan.length) log(`  linked ${linked} / ${plan.length}`);
    }
  } else linked = plan.length;
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
