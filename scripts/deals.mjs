/* DEALS, THEIR ACTION ITEMS, AND WHY THEY ARE STUCK.
 *
 * ONE MODULE AND ONE TABLE SET, in D1. Airtable is near its 50,000-record cap
 * and an action-item log is exactly the kind of thing that would eat it — a
 * deal with a four-stage playbook is ~12 rows before anybody does anything.
 * So: nothing here is ever written to Airtable.
 *
 * WHAT IS IN KYLAS AND WHAT IS HERE. The deal itself and its tasks are real
 * Kylas records, because Sales works in Kylas and a deal that only exists in
 * this console is a deal Sales cannot see. The SLA clocks, the slip history
 * and the ball-in-court are here, because Kylas has nowhere to put them and
 * they are the only things that answer "why has this not moved".
 *
 * EVERY KYLAS WRITE FROM THIS FILE IS A POST. See scripts/kylas.mjs.
 *
 * ── THE TWO CLOCKS ───────────────────────────────────────────────────
 * Every action item carries BOTH:
 *   baseline_due_at  what we first promised. Never moves.
 *   current_due_at   what we are promising now. Moves, and each move costs a
 *                    slip and a reason.
 *   completed_at     when it actually happened.
 * One clock answers "are we late"; two answer "were we ever on time, and who
 * made it late". A single due date that is edited silently is how a pipeline
 * reports 100% on-time while everybody knows it is three weeks behind.
 *
 * ── BALL IN COURT ────────────────────────────────────────────────────
 * The reason a BD is not penalised for a Planning Team delay. Pushing a date
 * REQUIRES a reason chip, and the chip decides whose court the deal is in.
 * The radar then counts deals and rupees by court, so "we are stuck" stops
 * being an argument and becomes a number with a name against it.
 */

export const COURTS = ["client_poc", "planning_team", "sales_poc", "bd"];
export const COURT_LABEL = {
  client_poc: "Client POC", planning_team: "Planning Team",
  sales_poc: "Sales POC", bd: "BD",
};

/* The chip a BD taps to push a date, and whose court that puts it in. The
   wording is theirs, not ours: these are the four things that actually
   happen, in the words the floor uses. */
export const REASON_CHIPS = [
  { k: "poc_no_pick", label: "POC didn't pick call", court: "client_poc", waNudge: true, noPick: true },
  { k: "poc_inputs_pending", label: "Inputs pending with POC", court: "client_poc", waNudge: true },
  { k: "dmm_pending", label: "DMM / cost sheet pending", court: "planning_team" },
  { k: "venue_quote_pending", label: "Venue quote pending", court: "planning_team" },
  { k: "walkthrough_pending", label: "Walkthrough pending", court: "sales_poc" },
  { k: "proposal_pending", label: "Proposal pending", court: "sales_poc" },
  { k: "bd_followup", label: "Mine — I need to chase", court: "bd" },
];
export const chipOf = (k) => REASON_CHIPS.find((c) => c.k === k) || null;

/* ── THE PLAYBOOKS ───────────────────────────────────────────────────
   Four stages, seeded when the deal is created, each with its own SLA in
   hours. The SLAs are deliberately short: they are a promise to look, not a
   promise to finish, and a 7-day SLA on "prep the call" tells nobody
   anything on day 3. */
export const PLAYBOOKS = {
  pre_call: { label: "Pre-Call Prep", items: [
    { k: "research", label: "Read the account research", sla: 4, court: "bd" },
    { k: "agenda", label: "Send agenda + confirm slot", sla: 4, court: "bd" },
  ] },
  post_call: { label: "Post-Call Awaiting Inputs / DMM", items: [
    { k: "inputs", label: "Collect inputs from POC", sla: 24, court: "client_poc" },
    { k: "dmm", label: "Raise DMM / cost sheet", sla: 24, court: "planning_team" },
  ] },
  dmm_walk: { label: "DMM Walkthrough & Re-work", items: [
    { k: "walkthrough", label: "Walkthrough with Sales POC", sla: 48, court: "sales_poc" },
    { k: "rework", label: "Re-work after feedback", sla: 24, court: "planning_team" },
  ] },
  venue_lock: { label: "Venue Lock & SQL Closure", items: [
    { k: "venue", label: "Lock the venue", sla: 48, court: "planning_team" },
    { k: "sql", label: "Confirm and move to SQL", sla: 24, court: "bd" },
  ] },
};
export const PLAYBOOK_ORDER = ["pre_call", "post_call", "dmm_walk", "venue_lock"];

/* The window the radar watches: after the Active Requirement call happened,
   before SQL. That is where deals go quiet, and it is the only stretch where
   four different people can each be the reason. */
export const PRE_SQL_FROM = "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS";
export const PRE_SQL_TO = "SQL_SALES_QUALIFIED_LEAD";

/* ── live tenant values ──────────────────────────────────────────────
   Verified against the account, not guessed. Overridable by env so a second
   tenant does not need a code change. */
export const DEAL_DEFAULTS = {
  pipelineId: 32572,                 /* Demand Funnel */
  stageId: 227155,                   /* Discovery Call Scheduled */
  currencyId: 431,                   /* INR */
  sourceId: 183847,
};

/* "{Company} || {Event Type} || {Pax} Pax" — the shape Sales already reads a
   deal list in. Missing parts are dropped rather than left as empty bars,
   because "Acme ||  || Pax" looks like a bug and reads as one. */
export function dealName(company, ev = {}) {
  return [String(company || "").trim(), String(ev.eventType || "").trim(),
          ev.pax ? `${String(ev.pax).trim()} Pax` : ""]
    .filter(Boolean).join(" || ") || String(company || "Deal");
}

/* The custom fields, by their live internal names. Only what is present is
   sent: an empty custom field on a create is a field set to empty, and the
   console does not know enough at this moment to assert that. */
export function dealCustomFields(c = {}, ev = {}) {
  const cf = {};
  if (ev.pax) cf.cfPaxNumberOfParticipants = String(ev.pax);
  if (ev.timeline) cf.cfExecutionDate = String(ev.timeline);
  if (c.city || ev.location) cf.cfLocation = String(c.city || ev.location);
  if (ev.duration) cf.cfDuration = String(ev.duration);
  const rem = [c.remarks, ev.remarks].filter(Boolean).join(" · ");
  if (rem) cf.cfRemarks = rem;
  return cf;
}

/* The body of POST /v1/deals. Pure, so the shape can be asserted without a
   tenant. estimatedValue is left off unless the budget parses to a number —
   budget is free text by design (CLAUDE.md §2: "approx 8L, not signed off")
   and inventing a figure from it would put a number in Sales' forecast that
   nobody said. */
export function buildDeal(c = {}, company = {}, ev = {}, opts = {}) {
  const d = { ...DEAL_DEFAULTS, ...(opts.defaults || {}) };
  const body = {
    name: dealName(company.name || c.company, ev),
    pipeline: { id: d.pipelineId },
    pipelineStage: { id: d.stageId },
    currencyId: d.currencyId,
    source: { id: d.sourceId },
  };
  if (company.id || c.companyId) body.company = { id: Number(company.id || c.companyId) };
  if (c.kid) body.contacts = [{ id: Number(c.kid) }];
  if (c.ownerId) body.ownerId = Number(c.ownerId);
  const cf = dealCustomFields(c, ev);
  if (Object.keys(cf).length) body.customFieldValues = cf;
  return body;
}

/* A RUPEE FIGURE OUT OF FREE TEXT — FOR THE RADAR ONLY, NEVER FOR KYLAS.
   Budget stays free text everywhere it is shown or written (CLAUDE.md §2:
   "approx 8L, not signed off" holds the half that matters), and buildDeal
   deliberately sends no estimatedValue. But "11 deals stuck" and "₹1.4 Cr
   stuck" get very different meetings, so the radar needs a number.

   The compromise: parse here, keep it in D1, and never push it. A figure
   this console inferred is fine on this console's own screen; the same
   figure in Sales' forecast would be a number nobody actually said.
   Unparseable is 0, not a guess. */
export function parseBudget(text) {
  const t = String(text || "").toLowerCase().replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)\s*(cr|crore|l|lac|lakh|k)?/.exec(t);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2] || "";
  if (/^(cr|crore)$/.test(unit)) return Math.round(n * 1e7);
  if (/^(l|lac|lakh)$/.test(unit)) return Math.round(n * 1e5);
  if (unit === "k") return Math.round(n * 1e3);
  /* A bare number under a thousand is almost always pax or a count that has
     wandered into the wrong field, not rupees. */
  return n >= 1000 ? Math.round(n) : 0;
}

/* THE HANDOVER NOTE. Everything the console knows and the deal record has
   nowhere to put, in one block Sales can read top to bottom. It is a note and
   not a set of fields on purpose: half of this is free text that was never
   meant to be parsed, and squeezing "approx 8L, not signed off" into a
   currency field loses the only half that matters. */
export function handoverNote(c = {}, company = {}, ev = {}, extra = {}) {
  const L = [];
  const put = (k, v) => { if (v) L.push(`${k}: ${v}`); };
  L.push(`DEAL HANDOVER — ${dealName(company.name || c.company, ev)}`);
  L.push("");
  put("Account", company.name || c.company);
  put("POC", [c.pocName, c.designation].filter(Boolean).join(", "));
  put("Phone", (c.phones || [])[0]?.value);
  put("Email", (c.emails || [])[0]?.value);
  put("BD", c.owner);
  put("Sales POC", extra.salesPoc);
  put("Slot", extra.slot);
  L.push("");
  L.push("REQUIREMENT");
  put("Event", ev.eventType);
  put("Pax", ev.pax);
  put("Timeline", ev.timeline);
  put("Budget", ev.budget);
  put("Mode of meeting", c.modeOfMeeting);
  put("Vendor info", c.vendorInfo);
  put("Service offering pitched", c.serviceOffering ? "Yes" : "");
  /* Every other event row, past and current: a company that ran an offsite
     last year and is asking about a launch now is two facts, and only one of
     them is the deal. */
  const rows = [...(c.current || []).map((r) => ["Now", r]), ...(c.past || []).map((r) => ["Past", r])]
    .filter(([, r]) => r !== ev);
  if (rows.length) {
    L.push("");
    L.push("OTHER EVENT ROWS");
    for (const [when, r] of rows)
      L.push(`- ${when} · ${[r.eventType, r.pax && `${r.pax} pax`, r.timeline, r.budget]
        .filter(Boolean).join(" · ")}`);
  }
  if (extra.research) { L.push(""); L.push("ACCOUNT RESEARCH"); L.push(String(extra.research)); }
  if (c.remarks) { L.push(""); L.push("REMARKS"); L.push(String(c.remarks)); }
  L.push("");
  L.push(`Created from the BD Call Console on ${new Date().toISOString().slice(0, 10)}.`);
  return L.join("\n");
}

/* ── the two clocks, as rules ────────────────────────────────────── */
const HOUR = 3600000;

/* A push always costs a slip and always needs a reason. Returning the reason
   as a REQUIREMENT rather than defaulting it is the point: a silent push is
   exactly the thing this is here to stop. */
export function pushDue(item, { to, chip, at = Date.now(), by = "" } = {}) {
  const c = chipOf(chip);
  if (!c) return { ok: false, why: "pushing a date needs a reason chip" };
  if (!to || Number(to) <= 0) return { ok: false, why: "a new date is needed" };
  const history = [...(item.slip_history ? JSON.parse(item.slip_history) : [])];
  history.push({ at, from: item.current_due_at, to: Number(to), chip, court: c.court, by });
  return {
    ok: true,
    patch: {
      current_due_at: Number(to),
      slip_count: (item.slip_count || 0) + 1,
      court: c.court,
      reason: chip,
      slip_history: JSON.stringify(history.slice(-20)),
    },
    /* The BD is not the reason unless the chip says so. This is the line that
       keeps a Planning Team delay off a BD's number. */
    penalisesBd: c.court === "bd",
    waNudge: !!c.waNudge,
    noPick: !!c.noPick,
  };
}

/* Done, and whether it beat the clock. TAT is measured against the BASELINE,
   not the pushed date — otherwise everything is always on time, which is the
   failure mode of every SLA that lets you move the goalposts. */
export function completeItem(item, { at = Date.now() } = {}) {
  const base = Number(item.baseline_due_at) || 0;
  return {
    patch: { state: "done", completed_at: at },
    onTime: base ? at <= base : true,
    tatHours: base ? Math.round(((at - base) / HOUR) * 10) / 10 : 0,
    againstCurrent: item.current_due_at ? at <= Number(item.current_due_at) : true,
  };
}

/* The consolidated timeline: one date for the whole deal, which is the latest
   thing still open. A deal is not "due Tuesday and also Friday" — it is due
   when the last open thing is due, and that is the number a radar can sort. */
export function consolidate(items = []) {
  const open = items.filter((i) => i.state !== "done" && i.state !== "cancelled");
  if (!open.length) return { open: 0, done: items.length, baselineDueAt: null,
                             currentDueAt: null, slipCount: 0, court: null };
  const baseline = Math.max(...open.map((i) => Number(i.baseline_due_at) || 0));
  const current = Math.max(...open.map((i) => Number(i.current_due_at) || Number(i.baseline_due_at) || 0));
  const slips = open.reduce((a, i) => a + (Number(i.slip_count) || 0), 0);
  /* Whose court the DEAL is in: the court of the oldest open item, because
     that is the thing actually holding it up. The newest item is usually
     still inside its SLA and would flatter the picture. */
  const oldest = [...open].sort((a, b) =>
    (Number(a.baseline_due_at) || 0) - (Number(b.baseline_due_at) || 0))[0];
  return { open: open.length, done: items.length - open.length,
           baselineDueAt: baseline || null, currentDueAt: current || null,
           slipCount: slips, court: oldest?.court || null,
           /* ANY open item having moved, not the maxima having moved. Comparing
              max(current) with max(baseline) hides a slip whenever a later
              item's untouched date is the larger of the two — which is the
              common case, because playbooks are seeded in order. */
           slipped: open.some((i) => Number(i.current_due_at || 0) > Number(i.baseline_due_at || 0)) };
}

/* THE RADAR. Deals between Active Requirement Call Done and SQL, counted and
   valued by whose court they are in. Rupees as well as count, because "11
   deals stuck" and "₹1.4 Cr stuck" get very different meetings. */
export function radar(deals = [], itemsByDeal = new Map(), { at = Date.now() } = {}) {
  const by = Object.fromEntries(COURTS.map((c) => [c, { court: c, label: COURT_LABEL[c], deals: 0, value: 0, overdue: 0 }]));
  let total = 0, value = 0;
  for (const d of deals) {
    if (d.state === "won" || d.state === "lost" || d.sql) continue;
    const t = consolidate(itemsByDeal.get(String(d.id)) || []);
    const court = t.court || d.court || "bd";
    if (!by[court]) continue;
    by[court].deals++;
    by[court].value += Number(d.value) || 0;
    if (t.currentDueAt && t.currentDueAt < at) by[court].overdue++;
    total++; value += Number(d.value) || 0;
  }
  return { total, value, by: COURTS.map((c) => by[c]).filter((x) => x.deals > 0),
           all: COURTS.map((c) => by[c]) };
}

/* ── the store ───────────────────────────────────────────────────── */
export function createDeals({ db, log = () => {}, now = () => Date.now() }) {
  if (!db) throw new Error("deals need a D1 binding");
  let schema = null;
  const ready = () => (schema ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY, kylas_deal_id TEXT, company_id TEXT, contact_id TEXT,
      name TEXT, owner TEXT, value REAL DEFAULT 0, stage TEXT, state TEXT NOT NULL DEFAULT 'open',
      court TEXT DEFAULT 'bd', sql INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS deal_items (
      id TEXT PRIMARY KEY, deal_id TEXT NOT NULL, playbook TEXT NOT NULL, item_key TEXT NOT NULL,
      label TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', court TEXT NOT NULL DEFAULT 'bd',
      reason TEXT, kylas_task_id TEXT,
      baseline_due_at INTEGER NOT NULL, current_due_at INTEGER NOT NULL,
      completed_at INTEGER, slip_count INTEGER NOT NULL DEFAULT 0, slip_history TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS deal_items_deal ON deal_items (deal_id, state)"),
    db.prepare("CREATE INDEX IF NOT EXISTS deal_items_due ON deal_items (state, current_due_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS deals_co ON deals (company_id, state)"),
  ]).catch((e) => { schema = null; throw e; }));

  async function create({ kylasDealId = "", companyId = "", contactId = "", name = "",
                          owner = "", value = 0, stage = "", playbooks = ["pre_call"] } = {}) {
    await ready();
    const t = now();
    const id = crypto.randomUUID();
    const stmts = [db.prepare(`INSERT INTO deals (id, kylas_deal_id, company_id, contact_id, name, owner, value, stage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, String(kylasDealId), String(companyId), String(contactId), name, owner, Number(value) || 0, stage, t, t)];
    for (const pb of playbooks) stmts.push(...seedStmts(id, pb, t));
    await db.batch(stmts);
    log(`deal ${id.slice(0, 8)} — ${name}`);
    return { id, kylasDealId: String(kylasDealId) };
  }

  function seedStmts(dealId, playbook, t) {
    const pb = PLAYBOOKS[playbook];
    if (!pb) return [];
    return pb.items.map((it) => {
      const due = t + it.sla * HOUR;
      return db.prepare(`INSERT INTO deal_items (id, deal_id, playbook, item_key, label, court,
        baseline_due_at, current_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), dealId, playbook, it.k, it.label, it.court, due, due, t, t);
    });
  }

  async function seed(dealId, playbook) {
    await ready();
    const t = now();
    const stmts = seedStmts(String(dealId), playbook, t);
    if (stmts.length) await db.batch(stmts);
    return { added: stmts.length };
  }

  async function items(dealId) {
    await ready();
    return (await db.prepare("SELECT * FROM deal_items WHERE deal_id = ? ORDER BY current_due_at").bind(String(dealId)).all()).results || [];
  }

  async function push(itemId, { to, chip, by = "" }) {
    await ready();
    const it = await db.prepare("SELECT * FROM deal_items WHERE id = ?").bind(String(itemId)).first();
    if (!it) throw Object.assign(new Error("no such action item"), { status: 404 });
    const r = pushDue(it, { to, chip, at: now(), by });
    if (!r.ok) throw Object.assign(new Error(r.why), { status: 400 });
    await db.prepare(`UPDATE deal_items SET current_due_at = ?, slip_count = ?, court = ?, reason = ?,
      slip_history = ?, updated_at = ? WHERE id = ?`)
      .bind(r.patch.current_due_at, r.patch.slip_count, r.patch.court, r.patch.reason,
            r.patch.slip_history, now(), String(itemId)).run();
    /* The DEAL's court follows the item that was just pushed: the radar reads
       the deal, and a deal whose court never moved would keep reporting BD. */
    await db.prepare("UPDATE deals SET court = ?, updated_at = ? WHERE id = ?")
      .bind(r.patch.court, now(), it.deal_id).run();
    return { ...r, item: { ...it, ...r.patch } };
  }

  async function complete(itemId) {
    await ready();
    const it = await db.prepare("SELECT * FROM deal_items WHERE id = ?").bind(String(itemId)).first();
    if (!it) throw Object.assign(new Error("no such action item"), { status: 404 });
    const r = completeItem(it, { at: now() });
    await db.prepare("UPDATE deal_items SET state = 'done', completed_at = ?, updated_at = ? WHERE id = ?")
      .bind(r.patch.completed_at, now(), String(itemId)).run();
    return r;
  }

  async function list({ owner = "", open = true } = {}) {
    await ready();
    const rows = (await db.prepare(
      `SELECT * FROM deals ${open ? "WHERE state = 'open'" : ""} ORDER BY updated_at DESC LIMIT 400`).all()).results || [];
    const mine = owner ? rows.filter((d) => String(d.owner) === String(owner)) : rows;
    const all = (await db.prepare("SELECT * FROM deal_items WHERE state != 'cancelled'").all()).results || [];
    const byDeal = new Map();
    for (const i of all) {
      if (!byDeal.has(i.deal_id)) byDeal.set(i.deal_id, []);
      byDeal.get(i.deal_id).push(i);
    }
    const t = now();
    return {
      deals: mine.map((d) => ({ ...d, timeline: consolidate(byDeal.get(d.id) || []),
                                items: byDeal.get(d.id) || [] })),
      radar: radar(mine, byDeal, { at: t }),
      at: t,
    };
  }

  return { create, seed, items, push, complete, list, ready };
}
