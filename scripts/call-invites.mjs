/* THE CALL-BACK, ON THE CALENDAR.
 *
 * Ayush, 2026-11-03: "the calendar block automation is not running — check and
 * fix it yourself." The blocks came from a Google Apps Script ("Kylas Sync") in
 * automations@enout.in: every night it emailed an invite — "Call Scheduled:
 * Gunjan (getflits) — Nov 02, 2026 at 9:00 AM IST" — to the contact's owner
 * and to Ayush, and Gmail turned the invite into the block. It was edited on
 * 31 Oct, ran once by hand at 11:01 PM IST, and never ran on its own again.
 * That script lives in an account nothing here can open, so the job moved
 * here, onto the Worker that already holds the Kylas key and already sends
 * mail as automations@enout.in (smtp.mjs).
 *
 * Every hour, after the contacts sync:
 *   - the Kylas contacts changed since the last run (one cheap delta);
 *   - each one whose call-back (the next-call field) is today or later gets an
 *     invite: owner + CALL_INVITE_CC (default ayush@enout.in);
 *   - ONE event per contact, ever. Its UID is fixed (kylas-call-<id>@enout.in),
 *     so a call-back moved to another day MOVES the block (SEQUENCE + 1)
 *     instead of adding a second one, and a cleared call-back cancels it;
 *   - nothing is re-sent while the date, the time and the owner are unchanged
 *     (what was sent is remembered in the Worker's store).
 *
 * The first run starts from the moment the old script last ran, so the calls
 * scheduled while it was broken (1–2 Nov) are the ones that go out first.
 *
 * CALENDAR_INVITES = "0" in wrangler.toml turns it off.
 */
import { createClient, toConsoleContact } from "./kylas.mjs";
import { resolveWriteFields } from "./kylas-write-map.mjs";
import { sendMail } from "./smtp.mjs";

/* The old script's last run (Sat 31 Oct, 11:01 PM IST). Contacts changed after
   it are what it never got to. */
export const FIRST_SINCE = "2026-10-31T17:31:00.000Z";
const SINCE_KEY = "call-invites:since";
const SENT_KEY = (id) => `call-invite:${id}`;
const IST = 330;

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* "2026-11-02" + "14:30" (IST) → the instant, and how a person reads it. */
export function whenOf(date, time) {
  const t = /^\d{1,2}:\d{2}/.test(String(time || "")) ? String(time) : "09:00";
  const [hh, mm] = t.split(":").map(Number);
  const start = new Date(Date.parse(`${date}T${pad(hh)}:${pad(mm)}:00Z`) - IST * 60000);
  const [y, mo, d] = date.split("-").map(Number);
  const h12 = ((hh + 11) % 12) + 1;
  const label = `${MONTHS[mo - 1]} ${pad(d)}, ${y} at ${h12}:${pad(mm)} ${hh < 12 ? "AM" : "PM"} IST`;
  return { start, end: new Date(start.getTime() + 3600_000), label };
}

/* iCalendar text: escaped, and folded at 75 octets as RFC 5545 asks. */
const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const bytes = (s) => new TextEncoder().encode(s).length;
function fold(line) {
  const out = [];
  let rest = line;
  while (bytes(rest) > 75) {
    let n = 75;
    while (bytes(rest.slice(0, n)) > 75) n--;
    out.push(rest.slice(0, n));
    rest = " " + rest.slice(n);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildInvite({ id, seq = 0, method = "REQUEST", name, company, when, organizer, attendees, description, now = new Date() }) {
  const lines = [
    "BEGIN:VCALENDAR", "PRODID:-//Enout//BD Console call invites//EN", "VERSION:2.0", "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:kylas-call-${id}@enout.in`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(when.start)}`,
    `DTEND:${icsTime(when.end)}`,
    `SUMMARY:${icsText(`Call: ${name}${company ? ` (${company})` : ""}`)}`,
    `DESCRIPTION:${icsText(description)}`,
    `ORGANIZER;CN=Automation Team:mailto:${organizer}`,
    ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    ...(method === "CANCEL" ? [] : ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Call", "TRIGGER:-PT10M", "END:VALARM"]),
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/* The email the old script sent, field for field. */
export function bodyOf(c, when, ownerEmail) {
  return [
    "A call has been scheduled.", "",
    `Name:    ${c.pocName || ""}`,
    `Company: ${c.company || ""}`,
    `Date:    ${when.label}`,
    `Owner:   ${ownerEmail || c.owner || ""}`,
    `Email:   ${(c.emails || [])[0]?.value || ""}`,
    `Phone:   ${(c.phones || [])[0]?.value || ""}`,
    `Kylas:   https://app.kylas.io/sales/contacts/details/${c.kid}`,
    `Remarks: ${c.rawRemarks || ""}`,
  ].join("\n");
}

const todayIst = (now) => new Date(now.getTime() + IST * 60000).toISOString().slice(0, 10);

export async function run({ env = {}, log = () => {}, store, kylas = null, apply = true, now = new Date(),
                            connect, max = Number(env.CALL_INVITE_MAX || 200) } = {}) {
  if (String(env.CALENDAR_INVITES ?? "1") === "0") return { skipped: "CALENDAR_INVITES is 0" };
  if (!store) throw new Error("call-invites needs the Worker's store");
  const user = env.MAIL_SMTP_USER, pass = env.MAIL_SMTP_PASS;
  if (apply && (!user || !pass)) return { skipped: "no MAIL_SMTP_USER / MAIL_SMTP_PASS" };
  kylas ||= createClient(env.KYLAS_KEY, { log: () => {}, ...(env.KYLAS_BASE ? { base: env.KYLAS_BASE } : {}) });
  const cc = String(env.CALL_INVITE_CC ?? "ayush@enout.in").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const organizer = (user || "automations@enout.in").toLowerCase();

  /* which custom field is the call-back on this account — the same resolver the save uses */
  const list = await kylas.raw("GET", "/v1/entities/contact/fields?entityType=contact&custom-only=false&sort=createdAt,asc&page=0&size=200");
  const fields = (Array.isArray(list) ? list : list?.content || list?.data || [])
    .map((f) => ({ name: f.name, label: f.displayName, type: f.type }));
  const writeMap = resolveWriteFields(fields, {});
  if (!writeMap.nextCall) return { skipped: "this Kylas account has no call-back field" };

  const started = now.toISOString();
  const since = (await store.get(SINCE_KEY)) || FIRST_SINCE;
  const changed = await kylas.contactsChangedSince(since);
  const contacts = Array.isArray(changed) ? changed : changed?.contacts || [];
  const users = (await kylas.users(contacts.map((c) => c.ownerId)).catch(() => ({ users: [] }))).users || [];
  const emailOf = new Map(users.map((u) => [String(u.id), u.email]));
  const today = todayIst(now);

  const out = { since, looked: contacts.length, sent: 0, moved: 0, cancelled: 0, unchanged: 0, past: 0, failed: 0, examples: [] };
  for (const raw of contacts) {
    if (out.sent + out.moved + out.cancelled >= max) { out.capped = true; break; }
    const c = toConsoleContact(raw, { writeMap });
    const cf = raw.customFieldValues || {};
    c.rawRemarks = String(cf.cfRemarks ?? raw.remarks ?? "").replace(/<[^>]+>/g, "").trim();
    const key = SENT_KEY(c.kid);
    const was = JSON.parse((await store.get(key)) || "null");
    const ownerEmail = emailOf.get(String(c.ownerId)) || "";
    const to = [...new Set([ownerEmail, ...cc].filter(Boolean))];

    if (!c.nextCallDate || c.nextCallDate < today) {
      if (!c.nextCallDate && was?.date && was.date >= today) {
        /* the call-back was cleared: take the block off the calendar */
        const when = whenOf(was.date, was.time);
        const ics = buildInvite({ id: c.kid, seq: was.seq + 1, method: "CANCEL", name: c.pocName, company: c.company,
          when, organizer, attendees: was.to || to, description: "This call is no longer scheduled.", now });
        if (apply) await send({ to: was.to || to, subject: `Cancelled: Call: ${c.pocName} (${c.company})`, text: "This call is no longer scheduled.", ics });
        await store.put(key, JSON.stringify({ ...was, date: "", seq: was.seq + 1 }), { ttlSeconds: 400 * 86400 });
        out.cancelled++;
      } else out.past++;
      continue;
    }
    const sig = `${c.nextCallDate} ${c.nextCallTime}|${to.join(",")}`;
    if (was?.sig === sig) { out.unchanged++; continue; }
    const seq = was ? was.seq + 1 : 0;
    const when = whenOf(c.nextCallDate, c.nextCallTime);
    const text = bodyOf(c, when, ownerEmail);
    const ics = buildInvite({ id: c.kid, seq, name: c.pocName, company: c.company, when, organizer,
      attendees: to, description: text, now });
    const subject = `Call Scheduled: ${c.pocName}${c.company ? ` (${c.company})` : ""} — ${when.label}`;
    try {
      if (apply) await send({ to, subject, text, ics });
      await store.put(key, JSON.stringify({ sig, seq, date: c.nextCallDate, time: c.nextCallTime, to }), { ttlSeconds: 400 * 86400 });
      was ? out.moved++ : out.sent++;
      if (out.examples.length < 5) out.examples.push(`${c.pocName} (${c.company}) — ${when.label} → ${to.join(", ")}`);
    } catch (e) {
      out.failed++;
      log(`! call invite for ${c.kid}: ${String(e.message).replace(pass || "\0", "***").slice(0, 160)}`);
    }
  }
  /* The watermark moves only when nothing failed, so a failed invite is tried again next hour. */
  if (!out.failed && !out.capped) await store.put(SINCE_KEY, new Date(Date.parse(started) - 120_000).toISOString(), { ttlSeconds: 400 * 86400 });
  log(`call invites: ${out.looked} changed since ${since} · ${out.sent} new · ${out.moved} moved · ` +
      `${out.cancelled} cancelled · ${out.unchanged} unchanged${out.failed ? ` · ${out.failed} FAILED` : ""}`);
  return out;

  async function send({ to, subject, text, ics }) {
    await sendMail({ host: env.MAIL_SMTP_HOST || "smtp.gmail.com", port: Number(env.MAIL_SMTP_PORT) || 465,
      user, pass, from: `Automation Team <${organizer}>`, to, subject, text, calendar: ics }, { connect });
  }
}
