/* /sales/home — the funnel, the per-BD columns, the story above them.
   Layout and copy from reference/enout-bd-ladder.html. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RUNGS, tally, stepConversion, today, type Company } from "../rules/ladder";
import { label, lead, range, type Grain, type YearMode } from "../rules/periods";
import { isCounted } from "../rules/grouping";
import type { Snapshot } from "../data/source";

const firstName = (n: string) => String(n).split(/\s+/)[0];
const initials = (n: string) => {
  const p = String(n).trim().split(/\s+/);
  return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase();
};
const hue = (n: string) => [...String(n)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
const Avatar = ({ name }: { name: string }) => (
  <span className="av" style={{ background: `hsl(${hue(name)} 45% 46%)` }} aria-hidden="true">
    {initials(name)}
  </span>
);
const rungColor = (i: number) => `var(--r${i})`;

export default function Dashboard({ snap }: { snap: Snapshot }) {
  const [grain, setGrain] = useState<Grain>("month");
  const [off, setOff] = useState(0);
  const [fy, setFy] = useState<YearMode>("fy");
  const nav = useNavigate();

  const T = today();
  const { s, e } = range(grain, off, T, fy);
  const counted = snap.companies.filter((c) => isCounted(snap.people[c.owner]));

  const team = tally(counted, s, e);
  const byBd = new Map<string, Company[]>();
  for (const c of counted) byBd.set(c.owner, [...(byBd.get(c.owner) || []), c]);
  /* Everyone counted appears, including a BD with a quiet month — an empty
     column is information, an absent one reads as "not on the team". */
  for (const [name, p] of Object.entries(snap.people)) if (isCounted(p) && !byBd.has(name)) byBd.set(name, []);

  const bds = [...byBd.keys()].sort((a, b) => {
    const A = tally(byBd.get(a)!, s, e), B = tally(byBd.get(b)!, s, e);
    return B[5] - A[5] || B[0] - A[0] || a.localeCompare(b);
  });
  const per = new Map(bds.map((b) => [b, tally(byBd.get(b)!, s, e)]));
  const rowMax = RUNGS.map((_, i) => Math.max(1, ...bds.map((b) => per.get(b)![i])));

  return (
    <section>
      <div className="periodbar">
        <div className="seg">
          {(["week", "month", "quarter", "year"] as Grain[]).map((g) => (
            <button key={g} type="button" aria-pressed={grain === g}
              onClick={() => { setGrain(g); setOff(0); }}>
              {g[0].toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
        <div className="stepper">
          <button type="button" aria-label="Previous period" onClick={() => setOff(off - 1)}>‹</button>
          <span className="plabel">{label(grain, off, T, fy)}</span>
          <button type="button" aria-label="Next period" disabled={off >= 0}
                  onClick={() => off < 0 && setOff(off + 1)}>›</button>
        </div>
        <label className="fy">Year runs
          <select value={fy} onChange={(ev) => setFy(ev.target.value as YearMode)}>
            <option value="fy">Apr–Mar (FY)</option>
            <option value="cal">Jan–Dec</option>
          </select>
        </label>
      </div>

      <Story bds={bds} per={per} team={team} counted={counted}
             grain={grain} off={off} today={T} fy={fy} />

      <div className="card scroll">
        <table className="ladder">
          {bds.length ? (
            <>
              <thead>
                <tr>
                  <th className="rung">Rung</th>
                  <th className="teamcol">Team</th>
                  <th>Step conv.</th>
                  {bds.map((b) => (
                    <th key={b}>
                      <button className="bdh" type="button" title={`Open ${b}'s accounts`}
                              onClick={() => nav(`/sales/companies/list?bd=${encodeURIComponent(b)}`)}>
                        <Avatar name={b} /><span>{firstName(b)}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RUNGS.map((r, i) => {
                  const conv = i === 0 ? null : stepConversion(counted, s, e, i);
                  return (
                    <tr key={r.name}>
                      <td className="rung">
                        <div className="rungname">
                          <span className={"step" + (i < 2 ? " l" : "")}
                                style={{ background: rungColor(i) }}>{i + 1}</span>
                          {r.name}
                        </div>
                      </td>
                      <td className="teamcol"><span className="cellv num">{team[i]}</span></td>
                      {/* Of the companies that reached the rung above IN this period,
                          how many have since come here. Not this rung's count over
                          the one above it — see rules/ladder.ts. */}
                      <td className="conv">
                        {!conv ? "—"
                          : conv.pct == null ? <span style={{ color: "var(--faint)" }}>no one yet</span>
                          : <><b className="num">{conv.pct}%</b> of the {conv.cohort} that
                             {conv.cohort === 1 ? " hit " : " hit "}{RUNGS[i - 1].short} this {grain}</>}
                      </td>
                      {bds.map((b) => {
                        const v = per.get(b)![i];
                        return (
                          <td key={b}>
                            <div className="cellv num" style={v ? undefined : { color: "var(--faint)" }}>{v}</div>
                            <div className="bar">
                              <i style={{ width: `${(v / rowMax[i]) * 100}%`,
                                          background: rungColor(Math.max(i, 2)) }} />
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : (
            <tbody><tr><td className="empty">No active BDAs to show.</td></tr></tbody>
          )}
        </table>
      </div>

      <h2 className="sec">How each BD is doing</h2>
      <p className="sec-sub">
        Only active Business Development Associates are counted. Change who's in from{" "}
        <button className="linkish" type="button">Team</button>.
      </p>
      <div className="people">
        {bds.length ? bds.map((b) => {
          const a = per.get(b)!;
          let sent: string;
          if (!a[0] && !a[2] && !a[5]) sent = "No ladder movement logged for this period.";
          else {
            sent = `Reached ${a[0]} ${a[0] === 1 ? "company" : "companies"}, ${a[1]} to the right POC`
                 + ` and ${a[2]} into a proper discovery call`;
            sent += a[5] ? `, with ${a[5]} ${a[5] === 1 ? "SQL" : "SQLs"} to show for it.` : ".";
          }
          const mx = Math.max(1, a[0]);
          return (
            <article className="card person" key={b}>
              <header>
                <Avatar name={b} />
                <div>
                  <h3>{b}</h3>
                  <div className="role">{snap.people[b]?.role || ""}</div>
                </div>
              </header>
              <p>{sent}</p>
              <div className="minifunnel">
                {RUNGS.map((r, i) => (
                  <>
                    <span key={r.short + "l"}>{r.short}</span>
                    <span className="t" key={r.short + "t"}>
                      <i style={{ width: `${(a[i] / mx) * 100}%`, background: rungColor(i) }} />
                    </span>
                    <span className="v" key={r.short + "v"}>{a[i]}</span>
                  </>
                ))}
              </div>
            </article>
          );
        }) : (
          <div className="card empty">
            Mark people as active Business Development Associates in <b>Team</b> to see them here.
          </div>
        )}
      </div>
    </section>
  );
}

function Story({ bds, per, team, counted, grain, off, today: T, fy }: {
  bds: string[]; per: Map<string, number[]>; team: number[]; counted: Company[];
  grain: Grain; off: number; today: number; fy: YearMode;
}) {
  const { s, e } = range(grain, off, T, fy);
  if (!bds.length)
    return (
      <p className="story">
        Nobody is set up as an active Business Development Associate yet.
        <span className="sub">Open <b>Team</b> and mark who's a BDA — the funnel counts only them.</span>
      </p>
    );

  if (!team[0] && !team[1] && !team[5])
    return (
      <p className="story">
        {lead(grain, off, T, fy)} nothing has moved up the ladder yet.
        <span className="sub">
          Counts appear as soon as a BD logs a call dated inside {label(grain, off, T, fy)}.
        </span>
      </p>
    );

  const right = stepConversion(counted, s, e, 1);
  const byDisc = [...bds].sort((a, b) => per.get(b)![2] - per.get(a)![2]);
  const bySql = [...bds].sort((a, b) => per.get(b)![5] - per.get(a)![5]);
  const bits: string[] = [];
  if (per.get(byDisc[0])![2] > 0) bits.push(`${firstName(byDisc[0])} led on discovery calls with ${per.get(byDisc[0])![2]}`);
  if (per.get(bySql[0])![5] > 0 && bySql[0] !== byDisc[0])
    bits.push(`${firstName(bySql[0])} closed the most SQLs (${per.get(bySql[0])![5]})`);
  if (team[3] && team[4] < team[3] * 0.7)
    bits.push(`${team[3] - team[4]} booked SQL meetings haven't happened yet — worth confirming`);

  return (
    <p className="story">
      {lead(grain, off, T, fy)} the team reached <b>{team[0]}</b>{" "}
      {team[0] === 1 ? "company" : "companies"}.{" "}
      {right.pct != null && <><b>{right.moved}</b> of them got through to the right POC ({right.pct}%),{" "}</>}
      <b>{team[2]}</b> had a successful discovery call, and <b>{team[5]}</b>{" "}
      {team[5] === 1 ? "became an SQL" : "became SQLs"}.
      {bits.length > 0 && <span className="sub">{bits.join(" · ")}.</span>}
    </p>
  );
}
