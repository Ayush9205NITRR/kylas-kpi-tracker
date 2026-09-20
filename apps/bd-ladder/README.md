# BD Ladder

The app from `reference/enout-bd-ladder.html`, as React + Vite + TypeScript.
Routes copy Kylas' own URLs, so `/sales/companies/details/1776620` here is the
same account as the same path in Kylas.

```bash
npm install
npm run dev        # http://localhost:5173/sales/home
npm test           # the business rules
npm run build
```

`VITE_USE_FIXTURE=1 npm run dev` runs it on six obviously-fake companies with a
banner saying so, for working on the screens with no proxy up. It is **not** the prototype's `makeSample()` — 760 invented
companies that looked real was the failure that generator caused, so this is
six rows and a warning.

## What is here

- `src/styles/app.css` — lifted **verbatim** from the reference. Tokens, both
  themes, every component rule. Changing a value here without changing it there
  makes the reference a lie.
- `src/rules/` — the funnel, periods, families, freshness, modes, who counts.
  One module each, all tested (`src/rules/rules.test.ts`).
- `src/routes/` — the four screens.
- the storage is **Airtable**, through the proxy — see below.

## Two deliberate departures from the reference

**No fill-down.** The prototype backfilled a missing lower rung with the next
higher rung's date, so a company whose only date was SQL counted at all six
rungs and read as 100% conversion at every step. Ayush, 2026-09-19: count only
real dates.

**Step conversion is a cohort**, not `count[i] / count[i-1]`. Two independently
windowed counts do not divide into a conversion and their ratio can exceed
100%, which reads as a broken screen. This asks: of the companies that reached
the rung above *this period*, how many have since come here. Monotone by
construction.

Both are recorded in `src/rules/ladder.ts` next to the code they govern.

## Where the data comes from

**Airtable, through the proxy — not Supabase.** Ayush, 2026-09-20: *"this is an
extension using so many different things will lead to a lot of friction while
being deployed"*. A second database means a second auth system, a second
migration path and a second set of secrets, for data that already lives in the
base the console writes to on every save. So this app is another client of
`scripts/proxy.mjs`, exactly as the extension is, and it holds no key.

```
   browser                    proxy                     stores
   BD Ladder  ──GET /ladder──▶ reportData()   ──────────▶ Airtable
              ──POST /focus──▶ writeFocus()              (Companies, Contacts,
              ─POST /research▶ writeResearch()            Stage Transitions,
                               readCompanies()            Focus, Research, Team)
                               ─────────────────────────▶ Kylas (contacts, on demand)
```

| | source |
|---|---|
| company, owner, stage, source, last call | Airtable `Companies`, mirrored from Kylas by the sync |
| the six rung dates | `firstArrivals()` in `report.mjs` over `Stage Transitions` — **the same derivation the Progress table counts**, read as dates |
| a company nobody has worked | `seededRung()` — the stage implies one rung, dated by the last call, marked `seeded` |
| meeting mode | `Stage Transitions.Mode`, stamped when the rung was crossed |
| RCA | Airtable `RCA`, gates in `docs/rca-reasons.json` |
| research, focus, roster | Airtable `Research`, `Focus`, `Focus History`, `Team` |

Run `node scripts/repair-base.mjs` to create the three new tables.

## Not built yet

- **Identity.** Nothing records who set a focus or saved research yet: the
  proxy is unauthenticated because it is local. `Set By` and `Updated By` are
  in the schema and travel through the API, so this is a question of where the
  name comes from, not of plumbing. Needs a decision before it is deployed
  anywhere but a laptop.
- Companies: filters, chips, sort, the freshness bars under each stage tile.
- Company page: focus control, contacts, the research form.
- The meeting-mode and RCA charts on the dashboard.
- Vercel deploy.
