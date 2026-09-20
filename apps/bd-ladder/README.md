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

With no Supabase configured it runs on six obviously-fake companies and says so
in the banner. It is **not** the prototype's `makeSample()` — 760 invented
companies that looked real was the failure that generator caused, so this is
six rows and a warning.

## What is here

- `src/styles/app.css` — lifted **verbatim** from the reference. Tokens, both
  themes, every component rule. Changing a value here without changing it there
  makes the reference a lie.
- `src/rules/` — the funnel, periods, families, freshness, modes, who counts.
  One module each, all tested (`src/rules/rules.test.ts`).
- `src/routes/` — the four screens.
- `supabase/schema.sql` — mirror tables, app-owned tables, and the RLS.

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

| | source |
|---|---|
| company, contacts, owner, stage, source, last call | Kylas, via the sync |
| the six rung dates | **Airtable's Stage Transitions** — the console has been recording every stage change since it went in. Not re-derived here. |
| meeting mode | `Stage Transitions.Mode`, stamped when the rung was crossed |
| RCA | Airtable's `RCA` table, gates in `docs/rca-reasons.json` |
| research, focus, roster overrides | this app's own Supabase tables |

A company nobody has worked has no transitions, so its rung is **seeded** from
the stage it sits on plus its last call. `company_rungs.source` records which,
and the banner says how many.

## Not built yet

- The Supabase source (`src/data/source.ts` has the interface and the fixture;
  the Supabase implementation is next), and the sync edge function.
- Google auth restricted to `@enout.in`. The RLS predicate is written and is
  the actual enforcement — Google's `hd` is only a hint.
- Companies: filters, chips, sort, the freshness bars under each stage tile.
- Company page: focus control, contacts, the research form.
- The meeting-mode and RCA charts on the dashboard.
- Vercel deploy.
