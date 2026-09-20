/* /sales/companies/details/:id — :id is the Kylas company id, so the URL is
   the same one Kylas uses for the same account. */
import { useParams, Link } from "react-router-dom";
import { KPI_LABELS, kpiRank, today } from "../rules/ladder";
import { freshnessOf, stageLabel } from "../rules/grouping";
import type { Snapshot } from "../data/source";

export default function CompanyPage({ snap }: { snap: Snapshot; reload: () => void }) {
  const { id } = useParams();
  const c = snap.companies.find((x) => x.id === id);
  if (!c) return (
    <div className="card empty">
      No company with id {id}. <Link to="/sales/companies/list">All companies</Link>
    </div>
  );

  const T = today();
  const rank = kpiRank(c);
  const f = freshnessOf(c.lastCall, T);

  return (
    <section>
      <Link className="back" to="/sales/companies/list">← All companies</Link>
      <div className="acct">
        <div className="lside">
          <div className="card ahead">
            <h2>{c.name}</h2>
            <div className="meta">
              <span className="kpi" style={{
                background: rank < 0 ? "var(--surface-2)" : `var(--r${rank})`,
                color: rank >= 3 ? "#fff" : "var(--ink)",
              }}>{KPI_LABELS[rank + 1]}</span>
              <span>{stageLabel(c.stage)}</span><span>·</span>
              <span>Owner: <b style={{ color: "var(--ink)" }}>{c.owner}</b></span><span>·</span>
              <span>{c.source || "No source"}</span><span>·</span>
              <span className="lc"><i className={`f-${f}`} />
                {c.lastCall == null ? "Never called" : `${T - c.lastCall}d ago`}</span>
            </div>
            <p style={{ margin: "10px 0 0" }}>
              <a className="linkish" target="_blank" rel="noopener"
                 href={`https://app.kylas.io/sales/companies/details/${encodeURIComponent(c.id)}`}>
                Open in Kylas ↗
              </a>
            </p>
          </div>
        </div>
        <aside className="rside">
          <div className="card research"><div className="rh"><h3>Research</h3></div>
            <p className="done">Not wired up yet.</p></div>
        </aside>
      </div>
    </section>
  );
}
