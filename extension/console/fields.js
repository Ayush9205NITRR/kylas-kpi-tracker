/* GENERATED FROM scripts/gen-fields.mjs — do not edit.
   Regenerate with: node scripts/gen-fields.mjs
   Loaded before console.js; the names below hang off window.Fields. */
(function (global) {

/* ── dial codes ──────────────────────────────────────────────────────
   Not a complete list and does not need to be: it exists so a pasted
   international number splits at the right place. Longest match wins, so
   +1 cannot swallow +1809. India first because that is 99% of the book. */
const DIAL_CODES = [
  "+91", "+1", "+44", "+971", "+65", "+61", "+49", "+33", "+81", "+86",
  "+92", "+94", "+880", "+977", "+27", "+31", "+39", "+34", "+46", "+7",
  "+55", "+52", "+60", "+62", "+63", "+66", "+82", "+90", "+972", "+966",
  "+974", "+973", "+968", "+20", "+234", "+254", "+64", "+353", "+41",
];

/* ISO code alongside the dial code. The documented phoneNumbers shape carries
   both ({type, code, dialCode, value, primary}); sending dialCode alone is one
   of the few differences between our body and the collection's. */
const ISO_OF = {
  "+91": "IN", "+1": "US", "+44": "GB", "+971": "AE", "+65": "SG", "+61": "AU",
  "+49": "DE", "+33": "FR", "+81": "JP", "+86": "CN", "+92": "PK", "+94": "LK",
  "+880": "BD", "+977": "NP", "+27": "ZA", "+31": "NL", "+39": "IT", "+34": "ES",
  "+46": "SE", "+7": "RU", "+55": "BR", "+52": "MX", "+60": "MY", "+62": "ID",
  "+63": "PH", "+66": "TH", "+82": "KR", "+90": "TR", "+972": "IL", "+966": "SA",
  "+974": "QA", "+973": "BH", "+968": "OM", "+20": "EG", "+234": "NG",
  "+254": "KE", "+64": "NZ", "+353": "IE", "+41": "CH",
};

/* National-number length per dial code, where it is worth being strict. India
   is the only one we can be confident about, and it is the one that matters:
   a mobile is exactly 10 digits starting 6-9. Everything else gets the loose
   6-14 range, because rejecting a real number is worse than passing a wrong
   one to Kylas. */
const NATIONAL = { "+91": { len: [10, 10], first: "6789", landline: "2345" } };
const LOOSE = { len: [6, 14], first: "" };

const digitsOnly = (s) => String(s == null ? "" : s).replace(/\D+/g, "");

/* Splits whatever an associate pasted into { cc, value }.

   THE BUG THIS FIXES. Kylas returns { dialCode: "+91", value: "9848022338" },
   so value is the NATIONAL number. We used to write back whatever sat in the
   field, and a number typed or pasted as "+918319585041" went out as
   { dialCode: "+91", value: "+918319585041" } — the country code twice. Kylas
   rejected it as "Invalid Mobile Number", including on a PUT to a contact it
   had itself stored that way, so a contact could be created once and then
   never updated again. */
function splitPhone(raw, ccHint) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { cc: "", value: "" };

  /* An explicit + is the strongest signal there is. Take it. */
  const plus = s.replace(/[^\d+]/g, "");
  if (plus.startsWith("+")) {
    const hit = DIAL_CODES.filter((d) => plus.startsWith(d))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) return { cc: hit, value: digitsOnly(plus.slice(hit.length)) };
    return { cc: "", value: digitsOnly(plus) };
  }

  /* 00 is the other way of writing +. */
  let d = digitsOnly(s);
  if (d.startsWith("00")) return splitPhone("+" + d.slice(2), ccHint);

  const cc = ccHint && String(ccHint).startsWith("+") ? String(ccHint) : "+91";
  const bare = cc.slice(1);

  /* A national number carrying its own country code, with no plus:
     918319585041. Only strip it when what is left is the right length, so a
     genuine 10-digit number beginning 91 survives. */
  const want = NATIONAL[cc];
  if (want && d.startsWith(bare) && d.length === bare.length + want.len[0])
    d = d.slice(bare.length);

  /* The trunk 0 an Indian landline is dialled with. */
  if (want && d.length === want.len[1] + 1 && d.startsWith("0")) d = d.slice(1);

  return { cc, value: d };
}

/* The one number a dialler or a call log should see: +919848022338. */
function e164(phone) {
  const { cc, value } = splitPhone(phone && phone.value !== undefined ? phone.value : phone,
                                  phone && phone.cc);
  if (!value) return "";
  return (cc || "+91") + value;
}

/* How a person should read it back: +91 98480 22338. */
function prettyPhone(phone) {
  const { cc, value } = splitPhone(phone && phone.value !== undefined ? phone.value : phone,
                                  phone && phone.cc);
  if (!value) return "";
  const c = cc || "+91";
  if (c === "+91" && value.length === 10) return c + " " + value.slice(0, 5) + " " + value.slice(5);
  return c + " " + value;
}

/* opts is a cc string or { cc, type }. Type matters: Kylas' complaint is
   "Invalid MOBILE Number", and an Indian mobile starts 6-9 while a landline
   starts 2-5, so the strict rule can only be applied to a MOBILE. */
function checkPhone(raw, opts) {
  const o = typeof opts === "string" || opts == null ? { cc: opts || "" } : opts;
  const { cc, value } = splitPhone(raw, o.cc);
  if (!value) return { ok: false, why: "no digits in it", cc, value };
  const rule = NATIONAL[cc || "+91"] || LOOSE;
  if (value.length < rule.len[0] || value.length > rule.len[1]) {
    const want = rule.len[0] === rule.len[1] ? rule.len[0] + " digits"
      : rule.len[0] + "-" + rule.len[1] + " digits";
    return { ok: false, why: value.length + " digits after " + (cc || "+91") + ", needs " + want, cc, value };
  }
  const mobile = !o.type || String(o.type).toUpperCase() === "MOBILE";
  const allowed = mobile ? (rule.first || "") : (rule.first || "") + (rule.landline || "");
  if (allowed && !allowed.includes(value[0]))
    return { ok: false,
             why: mobile ? "an Indian mobile starts with " + rule.first.split("").join("/")
                         : "starts with " + value[0] + ", which is not a valid Indian number",
             cc, value };
  return { ok: true, why: "", cc, value };
}

/* Deliberately loose. The job is to catch a typo and a pasted sentence, not to
   argue with RFC 5322. */
function checkEmail(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return { ok: false, why: "empty", value: "" };
  if (/\s/.test(v)) return { ok: false, why: "has a space in it", value: v };
  if ((v.match(/@/g) || []).length !== 1) return { ok: false, why: "needs exactly one @", value: v };
  const [user, host] = v.split("@");
  if (!user) return { ok: false, why: "nothing before the @", value: v };
  if (!/^[^.]([\w.+-]*[^.])?$/.test(user)) return { ok: false, why: "the part before @ looks wrong", value: v };
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(host)) return { ok: false, why: "the domain looks wrong", value: v };
  if (host.split(".").pop().length < 2) return { ok: false, why: "the domain ends too short", value: v };
  return { ok: true, why: "", value: v.toLowerCase() };
}

/* Kylas needs a lastName. One word is a last name; the rest splits on the last
   space, so "Nandini Shenoy" is Nandini / Shenoy and "A B C" is "A B" / "C". */
function splitName(raw) {
  const parts = String(raw == null ? "" : raw).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function checkName(raw) {
  const v = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
  if (!v) return { ok: false, why: "a name is required", value: "" };
  if (v.length > 100) return { ok: false, why: "longer than 100 characters", value: v };
  /* Digits in a name are nearly always a phone number pasted into the wrong
     box, which is exactly the mistake that creates a junk contact. */
  if (/\d/.test(v)) return { ok: false, why: "has digits in it — is that a phone number?", value: v };
  if (/^(test|temp|unknown|na|n\/a|-)$/i.test(v))
    return { ok: false, why: "a placeholder name creates a contact nobody can find later", value: v };
  return { ok: true, why: "", value: v };
}

function checkUrl(raw, { host = "" } = {}) {
  let v = String(raw == null ? "" : raw).trim();
  if (!v) return { ok: true, why: "", value: "" };
  if (!/^https?:\/\//i.test(v)) v = "https://" + v.replace(/^\/+/, "");
  let u;
  try { u = new URL(v); } catch { return { ok: false, why: "not a web address", value: v }; }
  if (u.protocol !== "https:") u.protocol = "https:";
  if (host && !u.hostname.toLowerCase().endsWith(host))
    return { ok: false, why: "expected a " + host + " address", value: u.href };
  return { ok: true, why: "", value: u.href };
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(Date.parse(v + "T00:00:00"));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));

/* ── the field table ─────────────────────────────────────────────────
   Every field the console can write, and what it will accept. This is the
   answer to "permissible entriable data types": one place, not scattered
   through the form.

   kind:  phone | email | name | text | url | picklist | date | time | flag | free
   free:  held exactly as the prospect said it. Budget, timeline and pax are
          free text on purpose (CLAUDE.md non-negotiable 2) and must never be
          validated into a number or a range. */
const FIELDS = {
  pocName:        { kind: "name",     label: "Name",              required: true },
  designation:    { kind: "text",     label: "Designation",       max: 255 },
  company:        { kind: "text",     label: "Company",           max: 255 },
  companyId:      { kind: "text",     label: "Company id",        max: 20 },
  linkedin:       { kind: "url",      label: "LinkedIn",          host: "linkedin.com" },
  phone:          { kind: "phone",    label: "Phone" },
  email:          { kind: "email",    label: "Email" },
  stage:          { kind: "picklist", label: "Stage" },
  source:         { kind: "picklist", label: "Source of data" },
  salutation:     { kind: "picklist", label: "Salutation" },
  modeOfMeeting:  { kind: "picklist", label: "Mode of meeting" },
  nextCallDate:   { kind: "date",     label: "Next call date" },
  nextCallTime:   { kind: "time",     label: "Next call time" },
  vendorInfo:     { kind: "text",     label: "Who handles this today", max: 1000 },
  serviceOffering:{ kind: "flag",     label: "What I pitched" },
  budget:         { kind: "free",     label: "Budget" },
  timeline:       { kind: "free",     label: "Timeline" },
  pax:            { kind: "free",     label: "Pax" },
  remarks:        { kind: "free",     label: "Remarks" },
};

/* Checks one value against the table. Returns { ok, why, value } with value
   NORMALISED — trimmed, https-forced, phone split — so a caller can write back
   what came out rather than what went in. */
function checkField(name, raw, opts) {
  const f = FIELDS[name];
  const o = opts || {};
  if (!f) return { ok: true, why: "", value: raw };
  const empty = raw === undefined || raw === null || String(raw).trim() === "";

  if (empty) return f.required
    ? { ok: false, why: f.label + " is required", value: "" }
    : { ok: true, why: "", value: "" };

  switch (f.kind) {
    case "phone": {
      const r = checkPhone(raw, { cc: o.cc, type: o.type });
      return { ok: r.ok, why: r.ok ? "" : f.label + ": " + r.why, value: r.value, cc: r.cc };
    }
    case "email": {
      const r = checkEmail(raw);
      return { ok: r.ok, why: r.ok ? "" : f.label + ": " + r.why, value: r.value };
    }
    case "name": {
      const r = checkName(raw);
      return { ok: r.ok, why: r.ok ? "" : f.label + ": " + r.why, value: r.value };
    }
    case "url": {
      const r = checkUrl(raw, { host: f.host });
      return { ok: r.ok, why: r.ok ? "" : f.label + ": " + r.why, value: r.value };
    }
    case "date":
      return isDate(raw) ? { ok: true, why: "", value: String(raw) }
        : { ok: false, why: f.label + ": needs to be a date", value: String(raw) };
    case "time":
      return isTime(raw) ? { ok: true, why: "", value: String(raw) }
        : { ok: false, why: f.label + ": needs to be a time like 15:30", value: String(raw) };
    case "picklist": {
      const v = String(raw);
      /* An unknown value is kept, never dropped — a blank reads as "no data"
         when the truth is "our list is stale" (kylas-api-notes.md §11). It is
         reported so somebody can fix the list. */
      if (o.allowed && o.allowed.length && !o.allowed.map(String).includes(v))
        return { ok: false, why: f.label + ': "' + v + '" is not one of the values this account uses',
                 value: v, keep: true };
      return { ok: true, why: "", value: v };
    }
    case "flag":
      return { ok: true, why: "", value: !!raw };
    case "text": {
      const v = String(raw).trim();
      return f.max && v.length > f.max
        ? { ok: false, why: f.label + ": longer than " + f.max + " characters", value: v.slice(0, f.max) }
        : { ok: true, why: "", value: v };
    }
    default:
      return { ok: true, why: "", value: typeof raw === "string" ? raw.trim() : raw };
  }
}

/* Validates a whole console contact before it is written anywhere.

   Returns { ok, problems: [{ field, why, blocking }], contact } where contact
   is the normalised copy. A problem is BLOCKING when Kylas would reject the
   write or the record would be unfindable; a phone number we cannot parse is
   blocking, a stale picklist value is not. */
function checkContact(c, opts) {
  const o = opts || {};
  const out = Object.assign({}, c);
  const problems = [];
  const add = (field, why, blocking) => problems.push({ field: field, why: why, blocking: blocking !== false });

  const nm = checkField("pocName", c.pocName);
  if (!nm.ok) add("pocName", nm.why); else out.pocName = nm.value;

  for (const key of ["designation", "vendorInfo"]) {
    const r = checkField(key, c[key]);
    if (!r.ok) add(key, r.why, false);
    out[key] = r.value;
  }

  const li = checkField("linkedin", c.linkedin);
  if (!li.ok) add("linkedin", li.why, false); else out.linkedin = li.value;

  /* Phones. At least one has to be dialable or the contact is useless to a
     caller, and every one that is present has to be valid or Kylas rejects the
     whole write — not just the bad entry. */
  out.phones = [];
  let dialable = 0;
  (c.phones || []).forEach((p, i) => {
    const raw = p && p.value;
    if (raw === undefined || raw === null || String(raw).trim() === "") return;
    const r = checkPhone(raw, { cc: p.cc, type: p.type });
    if (!r.ok) { add("phones." + i, "Phone " + String(raw).trim() + ": " + r.why); return; }
    dialable++;
    out.phones.push({ type: p.type || "MOBILE", cc: r.cc || "+91", value: r.value,
                      primary: !!p.primary });
  });
  if (!dialable && !o.allowNoPhone) add("phones", "A contact needs at least one phone number to call");
  if (dialable && !out.phones.some((p) => p.primary)) out.phones[0].primary = true;

  out.emails = [];
  (c.emails || []).forEach((e, i) => {
    const raw = e && e.value;
    if (raw === undefined || raw === null || String(raw).trim() === "") return;
    const r = checkEmail(raw);
    /* A bad email is blocking because Kylas rejects the request over it, and
       the associate loses the whole save for one stray character. */
    if (!r.ok) { add("emails." + i, "Email " + String(raw).trim() + ": " + r.why); return; }
    out.emails.push({ type: e.type || "OFFICE", value: r.value, primary: !!e.primary });
  });
  if (out.emails.length && !out.emails.some((e) => e.primary)) out.emails[0].primary = true;

  for (const [key, allowed] of [["stage", o.stages], ["source", o.sources],
                                ["salutation", o.salutations], ["modeOfMeeting", o.modes]]) {
    const r = checkField(key, c[key], { allowed: allowed });
    if (!r.ok) add(key, r.why, false);
    if (c[key] !== undefined) out[key] = r.value;
  }

  if (c.nextCallDate) {
    const r = checkField("nextCallDate", c.nextCallDate);
    if (!r.ok) add("nextCallDate", r.why);
  }
  if (c.nextCallTime) {
    const r = checkField("nextCallTime", c.nextCallTime);
    if (!r.ok) add("nextCallTime", r.why);
  }

  const name = splitName(out.pocName);
  out.firstName = name.firstName;
  out.lastName = name.lastName;

  return { ok: !problems.some((p) => p.blocking), problems: problems, contact: out };
}

  global.Fields = { DIAL_CODES, ISO_OF, FIELDS, splitPhone, e164, prettyPhone, checkPhone, checkEmail, checkName, checkUrl, splitName, checkField, checkContact, isDate, isTime };
})(window);
