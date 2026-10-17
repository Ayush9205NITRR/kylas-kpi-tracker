/* THE DAILY WRITE-BACK EMAIL.
 *
 * Ayush, 2026-09-29: "I should get an email — how many contacts have been
 * updated, and how many accounts have been created."
 *
 * WHAT IT COUNTS, AND WHY IT COUNTS THAT. Not what the console meant to do:
 * what actually reached Kylas. Every save is a row in the D1 save queue, and
 * each finished row carries the `wrote` list the save itself built — "created
 * contact", "updated contact", "logged call" — plus whichever leg failed. So
 * the digest reads the job rows for the day and counts them. A save that was
 * rejected is in there too, named, because a number that quietly excludes
 * failures is how a broken write-back goes unnoticed for a week.
 *
 * ACCOUNTS CREATED IS HONEST ABOUT BEING ZERO. The console has never created a
 * company in Kylas — it attaches contacts to companies that already exist —
 * and a digest that prints a number there would be inventing one. It prints
 * the accounts the console SAVED FOR THE FIRST TIME instead (new to the KPI
 * base), under its own name, and says the Kylas figure is zero by design.
 *
 * SENDING. No mail provider is a dependency: `sendDigest` posts to whatever
 * MAIL_URL is set to, with MAIL_KEY as its bearer, in the shape Resend and
 * most others accept ({from, to, subject, text, html}). With nothing set it
 * logs the digest and returns "not configured", which is also what it does in
 * every test — nothing here can email anybody by accident.
 */
import { dayOf, today as todayIn, IST_MIN } from "./day.mjs";

/* ── counting ──────────────────────────────────────────────────────────── */

const wroteHas = (j, what) => (j.result?.wrote || []).some((w) => w.startsWith(what));

/* rows: what saveQueue.finishedSince() returns.
   newCompanies / newContacts: ids first saved on this day, from the KPI base. */
export function summarise(rows = [], { day, newCompanies = 0, seenCompanies = new Set(), push } = {}) {
  const out = {
    day,
    contactsUpdated: 0, contactsCreated: 0, callsLogged: 0,
    accountsTouched: seenCompanies.size, accountsFirstSaved: newCompanies,
    accountsCreatedInKylas: 0,          /* by design — see the header */
    failed: 0, partial: 0, failures: [],
    /* THE AIRTABLE -> KYLAS PUSH (scripts/push-log.mjs). undefined: the caller
       did not look. null: it looked and there is nowhere to read it from (the
       Push Log table does not exist). An object: what the last night did. */
    push,
    /* Saves that left a value off because Kylas has no field for it. The save
       itself succeeded, which is why only a count can show it. */
    unmappedSaves: 0, unmappedWhat: [],
  };
  for (const j of rows) {
    if (j.state === "failed") {
      out.failed++;
      const why = j.error?.message || j.error || "no reason recorded";
      out.failures.push({ what: j.result?.kid ? `contact ${j.result.kid}` : "a new contact",
                          why: String(why).slice(0, 160), tries: j.tries });
      continue;
    }
    if (wroteHas(j, "created contact")) out.contactsCreated++;
    else if (wroteHas(j, "updated contact") || wroteHas(j, "adopted")) out.contactsUpdated++;
    if (wroteHas(j, "logged call")) out.callsLogged++;
    if (j.result?.unmapped?.length) {
      out.unmappedSaves++;
      for (const w of j.result.unmapped) if (!out.unmappedWhat.includes(w)) out.unmappedWhat.push(w);
    }
    /* A save whose Kylas half landed and whose Airtable half did not is not a
       failure and is not a clean success either. It is the one that silently
       costs a KPI, so it is counted and named. */
    if (j.result?.airtableError || j.result?.callLogError) {
      out.partial++;
      out.failures.push({ what: `contact ${j.result.kid || "?"} (part of the save)`,
                          why: String(j.result.airtableError || j.result.callLogError).slice(0, 160),
                          tries: j.tries });
    }
  }
  return out;
}

/* ── rendering ─────────────────────────────────────────────────────────── */

const LINES = [
  ["Contacts updated in Kylas", "contactsUpdated"],
  ["Contacts created in Kylas", "contactsCreated"],
  ["Calls logged in Kylas", "callsLogged"],
  ["Accounts worked", "accountsTouched"],
  ["Accounts saved here for the first time", "accountsFirstSaved"],
];

export function renderText(s) {
  const rows = LINES.map(([label, k]) => `  ${String(s[k]).padStart(5)}  ${label}`);
  const body = [
    `BD console → Kylas, ${s.day}`,
    "",
    ...rows,
    `      0  Accounts created in Kylas (the console never creates companies)`,
    "",
  ];
  if (s.failed || s.partial) {
    body.push(`${s.failed} save(s) failed, ${s.partial} landed only halfway:`);
    for (const f of s.failures.slice(0, 20)) body.push(`  · ${f.what} — ${f.why}${f.tries ? ` (${f.tries} tries)` : ""}`);
    if (s.failures.length > 20) body.push(`  · …and ${s.failures.length - 20} more`);
  } else if (s.contactsUpdated + s.contactsCreated + s.callsLogged) {
    body.push("Nothing failed.");
  } else {
    body.push("Nothing was saved yesterday.");
  }
  body.push(...pushLines(s));
  return body.join("\n");
}

/* THE PUSH SECTION, SHARED BY THE TEXT AND HTML RENDERERS. Returns plain lines;
   empty when the caller did not look (older callers, every test that predates
   this). A missing Push Log table is said, not shown as zero: zero would read
   as "nothing needed pushing". */
export function pushLines(s) {
  const out = [];
  if (s.push === undefined && !s.unmappedSaves) return out;
  out.push("", "Airtable → Kylas push");
  if (s.push === null) out.push("  Not tracked yet — the Push Log table does not exist. Run: node scripts/repair-base.mjs");
  else if (s.push) {
    const p = s.push;
    if (!p.contacts && !p.runs) out.push("  No push ran in the last 24 hours.");
    else {
      out.push(`  ${String(p.pushed).padStart(5)}  pushed, and read back from Kylas`);
      out.push(`  ${String(p.partly).padStart(5)}  partly pushed`);
      out.push(`  ${String(p.notPushed).padStart(5)}  NOT pushed`);
      for (const f of p.problems.slice(0, 15)) out.push(`  · ${f.what} — ${f.why}`);
      if (p.problems.length > 15) out.push(`  · …and ${p.problems.length - 15} more`);
    }
    if (p.mapProblems.length) {
      out.push("", "Field map — these will not reach Kylas until fixed:");
      for (const m of p.mapProblems) out.push(`  · ${m.label}: ${m.note}`);
    }
  }
  if (s.unmappedSaves)
    out.push("", `${s.unmappedSaves} save(s) left a value off because Kylas has no field for it: ${s.unmappedWhat.join(", ")}.`);
  return out;
}

/* Anything in the push the reader must act on, for the subject line. */
export function attention(s) {
  const p = s.push;
  return (p ? p.partly + p.notPushed + p.mapProblems.length : 0) + (s.unmappedSaves ? 1 : 0);
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function renderHtml(s) {
  const row = (label, n, dim) =>
    `<tr><td style="padding:6px 14px 6px 0;font:600 22px/1.2 system-ui;color:${dim ? "#8b8b9a" : "#111"}">${n}</td>` +
    `<td style="padding:6px 0;font:14px/1.4 system-ui;color:#4a4a57">${esc(label)}</td></tr>`;
  const fails = s.failures.length
    ? `<p style="font:14px/1.5 system-ui;color:#b4232a;margin:18px 0 6px">` +
      `${s.failed} failed, ${s.partial} landed only halfway</p><ul style="font:13px/1.6 system-ui;color:#4a4a57;margin:0;padding-left:18px">` +
      s.failures.slice(0, 20).map((f) => `<li>${esc(f.what)} — ${esc(f.why)}</li>`).join("") + `</ul>`
    : `<p style="font:14px/1.5 system-ui;color:#4a4a57;margin:18px 0 0">Nothing failed.</p>`;
  const pl = pushLines(s);
  const pushHtml = pl.length
    ? `<p style="font:600 14px/1.4 system-ui;color:${attention(s) ? "#b4232a" : "#111"};margin:22px 0 6px">${esc(pl[1])}</p>` +
      `<div style="font:13px/1.6 system-ui;color:#4a4a57">${pl.slice(2).map((l) => l ? `<div>${esc(l).replace(/^ {2}/, "&nbsp;&nbsp;")}</div>` : `<div style="height:8px"></div>`).join("")}</div>`
    : "";
  return `<div style="max-width:520px"><p style="font:600 15px/1.3 system-ui;color:#111;margin:0 0 14px">` +
    `BD console → Kylas · ${esc(s.day)}</p><table cellspacing="0" cellpadding="0">` +
    LINES.map(([label, k]) => row(label, s[k])).join("") +
    row("Accounts created in Kylas (never — the console does not create companies)", 0, true) +
    `</table>${fails}${pushHtml}</div>`;
}

/* ── sending ───────────────────────────────────────────────────────────── */

export async function sendDigest(env = {}, s, { log = () => {}, fetchImpl = fetch } = {}) {
  const url = env.MAIL_URL, key = env.MAIL_KEY, to = env.MAIL_TO, from = env.MAIL_FROM;
  const text = renderText(s);
  if (!url || !to || !from) { log(`digest (not sent — set MAIL_URL, MAIL_KEY, MAIL_FROM, MAIL_TO):\n${text}`);
    return { sent: false, why: "not configured", text }; }
  const body = { from, to: String(to).split(",").map((x) => x.trim()).filter(Boolean),
                 subject: `${attention(s) ? "⚠ " : ""}BD console → Kylas · ${s.day} · ${s.contactsUpdated} updated, ${s.contactsCreated} created` +
                    (attention(s) ? ` · ${attention(s)} need attention` : ""),
                 text, html: renderHtml(s) };
  const res = await fetchImpl(url, { method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body) });
  const out = await res.text().catch(() => "");
  if (!res.ok) { log(`! digest not sent — ${res.status} ${out.slice(0, 160)}`); return { sent: false, why: `${res.status}`, text }; }
  log(`digest sent to ${to}`);
  return { sent: true, text };
}

/* ── the day's window ──────────────────────────────────────────────────── */

/* Midnight to midnight where the associates are, as everything else here is.
   Called after midnight for the day that just ended. */
export function windowFor(dayStr, tzMin = IST_MIN) {
  const from = Date.parse(`${dayStr}T00:00:00Z`) - tzMin * 60000;
  return { from, to: from + 86400000 };
}

export const yesterdayIn = (tzMin = IST_MIN, now = Date.now()) => todayIn(tzMin, now - 86400000);
export { dayOf };
