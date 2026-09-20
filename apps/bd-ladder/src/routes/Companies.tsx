/* /sales/companies/list — stage groups, filters, the list.
   Not built yet: the shell, the families and the freshness bars come next. */
import { FAMILIES, familyOf, freshnessOf, stageLabel, isCounted } from "../rules/grouping";
import { today } from "../rules/ladder";
import type { Snapshot } from "../data/source";
import { Link } from "react-router-dom";

export default function Companies({ snap }: { snap: Snapshot }) {
  const T = today();
  const rows = snap.companies;
  const byFamily = new Map<string, typeof rows>();
  for (const c of rows) {
    const k = familyOf(c.stage);
    byFamily.set(k, [...(byFamily.get(k) || []), c]);
  }
  return (
    <section>
      <div className="fams">
        {FAMILIES.map((f) => {
          const list = byFamily.get(f.key) || [];
          if (!list.length) return null;
          return (
            <div className="fam" key={f.key}>
              <h3><button type="button">{f.label}</button>
                <span className="c num">{list.length}</span>
                <span className="h">{f.hint}</span></h3>
              <div className="tiles">
                {[...new Set(list.map((c) => c.stage))].map((st) => {
                  const n = list.filter((c) => c.stage === st).length;
                  return (
                    <button className="tile" key={st} type="button">
                      <span className="nm">{stageLabel(st)}</span>
                      <span className="ct num">{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card explorer">
        <div className="exhead">
          <h2>All accounts</h2>
          <span className="num" style={{ color: "var(--muted)", fontWeight: 600 }}>
            {rows.length} {rows.length === 1 ? "company" : "companies"}
          </span>
        </div>
        <div className="scroll" style={{ marginTop: 14 }}>
          <table className="acc">
            <thead><tr>
              <th>Company</th><th>Pipeline stage</th><th>BD</th><th>Source</th><th>Last call</th>
            </tr></thead>
            <tbody>
              {rows.map((c) => {
                const f = freshnessOf(c.lastCall, T);
                return (
                  <tr key={c.id}>
                    <td className="co">
                      <Link to={`/sales/companies/details/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{stageLabel(c.stage)}</td>
                    <td>{c.owner}{isCounted(snap.people[c.owner]) ? "" : " (not counted)"}</td>
                    <td>{c.source || "—"}</td>
                    <td><span className="lc"><i className={`f-${f}`} />
                      {c.lastCall == null ? "Never" : `${T - c.lastCall}d ago`}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
