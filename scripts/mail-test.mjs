#!/usr/bin/env node
/* SEND ONE TEST MAIL THROUGH THE SAME SMTP CODE THE DAILY DIGEST USES.
 *
 *   MAIL_SMTP_USER=you@gmail.com MAIL_SMTP_PASS='abcd efgh ijkl mnop' MAIL_TO=ayush@enout.in \
 *     node scripts/mail-test.mjs
 *   (or put the three in .env.local and run: node --env-file=.env.local scripts/mail-test.mjs)
 *
 * Checks the app password and Gmail's answer from this machine, without waiting
 * for the 06:00 cron. It uses Node's TLS socket; the Worker uses cloudflare:sockets
 * for the same conversation, so this proves the credentials and the protocol, not
 * the Worker's socket. Prints the server's words on a refusal, never the password.
 */
import tls from "node:tls";
import { Readable, Writable } from "node:stream";
import { sendMail } from "./smtp.mjs";

const env = process.env;
const missing = ["MAIL_SMTP_USER", "MAIL_SMTP_PASS", "MAIL_TO"].filter((k) => !env[k]);
if (missing.length) { console.error(`Not set: ${missing.join(", ")}`); process.exit(1); }

const connect = (host, port) => new Promise((resolve, reject) => {
  const s = tls.connect({ host, port, servername: host }, () => resolve({
    readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy() }));
  s.once("error", reject);
});

const host = env.MAIL_SMTP_HOST || "smtp.gmail.com", port = Number(env.MAIL_SMTP_PORT) || 465;
try {
  const r = await sendMail({
    host, port, user: env.MAIL_SMTP_USER, pass: env.MAIL_SMTP_PASS, from: env.MAIL_FROM || env.MAIL_SMTP_USER,
    to: String(env.MAIL_TO).split(",").map((x) => x.trim()),
    subject: "BD console · test mail ✓",
    text: "If you can read this, the app password works and the daily digest can reach you.",
    html: "<p>If you can read this, the app password works and the daily digest can reach you.</p>",
  }, { connect });
  console.log(`Sent to ${env.MAIL_TO}. Server said: ${r.reply}`);
} catch (e) {
  console.error(String(e.message).replaceAll(env.MAIL_SMTP_PASS, "***"));
  process.exit(1);
}
