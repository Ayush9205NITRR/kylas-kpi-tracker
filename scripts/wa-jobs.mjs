/* THE WHATSAPP OUTBOX. A table the console writes to and the bot reads.
 *
 * The outreach bot (`whatsapp-bd-outreach`, 8 seats on whatsapp-web.js) is
 * already built and already works. This file is deliberately NOT a WhatsApp
 * integration: it is the queue between the two, and the only thing it knows
 * about WhatsApp is that something else will eventually send these rows.
 *
 * WHY A REVERSE PULL. The bot polls /wa/drain and leases what is due. The
 * alternative — the Worker calling the bot — would put eight laptops, their
 * network and their QR sessions on the critical path of /save, which is the
 * one request a BD waits for 200 times a day. Here /save does ONE INSERT and
 * returns; if every seat is offline the rows simply sit there.
 *
 * SO: NOTHING IN THIS FILE TALKS TO THE NETWORK. If it ever does, a bot that
 * is asleep becomes a save that is slow, and that is the whole reason the
 * table exists.
 *
 * Two tables, both in D1, none in Airtable — the base is near its 50k cap and
 * a message queue is the last thing that should eat it:
 *   wa_sequences  one per contact: which playbook, which step, and whether it
 *                 is still allowed to run.
 *   wa_jobs       the outbox proper. One row per message the bot should send.
 *
 * The rules below (the six post-send cases) are pure functions over plain
 * objects, with the clock passed in, so they can be tested without a database
 * and without a calendar.
 */

export const WA_STAGES = {
  /* Stage -> which playbook, and whether the console offers the pill at all.
     The three CNC rungs and Connect Later are the "we could not reach them"
     family: those auto-queue, because that is exactly the case a BD has no
     time to type into. Activation and MQL carry the event detail. */
  CNC_COULD_NOT_CONNECT: { seq: "cnc", step: 1, auto: true },
  CNC_COULD_NOT_CONNECT_2: { seq: "cnc", step: 2, auto: true },
  CNC_COULD_NOT_CONNECT_3: { seq: "cnc", step: 3, auto: true, multiThread: true },
  CONNECT_LATER: { seq: "cnc", step: 1, auto: true },
  ACTIVATION: { seq: "event", step: 1, auto: false, needsEvent: true },
  MQL_MARKETING_QUALIFIED_LEAD: { seq: "event", step: 1, auto: false, needsEvent: true },
  DISCOVERY_CALL_BOOKED: { seq: "confirm", step: 1, auto: false },
  DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS: { seq: "inputs", step: 1, auto: false },
  ACTIVE_REQUIREMENT_CALL_BOOKED: { seq: "confirm", step: 1, auto: false },
};

/* Reaching either of these on ANY contact at a company means the account is
   live, and a cold chase running at the same time on a colleague reads as a
   left hand that does not know what the right is doing. */
export const WARM_STAGES = new Set(["DISCOVERY_CALL_BOOKED", "ACTIVE_REQUIREMENT_CALL_BOOKED",
  "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS", "SQL_SALES_QUALIFIED_LEAD"]);

export const PAUSE_REASONS = ["inbound_reply", "call_supersedes_wa", "multi_thread_guard",
  "not_on_wa", "seat_offline", "opt_out"];

/* ── business hours ──────────────────────────────────────────────────
   09:30–19:30 IST. A follow-up that fires at 03:00 because a queue drained
   on UTC is not a follow-up, it is a reason to be blocked. IST is UTC+5:30
   and has no daylight saving, so the offset is a constant and this needs no
   timezone library. */
export const IST_OFFSET_MIN = 330;
const DAY_MS = 86400000;
export const BUSINESS = { openMin: 9 * 60 + 30, closeMin: 19 * 60 + 30 };

export function istMinutes(ts) {
  const d = new Date(ts + IST_OFFSET_MIN * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
export function inBusinessHours(ts) {
  const m = istMinutes(ts);
  return m >= BUSINESS.openMin && m < BUSINESS.closeMin;
}
/* The next moment this message is allowed to go. Inside hours that is now;
   before open it is today's open; after close it is tomorrow's. Sunday is
   deliberately NOT skipped — the team does call on Saturdays and Ayush has
   not said otherwise, and inventing a weekend rule nobody asked for is how a
   queue quietly stops delivering. */
export function nextBusinessSlot(ts) {
  const m = istMinutes(ts);
  if (m >= BUSINESS.openMin && m < BUSINESS.closeMin) return ts;
  if (m < BUSINESS.openMin) return ts + (BUSINESS.openMin - m) * 60000;
  return ts + (BUSINESS.openMin + 24 * 60 - m) * 60000;
}

/* ── the six cases, as rules ─────────────────────────────────────────
   Each returns what SHOULD happen, and nothing happens here. The caller
   turns it into statements; the tests read it directly. */

/* 1 · they replied. Everything queued for them stops — a sequence that keeps
   firing after a human answered is the single thing that makes an outreach
   bot look like a bot. The call-back moves to today so the BD sees them in
   Work today rather than discovering the reply next week. */
export function onInboundReply(seq, { at = Date.now() } = {}) {
  return {
    pause: { reason: "inbound_reply", at },
    cancelQueued: true,
    note: "Replied on WhatsApp — sequence paused",
    nextCallDate: new Date(at + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10),
    badge: "WA Replies",
    seqId: seq?.id || "",
  };
}

/* 2 · nobody replied, so the sequence may advance — but only in hours, and
   only while it is still active. */
export function onNoReplyAdvance(seq, { at = Date.now(), gapHours = 24 } = {}) {
  if (!seq || seq.state !== "active") return { advance: false, why: "sequence is not running" };
  const next = (seq.step || 1) + 1;
  if (next > (seq.steps || 3)) return { advance: false, why: "sequence finished" };
  return { advance: true, step: next, dueAt: nextBusinessSlot(at + gapHours * 3600000) };
}

/* 3 · a CALL beats a queued message. The BD has just spoken to them (or
   tried); whatever was waiting to be sent was written for a world before
   that call, and sending it afterwards is worse than not sending it. */
export function onCallSupersedes(jobs = [], { at = Date.now() } = {}) {
  return { cancel: jobs.filter((j) => j.state === "queued").map((j) => j.id), reason: "call_supersedes_wa", at };
}

/* 4 · multi-thread guard. Once ANY POC at an account is warm, the cold chase
   on their colleagues stops: two people at the same company getting a "just
   following up" while their colleague is mid-discovery is the fastest way to
   lose both. */
export function onMultiThreadGuard(seqs = [], warmContactId, { at = Date.now() } = {}) {
  return {
    pause: seqs.filter((s) => s.state === "active" && s.seq === "cnc"
      && String(s.contactId) !== String(warmContactId)).map((s) => s.id),
    reason: "multi_thread_guard", at,
  };
}

/* 5 · the number is not on WhatsApp, or the seat that owns it is offline.
   These are NOT the same and must not read the same: not_on_wa is final and
   the BD needs to know to ring instead; seat_offline is this laptop, this
   hour, and the job should wait rather than be thrown away. */
export function onDeliveryFailure(job, kind, { at = Date.now() } = {}) {
  if (kind === "not_on_wa") {
    return { job: job?.id, state: "failed", pauseSequence: true, reason: "not_on_wa",
             note: "Not reachable on WhatsApp — call instead", at };
  }
  return { job: job?.id, state: "queued", pauseSequence: false, reason: "seat_offline",
           retryAt: nextBusinessSlot(at + 30 * 60000), at };
}

/* 6 · opt-out. "STOP", "do not message me". Hard halt, and it outlives the
   sequence: the contact is marked so a LATER stage change cannot start a new
   one. Nothing else in this file is permanent; this is. */
export function onOptOut(seq, { at = Date.now() } = {}) {
  return { pause: { reason: "opt_out", at }, cancelQueued: true, dnd: true,
           note: "Opted out of WhatsApp — do not message", seqId: seq?.id || "" };
}

/* What the console should offer on a card at this stage, and whether it
   should have queued something already. */
export function waPlan(stage, { optedOut = false, hasPhone = true } = {}) {
  const def = WA_STAGES[stage];
  if (!def || !hasPhone) return { offer: false };
  if (optedOut) return { offer: false, why: "opted out" };
  return { offer: true, seq: def.seq, step: def.step, auto: !!def.auto,
           needsEvent: !!def.needsEvent, multiThread: !!def.multiThread };
}

/* The variables the bot fills a template with. Event rows are read live off
   the card, not from a copy, because the whole point of sending at ACTIVATION
   or MQL is that it quotes what they just said. */
export function waVars(contact = {}, company = {}) {
  const rows = [...(contact.current || []), ...(contact.past || [])];
  const best = rows.find((r) => r.budget || r.timeline || r.pax) || rows[0] || {};
  return {
    name: String(contact.pocName || "").split(/\s+/)[0] || "there",
    company: company.name || contact.company || "",
    eventType: best.eventType || "",
    pax: best.pax || "",
    timeline: best.timeline || "",
    budget: best.budget || "",
  };
}

/* ── TEMPLATES ───────────────────────────────────────────────────────
   The copy was the bot's, which meant changing a sentence was a deploy of a
   different repo. It lives here now: five playbooks, each one row, editable
   from the console by anyone who can see the queue.

   The eight variables are the only ones that exist. A body may name any of
   them and nothing else — an unknown {{token}} is left alone rather than
   silently blanked, because a half-substituted message is worse than an
   obviously wrong one: one gets noticed, the other gets sent. */
export const TEMPLATE_VARS = ["name", "company", "eventType", "pax", "timeline",
                              "budget", "nextCallDate", "bdName"];
/* What each one falls back to when the record has nothing. "there" rather
   than a blank, because "Hi ," is the single most obvious tell that a human
   did not write the message. */
export const VAR_FALLBACK = { name: "there", company: "your team", eventType: "your event",
  pax: "", timeline: "", budget: "", nextCallDate: "", bdName: "" };

export const DEFAULT_TEMPLATES = [
  { id: "cnc", name: "Could not connect", stageGroup: "cnc", autoSend: 1,
    body: "Hi {{name}}, this is {{bdName}} from Enout. Tried reaching you about {{company}}'s upcoming event plans — is now a bad time? Happy to call back whenever suits you." },
  { id: "event", name: "Event detail follow-up", stageGroup: "event", autoSend: 0,
    body: "Hi {{name}}, great speaking just now. Noting what you shared for {{company}}: {{eventType}} for about {{pax}} people around {{timeline}}, budget {{budget}}. I'll put together a couple of options — anything else I should factor in?" },
  { id: "confirm", name: "Meeting confirmation", stageGroup: "confirm", autoSend: 0,
    body: "Hi {{name}}, confirming our call on {{nextCallDate}} about {{company}}'s {{eventType}}. I'll share a short agenda beforehand. — {{bdName}}, Enout" },
  { id: "noshow", name: "Missed the call", stageGroup: "noshow", autoSend: 0,
    body: "Hi {{name}}, we had a call scheduled today and I could not reach you — no problem at all. Shall I try again on {{nextCallDate}}? — {{bdName}}, Enout" },
  { id: "inputs", name: "Awaiting inputs", stageGroup: "inputs", autoSend: 0,
    body: "Hi {{name}}, following up on the inputs for {{company}}'s {{eventType}} ({{pax}} pax, {{timeline}}). Once I have those I can get you costed options. — {{bdName}}" },
];

/* THE RENDERER, AND IT IS THE ONLY ONE. The composer previews with it, the
   save path renders with it, and the body that reaches the bot is the string
   it produced — so what a BD read on screen is exactly what goes out. A
   preview computed one way and a send computed another is how somebody sends
   "Hi {{name}}" to a prospect. */
export function renderTemplate(body, vars = {}, fallbacks = {}) {
  return String(body || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key) => {
    /* A CUSTOM VARIABLE IS SUBSTITUTED IF THE CALLER MAPPED IT, and left
       visible if nobody did. Both halves matter: the mapper exists so a BD
       can type {{venue_city}} and fill it, and the "left visible" half is
       what stops an unmapped one going out as a blank. */
    if (!TEMPLATE_VARS.includes(key)) {
      const c = String(vars[key] ?? "").trim() || String(fallbacks[key] ?? "").trim();
      return c || whole;
    }
    const v = String(vars[key] ?? "").trim();
    if (v) return v;
    const f = fallbacks[key] ?? VAR_FALLBACK[key] ?? "";
    return String(f);
  })
  /* A row with no pax leaves "for about  people"; collapsing the hole is the
     difference between a gap and a typo. */
  .replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim();
}

/* Which variables a body actually uses, for the mapper. */
export const varsUsed = (body) =>
  [...new Set([...String(body || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))]
    .filter((v) => TEMPLATE_VARS.includes(v));

/* ── SEQUENCES, AND THE ONE COLUMN THAT SAYS WHERE SOMEBODY IS ───────
   Two ladders, each walked in order and never jumped:
     CNC-1 → CNC-2 → CNC-3        nobody picked up
     Warmup-1 → Warmup-2 → Warmup-3   Activation / MQL, keeping it warm
   Step N only ever targets people who are AT step N-1 and have not replied,
   been called, opted out or turned out not to be on WhatsApp. That rule is
   `eligible()` below and it is the whole reason this is sequence-based: no
   calendar, no cron, nothing to go wrong at 3am — the next step is simply
   whoever the last step reached.

   THE STATUS IS DERIVED, NEVER STORED TWICE. It comes out of wa_sequences,
   which the webhook already maintains, so the Contacts column and the
   composer's gating cannot disagree — and Airtable gains no rows. */
export const WA_STATUS = {
  NONE: "Not Sent", REPLIED: "Replied", DND: "DND", NOT_ON_WA: "Not on WA",
};
export const SEQ_LABEL = { cnc: "CNC", warmup: "Warmup" };

export function statusOf(seq) {
  if (!seq) return WA_STATUS.NONE;
  if (seq.dnd || seq.state === "opted_out") return WA_STATUS.DND;
  if (seq.reason === "not_on_wa") return WA_STATUS.NOT_ON_WA;
  if (seq.reason === "inbound_reply") return WA_STATUS.REPLIED;
  const n = Number(seq.sent_step || 0);
  if (!n) return WA_STATUS.NONE;
  return `${SEQ_LABEL[seq.seq] || seq.seq}-${n} Sent`;
}

/* Who the NEXT step may go to. `step` is the one about to be sent, so step 1
   is anybody untouched and step N>1 is exactly those sitting at N-1.
   A reply, a DND, a not-on-WhatsApp or a cooldown that has not elapsed all
   take somebody out — and each returns WHY, because a contact silently
   missing from a list is the fastest way to lose trust in the list. */
export function eligible(contact, seqRow, { seq = "cnc", step = 1, now = Date.now(),
                                            cooldownHours = 48, capReached = false } = {}) {
  if (!contact?.phone) return { ok: false, why: "no number" };
  const st = statusOf(seqRow);
  if (st === WA_STATUS.DND) return { ok: false, why: "opted out" };
  if (st === WA_STATUS.NOT_ON_WA) return { ok: false, why: "not on WhatsApp" };
  if (st === WA_STATUS.REPLIED) return { ok: false, why: "replied — talk to them" };
  if (capReached) return { ok: false, why: "daily cap reached" };
  const want = step > 1 ? `${SEQ_LABEL[seq]}-${step - 1} Sent` : WA_STATUS.NONE;
  if (st !== want) return { ok: false, why: st === WA_STATUS.NONE ? `needs ${SEQ_LABEL[seq]}-${step - 1} first` : `at ${st}` };
  /* The gap between two steps of the same ladder. Three messages in an hour
     is what gets a number banned; this is the floor under that. */
  if (step > 1 && seqRow?.sent_at && now - Number(seqRow.sent_at) < cooldownHours * 3600000)
    return { ok: false, why: `too soon — ${Math.ceil((cooldownHours * 3600000 - (now - Number(seqRow.sent_at))) / 3600000)}h to go` };
  return { ok: true };
}

/* ── ANTI-BAN ────────────────────────────────────────────────────────
   whatsapp-web.js drives a real logged-in phone. A number that sends 300
   cold messages in a morning is a number that stops existing, and it takes
   the BD's own WhatsApp with it. These are the brakes, and they are
   admin-only because the person who wants them lifted is never the person
   who pays for a ban. */
export const WA_DEFAULTS = {
  dailyCapPerSeat: 60,     /* per phone, per day */
  maxCnc: 3,
  maxWarmup: 4,
  cooldownHours: 48,
  killSwitch: 0,
};

/* Custom variables: anything the template editor finds that is not one of
   the eight built-ins. They are rendered from the same vars object, so a
   mapper row that supplies a static value just puts it there. */
export const customVarsIn = (body) =>
  [...new Set([...String(body || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))]
    .filter((v) => !TEMPLATE_VARS.includes(v));

export const TEMPLATE_VISIBILITY = ["private", "team", "official"];

/* A SEAT IN TROUBLE, BEFORE THE BAN. whatsapp-web.js drives a real logged-in
   phone, and the two things that precede a number being cut off are people
   blocking it and people ignoring it. Neither is visible in a total: one seat
   out of eight can be burning while the team average looks fine.

   The thresholds are deliberately unsubtle — this is a smoke alarm, not a
   dashboard. The reply floor only applies once a seat has sent enough for a
   rate to mean anything; below that it is noise, and flagging on noise is how
   an alarm gets ignored. */
export const SEAT_FLAGS = { badRate: 0.05, replyFloor: 0.08, minSends: 30 };

export function seatHealth(row = {}) {
  const sent = Number(row.sent || 0);
  const bad = Number(row.opt_out || 0) + Number(row.failed || 0) + Number(row.not_on_wa || 0);
  const replied = Number(row.replied || 0);
  const flags = [];
  if (sent && bad / sent > SEAT_FLAGS.badRate)
    flags.push({ k: "burning", why: `${Math.round((bad / sent) * 100)}% opted out or failed — rest this number` });
  if (sent >= SEAT_FLAGS.minSends && replied / sent < SEAT_FLAGS.replyFloor)
    flags.push({ k: "ignored", why: `${Math.round((replied / sent) * 100)}% reply on ${sent} sends — the wording is not landing` });
  return { seat: row.seat || "", sent, bad, replied, flags, ok: !flags.length };
}

/* ── the store ───────────────────────────────────────────────────── */
export function createWaJobs({ db, log = () => {}, now = () => Date.now() }) {
  if (!db) throw new Error("the WhatsApp outbox needs a D1 binding");
  let schema = null;
  const ready = () => (schema ||= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_sequences (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, company_id TEXT, seq TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 1, steps INTEGER NOT NULL DEFAULT 3,
      state TEXT NOT NULL DEFAULT 'active', reason TEXT, owner TEXT, seat TEXT,
      dnd INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_jobs (
      id TEXT PRIMARY KEY, seq_id TEXT, contact_id TEXT NOT NULL, company_id TEXT,
      seat TEXT, phone TEXT NOT NULL, template TEXT NOT NULL, vars TEXT,
      state TEXT NOT NULL DEFAULT 'queued', tries INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS wa_jobs_due ON wa_jobs (state, due_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS wa_jobs_contact ON wa_jobs (contact_id, state)"),
    db.prepare("CREATE INDEX IF NOT EXISTS wa_seq_contact ON wa_sequences (contact_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS wa_seq_co ON wa_sequences (company_id, state)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, stage_group TEXT NOT NULL,
      auto_send INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_settings (
      k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`),
    /* One row per template per seat. Counters, not events: the event log is
       the bot's, and this only has to answer "is seat 4 getting read" and
       "does the CNC-2 wording land". */
    db.prepare(`CREATE TABLE IF NOT EXISTS wa_metrics (
      k TEXT PRIMARY KEY, template TEXT NOT NULL, seat TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
      read INTEGER NOT NULL DEFAULT 0, replied INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, not_on_wa INTEGER NOT NULL DEFAULT 0,
      opt_out INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`),
  ]).then(() => migrate()).then(() => seedTemplates()).catch((e) => { schema = null; throw e; }));

  /* Columns added after the table existed. SQLite has no "ADD COLUMN IF NOT
     EXISTS", and a database created before this release has the table but
     not the column — so each one is attempted and the "duplicate column"
     refusal is the success case. */
  async function migrate() {
    for (const [t, col, decl] of [
      ["wa_sequences", "sent_step", "INTEGER NOT NULL DEFAULT 0"],
      ["wa_sequences", "sent_at", "INTEGER"],
      ["wa_jobs", "sent_at", "INTEGER"],
      ["wa_jobs", "delivered_at", "INTEGER"],
      /* The BD's own label for this blast — "GPTW batch 3", "Mumbai FMCG".
         Session-only in the UI (never a saved template) but stored ON THE
         JOB, because a metric with no campaign against it cannot answer
         "which batch actually worked". */
      ["wa_jobs", "campaign", "TEXT"],
      ["wa_metrics", "campaign", "TEXT"],
      ["wa_templates", "visibility", "TEXT NOT NULL DEFAULT 'team'"],
      ["wa_templates", "owner_email", "TEXT"],
    ]) {
      try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col} ${decl}`).run(); }
      catch { /* already there */ }
    }
    /* AFTER the columns, not with the tables: an index on a column that the
       ALTER above is about to add fails the whole batch, and ready() then
       rejects on every call. */
    try { await db.prepare("CREATE INDEX IF NOT EXISTS wa_jobs_sent ON wa_jobs (seat, sent_at)").run(); }
    catch { /* older sqlite, or the column genuinely is not there */ }
  }

  /* INSERT OR IGNORE, so the defaults appear on a fresh database and an
     edited one is never quietly reset to the factory wording. */
  async function seedTemplates() {
    const t = now();
    await db.batch(DEFAULT_TEMPLATES.map((x) => db.prepare(
      `INSERT OR IGNORE INTO wa_templates (id, name, stage_group, auto_send, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(x.id, x.name, x.stageGroup, x.autoSend, x.body, t, t)));
  }

  async function templates() {
    await ready();
    const rows = (await db.prepare("SELECT * FROM wa_templates ORDER BY stage_group, name").all()).results || [];
    return rows.map((r) => ({ id: r.id, name: r.name, stageGroup: r.stage_group,
                              autoSend: !!r.auto_send, body: r.body,
                              /* team unless somebody chose otherwise: a
                                 template nobody else can see is the default
                                 that quietly stops a team sharing wording. */
                              visibility: r.visibility || "team", owner: r.owner_email || "",
                              updatedAt: r.updated_at }));
  }
  async function saveTemplate({ id = "", name = "", stageGroup = "cnc", autoSend = false,
                                body = "", visibility = "team", owner = "" }) {
    await ready();
    const clean = String(body || "").slice(0, 4000);
    if (!String(name).trim()) throw Object.assign(new Error("a template needs a name"), { status: 400 });
    if (!clean.trim()) throw Object.assign(new Error("a template needs a message"), { status: 400 });
    const t = now();
    const key = String(id || "").trim() || `t${t.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const vis = TEMPLATE_VISIBILITY.includes(String(visibility)) ? String(visibility) : "team";
    await db.prepare(`INSERT INTO wa_templates (id, name, stage_group, auto_send, body, visibility, owner_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, stage_group = excluded.stage_group,
        auto_send = excluded.auto_send, body = excluded.body, visibility = excluded.visibility,
        updated_at = excluded.updated_at`)
      .bind(key, String(name).slice(0, 120), String(stageGroup), autoSend ? 1 : 0, clean, vis,
            String(owner || ""), t, t).run();
    return { id: key };
  }
  async function deleteTemplate(id) {
    await ready();
    /* The five defaults come back on the next read anyway (INSERT OR IGNORE),
       so deleting one is refused rather than being a confusing no-op. */
    if (DEFAULT_TEMPLATES.some((x) => x.id === String(id)))
      throw Object.assign(new Error("that is a built-in template — edit it instead of deleting it"), { status: 400 });
    await db.prepare("DELETE FROM wa_templates WHERE id = ?").bind(String(id)).run();
    return { deleted: String(id) };
  }

  const LEASE_MS = 3 * 60 * 1000;

  /* THE HOT PATH. /save calls this and waits for it, so it is one INSERT and
     one UPDATE, no reads of Kylas, no reads of Airtable, no network at all. */
  /* `vars.body_override` is the composer's rendered, possibly hand-edited
     text. When it is there the bot sends it verbatim and the template is
     only a label — which is the whole point of letting a BD edit before
     sending. */
  async function queue({ contactId, companyId, phone, stage, template, vars = {},
                         owner = "", seat = "", dueAt = null, campaign = "" }) {
    await ready();
    const cid = String(contactId || "");
    if (!cid || !phone) throw Object.assign(new Error("a WhatsApp job needs a contact and a number"), { status: 400 });
    const t = now();
    /* Queuing is refused too — the switch is "pause all outreach", and a
       queue that fills while it is down is a flood the moment it lifts. */
    const cfg = await settings();
    if (Number(cfg.killSwitch))
      throw Object.assign(new Error("Outreach is paused by an admin (kill switch)."), { status: 423 });
    const plan = waPlan(stage, {});
    const seqId = `${cid}:${plan.seq || "adhoc"}`;
    const id = crypto.randomUUID();
    await db.batch([
      /* The same contact being queued again replaces what was waiting — see
         onCallSupersedes. Doing it in the same batch keeps "cancel the old,
         add the new" from ever being half-applied. */
      db.prepare("UPDATE wa_jobs SET state = 'cancelled', error = 'call_supersedes_wa', updated_at = ? WHERE contact_id = ? AND state = 'queued'")
        .bind(t, cid),
      db.prepare(`INSERT INTO wa_sequences (id, contact_id, company_id, seq, step, state, owner, seat, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET step = excluded.step, state =
          CASE WHEN wa_sequences.dnd = 1 THEN 'opted_out' ELSE 'active' END, updated_at = excluded.updated_at`)
        .bind(seqId, cid, String(companyId || ""), plan.seq || "adhoc", plan.step || 1, owner, seat, t, t),
      db.prepare(`INSERT INTO wa_jobs (id, seq_id, contact_id, company_id, seat, phone, template, vars, campaign, due_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM wa_sequences WHERE contact_id = ? AND dnd = 1)`)
        .bind(id, seqId, cid, String(companyId || ""), seat, String(phone), String(template || plan.seq || "adhoc"),
              JSON.stringify(vars), String(campaign || ""), Number(dueAt) || nextBusinessSlot(t), t, t, cid),
    ]);
    return { id, seqId, dueAt: Number(dueAt) || nextBusinessSlot(t) };
  }

  /* The bot's poll. Leases rather than deletes, so a seat that dies mid-send
     does not silently drop the message. */
  /* EIGHT LAPTOPS POLL THIS, ALL DAY, AND MOST POLLS HAVE NOTHING TO DO.
     So the empty case costs exactly ONE indexed SELECT and ZERO writes —
     no lease, no counter, no settings read unless there is something to
     hand over. That is the difference between a queue that is free to run
     and one that bills by the poll.
     ORDER: the cheap SELECT first, the kill switch and the cap only once
     there is actually work. */
  async function drain({ seat = "", limit = 20 } = {}) {
    await ready();
    const t = now();
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = (await db.prepare(
      `SELECT * FROM wa_jobs WHERE state = 'queued' AND due_at <= ? AND lease_until < ?
         AND (seat = '' OR seat IS NULL OR seat = ?) ORDER BY due_at LIMIT ?`)
      .bind(t, t, String(seat), n).all()).results || [];
    if (!rows.length) return { jobs: [] };

    const cfg = await settings();
    /* THE KILL SWITCH IS CHECKED HERE, not only at queue time: the whole
       point of it is to stop sending that is ALREADY queued, in the middle
       of a morning, from one button. */
    if (Number(cfg.killSwitch)) return { jobs: [], paused: true, reason: "kill switch" };

    const already = await sentToday(seat);
    const room = Math.max(0, Number(cfg.dailyCapPerSeat) - already);
    if (!room) return { jobs: [], capped: true, sentToday: already, cap: Number(cfg.dailyCapPerSeat) };
    const take = rows.slice(0, room);

    await db.batch(take.map((r) => db.prepare(
      "UPDATE wa_jobs SET state = 'leased', lease_until = ?, seat = ?, tries = tries + 1, updated_at = ? WHERE id = ?")
      .bind(t + LEASE_MS, String(seat), t, r.id)));
    return { jobs: take.map((r) => ({ ...r, vars: JSON.parse(r.vars || "{}") })),
             sentToday: already, cap: Number(cfg.dailyCapPerSeat) };
  }

  /* What the bot tells us afterwards. One route, every outcome, because the
     six cases differ only in what they do and not in how they arrive. */
  async function webhook({ event, jobId = "", contactId = "", companyId = "", stage = "", text = "" }) {
    await ready();
    const t = now();
    const cid = String(contactId || "");
    const out = { event, applied: [] };

    /* The job row knows its template and seat; the metrics are keyed on
       those, so nothing extra has to be passed in from the bot. */
    const job = jobId ? await db.prepare("SELECT * FROM wa_jobs WHERE id = ?").bind(String(jobId)).first() : null;
    const tpl = job?.template || "adhoc", st = job?.seat || "", cp = job?.campaign || "";

    if (event === "sent" || event === "delivered" || event === "read") {
      if (event === "sent") {
        await db.batch([
          db.prepare("UPDATE wa_jobs SET state = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").bind(t, t, jobId),
          /* THE LADDER MOVES ON A SEND, not on a queue. A message that sat
             in the outbox and never went has not advanced anybody, and
             treating it as if it had is how CNC-2 goes to somebody who never
             got CNC-1. */
          db.prepare(`UPDATE wa_sequences SET sent_step = MAX(sent_step, step), sent_at = ?, updated_at = ?
            WHERE id = ?`).bind(t, t, job?.seq_id || ""),
        ]);
      }
      /* Delivery is STAMPED, not just counted: the reply rate is replies
         inside seven days over what was delivered in that window, and a
         counter with no clock on it cannot answer a windowed question. */
      if (event === "delivered")
        await db.prepare("UPDATE wa_jobs SET delivered_at = ? WHERE id = ?").bind(t, jobId).run();
      await bump(tpl, st, event === "read" ? "read" : event === "delivered" ? "delivered" : "sent", cp);
      out.applied.push(event);
      return out;
    }
    if (event === "inbound_reply") {
      await db.batch([
        db.prepare("UPDATE wa_jobs SET state = 'cancelled', error = 'inbound_reply', updated_at = ? WHERE contact_id = ? AND state IN ('queued','leased')").bind(t, cid),
        db.prepare("UPDATE wa_sequences SET state = 'paused', reason = 'inbound_reply', updated_at = ? WHERE contact_id = ?").bind(t, cid),
      ]);
      out.applied.push("paused", "cancelled");
      await bump(tpl, st, "replied", cp);
      out.reply = onInboundReply({ id: cid }, { at: t });
      return out;
    }
    if (event === "opt_out") {
      await db.batch([
        db.prepare("UPDATE wa_jobs SET state = 'cancelled', error = 'opt_out', updated_at = ? WHERE contact_id = ? AND state IN ('queued','leased')").bind(t, cid),
        /* UPSERT, NOT UPDATE. An opt-out can arrive for somebody this console
           has never queued a message to — they replied STOP to a colleague's
           thread, or the bot saw it on an older conversation. UPDATE touched
           no rows in that case and the DND was silently forgotten, so the
           next stage change queued them a message anyway. The flag has to
           exist before there is a sequence to put it on. */
        db.prepare(`INSERT INTO wa_sequences (id, contact_id, company_id, seq, step, state, reason, dnd, created_at, updated_at)
          VALUES (?, ?, '', 'optout', 0, 'opted_out', 'opt_out', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET state = 'opted_out', reason = 'opt_out', dnd = 1, updated_at = excluded.updated_at`)
          .bind(`${cid}:dnd`, cid, t, t),
        db.prepare("UPDATE wa_sequences SET state = 'opted_out', reason = 'opt_out', dnd = 1, updated_at = ? WHERE contact_id = ?").bind(t, cid),
      ]);
      out.applied.push("dnd");
      await bump(tpl, st, "opt_out", cp);
      return out;
    }
    if (event === "not_on_wa" || event === "seat_offline") {
      const d = onDeliveryFailure({ id: jobId }, event, { at: t });
      await db.prepare(
        d.state === "failed"
          ? "UPDATE wa_jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?"
          : "UPDATE wa_jobs SET state = 'queued', lease_until = 0, error = ?, due_at = MAX(due_at, ?), updated_at = ? WHERE id = ?")
        .bind(...(d.state === "failed" ? [event, t, jobId] : [event, d.retryAt, t, jobId])).run();
      if (d.pauseSequence && cid)
        await db.prepare("UPDATE wa_sequences SET state = 'paused', reason = ?, updated_at = ? WHERE contact_id = ?")
          .bind(event, t, cid).run();
      await bump(tpl, st, event === "not_on_wa" ? "not_on_wa" : "failed", cp);
      out.applied.push(d.state);
      return out;
    }
    /* A contact went warm: hold the cold chase on everybody else there. */
    if (event === "stage_warm" && WARM_STAGES.has(stage) && companyId) {
      await db.batch([
        db.prepare(`UPDATE wa_sequences SET state = 'paused', reason = 'multi_thread_guard', updated_at = ?
          WHERE company_id = ? AND contact_id != ? AND state = 'active' AND seq = 'cnc'`).bind(t, String(companyId), cid),
        db.prepare(`UPDATE wa_jobs SET state = 'cancelled', error = 'multi_thread_guard', updated_at = ?
          WHERE company_id = ? AND contact_id != ? AND state = 'queued'`).bind(t, String(companyId), cid),
      ]);
      out.applied.push("multi_thread_guard");
      return out;
    }
    void text;
    return { event, applied: [], ignored: true };
  }

  async function status({ owner = "" } = {}) {
    await ready();
    const t = now();
    const rows = (await db.prepare(
      "SELECT state, COUNT(*) AS n FROM wa_jobs GROUP BY state").all()).results || [];
    const replies = (await db.prepare(
      "SELECT COUNT(*) AS n FROM wa_sequences WHERE state = 'paused' AND reason = 'inbound_reply'").first()) || {};
    const due = (await db.prepare(
      "SELECT COUNT(*) AS n FROM wa_jobs WHERE state = 'queued' AND due_at <= ?").bind(t).first()) || {};
    void owner;
    const cfg = await settings();
    const seats = (await db.prepare("SELECT * FROM wa_metrics").all()).results || [];
    const bySeat = {};
    for (const r of seats) {
      const k = r.seat || "unassigned";
      const acc = (bySeat[k] ||= { seat: k, sent: 0, replied: 0, failed: 0, opt_out: 0, not_on_wa: 0 });
      for (const c of ["sent", "replied", "failed", "opt_out", "not_on_wa"]) acc[c] += r[c] || 0;
    }
    return { by: Object.fromEntries(rows.map((r) => [r.state, r.n])),
             replies: replies.n || 0, dueNow: due.n || 0, inHours: inBusinessHours(t),
             killSwitch: Number(cfg.killSwitch) === 1,
             /* Only the seats actually in trouble: a list of eight "fine"s
                is a list nobody reads, and the one that matters hides in it. */
             seatFlags: Object.values(bySeat).map(seatHealth).filter((x) => !x.ok) };
  }

  /* ── settings ──────────────────────────────────────────────────── */
  async function settings() {
    await ready();
    const rows = (await db.prepare("SELECT k, v FROM wa_settings").all()).results || [];
    const out = { ...WA_DEFAULTS };
    for (const r of rows) {
      const n = Number(r.v);
      out[r.k] = Number.isFinite(n) ? n : r.v;
    }
    return out;
  }
  async function saveSettings(patch = {}, by = "") {
    await ready();
    const t = now();
    const keys = Object.keys(WA_DEFAULTS);
    const stmts = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!keys.includes(k)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      stmts.push(db.prepare(`INSERT INTO wa_settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(k, String(n), t, by));
    }
    if (stmts.length) await db.batch(stmts);
    return settings();
  }

  /* ── metrics ───────────────────────────────────────────────────── */
  const METRIC_COLS = ["sent", "delivered", "read", "replied", "failed", "not_on_wa", "opt_out"];
  async function bump(template, seat, col, campaign = "") {
    if (!METRIC_COLS.includes(col)) return;
    const t = now();
    const tpl = String(template || "adhoc"), st = String(seat || ""), cp = String(campaign || "");
    await db.prepare(`INSERT INTO wa_metrics (k, template, seat, campaign, ${col}, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(k) DO UPDATE SET ${col} = ${col} + 1, updated_at = excluded.updated_at`)
      .bind(`${cp}|${tpl}|${st}`, tpl, st, cp, t).run();
  }
  async function metrics() {
    await ready();
    const rows = (await db.prepare("SELECT * FROM wa_metrics").all()).results || [];
    const zero = () => Object.fromEntries(METRIC_COLS.map((c) => [c, 0]));
    const total = zero(), byTemplate = {}, bySeat = {};
    for (const r of rows) {
      for (const c of METRIC_COLS) {
        total[c] += r[c] || 0;
        (byTemplate[r.template] ||= { ...zero(), template: r.template })[c] += r[c] || 0;
        (bySeat[r.seat || "unassigned"] ||= { ...zero(), seat: r.seat || "unassigned" })[c] += r[c] || 0;
      }
    }
    const byCampaign = {};
    for (const r of rows) {
      const c = r.campaign || "(none)";
      for (const col of METRIC_COLS) (byCampaign[c] ||= { ...zero(), campaign: c })[col] += r[col] || 0;
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

    /* REPLY RATE IS A WINDOWED, UNIQUE-PERSON NUMBER: distinct contacts who
       replied in the last seven days over what was delivered in the same
       seven days. The raw counter would count one chatty prospect three
       times and divide it by six months of sends — a figure that only ever
       goes down and tells nobody anything. */
    const cut = now() - 7 * 86400000;
    const r7 = await db.prepare(
      "SELECT COUNT(DISTINCT contact_id) AS n FROM wa_sequences WHERE reason = 'inbound_reply' AND updated_at >= ?")
      .bind(cut).first();
    const d7 = await db.prepare(
      "SELECT COUNT(*) AS n FROM wa_jobs WHERE delivered_at >= ?").bind(cut).first();

    return { total, byTemplate: Object.values(byTemplate), bySeat: Object.values(bySeat),
             byCampaign: Object.values(byCampaign),
             window7d: { replied: r7?.n || 0, delivered: d7?.n || 0, rate: pct(r7?.n || 0, d7?.n || 0) },
             rates: { delivered: pct(total.delivered, total.sent), read: pct(total.read, total.sent),
                      replied: pct(r7?.n || 0, d7?.n || 0) } };
  }

  /* ── statuses, for the Contacts column and the composer's gating ── */
  async function statuses(contactIds = []) {
    await ready();
    const ids = [...new Set(contactIds.map(String).filter(Boolean))];
    if (!ids.length) return {};
    const out = {};
    /* Chunked IN(), because a view can hold 400 people and SQLite has a
       limit on bound parameters. */
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const rows = (await db.prepare(
        `SELECT * FROM wa_sequences WHERE contact_id IN (${part.map(() => "?").join(",")})`)
        .bind(...part).all()).results || [];
      for (const r of rows) {
        /* A contact can own a cnc row AND a dnd row; the hardest state wins,
           which is what statusOf's own order already encodes. */
        const next = statusOf(r);
        const have = out[r.contact_id];
        const rank = (x) => (x === WA_STATUS.DND ? 4 : x === WA_STATUS.NOT_ON_WA ? 3
          : x === WA_STATUS.REPLIED ? 2 : x === WA_STATUS.NONE ? 0 : 1);
        if (!have || rank(next) > rank(have)) out[r.contact_id] = next;
      }
    }
    for (const id of ids) out[id] ||= WA_STATUS.NONE;
    return out;
  }

  /* How many a seat has actually SENT today, against the cap. Counted off
     wa_jobs.sent_at, which the webhook stamps — not off what was queued,
     because a queue that never went out has banned nobody. */
  async function sentToday(seat) {
    await ready();
    const since = new Date(new Date(now()).setUTCHours(0, 0, 0, 0)).getTime() - IST_OFFSET_MIN * 60000;
    const r = await db.prepare("SELECT COUNT(*) AS n FROM wa_jobs WHERE seat = ? AND sent_at >= ?")
      .bind(String(seat || ""), since).first();
    return r?.n || 0;
  }

  /* THE EIGHT FIELDS THE CONTACTS TABLE SHOWS, in one query. Joined here
     rather than on the client because the client would need the job rows
     too, and shipping a view's worth of jobs to paint one column is the
     opposite of the point. Airtable is not touched. */
  async function contactFields(contactIds = []) {
    await ready();
    const ids = [...new Set(contactIds.map(String).filter(Boolean))];
    if (!ids.length) return {};
    const out = {};
    for (let i = 0; i < ids.length; i += 150) {
      const part = ids.slice(i, i + 150);
      const marks = part.map(() => "?").join(",");
      const [seqs, jobs] = await Promise.all([
        db.prepare(`SELECT * FROM wa_sequences WHERE contact_id IN (${marks})`).bind(...part).all(),
        /* One row per contact: the latest job, plus the counts. */
        db.prepare(`SELECT contact_id,
             COUNT(*) AS n,
             SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent,
             MAX(sent_at) AS last_sent,
             MAX(delivered_at) AS last_delivered
           FROM wa_jobs WHERE contact_id IN (${marks}) GROUP BY contact_id`).bind(...part).all(),
        ]);
      const latest = {};
      for (const r of (await db.prepare(
        `SELECT contact_id, template, seat, campaign, state, sent_at FROM wa_jobs
           WHERE contact_id IN (${marks}) ORDER BY COALESCE(sent_at, updated_at)`).bind(...part).all()).results || [])
        latest[r.contact_id] = r;
      const byC = {};
      for (const r of seqs.results || []) {
        const have = byC[r.contact_id];
        if (!have || Number(r.sent_step || 0) > Number(have.sent_step || 0) || r.dnd) byC[r.contact_id] = r;
      }
      const counts = Object.fromEntries((jobs.results || []).map((r) => [r.contact_id, r]));
      for (const id of part) {
        const q = byC[id], j = latest[id], c = counts[id];
        out[id] = {
          status: statusOf(q),
          campaign: j?.campaign || "",
          lastSentAt: c?.last_sent ? new Date(Number(c.last_sent)).toISOString().slice(0, 10) : "",
          lastTemplate: j?.template || "",
          /* The DELIVERY state of the last message, which is not the same
             question as where they are on the ladder: "CNC-2 Sent, failed"
             is a real and important pair. */
          deliveryState: q?.reason === "not_on_wa" ? "not on WhatsApp"
            : c?.last_delivered ? "delivered" : j?.state || "",
          sentCount: Number(c?.sent || 0),
          replyAt: q?.reason === "inbound_reply" && q?.updated_at
            ? new Date(Number(q.updated_at)).toISOString().slice(0, 10) : "",
          seat: j?.seat || q?.seat || "",
        };
      }
    }
    return out;
  }

  /* The raw rows, for the gate — statuses() flattens to one label per
     contact and the cooldown needs sent_at, which the label has thrown away. */
  async function sequencesFor(contactIds = []) {
    await ready();
    const ids = [...new Set(contactIds.map(String).filter(Boolean))];
    const out = {};
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      if (!part.length) break;
      const rows = (await db.prepare(
        `SELECT * FROM wa_sequences WHERE contact_id IN (${part.map(() => "?").join(",")})`)
        .bind(...part).all()).results || [];
      for (const r of rows) {
        const have = out[r.contact_id];
        if (!have || Number(r.sent_step || 0) > Number(have.sent_step || 0) || r.dnd) out[r.contact_id] = r;
      }
    }
    return out;
  }

  /* The kill switch's optional second half. */
  async function cancelAllQueued(by = "") {
    await ready();
    const t = now();
    const r = await db.prepare(
      "UPDATE wa_jobs SET state = 'cancelled', error = 'kill_switch', updated_at = ? WHERE state IN ('queued','leased')")
      .bind(t).run();
    log(`wa kill switch by ${by}: queued jobs cancelled`);
    return { cancelled: r?.meta?.changes ?? r?.changes ?? 0 };
  }

  return { queue, drain, webhook, status, ready, templates, saveTemplate, deleteTemplate,
           settings, saveSettings, metrics, statuses, contactFields, sequencesFor,
           sentToday, bump, cancelAllQueued };
}
