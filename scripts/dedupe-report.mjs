/* THE DUPLICATE CHECK, AS A PERSON READS IT.
 *
 * One function, used by the terminal probe (dedupe.mjs), the demo and any
 * message that has to explain a verdict. The point of the layout is that the
 * answer to "did it work, and how do you know" is on the screen without having
 * to read code: what was checked, which sources answered and what each one
 * found, the verdict, every match with WHY it matched, and what the save will
 * do about it.
 */
const pad = (s, n) => String(s).padEnd(n);
const n = (x) => Number(x).toLocaleString("en-IN");

const SRC = { airtable: "Airtable copy", kylas: "Kylas search " };

function sourceLine(key, l = {}) {
  if (l.status === "ok") {
    const bits = [`${n(l.rows ?? 0)} ${key === "airtable" ? "contacts read" : "rows returned"}`];
    if (l.queries) bits.unshift(`${l.queries} search${l.queries === 1 ? "" : "es"}`);
    bits.push(`${l.hits ?? 0} real match${l.hits === 1 ? "" : "es"}`);
    return `ok       ${bits.join(" · ")}${l.partial ? ` · ${l.partial}` : ""}`;
  }
  return `${pad(l.status || "skipped", 8)} ${l.why || ""}`.trimEnd();
}

const ACTION = {
  open: 'Save is BLOCKED. The console offers "Open existing". "Create anyway" is allowed, and is logged.',
  "create-and-flag": "Save goes ahead. A flag is recorded for an admin to review.",
  create: "Save goes ahead. Nothing to flag.",
};
const HEAD = { existing: "EXISTING", flag: "FLAG", unverified: "UNVERIFIED", clear: "CLEAR" };

export function renderVerdict(card, v, { indent = "" } = {}) {
  const who = [card?.pocName || "(no name)",
               ...(card?.phones || []).map((p) => p.value ?? p),
               ...(card?.emails || []).map((e) => e.value ?? e),
               card?.companyId ? `company ${card.companyId}` : ""].filter(Boolean).join(" · ");
  const out = [];
  out.push(`CHECKING   ${who}`);
  for (const k of ["airtable", "kylas"]) out.push(`${k === "airtable" ? "SOURCES   " : "          "} ${SRC[k]}: ${sourceLine(k, v.lookup?.[k])}`);
  out.push(`VERDICT    ${HEAD[v.verdict] || v.verdict}   coverage: ${v.coverage}`);
  out.push(`           ${v.summary}`);
  if (v.matches.length) {
    out.push("MATCHES");
    for (const m of v.matches) {
      const role = m.samePerson ? (m.sameCompany === false ? "same person, other company" : "same person")
                                : "different person";
      out.push(`  • ${m.name}${m.company ? ` · ${m.company}` : m.companyId ? ` · company ${m.companyId}` : ""}` +
               `${m.owner ? ` · owner ${m.owner}` : m.ownerId ? ` · owner id ${m.ownerId}` : ""}` +
               `${m.kid ? ` · id ${m.kid}` : ""}`);
      out.push(`      matched on ${m.matchedOn.join(" and ")} · ${role} · found by ${m.sources.join(" + ")}`);
    }
  }
  if (v.flags.length) {
    out.push("FLAGS");
    for (const f of v.flags) out.push(`  ⚑ ${pad(f.kind, 15)} ${f.why}`);
  }
  out.push(`ACTION     ${ACTION[v.action] || v.action}`);
  return out.map((l) => indent + l).join("\n");
}

/* One line per case, for a table at the end of a demo. */
export function oneLine(label, v) {
  return `${pad(label, 46)} ${pad(HEAD[v.verdict] || v.verdict, 11)} ${pad(v.action, 16)} ${v.flags.map((f) => f.kind).join(", ") || "—"}`;
}
