#!/usr/bin/env node
/* ADMIN AND BDA, OLD PROCESSES AND NEW, END TO END.
 *
 *   node scripts/test-role-stress.mjs
 *
 * Spawns the mocks once and TWO proxies against them, because the role is
 * decided from the signed-in user and the only honest way to test an
 * associate is to be one:
 *   :8787  admin     ADMIN_IDS matches the mock's user
 *   :8788  associate ADMIN_EMAILS names somebody else, so nothing matches
 * Separate JOBS_DB files, so the two personas cannot read each other's
 * queues and deals by accident — which would make every scoping assertion
 * below pass for the wrong reason.
 *
 * It covers what already worked as well as what is new. A release that adds
 * deals and a message queue and quietly breaks /report is not a release.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const A = "http://127.0.0.1:8787";          /* admin */
const B = "http://127.0.0.1:8788";          /* associate */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = { adminOld: [], adminNew: [], bdaOld: [], bdaNew: [] };
let fails = 0;
const ok = (bucket, what, cond, detail = "") => {
  R[bucket].push({ what, cond: !!cond, detail });
  if (!cond) { fails++; console.log(`  FAIL  [${bucket}] ${what}${detail ? `  — ${detail}` : ""}`); }
};

const get = async (base, path) => {
  const r = await fetch(base + path);
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
};
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
};

for (const f of [".save-journal.json", ".role-admin.sqlite", ".role-bda.sqlite"])
  if (existsSync(`${REPO}/${f}`)) unlinkSync(`${REPO}/${f}`);

const MOCKS = { KYLAS_BASE: "http://127.0.0.1:9900", KYLAS_KEY: "x",
  AIRTABLE_BASE_URL: "http://127.0.0.1:9901", AIRTABLE_PAT: "pat_mock", AIRTABLE_BASE: "appMOCK" };
const procs = [];
const up = async (file, env, probe) => {
  const p = spawn("node", [file], { cwd: REPO, env: { ...process.env, ...env }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 70; i++) { try { if ((await probe()).status > 0) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`${file} (${env.PORT || ""}) never came up`);
};

try {
  await up("scripts/mock-kylas.mjs", { MOCK_MANY: "6" },
    () => fetch("http://127.0.0.1:9900/__writes", { headers: { "api-key": "x" } }));
  await up("scripts/mock-airtable.mjs", {}, () => fetch("http://127.0.0.1:9901/v0/appMOCK/Contacts"));
  await up("scripts/proxy.mjs", { ...MOCKS, PORT: "8787", ADMIN_IDS: "74725",
    JOBS_DB: `${REPO}/.role-admin.sqlite` }, () => fetch(A + "/health"));
  await up("scripts/proxy.mjs", { ...MOCKS, PORT: "8788", ADMIN_EMAILS: "nobody@enout.in",
    JOBS_DB: `${REPO}/.role-bda.sqlite` }, () => fetch(B + "/health"));

  /* ══ 1 · ADMIN, OLD PROCESSES ═══════════════════════════════════════ */
  const h = await get(A, "/health");
  ok("adminOld", "/health answers", h.status === 200 && !!h.j?.version, JSON.stringify(h.j || {}).slice(0, 80));
  /* The role is on /health, with the signed-in user — there is no /me. */
  ok("adminOld", "/health says admin", h.j?.role === "admin", `role=${h.j?.role}`);
  const meta = await get(A, "/meta");
  ok("adminOld", "/meta carries the picklists", meta.status === 200 && !!meta.j?.picklists);
  const cos = await get(A, "/companies?owner=all&page=0");
  ok("adminOld", "/companies?owner=all returns the team's accounts",
     cos.status === 200 && Array.isArray(cos.j?.companies), `${cos.j?.companies?.length} rows`);
  const rep = await get(A, "/report?period=month&owner=all");
  ok("adminOld", "/report month/all answers with a current period",
     rep.status === 200 && !!rep.j?.current, JSON.stringify(rep.j?.current || {}).slice(0, 80));
  for (const [path, label] of [["/rca", "/rca"], ["/dupe-flags", "/dupe-flags"],
                               ["/offsite-audit", "/offsite-audit"], ["/allot-jobs", "/allot-jobs"]]) {
    const r = await get(A, path);
    ok("adminOld", `${label} is open to an admin`, r.status === 200, `${r.status}`);
  }
  const q = await get(A, "/queue?owner=all");
  ok("adminOld", "/queue still answers", q.status === 200);
  const views = await get(A, "/views");
  ok("adminOld", "/views still answers", views.status === 200 && Array.isArray(views.j?.views));

  /* ══ 2 · ADMIN, NEW PROCESSES ══════════════════════════════════════ */
  const base = {
    companyId: "903", company: "Shorehouse Retail", designation: "Head of HR",
    emails: [{ type: "OFFICE", value: "stress@shorehouse.example", primary: true }],
    modeOfMeeting: "Virtual", vendorInfo: "Uses Thomas Cook", serviceOffering: true,
    remarks: "Finance review on the 20th",
    current: [{ eventType: "Employee offsites", pax: "120", timeline: "March",
                budget: "approx 8L, not signed off" }],
  };
  const t0 = Date.now();
  const hand = await post(A, "/save", { contact: { ...base, lid: "rs-admin-1", pocName: "Stress Handoff",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811777001", primary: true }],
    stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" }, call: {} });
  const handMs = Date.now() - t0;
  ok("adminNew", "/save on Active Requirement answers 200", hand.status === 200, `${hand.status}`);
  ok("adminNew", "...and creates a Deal in the same request", !!hand.j?.deal?.id, JSON.stringify(hand.j?.deal || {}));
  /* The Worker allows 50 subrequests per request. The save already spends
     most of them; a whole-second ceiling here is the crude proxy for "the
     deal leg did not double the work". */
  ok("adminNew", "...inside a sane request budget", handMs < 20000, `${handMs}ms`);

  const dealsRaw = await (await fetch("http://127.0.0.1:9900/__deals", { headers: { "api-key": "x" } })).json();
  const deal = dealsRaw.deals.find((d) => String(d.id) === String(hand.j?.deal?.id));
  ok("adminNew", "...in Demand Funnel 32572 / stage 227155 / INR 431 / source 183847",
     deal?.pipeline?.id === 32572 && deal?.pipelineStage?.id === 227155
     && deal?.currencyId === 431 && deal?.source?.id === 183847,
     JSON.stringify({ p: deal?.pipeline?.id, s: deal?.pipelineStage?.id, c: deal?.currencyId, src: deal?.source?.id }));
  ok("adminNew", "...with the handover note attached",
     (deal?.notes || []).some((n) => /approx 8L, not signed off/.test(n) && /Uses Thomas Cook/.test(n)));
  ok("adminNew", "...and at least one Kylas Deal Task", (deal?.tasks || []).length >= 1, `${(deal?.tasks || []).length}`);

  /* The contact must come out of the hand-off exactly as rich as it went in. */
  let got = null;
  for (let i = 0; i < 12; i++) {
    got = await (await fetch(`http://127.0.0.1:9900/v1/contacts/${hand.j.kid}`, { headers: { "api-key": "x" } })).json();
    if (!/Too many requests/i.test(JSON.stringify(got))) break;
    await sleep(400);
  }
  const blob = JSON.stringify(got || {});
  ok("adminNew", "...and the contact keeps its name, phone, email and designation",
     /Stress Handoff/.test(blob) && blob.includes("9811777001")
     && blob.includes("stress@shorehouse.example") && /Head of HR/.test(blob), blob.slice(0, 140));

  const dl = await get(A, "/deals?owner=all");
  ok("adminNew", "/deals answers with deals, a radar and the reason chips",
     dl.status === 200 && Array.isArray(dl.j?.deals) && !!dl.j?.radar && (dl.j?.chips || []).length >= 6);
  const courts = (dl.j?.radar?.all || []).map((c) => c.court);
  ok("adminNew", "...the radar is split across all four courts",
     ["client_poc", "planning_team", "sales_poc", "bd"].every((c) => courts.includes(c)), courts.join(","));
  ok("adminNew", "...and carries a rupee figure parsed locally from the free-text budget",
     (dl.j?.radar?.value || 0) >= 800000, `${dl.j?.radar?.value}`);

  const mine = dl.j.deals.find((d) => String(d.kylas_deal_id) === String(hand.j.deal.id));
  const item = (mine?.items || [])[0];
  ok("adminNew", "...action items are seeded with both clocks",
     !!item && Number(item.baseline_due_at) > 0 && item.baseline_due_at === item.current_due_at);
  const baselineWas = Number(item?.baseline_due_at);

  const noChip = await post(A, "/deal-item", { action: "push", id: item.id, to: Date.now() + 864e5 });
  ok("adminNew", "a timeline push with NO reason chip is refused 400", noChip.status === 400, `${noChip.status}`);
  const withChip = await post(A, "/deal-item", { action: "push", id: item.id,
    to: Date.now() + 2 * 864e5, chip: "dmm_pending" });
  ok("adminNew", "...with a Planning Team chip it is accepted", withChip.status === 200, `${withChip.status}`);
  ok("adminNew", "...and the ball moves OFF the BD", withChip.j?.patch?.court === "planning_team"
     && withChip.j?.penalisesBd === false, JSON.stringify(withChip.j?.patch || {}));
  const after = await get(A, "/deals?owner=all");
  const item2 = (after.j.deals.find((d) => d.id === mine.id)?.items || []).find((x) => x.id === item.id);
  ok("adminNew", "...the baseline is IMMUTABLE", Number(item2.baseline_due_at) === baselineWas,
     `${item2.baseline_due_at} vs ${baselineWas}`);
  ok("adminNew", "...the current date moved and the slip is counted",
     Number(item2.current_due_at) > baselineWas && Number(item2.slip_count) === 1);
  const doneR = await post(A, "/deal-item", { action: "complete", id: item.id });
  /* Completed now. The baseline was +4h and the pushed date is +2d, so the
     SIZE of the TAT says which clock was used: about -4h means baseline,
     about -48h would mean it had quietly started measuring the pushed date —
     which is the failure this whole two-clock design exists to prevent.
     (test-deals.mjs covers the late side against a fixed instant.) */
  ok("adminNew", "...and completing computes TAT against the BASELINE, not the pushed date",
     doneR.status === 200 && doneR.j?.onTime === true
     && doneR.j?.tatHours < 0 && doneR.j?.tatHours > -8,
     JSON.stringify(doneR.j || {}).slice(0, 100));

  /* ── the outbox, under an 8-seat burst ─────────────────────────── */
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => post(A, "/wa/queue", {
    contactId: `80${i}`, companyId: i < 4 ? "903" : "1776620", phone: `+9190000000${i}`,
    stage: "CNC_COULD_NOT_CONNECT", vars: { name: `BD${i}` }, seat: `seat-${i}`,
    dueAt: Date.now() })));
  ok("adminNew", "8 BDs queue at once without a failure", burst.every((r) => r.status === 200),
     burst.map((r) => r.status).join(","));
  const drained = await Promise.all(Array.from({ length: 8 }, (_, i) => post(A, "/wa/drain", { seat: `seat-${i}`, limit: 5 })));
  const ids = drained.flatMap((d) => (d.j?.jobs || []).map((j) => j.id));
  ok("adminNew", "...every seat drains, and no job is handed to two seats",
     ids.length > 0 && new Set(ids).size === ids.length, `${ids.length} jobs, ${new Set(ids).size} unique`);

  /* the six cases */
  const w = (body) => post(A, "/wa/webhook", body);
  await w({ event: "inbound_reply", contactId: "800" });
  const s1 = await get(A, "/wa/status");
  ok("adminNew", "case 1 · inbound_reply pauses and is counted", (s1.j?.replies || 0) >= 1, JSON.stringify(s1.j || {}));

  const q2 = await post(A, "/wa/queue", { contactId: "811", companyId: "903",
    phone: "+919000000011", stage: "CNC_COULD_NOT_CONNECT", dueAt: Date.now() });
  await post(A, "/wa/queue", { contactId: "811", companyId: "903", phone: "+919000000011",
    stage: "CNC_COULD_NOT_CONNECT_2", dueAt: Date.now() });
  const d811 = await post(A, "/wa/drain", { seat: "seat-x", limit: 20 });
  const d811ids = (d811.j?.jobs || []).map((j) => j.id);
  ok("adminNew", "case 3 · a new call supersedes the waiting message",
     d811ids.length > 0 && !d811ids.includes(q2.j.id), `${d811ids.length} drained`);

  await post(A, "/wa/queue", { contactId: "820", companyId: "1778327", phone: "+919000000020", stage: "CNC_COULD_NOT_CONNECT", dueAt: Date.now() });
  await w({ event: "stage_warm", contactId: "821", companyId: "1778327", stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" });
  const d820 = await post(A, "/wa/drain", { seat: "seat-y", limit: 20 });
  const d820c = (d820.j?.jobs || []).map((j) => String(j.contact_id));
  ok("adminNew", "case 4 · multi_thread_guard holds a colleague's cold chase",
     !d820c.includes("820"), `drained ${d820c.join(",") || "nothing"}`);

  const q5 = await post(A, "/wa/queue", { contactId: "830", companyId: "903", phone: "+919000000030", stage: "CONNECT_LATER", dueAt: Date.now() });
  const offl = await w({ event: "seat_offline", jobId: q5.j.id, contactId: "830" });
  ok("adminNew", "case 5a · seat_offline requeues rather than discards", offl.j?.applied?.includes("queued"), JSON.stringify(offl.j || {}));
  const nowa = await w({ event: "not_on_wa", jobId: q5.j.id, contactId: "830" });
  ok("adminNew", "case 5b · not_on_wa fails it for good", nowa.j?.applied?.includes("failed"), JSON.stringify(nowa.j || {}));

  await w({ event: "opt_out", contactId: "840" });
  await post(A, "/wa/queue", { contactId: "840", companyId: "903", phone: "+919000000040", stage: "CNC_COULD_NOT_CONNECT", dueAt: Date.now() });
  const d840 = await post(A, "/wa/drain", { seat: "seat-z", limit: 30 });
  ok("adminNew", "case 6 · an opted-out contact can never be queued again",
     !(d840.j?.jobs || []).map((j) => String(j.contact_id)).includes("840"));

  /* case 2 is a clock, not a route: proved in test-wa-jobs.mjs against a
     fixed instant. Asserted here only as "the status knows the hours". */
  const sched = await post(A, "/wa/queue", { contactId: "850", companyId: "903",
    phone: "+919000000050", stage: "CNC_COULD_NOT_CONNECT" });
  const im = new Date(sched.j.dueAt + 330 * 60000);
  const mins = im.getUTCHours() * 60 + im.getUTCMinutes();
  ok("adminNew", "a job queued with no date lands inside 09:30–19:30 IST",
     mins >= 570 && mins < 1170, `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")} IST`);
  const s2 = await get(A, "/wa/status");
  ok("adminNew", "case 2 · the queue knows whether it is inside business hours",
     typeof s2.j?.inHours === "boolean", JSON.stringify(s2.j || {}).slice(0, 80));

  /* ══ 3 · BDA, OLD PROCESSES ════════════════════════════════════════ */
  const bh = await get(B, "/health");
  ok("bdaOld", "/health answers", bh.status === 200);
  ok("bdaOld", "/health says associate, not admin", bh.j?.role === "associate", `role=${bh.j?.role}`);
  const bcos = await get(B, "/companies?owner=all");
  ok("bdaOld", "/companies is scoped to them even when they ask for everyone",
     bcos.status === 200 && String(bcos.j?.owner || "") !== "all", `owner=${bcos.j?.owner}`);
  const bq = await get(B, "/queue");
  ok("bdaOld", "/queue answers", bq.status === 200);
  const brep = await get(B, "/report?period=month");
  ok("bdaOld", "/report answers", brep.status === 200 && !!brep.j?.current);
  for (const path of ["/dupe-flags", "/offsite-audit"]) {
    const r = await get(B, path);
    ok("bdaOld", `${path} is refused 403`, r.status === 403, `${r.status}`);
  }
  for (const [lid, stage, phone] of [["rs-bda-1", "CNC_COULD_NOT_CONNECT", "9811777011"],
                                     ["rs-bda-2", "MQL_MARKETING_QUALIFIED_LEAD", "9811777012"],
                                     ["rs-bda-3", "DISCOVERY_CALL_BOOKED", "9811777013"]]) {
    const t = Date.now();
    const r = await post(B, "/save", { contact: { ...base, lid, pocName: `BDA ${lid}`,
      phones: [{ type: "MOBILE", cc: "+91", value: phone, primary: true }], stage }, call: {} });
    ok("bdaOld", `/save ${stage} works and is quick`, r.status === 200 && Date.now() - t < 20000,
       `${r.status} ${Date.now() - t}ms`);
  }

  /* ══ 4 · BDA, NEW PROCESSES ════════════════════════════════════════ */
  /* CNC auto-queues; the pill can also turn it off. Both are the same flag. */
  const cnc = await post(B, "/save", { contact: { ...base, lid: "rs-bda-wa", pocName: "BDA WA",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811777021", primary: true }],
    stage: "CNC_COULD_NOT_CONNECT" }, call: {}, sendWa: true, seat: "seat-bda" });
  ok("bdaNew", "[✓ Send WA] on save queues a job", cnc.j?.wa?.queued === true, JSON.stringify(cnc.j?.wa || {}));
  /* The BDA's job is queued by /save, which schedules into business hours —
     so drain everything that is due, then look for the seat rather than
     asserting on an empty list and calling it a pass. */
  await post(B, "/wa/queue", { contactId: String(cnc.j?.kid || "860"), companyId: "903",
    phone: "+919811777021", stage: "CNC_COULD_NOT_CONNECT", seat: "seat-bda", dueAt: Date.now() });
  const bdrain = await post(B, "/wa/drain", { seat: "seat-bda", limit: 10 });
  ok("bdaNew", "...under the BDA's own seat", (bdrain.j?.jobs || []).some((j) => j.seat === "seat-bda"),
     `${(bdrain.j?.jobs || []).length} jobs`);
  const off = await post(B, "/save", { contact: { ...base, lid: "rs-bda-off", pocName: "BDA NoWA",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811777022", primary: true }],
    stage: "CNC_COULD_NOT_CONNECT" }, call: {}, sendWa: false });
  ok("bdaNew", "...and unticking it queues nothing", off.j?.wa?.queued !== true, JSON.stringify(off.j?.wa || {}));

  const bhand = await post(B, "/save", { contact: { ...base, lid: "rs-bda-deal", pocName: "BDA Handoff",
    phones: [{ type: "MOBILE", cc: "+91", value: "9811777031", primary: true }],
    stage: "ACTIVE_REQUIREMENT_CALL_BOOKED" }, call: {} });
  ok("bdaNew", "a BDA's hand-off creates their deal too", !!bhand.j?.deal?.id, JSON.stringify(bhand.j?.deal || {}));
  const bdl = await get(B, "/deals");
  const bmine = bdl.j?.deals?.find((d) => String(d.kylas_deal_id) === String(bhand.j?.deal?.id));
  ok("bdaNew", "...and they can see its action items", (bmine?.items || []).length >= 1);
  const bitem = (bmine?.items || [])[0];
  const bpush = await post(B, "/deal-item", { action: "push", id: bitem.id,
    to: Date.now() + 3 * 864e5, chip: "dmm_pending", contactId: bhand.j.kid, companyId: "903" });
  ok("bdaNew", "...can push with a Planning Team reason", bpush.status === 200);
  /* THE POINT OF THE WHOLE MECHANISM. */
  ok("bdaNew", "...and it does NOT count against the BDA", bpush.j?.penalisesBd === false);
  const bafter = await get(B, "/deals");
  const bdeal = bafter.j.deals.find((d) => d.id === bmine.id);
  ok("bdaNew", "...the deal sits in the Planning Team's court, not theirs",
     (bdeal?.timeline?.court || bdeal?.court) === "planning_team",
     `${bdeal?.timeline?.court || bdeal?.court}`);
  const bdCount = (bafter.j.radar?.all || []).find((c) => c.court === "bd")?.deals ?? -1;
  const ptCount = (bafter.j.radar?.all || []).find((c) => c.court === "planning_team")?.deals ?? -1;
  ok("bdaNew", "...and the radar shows it under Planning Team", ptCount >= 1, `bd=${bdCount} planning=${ptCount}`);
  const bdone = await post(B, "/deal-item", { action: "complete", id: bitem.id });
  ok("bdaNew", "a BDA can complete their own action item", bdone.status === 200);
  const nudge = await post(B, "/deal-item", { action: "push", id: (bmine.items[1] || bitem).id,
    to: Date.now() + 864e5, chip: "poc_no_pick", contactId: bhand.j.kid, companyId: "903",
    phone: "+919811777031", name: "BDA Handoff" });
  ok("bdaNew", "“POC didn't pick” nudges on WhatsApp in the same tap",
     nudge.status === 200 && nudge.j?.nudged === true, JSON.stringify(nudge.j?.nudged));
} catch (e) {
  console.log(`\n! the run itself failed: ${e?.stack || e}`);
  fails++;
} finally {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  await sleep(400);
  const row = (label, k) => {
    const list = R[k], bad = list.filter((x) => !x.cond).length;
    return `│ ${label.padEnd(22)} │ ${String(list.length).padStart(5)} │ ${String(list.length - bad).padStart(6)} │ ${String(bad).padStart(6)} │ ${(bad ? "FAIL" : "PASS").padEnd(6)} │`;
  };
  console.log("\n┌────────────────────────┬───────┬────────┬────────┬────────┐");
  console.log("│ persona / process      │ total │ passed │ failed │ result │");
  console.log("├────────────────────────┼───────┼────────┼────────┼────────┤");
  console.log(row("Admin · old", "adminOld"));
  console.log(row("Admin · new", "adminNew"));
  console.log(row("BDA · old", "bdaOld"));
  console.log(row("BDA · new", "bdaNew"));
  console.log("└────────────────────────┴───────┴────────┴────────┴────────┘");
  const all = Object.values(R).flat();
  console.log(`\n${all.length - all.filter((x) => !x.cond).length} passed, ${all.filter((x) => !x.cond).length} failed`);
  process.exit(fails ? 1 : 0);
}
