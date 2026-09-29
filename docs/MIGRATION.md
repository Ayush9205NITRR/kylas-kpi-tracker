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

### The finding the benchmark turned up

**The database stops being the bottleneck and the payload becomes one.** At
10,000 companies `/companies` answers in 309ms and then has to send 5.7MB to
a browser. On a laptop on office wifi that is the slower half; on a phone it
is most of the wait.

This is not caused by the migration — the same reply is 10.7MB out of
Airtable today, so the move roughly halves it. But it is the next thing worth
fixing once the move is done, and it is worth knowing before anyone reads
"162x faster" and expects the screen to be 162x faster. It will not be.

Three ways out when the time comes, cheapest first: send only the columns the
table has switched on; page the list and fetch the rest as it scrolls; or
filter server-side, which is only possible once the data is in SQL.

## Still to build

1. **The Kylas write-back** — Gate 4. Waiting on the field list.

Nothing so far changes what an associate sees.
