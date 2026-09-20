/* /sales/companies/list/focus — what each BD picked, and what they dropped. */
import type { Snapshot } from "../data/source";
import { Link } from "react-router-dom";

export default function FocusLists({ snap }: { snap: Snapshot }) {
  const entries = Object.values(snap.focus)
    .map((f) => ({ f, c: snap.companies.find((c) => c.id === f.companyId) }))
    .filter((e) => e.c);
  const foc = entries.filter((e) => e.f.status === "focus");
  const dep = entries.filter((e) => e.f.status === "depri");

  return (
    <section>
      <p className="story">
        The team has <b>{foc.length}</b> accounts on focus lists and has deprioritized <b>{dep.length}</b>.
      </p>
      <h2 className="sec">Recently deprioritized</h2>
      <p className="sec-sub">
        Every account a BD has taken off their list, with the reason they gave.
      </p>
      <div className="card scroll">
        {dep.length ? (
          <table className="dtab">
            <thead><tr><th>Company</th><th>BD</th><th>Reason</th><th>Note</th><th>When</th></tr></thead>
            <tbody>
              {dep.map(({ f, c }) => (
                <tr key={f.companyId}>
                  <td className="co"><Link to={`/sales/companies/details/${c!.id}`}>{c!.name}</Link></td>
                  <td>{f.ownerName}</td>
                  <td>{f.reason || "—"}</td>
                  <td style={{ color: "var(--muted)" }}>{f.note}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(f.setAt).toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">Nobody has deprioritized an account yet.</div>}
      </div>
    </section>
  );
}
