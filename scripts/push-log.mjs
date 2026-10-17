/* THE RECORD OF WHAT WAS PUSHED TO KYLAS, AND WHAT WAS NOT.
 *
 * Ayush, 2026-10-17: "have existing data points, let us start tracking
 * everything (sync back module ke end mein Airtable se Kylas pe data push karo)
 * -> data push hone ke baad: successfully pushed / yeh data push nahi hua."
 *
 * Until this, the answer to "did last night's push work" was a line in
 * `wrangler tail` that scrolled away. The nightly push wrote to the live CRM,
 * counted its writes in a number, and kept nothing. Now every contact it
 * touches leaves a row, and every row says one of three things:
 *
 *   Pushed        every value was sent, Kylas accepted it, and a read-back of
 *                 the record shows it there. The only word that means "done".
 *   Partly pushed some values landed and some did not; the row names both.
 *   Not pushed    nothing landed; the row says why.
 *
 * "Verified" is the read-back. A 200 from the contact endpoint means the
 * request was well formed and never that anything was stored — this repo has
 * been bitten by exactly that (a company's owner, `probe-write.mjs`'s DROPPED).
 *
 * ONE ROW PER CONTACT PER RUN, not one per field. A night is at most
 * PUSH_LIMIT contacts, so the log grows by at most that much a day; one row per
 * field would double it and make the table harder to read. The per-field
 * outcome is in `Detail` as JSON, and in `Pushed` / `Not Pushed` as words.
 *
 * ALSO KEPT: a row per run (`Contact` = "(run)") that carries what the map found
 * wrong BEFORE any contact was touched — a field this account does not have, a
 * field whose type is not the kind we send. Those are the failures with no
 * contact attached to them, and the digest needs somewhere to read them from.
 *
 * NOTHING HERE MAY FAIL A PUSH. The log is a witness; a push that is refused
 * because its record could not be written is a push that stops telling the
 * truth. Every function returns `{ stored: false, why }` instead of throwing,
 * and the common cause — the table has not been created yet — says so and names
 * the command.
 */
import { upsertManyTolerant, listTolerant } from "./airtable.mjs";

export const PUSH_LOG = "Push Log";
export const FIELD_MAP_TABLE = "Field Map";

const NO_TABLE = /NOT_FOUND|INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND|Could not find table/i;
const noTable = (table) => `no "${table}" table in the base — run: node scripts/repair-base.mjs`;
const short = (s, n = 220) => String(s ?? "").slice(0, n);

/* The word for a per-field status, for a human reading the row. */
const WHY = {
  pushed: "pushed and verified",
  dropped: "Kylas answered OK but kept nothing",
  mismatch: "Kylas kept a different value",
  type: "held back: wrong type for the Kylas field",
  unmapped: "no such field on this Kylas account",
  refused: "Kylas refused the write",
  unread: "written, but the record could not be read back",
};
export const whyOf = (status) => WHY[status] || status;

/* outcomes: [{ key, label, kylasField, sent, got, status, why }] for one contact. */
export function contactRow({ run, at, source = "Nightly push", kid, name = "", outcomes = [], error = "" }) {
  const ok = outcomes.filter((o) => o.status === "pushed");
  const bad = outcomes.filter((o) => o.status !== "pushed");
  const status = !outcomes.length ? "Not pushed" : !bad.length ? "Pushed" : ok.length ? "Partly pushed" : "Not pushed";
  const reason = bad.map((o) => `${o.label || o.key}: ${o.why || whyOf(o.status)}`).join("\n") || error;
  return {
    Key: `${run}|${kid || name || "?"}`, Run: run, At: at, Source: source,
    "Kylas ID": String(kid || ""), Contact: short(name, 120), Status: status,
    Pushed: ok.map((o) => o.label || o.key).join(", "),
    "Not Pushed": bad.map((o) => o.label || o.key).join(", "),
    Reason: short(reason, 900),
    Verified: !!outcomes.length && !bad.length,
    Detail: short(JSON.stringify(outcomes.map((o) => ({
      k: o.key, f: o.kylasField, s: o.status, sent: o.sent, got: o.got, why: o.why }))), 9000),
  };
}

/* The run row: what the map found wrong before any contact was touched, and
   the totals, so one row answers "how did the night go". */
export function runRow({ run, at, source = "Nightly push", totals = {}, mapProblems = [] }) {
  const status = mapProblems.length || totals.notPushed ? (totals.pushed ? "Partly pushed" : "Not pushed") : "Pushed";
  return {
    Key: `${run}|run`, Run: run, At: at, Source: source, "Kylas ID": "", Contact: "(run)", Status: status,
    Pushed: String(totals.pushed ?? 0), "Not Pushed": String((totals.notPushed ?? 0) + (totals.gone ?? 0)),
    Reason: short(mapProblems.map((p) => `${p.label}: ${p.note}`).join("\n"), 900),
    Verified: !(mapProblems.length || totals.notPushed),
    Detail: short(JSON.stringify({ totals, mapProblems }), 9000),
  };
}

export async function recordPush(at, rows, { log = () => {} } = {}) {
  if (!at || !rows?.length) return { stored: false, why: rows?.length ? "no Airtable client" : "nothing to record", rows: 0 };
  try {
    const { dropped } = await upsertManyTolerant(at, PUSH_LOG, "Key", rows);
    if (dropped?.length) log(`  ! ${PUSH_LOG} has no column for: ${dropped.join(", ")} — run scripts/repair-base.mjs`);
    return { stored: true, rows: rows.length, dropped: dropped || [] };
  } catch (e) {
    const why = NO_TABLE.test(e.message) ? noTable(PUSH_LOG) : short(e.message, 160);
    log(`  ! push log not written — ${why}`);
    return { stored: false, why, rows: 0 };
  }
}

/* The Field Map table: one row per datum, overwritten each time it is checked.
   `Last Pushed At` and `Last Error` are written only by a push, so a row the
   CLI writes does not erase what the last night said. */
export async function storeFieldMap(at, resolved, { log = () => {}, now = new Date().toISOString(), last = {} } = {}) {
  if (!at) return { stored: false, why: "no Airtable client", rows: 0 };
  const rows = resolved.map((r) => {
    const l = last[r.key] || {};
    return {
      Key: r.key, Datum: r.label, Flow: r.via, Entity: r.entity,
      "Airtable Table": r.airtableTable, "Airtable Field": r.airtableField, "Airtable Type": r.airtableType,
      "Kylas Field": r.kylasField || "", "Kylas Type": r.kylasType || "", Sends: r.sends,
      Status: r.status, Note: short(r.note, 300), "Last Checked": now,
      ...(l.at ? { "Last Pushed At": l.at } : {}),
      ...(l.error !== undefined ? { "Last Error": short(l.error, 300) } : {}),
    };
  });
  try {
    const { dropped } = await upsertManyTolerant(at, FIELD_MAP_TABLE, "Key", rows);
    if (dropped?.length) log(`  ! ${FIELD_MAP_TABLE} has no column for: ${dropped.join(", ")} — run scripts/repair-base.mjs`);
    return { stored: true, rows: rows.length, dropped: dropped || [] };
  } catch (e) {
    const why = NO_TABLE.test(e.message) ? noTable(FIELD_MAP_TABLE) : short(e.message, 160);
    log(`  ! field map not written — ${why}`);
    return { stored: false, why, rows: 0 };
  }
}

/* The log between two instants, or null when there is nothing to read from
   (no table, no client). The digest treats null as "not tracked yet" and says
   so, rather than printing a zero it has no grounds for. */
export async function readPushLog(at, { fromIso, toIso } = {}) {
  if (!at) return null;
  /* ONE-SIDED IN THE FORMULA, THE OTHER SIDE IN CODE. The window's end is
     filtered here rather than with IS_BEFORE: the mock stand-in only speaks the
     single IS_AFTER shape, and a log read with a formula the tests cannot run is
     a log read nobody tested. The table is a few hundred rows a month. */
  const formula = `IS_AFTER({At}, '${fromIso}')`;
  const end = Date.parse(toIso);
  try {
    return (await listTolerant(at, PUSH_LOG, { formula, pageSize: 100, maxPages: 200 })).map((r) => r.fields || {})
      .filter((f) => !Number.isFinite(end) || !f.At || Date.parse(f.At) <= end);
  } catch (e) {
    if (NO_TABLE.test(e.message)) return null;
    throw e;
  }
}

/* What the digest prints. `rows` are Push Log rows (fields only). */
export function summarisePush(rows) {
  if (!rows) return null;
  const out = { runs: 0, contacts: 0, pushed: 0, partly: 0, notPushed: 0, verified: 0, gone: 0,
                problems: [], mapProblems: [] };
  for (const r of rows) {
    if (r.Contact === "(run)") {
      out.runs++;
      try { for (const p of JSON.parse(r.Detail || "{}").mapProblems || []) out.mapProblems.push(p); } catch { /* a hand-edited row */ }
      continue;
    }
    out.contacts++;
    if (r.Status === "Pushed") out.pushed++;
    else if (r.Status === "Partly pushed") out.partly++;
    else out.notPushed++;
    if (r.Verified) out.verified++;
    if (r.Status !== "Pushed")
      out.problems.push({ what: `${r.Contact || "contact"}${r["Kylas ID"] ? ` (${r["Kylas ID"]})` : ""}`,
                          why: String(r.Reason || r["Not Pushed"] || "no reason recorded").split("\n")[0] });
  }
  /* The same map problem on every run of the day is one problem. */
  const seen = new Set();
  out.mapProblems = out.mapProblems.filter((p) => (seen.has(p.key) ? false : seen.add(p.key)));
  return out;
}
