/* NAMED VIEWS — the rules, with nothing around them.
 *
 * A view is a named set of companies a BD saved: "Mumbai FMCG", "Ayush's
 * GPTW batch", "Call before Friday". It is Airtable's idea, and the reason it
 * belongs here is that the Accounts list is 18,000 rows and the filters that
 * get you to the forty you are actually working are not worth rebuilding
 * every morning.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The permission question — who may read,
 * who may change, who may delete — is the part that has to be right, and a
 * rule buried in a route handler is a rule nobody can test. Everything here
 * is pure: no store, no network, no clock it does not take as an argument.
 *
 * HOW IT IS STORED (handlers.mjs owns this, stated here because the shape is
 * the contract): ONE KEY PER VIEW, `view:<id>`. Two BDs saving two views
 * touch two keys and cannot overwrite each other — which a single "all the
 * views" document could not promise. Pins are per person, in `viewpins:<email>`,
 * so pinning a shared view is not a write to something everyone else is also
 * writing.
 *
 * WHO MAY DO WHAT
 *   read    a team view: everybody. A personal view: its owner, and admins.
 *   write   a team view: any signed-in BD — it is the team's list, and a
 *           shared list only one person can fix is a list that goes stale.
 *           A personal view: its owner, and admins.
 *   delete  its owner, and admins — for a team view too. Editing someone's
 *           shared list is collaboration; deleting it is not.
 */

export const VIEW_LIMITS = {
  name: 80,
  description: 500,
  companies: 5000,       /* a view is a working list, not a copy of the CRM */
  perOwner: 300,
  id: 64,
};

export const VISIBILITIES = ["team", "personal"];
export const SCOPES = ["both", "accounts", "contacts"];

const lc = (v) => String(v ?? "").trim().toLowerCase();

/* Control characters, zero-width joiners and the rest do not belong in a name
   that will be rendered, put in a title attribute and sorted. The renderer
   escapes too — this is so what is STORED is clean, rather than relying on
   every future reader to escape it. */
/* Built from escape sequences on purpose: the literal characters are
   invisible, and an invisible character inside a regex is how this file
   failed to parse the first time it was written. */
const BAD_CHARS = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\uFEFF]", "g");

export function cleanText(v, max) {
  return String(v ?? "")
    .replace(BAD_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function newViewId(rand = Math.random) {
  return "v" + Date.now().toString(36) + Math.floor(rand() * 1e9).toString(36);
}

export const viewKey = (id) => `view:${id}`;
export const pinsKey = (email) => `viewpins:${lc(email)}`;
export const isViewKey = (k) => typeof k === "string" && k.startsWith("view:");

/* A company id as everything else in this repo holds it: a string of digits.
   Anything else is dropped rather than stored and puzzled over later. */
export function cleanCompanies(list, max = VIEW_LIMITS.companies) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw?.id ?? raw ?? "").trim();
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/* WHAT A SAVE IS ALLOWED TO SAY. Returns { ok, errors, clean } — never throws,
   because the caller turns this into a 400 with the field named. */
export function checkView(body = {}, { existing = null } = {}) {
  const errors = {};
  const name = cleanText(body.name ?? existing?.name, VIEW_LIMITS.name);
  if (!name) errors.name = "A view needs a name";
  else if (name.length < 2) errors.name = "That name is too short to find again";

  const visibility = lc(body.visibility ?? existing?.visibility ?? "team");
  if (!VISIBILITIES.includes(visibility))
    errors.visibility = `Visibility is “team” or “personal”, not “${visibility}”`;

  const scope = lc(body.scope ?? existing?.scope ?? "both");
  if (!SCOPES.includes(scope))
    errors.scope = `Scope is one of ${SCOPES.join(", ")}`;

  const companies = body.companies === undefined
    ? (existing?.companies || [])
    : cleanCompanies(body.companies);
  if (Array.isArray(body.companies) && body.companies.length > VIEW_LIMITS.companies)
    errors.companies = `A view holds at most ${VIEW_LIMITS.companies} accounts`;

  return {
    ok: !Object.keys(errors).length,
    errors,
    clean: {
      name,
      description: cleanText(body.description ?? existing?.description ?? "", VIEW_LIMITS.description),
      visibility, scope, companies,
      /* Saved filters are the console's own state object. Stored as given and
         handed back untouched; the console is the only thing that reads it. */
      filters: body.filters === undefined ? (existing?.filters ?? null) : (body.filters || null),
    },
  };
}

export function canRead(view, me) {
  if (!view) return false;
  if (me?.admin) return true;
  if (view.visibility === "team") return true;
  return !!me?.email && lc(view.ownerEmail) === lc(me.email);
}

/* A team view is the team's: any signed-in BD may change it. A personal one is
   its owner's. */
export function canWrite(view, me) {
  if (!view) return false;
  if (me?.admin) return true;
  if (!me?.email) return false;
  if (view.visibility === "team") return true;
  return lc(view.ownerEmail) === lc(me.email);
}

/* Deleting is not editing. Someone else's shared list is not yours to remove,
   however freely you may add to it. */
export function canDelete(view, me) {
  if (!view) return false;
  if (me?.admin) return true;
  return !!me?.email && lc(view.ownerEmail) === lc(me.email);
}

/* What the console is told about a view. `can` is computed here so the UI
   never has to re-derive a permission and get it subtly different. */
export function viewForClient(view, me, { pinned = false } = {}) {
  return {
    id: view.id,
    name: view.name,
    description: view.description || "",
    visibility: view.visibility,
    scope: view.scope || "both",
    companies: view.companies || [],
    count: (view.companies || []).length,
    filters: view.filters || null,
    owner: view.ownerName || view.ownerEmail || "",
    ownerEmail: view.ownerEmail || "",
    mine: !!me?.email && lc(view.ownerEmail) === lc(me.email),
    pinned,
    createdAt: view.createdAt || null,
    updatedAt: view.updatedAt || null,
    updatedBy: view.updatedBy || "",
    rev: view.rev || 1,
    can: { write: canWrite(view, me), delete: canDelete(view, me) },
  };
}

/* Adding and removing in one step, order-independent: the same call twice
   leaves the same list, which is what makes a retry safe. */
export function mergeCompanies(current = [], { add = [], remove = [] } = {}) {
  const out = new Set(cleanCompanies(current));
  for (const id of cleanCompanies(add)) out.add(id);
  for (const id of cleanCompanies(remove)) out.delete(id);
  return [...out].slice(0, VIEW_LIMITS.companies);
}

/* Pinned first, then most recently used, then by name — so the strip reads
   the way a person expects without anybody having to drag anything. */
export function sortViews(list = []) {
  return [...list].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    || String(a.name || "").localeCompare(String(b.name || "")));
}

/* "Mumbai FMCG" -> "Mumbai FMCG (copy)", and again -> "(copy 2)", so
   duplicating twice does not make two things with one name. */
export function copyName(name, taken = []) {
  const have = new Set(taken.map((n) => lc(n)));
  const base = cleanText(name, VIEW_LIMITS.name - 12) || "View";
  let out = `${base} (copy)`;
  for (let n = 2; have.has(lc(out)); n++) out = `${base} (copy ${n})`;
  return out.slice(0, VIEW_LIMITS.name);
}
