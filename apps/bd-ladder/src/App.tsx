/* The shell: top bar, the three tabs, the banner. Markup and classes follow
   reference/enout-bd-ladder.html so the lifted CSS applies unchanged.

   The tabs are real routes rather than the prototype's hash state, and they
   copy Kylas' own URLs, so /sales/companies/details/1776620 in this app is the
   same company as the same path in Kylas. */
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { source, type Snapshot } from "./data/source";
import Dashboard from "./routes/Dashboard";
import Companies from "./routes/Companies";
import FocusLists from "./routes/FocusLists";
import CompanyPage from "./routes/CompanyPage";
import "./styles/app.css";

const TABS = [
  { to: "/sales/home", label: "Dashboard" },
  { to: "/sales/companies/list", label: "Companies" },
  { to: "/sales/companies/list/focus", label: "Focus lists" },
];

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState("");
  const { pathname } = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    source.load().then(setSnap).catch((e) => setErr(String(e.message || e)));
  }, []);

  /* The Companies tab stays lit on a company page — it is where you came from
     and where Back goes. */
  const onCompanies = pathname.startsWith("/sales/companies")
    && !pathname.startsWith("/sales/companies/list/focus");

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand"><h1>BD Ladder</h1><span>Enout · business development</span></div>
        {/* BUTTONS, not links. The reference styles `.tabs button[aria-selected]`,
            so an anchor here renders three underlined links where a segmented
            control should be — the CSS is lifted verbatim and it is the markup
            that has to match it, not the other way round. */}
        <nav className="tabs" role="tablist">
          {TABS.map((t) => {
            const on = t.to === "/sales/companies/list" ? onCompanies : pathname === t.to;
            return (
              <button key={t.to} type="button" role="tab" aria-selected={on}
                      onClick={() => nav(t.to)}>{t.label}</button>
            );
          })}
        </nav>
        <div className="actions">
          <button className="btn" type="button">Team</button>
          <button className="btn primary" type="button" disabled={snap?.origin !== "proxy"}>Sync now</button>
        </div>
      </header>

      <Banner snap={snap} err={err} />

      <main>
        {err && <div className="card empty">Could not load: {err}</div>}
        {!snap && !err && <div className="card empty">Loading…</div>}
        {snap && (
          <Routes>
            <Route path="/sales/home" element={<Dashboard snap={snap} />} />
            <Route path="/sales/companies/list" element={<Companies snap={snap} />} />
            <Route path="/sales/companies/list/focus" element={<FocusLists snap={snap} />} />
            <Route path="/sales/companies/details/:id"
                   element={<CompanyPage snap={snap} reload={() => source.load().then(setSnap)} />} />
            <Route path="*" element={<Dashboard snap={snap} />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

/* Where the numbers came from, in the prototype's own banner. It said "you're
   looking at sample data" because it had no backend; it now says what synced
   and when, and — the line Ayush asked to keep verbatim — how many owners have
   no role yet, because those people are silently absent from every count. */
function Banner({ snap, err }: { snap: Snapshot | null; err: string }) {
  if (err || !snap) return null;

  if (snap.origin === "fixture")
    return (
      <div className="banner">
        <span className="dot" />
        <span>
          <b>Fixture data</b> — these six companies are made up, so the screens have something
          to draw. Unset <code>VITE_USE_FIXTURE</code> and start the proxy
          (<code>source .env.local && node scripts/proxy.mjs</code>) to see the team's real numbers.
        </span>
      </div>
    );

  const owners = new Set(snap.companies.map((c) => c.owner).filter(Boolean));
  const unknown = [...owners].filter((o) => !snap.people[o]).length;
  const seeded = snap.companies.filter((c) => c.rungs.some((r) => r?.source === "seeded")).length;
  const when = snap.syncedAt ? new Date(snap.syncedAt) : null;

  return (
    <div className="banner live">
      <span className="dot" />
      <span>
        <b>{snap.companies.length.toLocaleString("en-IN")}</b> companies
        {when ? `, synced ${when.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} ` +
                `${when.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : ""}.
        {seeded > 0 && <> <b>{seeded.toLocaleString("en-IN")}</b> have no call history yet, so their rung
          is inferred from the stage they are on.</>}
        {unknown > 0 && <> <b>{unknown}</b> owners have no role yet, so they aren't counted.</>}
      </span>
      {unknown > 0 && <button className="linkish" type="button">Set roles</button>}
    </div>
  );
}
