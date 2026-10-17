/* A MAIL SENDER FOR A GMAIL APP PASSWORD — SMTP OVER AN IMPLICIT-TLS SOCKET.
 *
 * Ayush, 2026-10-17: use the app password the other project (kylas-airtable-sync)
 * already sends mail with, rather than signing up to a mail API.
 *
 * A Gmail app password is an SMTP credential. It is not an API key and cannot
 * be sent to an HTTPS endpoint, so the digest's `MAIL_URL` path (Resend's shape)
 * cannot carry it. A Worker can open an outbound TCP socket with
 * `cloudflare:sockets`, so this speaks SMTP itself — about as much of it as one
 * message needs: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
 *
 * PORT 465 (TLS from the first byte), not 587/STARTTLS: one fewer step to get
 * wrong, and the socket is encrypted before the password is written to it.
 *
 * THE SOCKET IS INJECTED. `connect(host, port)` returns { readable, writable }
 * (web streams, which is what `cloudflare:sockets` gives and what Node can
 * adapt a net socket to), so the whole conversation is tested against a mock
 * SMTP server and nothing here can email anybody by accident.
 *
 * NEVER LOGGED: the password, and the AUTH line. Errors carry the server's
 * reply to the step that failed, which says "535 … Username and Password not
 * accepted" without repeating what was sent.
 *
 * THE BODIES GO OUT AS BASE64. A digest has long lines and non-ASCII (the ⚠ in
 * the subject, rupee signs, names); base64 sidesteps line-length limits,
 * dot-stuffing and 8-bit transport in one move.
 */

const CRLF = "\r\n";
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (s) => {
  const bytes = typeof s === "string" ? enc.encode(s) : s;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&" + CRLF).trimEnd();

/* "Name <a@b.c>" -> "a@b.c". The envelope wants the bare address. */
export const addressOf = (s) => {
  const m = String(s || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(s || "")).trim();
};

/* A header value that may hold non-ASCII (RFC 2047). */
const header = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`);

export function buildMessage({ from, to, subject, text, html, now = new Date(), id = crypto.randomUUID() }) {
  const boundary = `=_enout_${id.replace(/-/g, "")}`;
  const domain = addressOf(from).split("@")[1] || "localhost";
  const part = (type, body) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body))].join(CRLF);
  const lines = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${header(subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    part("text/plain", text || ""),
    ...(html ? [part("text/html", html)] : []),
    `--${boundary}--`,
    "",
  ];
  return lines.join(CRLF);
}

/* Read replies off the socket one at a time. A reply is one or more lines
   "250-…" ending with "250 …". */
function replies(readable, timeoutMs) {
  const reader = readable.getReader();
  let buf = "";
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smtp: no reply from the server")), timeoutMs);
    (async () => {
      for (;;) {
        /* Only complete lines count: "250 O" arriving before "K\r\n" is not a reply yet. */
        const lines = buf.split(CRLF).slice(0, -1);
        const done = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
        if (done >= 0) {
          const taken = lines.slice(0, done + 1);
          buf = buf.split(CRLF).slice(done + 1).join(CRLF);
          clearTimeout(timer);
          return resolve({ code: Number(taken[done].slice(0, 3)), text: taken.map((l) => l.slice(4)).join("\n") });
        }
        const { value, done: eof } = await reader.read();
        if (eof) { clearTimeout(timer); return reject(new Error("smtp: the server closed the connection")); }
        buf += dec.decode(value, { stream: true });
      }
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
  return { next, release: () => { try { reader.releaseLock(); } catch { /* already gone */ } } };
}

/* cfg: { host, port, user, pass, from, to: [..], subject, text, html }.
   Throws on any refusal, with the step and the server's words; resolves with
   { sent: true, id } when the server accepted the message. */
export async function sendMail(cfg, { connect, timeoutMs = 15000, now, id } = {}) {
  const { host = "smtp.gmail.com", port = 465, user, pass } = cfg;
  const to = (cfg.to || []).filter(Boolean);
  if (!user || !pass) throw new Error("smtp: no user or password");
  if (!to.length) throw new Error("smtp: no recipient");
  const from = cfg.from || user;
  const sock = await (connect || defaultConnect)(host, port);
  const w = sock.writable.getWriter();
  const r = replies(sock.readable, timeoutMs);
  const send = (line) => w.write(enc.encode(line + CRLF));
  const expect = async (what, ...ok) => {
    const got = await r.next();
    if (!ok.includes(got.code)) throw new Error(`smtp: ${what} refused — ${got.code} ${got.text.slice(0, 200)}`);
    return got;
  };
  try {
    await expect("greeting", 220);
    await send(`EHLO ${addressOf(from).split("@")[1] || "localhost"}`);
    await expect("EHLO", 250);
    await send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
    await expect("login", 235);
    await send(`MAIL FROM:<${addressOf(from)}>`);
    await expect("sender", 250);
    for (const t of to) { await send(`RCPT TO:<${addressOf(t)}>`); await expect(`recipient ${addressOf(t)}`, 250, 251); }
    await send("DATA");
    await expect("DATA", 354);
    const msg = buildMessage({ from, to, subject: cfg.subject, text: cfg.text, html: cfg.html, now, id });
    /* dot-stuffing: a line that starts with "." would end the message early. */
    await w.write(enc.encode(msg.replace(/^\./gm, "..") + CRLF + "." + CRLF));
    const done = await expect("message", 250);
    try { await send("QUIT"); } catch { /* it has the message */ }
    return { sent: true, reply: done.text.split("\n")[0] };
  } finally {
    r.release();
    try { w.releaseLock(); } catch { /* gone */ }
    try { await sock.close?.(); } catch { /* gone */ }
  }
}

/* In a Worker. Not imported at the top: `cloudflare:sockets` does not exist in
   Node, where every test runs, and a static import would stop this file loading. */
async function defaultConnect(host, port) {
  const { connect } = await import("cloudflare:sockets");
  const s = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  await s.opened;
  return s;
}
