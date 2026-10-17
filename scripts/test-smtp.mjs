#!/usr/bin/env node
/* THE SMTP SENDER (Gmail app password), AGAINST A MOCK SMTP SERVER.
 *
 *   node scripts/test-smtp.mjs
 *
 * A real server speaks first, answers in multi-line replies, and refuses a bad
 * password with a 535. The mock does all three, on a plain local socket (the
 * Worker's TLS is `cloudflare:sockets`' job; what is tested here is the
 * conversation). Nothing leaves this machine.
 */
import net from "node:net";
import { Readable, Writable } from "node:stream";
import { sendMail, buildMessage, addressOf } from "./smtp.mjs";
import { summarise, sendDigest } from "./digest.mjs";

let pass = 0, fail = 0;
const ok = (what, c, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${!c && d ? `  — ${d}` : ""}`); };

/* A tiny SMTP server. `script` can override one step's reply: { auth: "535 …" }. */
function server(script = {}) {
  const seen = { lines: [], data: "" };
  const srv = net.createServer((sock) => {
    let inData = false, buf = "";
    const say = (s) => sock.write(s + "\r\n");
    say("220 mock ESMTP");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          seen.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
          say(script.message || "250 2.0.0 OK queued"); continue;
        }
        const nl = buf.indexOf("\r\n"); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        seen.lines.push(line);
        if (/^EHLO/.test(line)) { sock.write("250-mock at your service\r\n250-SIZE 35882577\r\n250 AUTH PLAIN\r\n"); }
        else if (/^AUTH PLAIN/.test(line)) say(script.auth || "235 2.7.0 Accepted");
        else if (/^MAIL FROM/.test(line)) say("250 2.1.0 OK");
        else if (/^RCPT TO/.test(line)) say(script.rcpt && line.includes(script.rcptBad) ? script.rcpt : "250 2.1.5 OK");
        else if (/^DATA/.test(line)) { say("354 go ahead"); inData = true; }
        else if (/^QUIT/.test(line)) { say("221 bye"); sock.end(); }
      }
    });
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, seen, port: srv.address().port })));
}
const connectTo = (port) => async () => {
  const s = net.connect(port, "127.0.0.1");
  await new Promise((r, j) => { s.once("connect", r); s.once("error", j); });
  return { readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy() };
};

const cfg = { user: "ayush@enout.in", pass: "abcd efgh ijkl mnop", from: "ayush@enout.in", to: ["ayush@enout.in", "ops@enout.in"],
              subject: "⚠ BD console → Kylas · 2026-10-17 · 3 updated", text: "line one\n.a line that starts with a dot\n₹8L", html: "<p>hi</p>" };

console.log("\n1 · a whole conversation");
{
  const { srv, seen, port } = await server();
  const r = await sendMail(cfg, { connect: connectTo(port), timeoutMs: 3000 });
  srv.close();
  ok("the server accepted the message", r.sent === true, JSON.stringify(r));
  const L = seen.lines;
  ok("EHLO, AUTH, MAIL, RCPT x2, DATA, in that order",
    /^EHLO/.test(L[0]) && /^AUTH PLAIN/.test(L[1]) && /^MAIL FROM:<ayush@enout.in>$/.test(L[2]) &&
    /^RCPT TO:<ayush@enout.in>$/.test(L[3]) && /^RCPT TO:<ops@enout.in>$/.test(L[4]) && L[5] === "DATA", JSON.stringify(L));
  const auth = Buffer.from(L[1].split(" ")[2], "base64").toString();
  ok("AUTH PLAIN carries user and password, NUL-separated", auth === `\0${cfg.user}\0${cfg.pass}`);
  ok("the subject is RFC 2047 encoded, so the ⚠ survives", /^Subject: =\?UTF-8\?B\?/m.test(seen.data));
  ok("it is multipart/alternative with a text and an html part", /multipart\/alternative/.test(seen.data) && /text\/plain/.test(seen.data) && /text\/html/.test(seen.data));
  const textPart = seen.data.split(/--=_enout_\w+/)[1];
  const body = Buffer.from(textPart.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
  ok("the body round-trips, including the leading-dot line and the rupee sign", body === cfg.text, JSON.stringify(body));
  ok("no line of the message is over 998 characters", seen.data.split("\r\n").every((l) => l.length <= 998));
  ok("the password is nowhere in the message", !seen.data.includes(cfg.pass));
}

console.log("\n2 · refusals say which step, in the server's words");
{
  const a = await server({ auth: "535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 Learn more" });
  const e1 = await sendMail(cfg, { connect: connectTo(a.port), timeoutMs: 3000 }).catch((e) => e);
  a.srv.close();
  ok("a wrong app password is a 535 at login", /login refused — 535/.test(e1.message) && /not accepted/.test(e1.message), e1.message);
  ok("...and the error does not repeat the password", !e1.message.includes(cfg.pass));
  const b = await server({ rcpt: "550 5.1.1 no such user", rcptBad: "ops@" });
  const e2 = await sendMail(cfg, { connect: connectTo(b.port), timeoutMs: 3000 }).catch((e) => e);
  b.srv.close();
  ok("a refused recipient names the recipient", /recipient ops@enout.in refused — 550/.test(e2.message), e2.message);
  const e3 = await sendMail({ ...cfg, pass: "" }, { connect: connectTo(1) }).catch((e) => e);
  ok("no password is caught before any connection", /no user or password/.test(e3.message));
  const e4 = await sendMail({ ...cfg, to: [] }, { connect: connectTo(1) }).catch((e) => e);
  ok("no recipient likewise", /no recipient/.test(e4.message));
}

console.log("\n3 · a silent server times out instead of hanging the cron");
{
  const quiet = net.createServer(() => { /* says nothing */ });
  await new Promise((r) => quiet.listen(0, "127.0.0.1", r));
  const t0 = Date.now();
  const e = await sendMail(cfg, { connect: connectTo(quiet.address().port), timeoutMs: 300 }).catch((x) => x);
  quiet.close();
  ok("it gives up", /no reply/.test(e.message) && Date.now() - t0 < 2500, e.message);
}

console.log("\n4 · helpers");
{
  ok("addressOf strips a display name", addressOf("BD Console <ayush@enout.in>") === "ayush@enout.in");
  ok("...and leaves a bare address alone", addressOf(" a@b.c ") === "a@b.c");
  const m = buildMessage({ from: "a@b.c", to: ["d@e.f"], subject: "plain", text: "x", id: "1234-5678" });
  ok("an ASCII subject stays readable", /^Subject: plain$/m.test(m));
  ok("a text-only message has one part", !/text\/html/.test(m));
}

console.log("\n5 · the digest uses it when MAIL_SMTP_* is set");
{
  const s = summarise([{ state: "done", result: { wrote: ["updated contact"] } }], { day: "2026-10-17" });
  const { srv, seen, port } = await server();
  const logs = [];
  const sent = await sendDigest({ MAIL_SMTP_USER: "ayush@enout.in", MAIL_SMTP_PASS: "secretsecretsecr", MAIL_TO: "ayush@enout.in" }, s,
    { log: (m) => logs.push(m), connect: connectTo(port), fetchImpl: async () => { throw new Error("must not use HTTP"); } });
  srv.close();
  ok("it sent over SMTP, with MAIL_FROM defaulting to the user", sent.sent === true && /^MAIL FROM:<ayush@enout.in>$/m.test(seen.lines.join("\n")), JSON.stringify(sent));
  ok("the log says so and never prints the password", logs.some((l) => /smtp/.test(l)) && !logs.join("").includes("secretsecretsecr"));

  const bad = await server({ auth: "535 5.7.8 Username and Password not accepted" });
  const l2 = [];
  const refused = await sendDigest({ MAIL_SMTP_USER: "ayush@enout.in", MAIL_SMTP_PASS: "secretsecretsecr", MAIL_TO: "ayush@enout.in" }, s,
    { log: (m) => l2.push(m), connect: connectTo(bad.port) });
  bad.srv.close();
  ok("a refused login is { sent: false }, not a throw", refused.sent === false && /535/.test(refused.why), JSON.stringify(refused));
  ok("...logged, without the password", l2.some((l) => /not sent/.test(l)) && !l2.join("").includes("secretsecretsecr"));

  const none = await sendDigest({ MAIL_TO: "ayush@enout.in" }, s, { log: () => {} });
  ok("nothing set is still 'not configured'", none.sent === false && none.why === "not configured");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
