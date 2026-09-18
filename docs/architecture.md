# Architecture — overlay, Airtable, Kylas

Supersedes the store design in `docs/kylas-api-notes.md` §3. The API facts in that
file still hold; the conclusion that overlay scalars should become Kylas custom
fields does not, because custom fields are billed per field.

---

## 1. Shape

```
  ┌─────────────────────────────┐
  │  Chrome extension / overlay │   the surface the BD associate lives in
  └──────────────┬──────────────┘
                 │  one call on Save
        ┌────────▼────────┐
        │  proxy (worker) │   holds both API keys, ~50 lines, free tier
        └───┬─────────┬───┘
            │         │
   ┌────────▼───┐  ┌──▼──────────────────────┐
   │  Airtable  │  │  Kylas                  │
   │  granular  │  │  remarks field (mirror) │
   │  KPI source│  │  + native call log      │
   └────────────┘  └─────────────────────────┘
```

**Airtable is the system of record for everything the overlay captures**, at full
granularity. **Kylas keeps its existing field count** — the overlay writes a
rendered summary into `remarks` only, so no new custom fields are billed.

### Why a proxy and not extension → Airtable directly

Direct writes work, but then every associate's browser holds an Airtable PAT with
write access to the whole base, and a Kylas api-key alongside it. Extension
storage is readable by anyone with the machine. One Cloudflare Worker or Vercel
function holds both keys and exposes a single `POST /save`. It costs nothing on a
free tier and it is the difference between rotating one secret and rotating one
per rep.

It also gives you one place to run the KPI derivations that Airtable formulas
can't express, and one place to retry a failed Kylas write without the associate
noticing.

### Where KPIs are computed

**In Airtable, not from the Kylas remarks text.** Remarks is a free-text field
and a rendered summary; parsing it back to compute metrics would be fragile and
would break the moment a human edits it. Remarks exists so that someone looking
at the record inside Kylas sees the context. The numbers come from the Airtable
tables in `docs/kpi-spec.md`.

### Writing to remarks without destroying it

Never overwrite the field. Rewrite only between markers, leaving anything a human
typed above them intact:

```
Spoke to her assistant, she asked for a Monday callback.

--- BD CONSOLE (auto, do not edit below) ---
Stage      Qualifying   ·   Last call 2026-09-16
Current    Employee offsites | ~8L, not approved | Q4 FY27 | 60-70 pax
Past       —
Vendor     First Event   ·   Mode  Virtual   ·   Offering pitched  yes
--- END ---
```

On save: read the contact, split on the markers, replace the managed block, `PUT`
the whole field back.

---

## 2. Extension vs standalone, revisited

With Airtable as the backend, the extension becomes viable as the primary
surface — there is no longer a server-rendered app it needs to be part of. Two
things still argue for keeping the console as a **web app the extension opens**,
rather than a panel injected into the Kylas DOM:

1. The split-pane layout wants ~1400px. Injected into Kylas' own page it fights
   for width with a UI you don't control.
2. Anything that reads Kylas' DOM breaks on their release schedule, silently.

Recommended split:

- **Web app** (the prototype, ported) — all data entry, all writes.
- **Extension** (~100 lines) — injects an "Open in console" button on a Kylas
  contact page that deep-links to `/contact/:kylasId`, and nothing else. No data
  path, no DOM scraping, nothing to break.

If you specifically want the console *inside* the Kylas tab, the extension can
host the same app in a full-height iframe pinned to the side. Same code, no DOM
coupling. That is a layout decision, not an architecture one.

---

## 3. Sync back from Kylas

Register a `CONTACT_UPDATED` webhook (`POST /v1/webhooks/`) pointing at the proxy.
When a contact changes in Kylas — someone edits it there, or the stage moves —
the proxy upserts the Airtable row and, if the pipeline stage changed, appends a
`Stage Transitions` record. This is what keeps `Last Call At` honest when a stage
moves outside the console.

---

## 4. Cost and limit notes

- Airtable API is rate-limited per base (5 req/s at time of writing — confirm for
  your plan). At 3 reps × 100 calls/day this is not close to binding, but batch
  the writes in one request per save rather than one per table.
- Per-base record caps vary by plan. `Stage Transitions` and `Call Log` are
  append-only and will be the tables that grow; budget for archiving them
  annually rather than letting them run forever.
- The proxy needs no database. It is stateless.

---

## 5. Who owns the KPI definition — settled 2026-09-18

Ayush asked the right question: *why do we need Airtable if the numbers are
already being worked out?* The answer at the time was uncomfortable — **they
were being worked out twice.**

The dashboard called `/companies`, pulled the contacts the browser held, and
recomputed Right POC, Successful Discovery and the three milestones in
JavaScript (`rollup()` in `extension/console/views.js`). The identical rules
also existed as Airtable formulas (`scripts/schema.mjs`). Only the browser copy
was ever on screen; Airtable was read for exactly one thing, the trend chart.

Two implementations of one definition, one of them invisible, is how a number
goes wrong quietly — and it already had: `cumulative()` was deriving a
successful discovery from a booked meeting, crediting a call that had not
happened.

### The decision

**Airtable owns the definition. The browser's copy is a fallback and says so.**

- `readCompanyKpis()` in `scripts/airtable.mjs` reads the `Companies` table,
  following Airtable's offset so a 250-row table is not silently truncated to
  the first page. `KPI_FIELDS` names every field the dashboard depends on, so
  that dependency is a list somebody can read rather than a grep.
- The proxy joins it onto `/companies` per company, keyed on **Kylas company
  id** — the only id the console has ever seen.
- `rollup()` replaces its own flags wholesale where Airtable has the row, and
  records `co.from = "airtable" | "browser"` per row. Wholesale, not merged:
  merging two definitions produces a third.
- Every view shows which source it is reading. `KPIs from Airtable`, or
  `KPIs from Airtable · 112 not saved yet` for companies allotted in Kylas that
  nobody has saved from the console yet, or an amber
  `computed in this browser — Airtable unavailable`.

### Why the fallback stays

Deleting it would mean no dashboard at all when the KPI store is unreachable —
and the same response carries the roster an associate calls from. A failed KPI
read is therefore not a failed request: Kylas' half arrives regardless, and the
badge turns amber. What is *not* acceptable is an unlabelled number, which is
what we had.

### What Airtable is actually for

Three things the browser cannot do, and the reason the answer was not "drop it":

1. **History.** Kylas stores the *current* stage, not that a company was at MQL
   on 4 September and SQL on 17 September. `Stage Transitions` and
   `Daily Snapshot` are the only record of time; recomputing from Kylas can only
   ever describe today.
2. **The granular data Kylas has no field for** — budget, timeline, pax, per
   event, past and current. Custom fields cost money, which is why this project
   exists. The remarks block is a rendering for a human, not a store.
3. **A place to look without the extension** — a manager, a phone, a grid with
   its own filters and views.

---

## 6. Who sees what — added 2026-09-18

Ayush: *"Everyone is not required to see the data of all the executives… create
a sign-in system so once you sign up you're only seeing your concerned data,
while the admin can see all the data."*

### What identity we already have, for free

The proxy holds **one Kylas API key**, and Kylas will say whose it is
(`GET /v1/users/me`). An associate runs the proxy with their own key, so the
proxy already knows who is sitting in front of it. No login screen needed for
the common case.

```
ADMIN_IDS=74725,82866       # Kylas user ids, the reliable form
ADMIN_EMAILS=ayush@enout.in # works only if /v1/users/me returns an email
```

- **Nobody listed** → everyone is an admin. Nothing is locked until somebody
  decides to lock it, so an existing install does not change behaviour.
- **Listed** → `role: "admin"`, the Who / Allotted-to selector offers Everyone
  and each associate by name.
- **Not listed** → `role: "associate"`. The selector is disabled and shows only
  their own name; `/companies` and `/report` serve their own rows whatever the
  request asks for, and the substitution is logged.

Kylas does not always return an email. If `ADMIN_EMAILS` is set and the email
comes back blank, **nobody can ever match** — including the owner. The proxy
says so once, with the `ADMIN_IDS` line to use instead, rather than silently
demoting everybody.

### This is scoping, not security

Worth being exact about, because the difference decides what it is good for.
The allowlist lives in the associate's own `.env.local`, on their own laptop.
Anyone who can edit that file can call themselves an admin, and anyone holding
a Kylas key can query Kylas directly regardless of this.

What it buys is that eight people each open the dashboard on **their own
numbers** instead of the whole team's — which is what makes it usable, and stops
one associate's bad week being everybody's business by default.

**Real access control needs the proxy deployed once, centrally**, with a login
in front of it and per-user keys held server-side. That is the same change
already wanted for the eight-laptop problem, and it is the point at which this
scoping becomes enforcement. Until then, treat it as a default view, not a
permission.

### Why the admin view of the whole team was empty

Not a permissions problem. The company-level KPIs join Kylas companies to
Airtable rows on the Kylas company id, and when that join matches nothing every
company number reads zero — while the Progress section, which reads the event
tables directly and needs no join, shows real data. Two right-looking halves and
nothing saying which side was empty.

`/kpi-debug` answers it in one call: how many company rows Airtable holds, how
many carry a Kylas id, samples from both sides, and the overlap. The dashboard
badge now says *"no company matched Airtable — check /kpi-debug"* rather than
counting thousands of companies as "not saved yet", which is true and useless.
