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

## Still to build

1. **The reconciler** — walks both sides, reports per-table differences as a
   number and a list of keys. The instrument the rest of this is read through,
   so it gets more care than the thing it measures.
2. **The backfill** — one pass, resumable, identical when re-run.
3. **The shadow writer** — after the reply, wrapped so it cannot throw into
   the save path.
4. **The derived views** — `sql-derived.mjs`, the 38 fields above.
5. **The comparison harness** — for shadow reads, at Gate 3.

Everything up to the shadow writer is invisible to production.
