# Integration — how the three rules actually get enforced

The three corrections you accepted (monotonic ladder, call-based Last Call At,
append-only transitions) all land in **one place**: the proxy's `POST /save`
handler. This is the important thing to understand before any code is written.

## Why not in Airtable

Airtable formulas and rollups are **stateless** — they recompute from whatever
the current values are. That is exactly why they cannot express any of the three:

| Rule | Why a formula can't do it |
|---|---|
| KPI Rank never decreases | Needs the *previous* rank as an input. A formula that reads current stage has no memory, so it drops when the contact goes cold. |
| Last Call At counts every call | Needs a row appended on saves where nothing changed. No formula appends rows. |
| Stage history | Needs an append on transition. Same reason. |

All three need **read-modify-write**, which needs code. So the split is:

- **Proxy** — appends the two logs, and maintains the one monotonic number.
- **Airtable** — aggregates them. Rollups, MIN/MAX, the company roll-up. All native.

Nothing that needs memory lives in Airtable. Nothing that is pure aggregation
lives in the proxy.

---

## The save path, step by step

The overlay sends **one** request on Save & next:

```json
POST /save
{ "kylasContactId": "40912",
  "contact":  { "name": "...", "designation": "...", "owner": "...", "company": {...} },
  "stage":    "Qualifying",
  "call":     { "startedAt": "2026-09-16T11:04:02Z", "duration": 74, "outcome": "Right POC" },
  "eventRows":[ { "rowKey": "uuid", "period": "Current", "eventType": "...",
                  "budget": "...", "timeline": "...", "pax": "...", "remarks": "..." } ],
  "vendorInfo": "First Event", "modeOfMeeting": "Virtual", "serviceOffering": true }
```

The proxy then does seven things, in this order:

### 1 · Resolve
Find the Airtable `Contacts` row by `Kylas Contact ID`. Create it if absent.
Resolve or create the `Companies` row and link it. Kylas already models company
and contact as related entities, so this mirrors that relationship rather than
inventing one.

### 2 · Append to Call Log — always
One row, **every save, unconditionally**, even when nothing changed and even on
the fourth no-answer to the same contact.

This is the whole of rule 2. `Contacts.Last Call At` is then a plain
`MAX(values)` rollup over this table and cannot go stale. `Call Count` comes free
and is what the pace counter should report against.

### 3 · Append to Stage Transitions — only on change
Compare the incoming stage to `Contacts.Current Stage`. If different, append
`{From, To, Changed At, Owner, Source: "Console"}`, then update `Current Stage`
and `Previous Stage` on the contact.

Those two columns are now a **cache of the log, not the source of truth**. If
they ever disagree with the log, the log wins and they get rebuilt. That is rule 3
— and `Last Stage Change At` (MIN/MAX rollups over this table) is what tells you
a contact sat at `Qualifying` for 41 days.

### 4 · Upsert Event Rows
Match on `Row Key` — a UUID the overlay assigns when the associate adds a row.
Update matches, insert new keys, delete rows whose key is no longer present.
Never delete-and-recreate the whole set: it churns record ids and destroys
anything linked to them.

### 5 · Recompute the rank — this is rule 1
```
computed = highest rung the contact qualifies for right now
         ( from the transition log + the event rows )

contact.KPI Rank = MAX(contact.KPI Rank, computed)     ← the monotonic step
if it increased:  contact.KPI Rank At = now
```

That one `MAX` is the entire mechanism. The rank can only ever move up.

Also set `Ever Picked = true` the first time a non-CNC stage is seen, and never
unset it — that is what makes Phone Picked monotonic too, rather than reading
current stage and losing a contact who regressed.

Write the live stage to `Current Stage` as normal. So a contact who booked an SQL
in March and died in April reads **KPI Rank 6, Current Stage Lost** — the funnel
keeps its March conversion, and the pipeline view shows the truth. Two fields,
two questions, neither corrupting the other.

### 6 · Write KPI Score
```
KPI Score = KPI Rank × 10^10 + unix_seconds(KPI Rank At)
```
A formula field, computed by Airtable. It exists so that the company roll-up in
the next section is a single `MAX`.

### 7 · Mirror out to Kylas
Fire-and-forget with retry, off the associate's critical path:
- `PUT /v1/contacts/{id}` with the rendered summary in the marker block of
  `remarks` (see `architecture.md` §1) — no new custom fields, no extra cost.
- `POST /v1/call-logs/` with outcome, `startTime` and `duration`, so the call
  lands in Kylas' own activity timeline natively.

Steps 1–6 are the authoritative write and complete in one Airtable batch. Step 7
failing means a sync backlog, never a lost call note.

---

## Company rollup — "highest state, by last qualitative update"

Airtable can give you the MAX rank, or the MAX date, but not natively "the date
belonging to the row holding the max rank". Packing both into one sortable number
solves it with no automation:

```
Companies.KPI Score    = rollup MAX(Contacts.KPI Score)
Companies.KPI Rank     = FLOOR(KPI Score / 10^10)
Companies.KPI Stage At = epoch + MOD(KPI Score, 10^10) seconds
Companies.KPI Stage    = label for that rank
```

Because rank dominates the high digits, `MAX` picks the highest-ranked contact
first and, **among contacts tied at that rank, the most recently updated one**.
So the company shows its best state and the date that state was last earned.

The same pattern gives you the rest:

```
Companies.Last Call At        = MAX(Contacts.Last Call At)     → Companies Reached
Companies.Ever Picked         = MAX(Contacts.Ever Picked)      → Phone Picked
Companies.Right POC Contacts  = ARRAYJOIN(ARRAYCOMPACT(Contacts.Right POC Name))
```

`Right POC Name` is a contact formula returning the name when the contact
qualifies and blank otherwise, so the company column lists exactly the qualifying
people — which is what you asked for.

---

## Inbound: Kylas → Airtable

Register a `CONTACT_UPDATED` webhook (`POST /v1/webhooks/`) pointing at the proxy.
On delivery it runs **steps 1, 3, 5 and 6 only** — no Call Log row, because a
field edit in Kylas is not a call, and `Source: "Kylas webhook"` on the
transition.

This is what keeps the ladder honest when a stage moves outside the console.
Without it, a manager advancing a stage in Kylas is invisible to the funnel.

---

## Backfill

The same handler, run once over existing contacts, with `Source: "Backfill"` and
`Changed At` set to whatever timestamp Kylas has for the record rather than now.
Because the ladder takes `MAX`, backfilling in any order produces the same
answer — you cannot corrupt a rank by replaying history out of sequence. That
property is worth the whole design on its own.

---

## What to build, in order

1. `scripts/create-base.mjs` — run it, get the base. **Untested against a live
   base**; I could not reach one from this session.
2. Proxy `POST /save` — steps 1–6. No Kylas writes yet, so it can be exercised
   against Airtable alone.
3. Port the prototype, pointed at the proxy. Overlay becomes real.
4. Step 7 — the Kylas mirror and native call log.
5. The `CONTACT_UPDATED` webhook.
6. Backfill.

Steps 1–3 are independently useful: at that point the console is capturing real
data and the KPIs compute, with Kylas not yet touched.

---

## Built — the Airtable write path

`scripts/airtable.mjs` holds the client and `syncContact`. The proxy calls it on
every save, alongside the Kylas write:

```
POST /save
  ├─ read the contact's current remarks from Kylas
  ├─ Kylas:    POST /v1/contacts  or  PUT /v1/contacts/{id}
  ├─ Airtable: company → contact → event rows → call log → transition
  └─ Kylas:    POST /v1/call-logs/
```

Airtable is optional. Without `AIRTABLE_PAT` and `AIRTABLE_BASE` the proxy still
reads and writes Kylas and each save reports `airtableSkipped`, so a missing
token costs the KPIs, not the dialling. `/targets` says which halves are live.

### What each save writes

| Table | How | Matched on |
|---|---|---|
| Companies | upsert | `Kylas Company ID` |
| Contacts | upsert, with `Company` linked | `Kylas Contact ID` |
| Event Rows | upsert per row, stale rows deleted | `Row Key` |
| Call Log | upsert, so a retry cannot double-count | `Key` = timestamp + contact |
| Stage Transitions | only when the stage actually moved | `Key` |

Every event row carries a UUID from the moment it is created in the console.
Without it an edited row would be written as a second row and keep counting
toward Right POC twice.

### The rank still only rises

`syncContact` reads the contact's existing `KPI Rank` and writes
`MAX(existing, computed)`, stamping `KPI Rank At` only when it increases.
`Ever Picked` is set once and never unset. Verified: a contact at Discovery
Call Booked (rung 19) dropped to CNC keeps rank 19.

### The daily freeze

```
AIRTABLE_PAT=... AIRTABLE_BASE=app... node scripts/snapshot.mjs           # yesterday
... node scripts/snapshot.mjs --date 2026-09-15 --dry-run
```

Run once a day after the day ends — a cron at 00:30 does it. It refuses to
freeze a day that is not over, and leaves an already-frozen day untouched.
Activity counts come from the two append-only logs; standing totals come from
the contacts as they are at that moment, which is why the run has to happen on
schedule rather than being reconstructed later.

### Testing without either key

```
node scripts/mock-kylas.mjs                     # 9900
node scripts/mock-airtable.mjs                  # 9901
KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x \
AIRTABLE_BASE_URL=http://127.0.0.1:9901 AIRTABLE_PAT=x AIRTABLE_BASE=appTEST \
  node scripts/proxy.mjs
node scripts/test-airtable-live.mjs
```

The mock Airtable implements upsert, filterByFormula and delete, and rate limits
above five requests a second like the real one.
