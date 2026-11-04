#!/usr/bin/env node
/* The calendar blocks: what replaced the "Kylas Sync" Apps Script.
 *
 *   node scripts/test-call-invites.mjs
 *
 * A fake Kylas, a real (local) SMTP server, and the Worker's store as a map.
 * Checks the invite is real iCalendar, goes to the owner and Ayush, matches
 * the old email, moves (never duplicates) when the call-back moves, cancels
 * when it is cleared, and is not re-sent when nothing changed.
 */
import net from "node:net";
import { Readable, Writable } from "node:stream";
import { run, whenOf, FIRST_SINCE } from "./call-invites.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !d ? "" : `  — ${String(d).slice(0, 220)}`}`); };

/* an SMTP server that keeps every message */
const mails = [];
const srv = net.createServer((sock) => {
  let inData = false, buf = "", rcpt = [];
  const say = (s) => sock.write(s + "\r\n");
  say("220 mock");
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n"); if (end < 0) return;
        mails.push({ to: rcpt, raw: buf.slice(0, end) }); buf = buf.slice(end + 5); inData = false; rcpt = [];
        say("250 OK"); continue;
      }
      const nl = buf.indexOf("\r\n"); if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      if (/^EHLO/.test(line)) sock.write("250-mock\r\n250 AUTH PLAIN\r\n");
      else if (/^AUTH/.test(line)) say("235 OK");
      else if (/^MAIL/.test(line)) say("250 OK");
      else if (/^RCPT TO:<(.+)>/.test(line)) { rcpt.push(/^RCPT TO:<(.+)>/.exec(line)[1]); say("250 OK"); }
      else if (/^DATA/.test(line)) { say("354 go"); inData = true; }
      else if (/^QUIT/.test(line)) { say("221 bye"); sock.end(); }
    }
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const connect = async () => {
  const s = net.connect(srv.address().port, "127.0.0.1");
  await new Promise((r, j) => { s.once("connect", r); s.once("error", j); });
  return { readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy() };
};
/* the parts of a message, decoded */
const parts = (raw) => {
  const out = {};
  for (const m of raw.matchAll(/Content-Type: ([^;\r\n]+)[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g))
    out[m[1]] = Buffer.from(m[2].replace(/\s/g, ""), "base64").toString("utf8");
  out.subject = /Subject: (.*)/.exec(raw)?.[1] || "";
  if (/^=\?UTF-8\?B\?/.test(out.subject)) out.subject = Buffer.from(out.subject.slice(10, -2), "base64").toString("utf8");
  return out;
};

/* a fake Kylas */
const NOW = new Date("2026-11-02T20:30:00Z");            /* 3 Nov, 2:00 AM IST */
let contacts = [];
const kylas = {
  raw: async () => [{ name: "cfNextCallDate", displayName: "Next Call Date", type: "DATETIME_PICKER" },
                    { name: "cfRemarks", displayName: "Remarks", type: "TEXT_FIELD" }],
  contactsChangedSince: async (since) => ({ contacts: contacts.filter((c) => c.updatedAt >= since) }),
  users: async () => ({ users: [{ id: "74726", name: "Arshdeep", email: "arshdeep@enout.in" }] }),
  company: async (id) => ({ id, name: String(id) === "77" ? "acpl" : "getflits" }),
};
const contact = (id, nextUtc, extra = {}) => ({
  id, firstName: "Gunjan", lastName: "", ownerId: 74726, updatedAt: "2026-11-01T10:00:00.000Z",
  company: { id: 9, name: "getflits" }, metaData: { idNameStore: { company: { 9: "getflits" } } },
  emails: [{ value: "gunjan@getflits.com", primary: true }], phoneNumbers: [{ value: "9408755502", primary: true }],
  customFieldValues: { cfNextCallDate: nextUtc, cfRemarks: "SQL, call booked" }, ...extra });
const store = new Map();
const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
const env = { MAIL_SMTP_USER: "automations@enout.in", MAIL_SMTP_PASS: "x" };
const go = () => run({ env, store: kv, kylas, connect, now: NOW });

console.log("\n1. a call-back set while the old script was down gets its block");
contacts = [contact(5381193, "2026-11-04T03:30:00.000Z")];          /* 9:00 AM IST on 4 Nov */
const r1 = await go();
ok("one invite sent", r1.sent === 1 && mails.length === 1, JSON.stringify(r1));
const m1 = parts(mails[0].raw), icsRaw = m1["text/calendar"] || "";
const ics = icsRaw.replace(/\r\n /g, "");            /* unfolded, as a calendar reads it */
ok("to the owner and to Ayush", JSON.stringify(mails[0].to.sort()) === JSON.stringify(["arshdeep@enout.in", "ayush@enout.in"]), mails[0].to);
ok("the subject reads as the old one did", m1.subject === "Call Scheduled: Gunjan (getflits) — Nov 04, 2026 at 9:00 AM IST", m1.subject);
ok("the body carries the same fields", /Name:\s+Gunjan/.test(m1["text/plain"]) && /Owner:\s+arshdeep@enout.in/.test(m1["text/plain"])
   && /contacts\/details\/5381193/.test(m1["text/plain"]) && /Phone:\s+9408755502/.test(m1["text/plain"]), m1["text/plain"]);
ok("it is a calendar invite (METHOD:REQUEST in a text/calendar part)", /method=REQUEST/.test(mails[0].raw) && /METHOD:REQUEST/.test(ics));
ok("one stable event per contact", /UID:kylas-call-5381193@enout.in/.test(ics) && /SEQUENCE:0/.test(ics));
ok("at 9:00 IST for an hour", /DTSTART:20261104T033000Z/.test(ics) && /DTEND:20261104T043000Z/.test(ics), ics);
ok("from the Automation Team, both invited", /ORGANIZER;CN=Automation Team:mailto:automations@enout.in/.test(ics)
   && /mailto:arshdeep@enout.in/.test(ics) && /mailto:ayush@enout.in/.test(ics));
ok("every iCalendar line is within 75 octets", icsRaw.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));

console.log("\n2. nothing is sent twice");
contacts[0].updatedAt = "2026-11-02T20:29:00.000Z";               /* touched again, same call-back */
const r2 = await go();
ok("an unchanged call-back is not re-sent", r2.unchanged === 1 && mails.length === 1, JSON.stringify(r2));

console.log("\n3. a moved call-back moves the block");
contacts[0].customFieldValues.cfNextCallDate = "2026-11-06T09:00:00.000Z";   /* 2:30 PM IST, 6 Nov */
contacts[0].updatedAt = "2026-11-02T20:29:30.000Z";
const r3 = await go();
const ics3 = parts(mails[1]?.raw || "")["text/calendar"] || "";
ok("one update, not a second block", r3.moved === 1 && mails.length === 2 && /UID:kylas-call-5381193@enout.in/.test(ics3) && /SEQUENCE:1/.test(ics3), JSON.stringify(r3));
ok("at the new time", /DTSTART:20261106T090000Z/.test(ics3) && /2:30 PM IST/.test(parts(mails[1].raw).subject), parts(mails[1].raw).subject);

console.log("\n4. a cleared call-back takes the block off");
contacts[0].customFieldValues.cfNextCallDate = null;
contacts[0].updatedAt = "2026-11-02T20:29:45.000Z";
const r4 = await go();
const ics4 = parts(mails[2]?.raw || "")["text/calendar"] || "";
ok("a CANCEL for the same event", r4.cancelled === 1 && /METHOD:CANCEL/.test(ics4) && /UID:kylas-call-5381193@enout.in/.test(ics4) && /SEQUENCE:2/.test(ics4), JSON.stringify(r4));

console.log("\n5. the past and the watermark");
contacts = [contact(777, "2026-10-20T03:30:00.000Z", { updatedAt: "2026-11-02T20:29:59.000Z" })];
const before = mails.length;
const r5 = await go();
ok("a call-back already in the past is not sent", r5.past === 1 && mails.length === before, JSON.stringify(r5));
ok("the first run starts where the old script stopped", r1.since === FIRST_SINCE);
ok("later runs start where the last one ended (less a two-minute overlap)", r5.since === new Date(NOW.getTime() - 120000).toISOString(), r5.since);

console.log("\n5b. the company named when Kylas sends only its id");
const bare = contact(8881, "2026-11-05T03:30:00.000Z", { updatedAt: "2026-11-02T20:29:59.500Z", company: { id: 77 }, metaData: {} });
contacts = [bare];
const b0 = mails.length;
await go();
ok("the subject carries the company (acpl), as the old script's did", /Call Scheduled: Gunjan \(acpl\)/.test(parts(mails[b0]?.raw || "").subject), parts(mails[b0]?.raw || "").subject);

console.log("\n6. switched off");
const r6 = await run({ env: { ...env, CALENDAR_INVITES: "0" }, store: kv, kylas, connect, now: NOW });
ok("CALENDAR_INVITES = 0 sends nothing", !!r6.skipped);
ok("a date with no time reads as 9:00 AM, as the old mails did", whenOf("2026-11-09", "").label === "Nov 09, 2026 at 9:00 AM IST");

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
