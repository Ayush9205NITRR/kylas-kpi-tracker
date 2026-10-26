/* THE MORNING MAIL, ONE PER BD.
 *
 * Ayush, 2026-10-26: every BD gets their own — their accounts that are called but
 * still below Activation and what changed since yesterday, plus "you have n
 * contacts whose reason is still owed". Admins keep the team-wide mail
 * (below-activation.mjs, unchanged). The address is the BD's own Kylas e-mail,
 * matched on the owner's name.
 *
 * Pure: the handlers pass in the day's stuck list, the changes, the contacts that
 * owe a reason and the Kylas users; nothing here reads or sends.
 */
import { renderText, renderHtml, subjectOf } from "./below-activation.mjs";
import { RCA_GATE } from "./rca.mjs";

export const nameKey = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const same = (a, b) => !!nameKey(a) && nameKey(a) === nameKey(b);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "there";

/* The part of the team-wide picture that is this owner's. */
export function forOwner(owner, stuck = [], ch = {}) {
  const mine = (x) => same(x.owner, owner);
  return {
    stuck: stuck.filter(mine),
    ch: { first: !!ch.first, added: (ch.added || []).filter(mine), climbed: (ch.climbed || []).filter(mine),
          closed: (ch.closed || []).filter(mine), moved: (ch.moved || []).filter(mine) },
  };
}

/* Who gets one, and who does not and why. owners: names (from the stuck list, the
   changes and the contacts owing a reason). users: Kylas users { id, name, email,
   active }. A name that is not exactly one active user at the company domain gets
   no mail — better a skipped BD in the log than somebody else's list in an inbox. */
export function recipients(owners = [], users = [], { domain = "", apiUser = "" } = {}) {
  const to = [], skipped = [];
  const seen = new Set();
  for (const owner of owners) {
    const k = nameKey(owner);
    if (!k || k === "—" || seen.has(k)) continue;
    seen.add(k);
    if (/super\s*admin/.test(k)) { skipped.push({ owner, why: "api user" }); continue; }
    const hits = users.filter((u) => same(u.name, owner));
    if (!hits.length) { skipped.push({ owner, why: "no Kylas user of that name" }); continue; }
    if (hits.length > 1) { skipped.push({ owner, why: "two Kylas users share the name" }); continue; }
    const u = hits[0];
    if (apiUser && String(u.id) === String(apiUser)) { skipped.push({ owner, why: "api user" }); continue; }
    if (u.active === false) { skipped.push({ owner, why: "deactivated" }); continue; }
    const email = String(u.email || "").trim().toLowerCase();
    if (!email) { skipped.push({ owner, why: "no e-mail on the Kylas user" }); continue; }
    if (domain && email.split("@")[1] !== domain.toLowerCase()) { skipped.push({ owner, why: "e-mail outside the company domain" }); continue; }
    to.push({ owner, email });
  }
  return { to, skipped };
}

const gateTitle = (g) => RCA_GATE?.[g]?.title || g;
const DUE_LIST = 8;

/* due: [{ name, gate, days }] — this owner's contacts waiting for a reason. */
export function renderBd({ owner, day, stuck = [], ch = { first: true, added: [], climbed: [], closed: [], moved: [] },
                           due = [], labels = {} }) {
  const hi = `Hi ${first(owner)},`;
  const n = due.length;
  const dueSorted = due.slice().sort((a, b) => (b.days || 0) - (a.days || 0));
  const subject = (stuck.length || ch.climbed.length || ch.closed.length ? subjectOf(day, stuck, ch).replace("BD · called, below Activation", "Your accounts · called, below Activation") : `Your day · ${day}`)
    + (n ? ` · ${n} reason${n === 1 ? "" : "s"} due` : "");

  const dueText = n ? [`${n} of your contact${n === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} stalled and the reason is still owed:`,
    ...dueSorted.slice(0, DUE_LIST).map((d) => `  ${d.name} — stuck ${d.days} days · ${gateTitle(d.gate)}`),
    ...(n > DUE_LIST ? [`  …and ${n - DUE_LIST} more`] : []),
    "Open the console and tap Reasons at the top — one click each.", ""] : [];
  const body = stuck.length || ch.climbed.length || ch.closed.length
    ? renderText(day, stuck, ch, { labels })
    : "None of your accounts is called-but-below-Activation today.";
  const text = [hi, "", ...dueText, body].join("\n");

  const amber = n ? `<div style="border:1px solid #f0c36d;background:#fff8e6;border-radius:8px;padding:10px 14px;margin:0 0 14px;font:13px/1.45 system-ui;color:#5c4400">` +
    `<b>${n} of your contact${n === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} stalled and the reason is still owed.</b>` +
    `<ul style="margin:6px 0 6px;padding-left:18px">${dueSorted.slice(0, DUE_LIST).map((d) => `<li>${esc(d.name)} — stuck ${d.days} days · ${esc(gateTitle(d.gate))}</li>`).join("")}</ul>` +
    `${n > DUE_LIST ? `<div>…and ${n - DUE_LIST} more</div>` : ""}Open the console and tap <b>Reasons</b> at the top — one click each.</div>` : "";
  const inner = stuck.length || ch.climbed.length || ch.closed.length
    ? renderHtml(day, stuck, ch, { labels }) : `<p style="font:13px system-ui;color:#444">None of your accounts is called-but-below-Activation today.</p>`;
  const html = `<div style="max-width:680px"><p style="font:14px system-ui;color:#111;margin:0 0 10px">${esc(hi)}</p>${amber}${inner}</div>`;
  return { subject, text, html };
}

/* EVERYTHING THE HANDLER NEEDS TO SEND, decided here so it can be tested without
   a mail server: who gets a mail today, what it says, and who was skipped and
   why. A BD with nothing called-and-stuck, no change and nothing owed gets none —
   an empty mail every morning teaches people to ignore the full ones. */
export function planBdMails({ stuck = [], ch = {}, due = [], users = [], domain = "", apiUser = "", labels = {}, day = "" } = {}) {
  const names = [...new Set([...stuck, ...(ch.added || []), ...(ch.climbed || []), ...(ch.closed || []), ...(ch.moved || []), ...due]
    .map((x) => x.owner).filter(Boolean))];
  const { to, skipped } = recipients(names, users, { domain, apiUser });
  const mails = [];
  for (const { owner, email } of to) {
    const mine = forOwner(owner, stuck, ch);
    const owed = due.filter((x) => same(x.owner, owner));
    if (!mine.stuck.length && !mine.ch.climbed.length && !mine.ch.closed.length && !owed.length) continue;
    mails.push({ owner, email, ...renderBd({ owner, day, ...mine, due: owed, labels }) });
  }
  return { mails, skipped };
}
