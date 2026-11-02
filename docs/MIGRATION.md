# Moving the KPI store off Airtable

Airtable is the system of record today. This describes replacing it with the
D1 database the Worker already runs, **without the console, the extension or
the save path changing until the last gate**.

Decided with Ayush, 2026-09-28:

- **Cloudflare D1**, not Postgres. It is already in the stack, already paid
  for on the Workers plan, and it runs next to the Worker rather than a
  region away.
- **All thirteen tables**, Research, Team and RCA included. One system, one
  architecture — not a split where three tables stay behind.
- **Nothing outside this console reads the base.** No interface, no
  automation, no Zap. Confirmed, and it is the thing to re-confirm before
  Gate 5.
- **A nightly job will push KPIs back to Kylas.** That is the point of Gate 4
  and the reason the write-back stops being a per-save round trip.

## The rule

Until Gate 5, the new database is a passenger. It is written to, read from
and compared against; nothing it says reaches a screen, and nothing it does
can fail a save. Unplugged at any point before then, nobody would notice.

## Gates

| | What | Production changes? |
|---|---|---|
| **0** | The schema exists, generated from `schema.mjs` | None |
| **1** | Backfill once, reconcile nightly | None — reads Airtable |
| **2** | Shadow writes: Airtable first, D1 after the reply | Writes D1. Reads unchanged. |
| **3** | Shadow reads: both answered, Airtable served, pair compared | None visible |
| **4** | Serve from D1, still writing both | Reversible by one flag |
| **5** | Stop writing Airtable | Not reversible without a re-backfill |

Each gate is a state the system can sit in indefinitely. Nothing has to be
finished the day it is started.

## Gate 0 — done

`scripts/sql-schema.mjs` generates the DDL from `scripts/schema.mjs`, the same
file `create-base.mjs` builds Airtable from. Generated rather than
hand-written because a hand-written copy drifts, and a second schema that
disagrees with production is worse than no second schema.

```sh
node scripts/sql-schema.mjs              # print it
node scripts/sql-schema.mjs --out db/schema.sql
node scripts/test-sql-schema.mjs         # 102 checks
```

What it produces: 13 tables, 5 foreign keys, 3 generated columns, 14 indexes.

### Two decisions inside it worth knowing

**Own-row vs child-dependent.** Airtable recomputes a rollup when a
*grandchild* changes. A SQLite stored generated column only recomputes when
its own row is written. So only fields that read their own row are columns
(`Has Any Signal`, `Is Complete`, `Measured Seconds`); the other 38 derived
fields belong to views. This is the migration's one silent-wrong-number risk,
so `test-sql-schema.mjs` asserts the split in both directions rather than
leaving it to whoever adds the next field.

**Blank is null, except checkboxes.** An Airtable number that was never filled
comes back absent, and a column defaulting to 0 turns "we do not know" into a
fact. No numeric column has a default. A checkbox is the exception — Airtable
omits it when false, so absent there really does mean 0.

### What the CHECK constraints buy

SQLite has five storage classes, so the field *type* cannot carry the meaning.
The constraints do instead: a stage the base has never heard of, a date in
`DD/MM/YYYY`, a date-time without a `T`, a checkbox holding 2 — all are
refused on write rather than discovered weeks later as a filter quietly
matching nothing.

## Gate 1 — the backfill and the reconciler

```sh
node --env-file=.env.local scripts/backfill.mjs  --db db/kpi.sqlite
node --env-file=.env.local scripts/reconcile.mjs --db db/kpi.sqlite
node scripts/test-migration.mjs          # 18 checks, against the mock
```

`backfill.mjs` is **read-only against Airtable** — it never writes, updates or
deletes there. The only thing it changes is the local SQLite file.

It is re-runnable by construction: every row is upserted on its Airtable
record id, so a second pass updates the rows the first one wrote rather than
inserting a second copy. A backfill that dies halfway is something you re-run,
not something you clean up after. Tables go parent-first, because a contact's
company has to exist before the contact can point at it.

`reconcile.mjs` answers three questions per table, kept apart because they
have different causes:

- **missing** — Airtable has it, the copy does not. The copy is behind.
- **extra** — the copy has it, Airtable does not. Something was deleted, or
  written twice.
- **differing** — both have it and they disagree. A field mapped wrongly.

It exits non-zero unless every table agrees, so it can be a cron that pages
you rather than a report somebody remembers to read.

**It refuses to compare a prefix to a prefix.** Airtable pages, and a reader
that stops early and then reports agreement is the exact shape of the bug that
once made a month of numbers the first 4,000 calls. Every table is read whole,
and a read that hits the page ceiling is a failure rather than a result.

**Comparison is by meaning, not by string.** `5` and `5.0`, a date-time
written `Z` versus `+00:00`, a select that arrived as an object rather than a
name — none of these are drift, and a reconciler that cried wolf on them daily
would be ignored within a week. `sql-store.mjs` holds those rules once, and
the backfill, the reconciler and the shadow writer all read them from there.

### What the base actually holds (2026-09-28)

| Table | Rows |
|---|---|
| Companies | 40 |
| Contacts | 80 |
| Call Log | 120 |

Small enough that "how far back should the backfill go" does not arise — it
takes everything, in seconds. Note that the ~17,900 companies live in **Kylas**,
not here; this base holds what the console has written since it started.

## Gate 1 (continued) — the derived numbers

```sh
node scripts/sql-derived.mjs --out db/derived.sql
node scripts/test-sql-derived.mjs                       # 98 checks, hand-computed
node --env-file=.env.local scripts/verify-kpis.mjs --db db/kpi.sqlite   # T3
```

38 of the 41 derived fields read a CHILD table, so they are **views**. The
other three read only their own row and are generated columns.

That split is the whole reason this file is careful. Airtable recomputes a
company's rollup when an *event row* changes, two levels below it. A stored
value recomputes only when its own row is written, so a company whose
grandchild changed would keep the old number and look perfectly fine. A view
has nothing stored to go stale. `test-sql-derived.mjs` §8 is that exact case:
insert an event row under a contact, touch neither the contact nor the
company, and the company's Right POC has to move.

Every expectation in that test was worked out from `kpi-spec.md` by hand. A
test that asks the view what it says and then asserts it said that proves
nothing.

`verify-kpis.mjs` is the other half: it compares the views against the values
**Airtable itself computed**, on every row, read-only both sides. Three kinds
of difference are not differences and are handled rather than tolerated —
list order (`ARRAYJOIN` follows link order, `group_concat` follows ours),
precision (120 versus 120.0), and blank (Airtable omits an empty formula
result). A verifier that cries wolf gets ignored inside a week.

## Gate 2 — the shadow copy

**It does not write from the save path.** The obvious design is a second write
inside `performSave`; this deliberately avoids it. A save already writes five
Airtable tables with an associate waiting, and hanging anything off it — even
wrapped so it cannot throw — grows a branch on the busiest path in the system
for the benefit of a database nobody reads yet, which would then have to be
unpicked again at Gate 4.

So the copy **pulls**, on the cron that already runs every minute. Airtable
knows when each row last changed; `shadow.mjs` asks for the ones that changed
since it last looked and upserts them. The save path does not know it exists.
The copy trails the base by up to a minute, which for something no screen
reads is not a cost.

One table per run, parent-first, with a two-minute overlap on the watermark —
the same mechanism the read mirror has used in production since 1.14. A full
lap is thirteen minutes at worst and normally finds nothing to do.

### Turning it on

Nothing happens until a **second D1 database** is bound as `KPI_DB`. It is
separate from the one holding the read mirror on purpose: it can be dropped
whole without touching anything that is running.

```sh
npx wrangler d1 create enout-kpi
# paste the database_id into the commented block at the end of wrangler.toml,
# uncomment it, then deploy
npx wrangler deploy
curl -s https://bd.enout.website/shadow-status   # where it has got to
```

With no binding, `createShadow` returns null, every call site skips, and
`/shadow-status` answers `{ configured: false }`. **Deploying the code without
creating the database changes nothing.**

If it throws, it is caught, recorded against that table in `shadow_state`, and
the next pass carries on with another one. It runs last in the maintenance job
and after the read mirror, so a failure there costs nothing that matters.

## Gate 3 — shadow reads

```sh
node scripts/test-shadow-read.mjs     # 52 checks
node scripts/bench-lanes.mjs          # latency, size and scale
curl -s https://bd.enout.website/shadow-reads
```

Every read of `/companies` is answered twice: Airtable's answer is served,
the SQL answer is computed behind the reply, and the two are compared. This
is the test row-level checks cannot do — a reply is rows *plus* a filter, a
sort and a timezone, and any of those four can read differently while every
row is identical.

Off unless `SHADOW_READS=1`. It doubles the work a read does, and there is no
reason to pay that before the copy has been agreeing for a week.

### What is not a difference

Most of `compare.mjs` is about what must *not* be reported. A comparison that
fired on list order, on 120 versus 120.0, or on `""` versus `null` would
report drift on every row of a perfectly correct copy — and then be switched
off, which is worse than never having built it.

- **Row order.** Airtable returns record order, SQL returns insert order, the
  console sorts it anyway. Matched by key.
- **Order inside a list.** `ARRAYJOIN` follows link order, `group_concat`
  follows ours. Names compare as sets.
- **Precision, blank and instants.** 120 / 120.0; `""` / `null` / `0`;
  the same moment written `Z` or `+00:00`.

What is never forgiven: a value on one side only, a number off by more than
rounding, a name in one list and not the other.

### Latency, size and scale

`bench-lanes.mjs` on synthetic data. The SQL side is real — real SQLite, the
real views, the real reader. Airtable is modelled at 250ms a page with its
five-a-second ceiling, because timing the live API over a home connection
measures the connection.

| Companies | Contacts | SQL read | Airtable | Faster | Reply | DB file |
|---|---|---|---|---|---|---|
| 40 | 120 | 1.1ms | 500ms | 446x | 23KB | 296KB |
| 1,000 | 3,000 | 20ms | 5.0s | 248x | 575KB | 1.5MB |
| 10,000 | 30,000 | 309ms | 50s | 162x | 5.7MB | 13MB |

The progress read — next call and TAT, four tables joined — is 0.2ms at
today's size and 48ms at 10,000 companies.

At 10,000 companies the whole database is 13MB against D1's 10GB ceiling:
about 785x headroom. Airtable's per-base record cap would have been passed
long before.

### The payload, and a correction

An earlier version of this note said the 5.7MB reply at 10,000 companies was
the next bottleneck. **That overstated it: 5.7MB is the uncompressed size, and
the network compresses this to about 300KB.** The figure to care about was
always the compressed one.

Two things were done anyway, because 300KB on every console open is still
worth not sending.

**Dead weight removed.** `_airtable.updatedAt` rode on every company row and
nothing had ever read it — not the console, not a report, not a test. `kpi.name`
and `kpi.owner` repeated the company's own name and owner, and the console
already fell back to the row. Removing all three: 5.66MB → 4.94MB raw,
304KB → 255KB compressed, and 13% less JSON for the browser to parse.

**The same answer is not sent twice.** Every reply now carries an `ETag`; the
console sends it back as `If-None-Match`; an unchanged answer is a **304 with
no body at all**. Measured on the live stack: first ask 19KB, second ask 0
bytes in 5ms.

That is the change that matters, because the company list barely changes
between console opens and the console asks for it every time. The browser
also skips parsing a reply it already holds, which on a big list is the
larger half of the cost.

The tag is a hash of the reply rather than a version number somebody has to
remember to bump — a forgotten bump shows as yesterday's list with nothing on
screen to say so. `cachedSeconds` is left out of the hash: it changes on every
request without the answer changing, and including it would have made this
quietly do nothing.

If the list ever does need to get smaller than 255KB, the options in order are:
send only the columns the table has switched on, page it, or filter
server-side — the last only possible once the data is in SQL.

## When this stops being optional

Asked by Ayush, 2026-10-07: how soon does Airtable have to go?

```sh
node scripts/capacity.mjs                    # the model, with its assumptions
node --env-file=.env.local scripts/capacity.mjs --measure   # ask Kylas for the real counts
```

**The answer is two answers**, and they fall due at different times:

- **Records per base** is reached by the *backfill*, not by use. 17,925
  companies plus their contacts is about **53,800 records before anybody calls
  anyone** — already past Team's 50,000. It does not matter how many
  associates there are. The gate is the day task 7 (fill the base from the
  17,925) finishes, and today the base holds 40 companies only because that
  sync has never completed. **Finishing that sync on a Team plan is what
  breaks it**, which makes the order of those two jobs the decision.
- **API calls per month** is reached by *use*. Team allows 100,000; a save is
  five requests, so about **4 associates at 150 calls a day spends the whole
  budget**. Over it, every request is throttled to 2/second until the 1st —
  not an error, just a console that has quietly become slow.

Business (125,000 records, no published monthly cap) buys room on both but
still fills: the 90-day raw Call Log alone is 108,000 rows at eight
associates, which is why `rollup-calls.mjs` exists and why its retention is a
flag.

The per-second ceiling is **5/s on every plan** and no upgrade moves it. Eight
associates saving in the same second want 40 requests. That one is not a
capacity problem that money fixes.

### Measured, not modelled — and it breaks before the caps do

```sh
node scripts/test-scale-airtable.mjs          # 17,925 companies, 90 days of calls
node scripts/test-scale-airtable.mjs --quick  # 2,000, for a fast check
```

The mock is filled to this account's real size and the **real client** is
pointed at it. The result is worse than the plan caps, because it arrives
without an error:

> asked for every contact with `maxPages: 200` — the base holds **35,850**,
> the read returned **20,000**, in 43.8s. A 200. No warning.

`listAll` returns a **prefix** when it runs out of pages unless the caller
passes `throwIfMore`, and most callers do not. **Six of twelve ceilings sit
below the table they read** at this size:

| read | ceiling | table holds | lost |
|---|---|---|---|
| `scanContacts` | 20,000 | 35,850 | 15,850 |
| contacts, for the board | 20,000 | 35,850 | 15,850 |
| `handlers.mjs` owners | 20,000 | 35,850 | 15,850 |
| `sync-kylas` watermark | 20,000 | 35,850 | 15,850 |
| `eventsFor` (scans all, filters after) | 6,000 | 8,963 | 2,963 |
| **`rollup-calls` raw log** | 40,000 | 108,000 | **68,000** |

The last one is the one to read twice. `rollup-calls.mjs` is the job that
keeps the base under the record cap, and at this size it can only see the
first 40,000 of 108,000 call rows — **the compaction cannot keep up with the
growth it exists to control.**

Records at this size total **181,493**, which is over Free, Team *and*
Business; only Enterprise Scale fits. And rebuilding the mirror alone, at
1,817 requests a lap every ~26h, is **50,876 requests a month** — half of
Team's entire budget before a single save.

So the answer to "will this work fine": no, and it will not say so. Raising
the ceilings stops the silent part but makes every read slower and more
expensive, and does nothing about either cap. The ceilings are worth raising
anyway, as a guard for the time before the migration lands — a wrong number
nobody can see is the worst state of the three.

## Still to build

1. **The Kylas write-back** — Gate 4. Waiting on the field list.

Nothing so far changes what an associate sees.

## 2026-11-03 · Turning it on, in one day

Ayush wanted the second copy ready today, with the live system untouched.

**Two fixes first.**
- **A failed pass no longer moves the watermark** (`shadow.mjs`). Until now, a first full copy that died
  stamped `since = now`, so the rows never read stayed unread for good. A 35,000-row Contacts table
  cannot be read in one Worker invocation, so this was certain to happen.
- **`BACKFILL_ORDER` includes the five tables built since September:** Dialler Calls, Call Notes,
  Push Log, Duplicate Flags and Field Map.

**The first lap runs on the laptop** (`scripts/sqlite-to-d1.mjs`). backfill.mjs fills a local file
from Airtable, and this turns the file into one SQL script for `wrangler d1 execute`. The script
skips generated columns and seeds `shadow_state` with a watermark 6 hours back, so the Worker's
minute cron continues incrementally from there. On mock: 656 rows, and every table's count matches
after the import.

```sh
npx wrangler d1 create enout-kpi        # paste database_id into the KPI_DB block in wrangler.toml
node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite
node scripts/sqlite-to-d1.mjs --db db/kpi.sqlite --out db/d1-import.sql
npx wrangler d1 execute enout-kpi --remote --file db/d1-import.sql
npx wrangler deploy                     # shadow writes on (Gate 2)
curl -s https://bd.enout.website/shadow-status
```

Gate 3 (`SHADOW_READS=1`) compares `/companies` today. The other routes need their SQL readers before
Gate 4 can serve them. That is the next piece of work.

## 2026-11-03 · Stress test before go-live (`scripts/stress-d1.mjs`)

Ayush: "my entire operation depends on it — mimic, stress test, fill the gaps." The test runs the real
scripts against the mock Airtable, with its 5 req/s ceiling on, and a real SQLite standing in for D1.
Size: 1,000 companies, 35,000 contacts, 20,000 call logs, 5,000 dialler calls, 2,000 call notes,
grown to 1,000,000 calls for the read test.

**Result: 41 / 41.**
- First lap: every table's count equals Airtable's, and every link resolves.
- 300 live saves while the cron runs: the copy caught up with no duplicates.
- Airtable outage: errors are reported, the watermark stays put, and rows written during the outage
  arrive afterwards.
- A steady cron run: ≤ 3 Airtable requests and ≤ 31 D1 calls.
- Companies list: ~50 ms at 35k contacts and ~0.6 s at 1M calls. A day's calls: < 1 ms.

**Gaps it found, now fixed:**
1. Airtable holds select values the copy's CHECK rules did not know: Call Log Outcome "SQL". One such
   row crashed the whole backfill. `schema.mjs` now has "SQL". Backfill and shadow **set a refused row
   aside** (`shadow_rejects` plus the report) instead of stopping. A table where *every* row is
   refused is still a failure.
2. One D1 statement per row made a busy minute cost 327 D1 calls. Rows now go **in batches of 50**,
   parents are looked up **in bulk**, and the busy minute costs 31.
3. A call copied before its brand-new contact pointed at nothing, for good. A missing parent is now
   **copied first**, and an absent parent is no longer cached as null.
4. (Earlier the same day) a failed pass no longer moves the watermark.

Run it again before each gate: `node scripts/stress-d1.mjs` takes about 8 minutes; `--quick` about 1.

## 2026-11-03 · Plug and play: `STORE=d1`

Ayush: "If I move the data to Cloudflare, the same system must run without any difference." And:
"why do we need Airtable — writes can go straight to Cloudflare."

**How it works.** Every read and write in the system already goes through one client,
`createAirtable()`. `scripts/airtable-d1.mjs` answers that client's REST calls from D1 instead
of Airtable: the same record shape, the same formulas, the same errors. It is plugged in *below*
the client, so the save path, the report, RCA, focus, dedupe, the crons and the migrations all
run unchanged. **One setting picks the store:** `STORE = "d1"` in `wrangler.toml` `[vars]`.
Node scripts read the same setting from `.env.local` and reach D1 through `D1_SQLITE=<file>` or
`CF_ACCOUNT_ID` + `CF_API_TOKEN` + `KPI_DB_ID` (`scripts/d1-node.mjs`). The research base's
Company List stays on Airtable, because the team edits it there.

**Proof that nothing differs:** `node scripts/test-parity.mjs` (~15 min) runs each suite on both
stores.

| Suite | Airtable | D1 |
|---|---|---|
| test-worker | 195 / 195 | 195 / 195 (and 189 / 195 with the Worker writing D1 in-process) |
| dialler | 30 | 30 |
| idempotency | 17 | 17 |
| etag | 33 | 33 |
| push-track | 74 | 74 |
| migration | 22 | 22 |
| ladder-migration | 33 | 33 |
| bulk-tag | 65 | 65 |

The 6 failures in the in-process run are harness artefacts. Each one is listed with its reason in
`test-parity.mjs`, so a new failure cannot be waved through.

`test-airtable-d1` (65 checks) covers the engine itself; `test-d1-rollback` (9) covers the way back.

**Gaps the parity work found and fixed.** The D1 copy's own maths had drifted from the live formulas:
- A removed event row still counted toward Right POC.
- `Ever Right POC` / `Ever Discovery` were ignored.
- Phone Picked read the wrong field.
- Reached ignored the stage date.

Two other fixes:
- **A save shows on the dashboard in about 0.9 s on D1, as it does today.** D1 keeps its own change
  stamp, so the save no longer waits for a cache timer.
- **A new select option from Kylas is accepted, as Airtable's typecast does.** D1 is built with
  loose selects.

**What is different, said plainly:**
1. **The Airtable base stops changing.** It stays as a frozen archive. Anything *outside* the
   console that reads it will stop seeing new data: Airtable views, interfaces and automations,
   and the "Kylas Sync" Apps Script in automations@enout.in. Check each one before the cut-over.
2. Creating a second row with an existing key (two call logs with one Key) is refused on D1;
   Airtable would have kept both. The console upserts, so it never does this.
3. `createdTime` on a record is when it last changed. Nothing reads it.

### Since the first write-up (same day): proven on real data and at speed
- **Live data.** 11 real SQL accounts were read from the live base (54 contacts, 13 event rows,
  90 calls, 89 stage changes) and recomputed on D1. **1,028 / 1,028 computed values are identical
  as text.** That match was reached only after fixing three shape differences:
  - rollup dates come back as a day;
  - two live fields were missing from `schema.mjs`: `First Right POC At` and `First Discovery At`;
  - the reverse-link lists.
- **The lookup the live base never had.** "Kylas Contact ID (from Contact)" on Event Rows does not
  exist live, so Airtable refuses the two reads that use it. D1 refuses them too, so a save behaves
  exactly as today. Making those reads work is a separate change, for after the switch.
- **Speed.**
  - Filtered reads use per-row views (`v_contacts_row`, `v_companies_row`), which are asserted equal to
    the one-pass views on every row.
  - D1 pages hold 2,000 rows and continue from the last id.
  - The read copy (mirror) stays on under D1.
  - `latency-compare.mjs` times every console route on both stores, on the same data, and only once
    both dashboards count the whole call log.
- **Cloudflare's own runtime.** `smoke-workerd.mjs` runs `wrangler dev --local` with a real D1. It
  found that, without an Airtable key, the console would have read everything from Kylas. Fixed: it
  now reads the store.
- **The tables follow the code** (`d1-schema-sync.mjs`). On the first query after a deploy, the store
  adds any missing table or column and rebuilds the views in one transaction. This replaces
  repair-base on D1.
- **The report.** `cutover-report.mjs` turns all of the above into one page.

### Cut-over (about 20 minutes, after hours)
```sh
npx wrangler d1 create enout-kpi          # paste the id into wrangler.toml (KPI_DB), uncomment
node --env-file=.env.local scripts/backfill.mjs --db db/kpi.sqlite
node scripts/sqlite-to-d1.mjs --db db/kpi.sqlite --out db/d1-import.sql
npx wrangler d1 execute enout-kpi --remote --file db/d1-import.sql
# .env.local: CF_ACCOUNT_ID, CF_API_TOKEN (D1 edit), KPI_DB_ID
node --env-file=.env.local scripts/cutover.mjs --check --out cutover.json   # must say READY
# wrangler.toml [vars]:  STORE = "d1"
npx wrangler deploy                        # note the time
node --env-file=.env.local scripts/cutover.mjs --after --cut <deploy time>  # SWITCHED + rollback line
```
`--check` copies Airtable's latest into D1 and compares every record and field. `--after` brings over
the saves of the last minute before the deploy, but never over a row that D1 has changed since the cut.

### Rollback, without losing a save
```sh
node --env-file=.env.local scripts/d1-to-airtable.mjs --since <deploy time>           # dry run
node --env-file=.env.local scripts/d1-to-airtable.mjs --since <deploy time> --apply
# wrangler.toml: remove STORE = "d1";  .env.local: remove STORE=d1
npx wrangler deploy
```
