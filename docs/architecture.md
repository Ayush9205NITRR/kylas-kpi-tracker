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
