# Where this project actually is

_Written 19 September 2026, at the end of a long session. Read this before
changing anything._

`CLAUDE.md` says what the rules are. `docs/architecture.md`, `docs/kpi-spec.md`
and `docs/HANDOFF-v2.md` say what the design is. **This file says what is true
right now** — what is built, what is not, what has already been tried and
failed, and what is waiting on Ayush.

If you are a fresh session picking this up: read `CLAUDE.md`, then this, then
go. You do not need to read the other docs until you touch the thing they
describe.

---

## 1 · Status, in one table

| | state |
|---|---|
| Code | on `claude/adoring-feynman-chhiyt`, which **is** the repo's default branch. Clean, pushed. |
| Extension | packaged by `scripts/package-extension.sh` → `dist/`. **Not published.** |
| Chrome Web Store | listing is a *draft*. Privacy tab answers are in the session log; `docs/privacy.html` is the policy. |
| Airtable base | **not repaired.** `repair-base.mjs` has never been run against the live base. |
| Proxy | runs locally for development. **Nothing is deployed anywhere.** |
| Crons | written (`scripts/cron.sh`, `install-cron.sh`). **Never installed on a real machine.** |
| Associates using it | none |

**Nothing is in production.** Every "it works" in this repo means "it works
against the mocks, verified by a test". That is a real bar — the mocks
reproduce Kylas' rate limiting, its result window, its 500s and Airtable's
rejections — but it is not the same as a live account.

---

## 2 · Getting a working stack in 30 seconds

Everything below runs with no keys and touches nothing real.

```sh
node scripts/mock-kylas.mjs &        # 9900 · Kylas, with its real awkwardness
node scripts/mock-airtable.mjs &     # 9901 · Airtable, with its rate limit

KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x \
AIRTABLE_BASE_URL=http://127.0.0.1:9901 AIRTABLE_PAT=pat_mock \
AIRTABLE_BASE=appMOCK PORT=8787 node scripts/proxy.mjs &

node scripts/dev-seed.mjs all        # fixtures with a spread, not a happy path
```

For the browser: the extension needs a host page. There is a stub served from a
scratch directory on `:8778` matching `app.kylas.io`'s URL shapes; the extension
copy under test needs `http://127.0.0.1:8778/*` added to `manifest.json`
`matches`. Playwright + `xvfb-run` — **extensions only load headed**, so
`xvfb-run -a node yourtest.mjs`, never `headless: true`.

### Tests that are committed

```sh
node scripts/validate-schema.mjs         # the schema is internally consistent
node scripts/test-validator.mjs          # ...and the validator catches 10 planted faults
node scripts/test-fields.mjs             # 62 · field parsing and normalisation
node scripts/test-report.mjs             # 56 · period maths, deltas, rollup merge
node scripts/test-kpi-fields.mjs         # the KPI projection matches the schema
node scripts/test-ladder-migration.mjs   # 33 · stage ladder remaps
node scripts/test-idempotency.mjs        # 17 · starts its own stack. The template to copy.
node scripts/test-behind-base.mjs        # 24 · a base one repair-base behind: the save
                                         #      survives it, and the backfill repairs it
```

`test-idempotency.mjs` is the one to imitate for anything new: it spawns its own
mocks and proxy, asserts, and cleans up.

### Tests that are NOT committed

The browser suites — board, grouping, accounts explorer, dashboard drill-down,
RCA flow, new contact, outbox — were written in a scratch directory and are
**gone**. `scripts/dev-seed.mjs` preserves the fixtures they used, which is the
expensive half. Rebuilding a suite is ~40 lines of Playwright around those.

---

## 3 · The bug catalogue

**A page cap that reads as a total.** `listAll` stops at 40 pages (4,000 rows)
unless told otherwise, and the report's reads did not say otherwise. The call
log passes 4,000 rows in about four days at this team's volume, so a month's
numbers were silently the first 4,000 calls. The same cap applied to the
company KPIs. Found only because the D1 copy, which reads whole tables,
disagreed with the direct path. Any whole-table read must pass `maxPages`.

These are not hypothetical. Each one shipped, was found by a test, and cost
real time. They recur because the codebase has three runtimes that must agree.

**A truthy placeholder mistaken for data.** A company row seeded with
`name: "Company " + id` made `if (!co.name)` false for ever, so the real name
could never replace it. Placeholders must be falsy or must not exist.

**One rule implemented twice, differently.** `NOT_CONNECTED` existed as
`[...UNTOUCHED, ...CNC_LADDER]` in the console and as a different test in
`airtable.mjs`; the authoritative one was the wrong one. Anything two runtimes
share is **generated** from `docs/*.json` — see `gen-stages.mjs`, `gen-rca.mjs`.
Do not hand-write a second copy.

**A field read by one half and never written by the other.** `Phones`,
`Emails`, `Salutation` were read back by the console and never written by
`syncContact`. The save gate then blocked on a phone number the record had.
When you add a field to a reader, grep for its writer.

**A derived flag that can be set but never cleared.** `Exit Reason` and
`Pending Create` both had this: the blank-dropping pass in `syncContact` skips
`""`, so a field could go true and never go back. Derived fields are assigned
*after* that pass.

**A search that stops early and says nothing.** `contactsForOwner` returned
page 0 and called it the account — 100 of 402. The mock now pages properly so
this fails loudly.

**429 read as end-of-data.** A paging loop that does not retry sees a 429's
missing `offset` as "no more rows" and silently truncates. This produced a
"regression" that did not exist. The real client (`listAll`) handles it; ad-hoc
probes must too.

**A checker that reports a difference it cannot justify.** Several verifiers
compared against a stale expectation. If a check fails, confirm the check is
right before touching the code.

**A fallback that checks for empty when the failure throws.** readCompany
filtered contacts on `{Kylas Company ID (from Company)}` — a lookup field
nothing ever created — and fell back "if the field does not exist" by testing
`recs.length`. Airtable answers a formula naming a missing field with
INVALID_FILTER_BY_FORMULA, not zero rows, so the fallback was unreachable and
every company open on every base threw and went to Kylas. Ask what the failure
actually looks like before writing the branch that handles it.

**One missing column losing the whole write.** Airtable rejects an entire
record for one field name the table does not have. The day `Phones` was added
to `syncContact`, every save against an un-repaired base died at step 3 — no
event rows, no call log, no transition — and the outbox correctly refused to
retry a 4xx, so an afternoon of dialling was simply gone. A read that fails
shows stale numbers; a write that fails loses the call. `upsertTolerant` now
drops the name Airtable objected to, sends the record again, and reports what
it gave up; `MOCK_AIRTABLE_NOFIELD=Table.Field` reproduces the rejection.

**A field written only going forward is a funnel that reads zero.**
`First Worked At` / `First Picked At` are written once, on a save, so every
contact worked before they existed had neither — and the ladder showed
"Companies worked 0" under "Right POC 2", which is not a funnel. A new column
that something is counted from needs a backfill in the same breath:
`migrate-first-worked.mjs`.

**Asking the same question on every request.** `/v1/users/me` cannot change
while the process runs, and it was being fetched on every `/health` poll and
twice per `/companies`, each behind the 450ms Kylas gap. A `/companies` served
entirely from a warm cache took 917ms, and 900 of those were that. Look for
the fixed cost before optimising the variable one.

**A mock more capable than the thing it stands in for.** The same bug hid for
weeks because mock-airtable resolved `{X (from Link)}` by hand. A stand-in that
is kinder than production does not test production. It now returns 422 for a
formula naming a field the table does not have.

**The version handshake exists for a reason.** `/health` returns the build; the
console warns when it differs. A proxy left running for hours serves yesterday's
code and answers everything cheerfully. **Restart the proxy after editing
`scripts/`** — an afternoon went into a bug that was only a stale process.

---

## 4 · Invariants that look arbitrary and are not

- **`KPI Rank` only rises.** Written as `MAX(existing, computed)`. `KPI Rank At`
  is when it last rose, which is how "stuck since" is known without a new column.
- **`Ever Picked` is monotonic** and excludes `NOT_CONNECTED` — CNC is rung 6,
  so `rank > 0` is not "they answered".
- **Right POC is derived, never typed.** Any of budget | timeline | pax on any
  row. Do not add a field for it.
- **Kylas has no stage history.** Verified against the whole Postman collection.
  A contact carries only its current `cfPipelineStageBd`. All history is ours.
- **The rollup destroys company identity.** `rollup-calls.mjs` aggregates old
  days to `day|owner|outcome`. Anything per-company per-period is impossible
  past the retention window — this is why the ladder opens on Calls, not
  Companies reached.
- **`/v1/search/company` stops at 10,000** while still reporting the true total.
  Hence the keyset crawl, with a `+1ms` cursor so ties are not dropped.
- **The save journal** (`.save-journal.json`) is what stops a lost reply
  creating a contact twice. It is written *before* the POST.
- **A save is synchronous, everything else is cached.** Pressing save POSTs to
  the proxy, which writes Kylas and Airtable before it answers; the browser
  copy is a working cache and an outage queue, never the store. Reads are the
  opposite — held and served stale while they refresh, because every Airtable
  request queues behind a 220ms gap and the same rows answer every period and
  every owner. What is held, and for how long:

  | | where | fresh for | dropped by |
  |---|---|---|---|
  | `/v1/users/me` | `whoami()`, proxy | 10 min | restart |
  | company crawl | `companyCache`, proxy | 5 min | `?fresh=1` |
  | dashboard's four tables | `reportData`, proxy | 60 s (15 min on the Worker, kept in D1) | a save (Node only), `?fresh=1` |
  | Companies index | `IDX`, airtable.mjs | 60 s | a save |
  | Contacts scan (no-rollup fallback) | `SCAN`, airtable.mjs | 30 s | a save |

  Every one of them is dropped by a save, so an associate never reads back a
  version from before their own call. Past the fresh window the held value is
  still served and the refresh runs behind it, so only the first request of a
  process ever waits.

  **On the Worker, reads come from D1, not from any of the above.** There is
  no long-lived process there, so per-process caches are empty on most
  requests. Three pieces replace them:
  - **`scripts/mirror.mjs`: a copy of every Airtable table the console reads,
    kept in D1.** It stays current three ways:
    - write-through from every Airtable write the server makes;
    - a delta by `LAST_MODIFIED_TIME` from the `*/5` cron, only while the
      console is in use;
    - a full rebuild into a new generation after the nightly sync and rollup.
      This covers what a delta cannot see: deletions, and rollups changed by
      another table.

    Instances hold rows in memory and pull only rows newer than the version
    they have seen.
  - **`shared()` in handlers.mjs: Kylas answers kept in D1.** These are
    `whoami`, the picklists, the company crawl, and the per-company and
    per-owner fallbacks.
  - **`/save` reads back the contact and company after writing**, because
    their formulas and rollups changed from rows the write-through did not
    return.

  Measured on workerd with 1,500 companies, 3,000 contacts and 6,000 calls, on
  a cold instance:
  - `/report`: 17.6 s → 0.29 s
  - `/companies` and `/queue`: under 0.5 s
  - Airtable reads while serving: 0

  The first full build is about 60 s and runs in the cron, never in a
  request. Tests: `test-mirror.mjs` (32), `test-worker.mjs` §6b and §8.

  **`/companies` uses Airtable only once the sync has run** (the `last-sync`
  row in Schema Migrations). The console writes a company on its first save,
  so an unsynced base is never quite empty. Its handful of rows used to be
  served as the whole account.

## 6 · Ayush's to-do, outside this repo

- **Run the Kylas sync once from the laptop** (DEPLOY.md part 9). The live
  base held 3 companies and 4 contacts on 2026-09-24 — the sync had never
  filled it. Check the dry run's counts against the Airtable plan's
  records-per-base limit first.
- **Workers Paid ($5/month)** on the Cloudflare account. Required, not
  optional: the report needs ~100 Airtable requests in one request, and Free
  allows 50 and 10 ms of CPU.
- **Open Workers & Pages once** in the dashboard so the account gets its
  workers.dev subdomain; until then the cron triggers do not register (error
  10063) and the nightly sync does not run in the cloud.

- **Rotate the Airtable PAT** — `pat7TsKhwZPyqTMG5…` was pasted in plain text in
  a chat. Never committed (verified), but treat it as burned.
- **Run `repair-base.mjs`** on the live base. A save no longer dies without it
  — it drops the column it cannot write and says so — but until it is run,
  `Phones` is not stored, the `RCA` and `Team` tables do not exist, and every
  company open scans the whole Contacts table because the `Company Kylas ID`
  rollup is missing. That scan is most of the "opening an account is slow".
- Then `seed-transitions.mjs`, then `migrate-ever-picked.mjs`, then
  `migrate-first-worked.mjs`. **That order** — each reads what the one before
  it writes. The last is what makes the funnel's bottom two rungs stop reading
  zero; without it "Companies worked" is 0 under a non-zero "Right POC".
- Enable GitHub Pages, or host `docs/privacy.html` on enout.in, for the store's
  privacy policy URL.

## 7 · Things that were tried and rejected

Do not re-propose these; they were built and thrown away.

- A wizard / stepper call flow. A real conversation jumps around.
- A five-hue colour scheme. Rainbow soup. (The palette is now Ayush's
  reference file, verbatim — see `CLAUDE.md`.)
- The KPI join between the Kylas crawl and Airtable. Deleted rather than
  debugged; `/companies` reads the mirror directly.
- The four headline tiles on the dashboard. They counted companies at a rung
  all-time while the ladder counts arrivals in the period — same words, two
  numbers, reads as a bug.
- Searching the queue. The scope filter runs first, so it could only ever find
  what was already on screen.
