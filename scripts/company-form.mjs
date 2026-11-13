/* THE NEW-COMPANY FORM'S FIXED LISTS AND CHECKS (Ayush, 2026-11-13).
 * Shared by the proxy (validation) and served to the console (/company-form),
 * so both sides agree on what a band is worth and how a city is spelled. */
import { INDUSTRIES } from "./industries.mjs";

/* Employee size: the band a BD picks, and the count it is stored as (its
   midpoint) so the score and revenue-per-employee can use it. */
export const EMP_BANDS = [
  ["1-10", 5], ["11-50", 30], ["51-200", 125], ["201-500", 350], ["501-1000", 750],
  ["1001-5000", 3000], ["5001-10000", 7500], ["10000+", 12000],
].map(([band, mid]) => ({ band, mid }));

/* Cities: one spelling each. The synonyms on the right all become the name
   on the left, so "Bangalore" and "Bengaluru" are one filter value. */
const CITY_SYN = {
  "Bengaluru": ["bangalore", "bengaluru", "blr"], "Mumbai": ["mumbai", "bombay"],
  "Gurugram": ["gurugram", "gurgaon", "ggn"], "New Delhi": ["new delhi", "delhi", "ncr", "delhi ncr"],
  "Noida": ["noida"], "Greater Noida": ["greater noida"], "Navi Mumbai": ["navi mumbai"],
  "Thane": ["thane"], "Pune": ["pune", "poona"], "Hyderabad": ["hyderabad", "secunderabad"],
  "Chennai": ["chennai", "madras"], "Kolkata": ["kolkata", "calcutta"], "Ahmedabad": ["ahmedabad"],
  "Jaipur": ["jaipur"], "Kochi": ["kochi", "cochin", "ernakulam"], "Coimbatore": ["coimbatore"],
  "Chandigarh": ["chandigarh", "mohali", "panchkula"], "Indore": ["indore"], "Lucknow": ["lucknow"],
  "Surat": ["surat"], "Vadodara": ["vadodara", "baroda"], "Nagpur": ["nagpur"], "Ludhiana": ["ludhiana"],
  "Bhubaneswar": ["bhubaneswar"], "Visakhapatnam": ["visakhapatnam", "vizag"], "Mysuru": ["mysuru", "mysore"],
  "Thiruvananthapuram": ["thiruvananthapuram", "trivandrum"], "Mangaluru": ["mangaluru", "mangalore"],
  "Goa": ["goa", "panaji", "margao"], "Bhopal": ["bhopal"], "Nashik": ["nashik"], "Rajkot": ["rajkot"],
  "Kanpur": ["kanpur"], "Patna": ["patna"], "Raipur": ["raipur"], "Dehradun": ["dehradun"],
  "Guwahati": ["guwahati"], "Faridabad": ["faridabad"], "Ghaziabad": ["ghaziabad"],
  "Pimpri-Chinchwad": ["pimpri-chinchwad", "pimpri chinchwad", "pcmc"], "Aurangabad": ["aurangabad"],
  "Madurai": ["madurai"], "Vijayawada": ["vijayawada"], "Amritsar": ["amritsar"], "Jodhpur": ["jodhpur"],
  "Udaipur": ["udaipur"], "Hubballi": ["hubli", "hubballi"], "Belagavi": ["belgaum", "belagavi"],
  "Dubai": ["dubai"], "Singapore": ["singapore"], "London": ["london"], "New York": ["new york", "nyc"],
  "San Francisco": ["san francisco", "sf"], "Bay Area": ["bay area"],
};
const SYN = new Map();
for (const [name, list] of Object.entries(CITY_SYN)) for (const s of list) SYN.set(s, name);
export const CITIES = Object.keys(CITY_SYN);
/* For the form: each city with the other spellings it answers to. */
export const CITY_LIST = Object.entries(CITY_SYN).map(([label, alias]) => ({ label, alias }));
/* "bangalore " -> "Bengaluru"; an unknown town is kept, tidied, as typed. */
export function normCity(raw) {
  const t = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const hit = SYN.get(t.toLowerCase());
  if (hit) return hit;
  return t.replace(/\b([a-z])/g, (m) => m.toUpperCase()).slice(0, 80);
}

/* Industries: docs/industries.json (via the generated industries.mjs) — groups, and the map from any source value. */
export const industries = () => INDUSTRIES;
/* A source industry ("information technology & services") -> [group, sub], or null. */
export function industryOf(raw) {
  const k = String(raw ?? "").trim().toLowerCase().split(",")[0].trim();
  return k ? industries().map?.[k] || null : null;
}
export const isIndustry = (group, sub) => !!industries().groups?.[group]?.includes(sub);

const money = (v) => (v === "" || v == null ? null : Number(String(v).replace(/[, ]/g, "")));
/* The form, checked. Returns { ok, errors: {field: why}, clean }. */
export function checkCompanyForm(f, { sources = [], people = [] } = {}) {
  const errors = {}, clean = {};
  clean.name = String(f?.name ?? "").trim().replace(/\s+/g, " ");
  if (clean.name.replace(/[^a-z0-9]/gi, "").length < 2) errors.name = "Type the company's name";
  else if (clean.name.length > 255) errors.name = "That name is too long";
  clean.ownerId = String(f?.ownerId ?? "").trim();
  if (!clean.ownerId) errors.ownerId = "Pick an owner";
  else if (people.length && !people.some((p) => String(p.id) === clean.ownerId)) errors.ownerId = "That owner is not an active user";
  clean.source = String(f?.source ?? "").trim();
  if (!clean.source) errors.source = "Pick the Source of Data";
  else if (sources.length && !sources.some((s) => s.code === clean.source || s.label === clean.source || String(s.id) === clean.source))
    errors.source = "Pick a Source of Data from the list";
  clean.linkedin = String(f?.linkedin ?? "").trim();
  if (!clean.linkedin) errors.linkedin = "Paste the company's LinkedIn page";
  else {
    if (!/^https?:\/\//i.test(clean.linkedin)) clean.linkedin = "https://" + clean.linkedin.replace(/^\/+/, "");
    if (!/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/[^\s/?#]+/i.test(clean.linkedin))
      errors.linkedin = "Use the company page, e.g. linkedin.com/company/acme";
  }
  const band = EMP_BANDS.find((b) => b.band === String(f?.empBand ?? ""));
  if (!band) errors.empBand = "Pick the employee size";
  else { clean.empBand = band.band; clean.employees = band.mid; }
  for (const k of ["revenue", "fundingAmount", "totalFunding"]) {
    const n = money(f?.[k]);
    if (n == null) continue;
    if (!Number.isFinite(n) || n < 0) errors[k] = "A number, in USD"; else clean[k] = Math.round(n);
  }
  clean.fundingType = String(f?.fundingType ?? "").trim().slice(0, 80);
  if (f?.lastRaised) {
    const d = String(f.lastRaised).slice(0, 10);
    const m = /^\d{4}-\d{2}$/.test(d) ? d + "-01" : d;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m) || Number.isNaN(Date.parse(m))) errors.lastRaised = "A date"; else clean.lastRaised = m;
  }
  if ((clean.fundingAmount != null || clean.totalFunding != null || clean.lastRaised) && !clean.fundingType)
    errors.fundingType = "Pick the funding type for these numbers";
  if (f?.industry || f?.subIndustry) {
    if (!isIndustry(f.industry, f.subIndustry)) errors.industry = "Pick an industry from the list";
    else { clean.industry = f.industry; clean.subIndustry = f.subIndustry; }
  }
  if (f?.city) clean.city = normCity(f.city);
  return { ok: !Object.keys(errors).length, errors, clean };
}
