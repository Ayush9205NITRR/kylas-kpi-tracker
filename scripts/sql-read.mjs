/* THE SAME ANSWERS, OUT OF THE SQL COPY.
 *
 * Gate 3 compares what the console would serve from Airtable with what it
 * would serve from SQL, so something has to produce the second one in exactly
 * the shape of the first. That is this file.
 *
 * It is deliberately a MIRROR of the readers in airtable.mjs rather than an
 * improvement on them. Anywhere it is tempted to be cleverer — to return a
 * real null where Airtable returns "", to sort more sensibly, to drop a field
 * nothing reads — it does not, because then a difference in the comparison
 * would mean "written differently" rather than "wrong", and a harness that
 * reports differences nobody will act on is a harness nobody reads.
 *
 * ONE QUERY PER READ. The whole point of the move is that a read is a query
 * next door instead of pages of Airtable, so a reader here that walked rows
 * one at a time would measure the wrong thing in the benchmark and teach the
 * wrong lesson in review.
 */

/* Airtable's ARRAYJOIN gives "Hema, Shipra"; the console wants a list. Same
   split as readCompanyKpis, on purpose. */
const names = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const flag = (v) => (v === 1 || v === true || v === "1" ? 1 : 0);

/* One row per company, KPI block attached — the shape readCompanies returns.
   `db` is anything with prepare().all(): a D1 binding, the fake, or
   node:sqlite. */
export async function readCompaniesSql(db) {
  const res = await db.prepare(`
    SELECT co."kylas_company_id", co."airtable_id", co."name", co."kylas_stage",
           co."last_called_at", co."account_health", co."source_of_data", co."batch",
           co."website", co."owner", co."kylas_owner_id", co."kylas_updated_at",
           v."kpi_rank", v."kpi_stage", v."kpi_stage_at", v."reached", v."phone_picked",
           v."right_poc", v."successful_discovery", v."sql_meeting_booked",
           v."sql_meeting_done", v."sql", v."right_poc_contacts", v."discovery_contacts",
           v."contact_count", v."last_call_at", v."call_count", v."talk_seconds"
    FROM "companies" co
    LEFT JOIN "v_companies" v ON v."id" = co."id"
    ORDER BY co."id"`).all();
  const rows = res?.results || res || [];
  return rows.map((r) => {
    const id = String(r.kylas_company_id || "");
    return {
      id,
      recordId: r.airtable_id,
      name: r.name || (id ? `Company ${id}` : ""),
      stage: r.kylas_stage || "",
      lastCalledAt: r.last_called_at || null,
      accountHealth: r.account_health || null,
      source: r.source_of_data || "",
      batch: r.batch || null,
      website: r.website || null,
      owner: r.owner || "",
      ownerId: String(r.kylas_owner_id || ""),
      /* A company with no Kylas id cannot be joined to anything the console
         holds, and readCompanyKpis skips it — so no KPI block here either,
         or the two sides would differ on a row neither can use. */
      kpi: id ? {
        rank: Number(r.kpi_rank || 0),
        stage: r.kpi_stage || "",
        /* Airtable returns "" for an empty formula, not null. */
        stageAt: r.kpi_stage_at || "",
        reached: flag(r.reached),
        picked: flag(r.phone_picked),
        right: flag(r.right_poc),
        discovery: flag(r.successful_discovery),
        booked: flag(r.sql_meeting_booked),
        done: flag(r.sql_meeting_done),
        sql: flag(r.sql),
        rightNames: names(r.right_poc_contacts),
        discoveryNames: names(r.discovery_contacts),
        contacts: Number(r.contact_count || 0),
        lastCalledAt: String(r.last_call_at || "").slice(0, 10),
        calls: Number(r.call_count || 0),
        talkSeconds: Number(r.talk_seconds || 0),
      } : null,
    };
  });
}

/* The four tables accountProgress() needs, in the shape it already expects —
   { id, fields } — so the SAME function computes the answer on both sides.
   Re-deriving next-call and TAT in SQL would be a second implementation of
   rules that are already tested (test-progress.mjs), and two implementations
   is exactly what this migration is trying to stop having. */
export async function progressInputsSql(db) {
  const q = async (sql) => ((await db.prepare(sql).all())?.results || []);
  const companies = (await q(`SELECT "id", "kylas_company_id" FROM "companies"`))
    .map((r) => ({ id: r.id, fields: { "Kylas Company ID": r.kylas_company_id } }));
  const contacts = (await q(`
    SELECT c."id", c."company_id", c."current_stage", c."kpi_rank", c."next_call_date"
    FROM "contacts" c`))
    .map((r) => ({ id: r.id, fields: {
      Company: r.company_id ? [r.company_id] : [],
      "Current Stage": r.current_stage || "",
      "KPI Rank": r.kpi_rank ?? 0,
      "Next Call Date": r.next_call_date || "",
    } }));
  const transitions = (await q(`
    SELECT "contact_id", "to_stage", "changed_at" FROM "stage_transitions"`))
    .map((r) => ({ id: 0, fields: {
      Contact: r.contact_id ? [r.contact_id] : [],
      "To Stage": r.to_stage || "", "Changed At": r.changed_at || "",
    } }));
  const calls = (await q(`
    SELECT "contact_id", "called_at", "next_call_date", "owner" FROM "call_log"`))
    .map((r) => ({ id: 0, fields: {
      Contact: r.contact_id ? [r.contact_id] : [],
      "Called At": r.called_at || "", "Next Call Date": r.next_call_date || "",
      Owner: r.owner || "",
    } }));
  return { companies, contacts, transitions, calls };
}

/* Focus, in the shape readFocus returns. */
export async function readFocusSql(db) {
  const rows = (await db.prepare(`
    SELECT "kylas_company_id", "company_name", "status", "reason", "note",
           "owner", "set_by", "set_at" FROM "focus"`).all())?.results || [];
  const out = {};
  for (const r of rows) {
    const id = String(r.kylas_company_id || "").trim();
    if (!id) continue;
    out[id] = { companyId: id, companyName: r.company_name || "", status: r.status || "",
                reason: r.reason || "", note: r.note || "", ownerName: r.owner || "",
                setByEmail: r.set_by || "", setAt: r.set_at || "" };
  }
  return out;
}
