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
                                     # (includes four promised call-backs on real
                                     #  Kylas ids — overdue, today, +3, +45)
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
node scripts/test-company-crawl.mjs      # 9 · every company past Kylas' 10,000 window
node scripts/test-days.mjs               # 43 · where one day ends. Every case is an hour
                                         #      the old code got wrong
node scripts/test-buckets.mjs            # 38 · the six call buckets, and the stages that
                                         #      are easy to file by rung and should not be
node scripts/test-kpi-data.mjs           # 37 · the values check: a dead rollup, drift, and a
                                         #      formula reading the wrong field
node scripts/test-offsite.mjs            # 45 · Offsite Timeline out of event-row text, and the
                                         #      old FY chips landing where the new picker does
node scripts/test-replace.mjs            # 27 · the PUT replaces the record, so every field the
                                         #      card is silent about is carried over from it
node scripts/test-write-map.mjs          # 29 · which Kylas field is the call-back and which is
                                         #      the offsite timeline, per account, and the
                                         #      values sent under them
node scripts/test-digest.mjs             # 28 · the daily write-back email, counted from the
                                         #      job rows — including what a friendly number hides
node scripts/test-enrich.mjs             # 62 · the tolerant number parser and its bands
node scripts/test-filter-types.mjs       # 169 · every column's type, its operators, and the
                                         #       page documenting them, all agreeing
node scripts/test-etag.mjs               # 33 · conditional requests, and what may not be cached
node scripts/test-sql-schema.mjs         # 102 · the generated SQL is the Airtable base, exactly
node scripts/test-sql-derived.mjs        # 98 · the views compute what Airtable's rollups did
node scripts/test-migration.mjs          # 22 · backfill and reconcile against a live-shaped base
node scripts/test-shadow.mjs             # 24 · the pull-based copy, on the existing cron
node scripts/test-shadow-read.mjs        # 52 · the two lanes answer the same thing
node scripts/test-worker.mjs             # the whole surface on workerd, with subrequest costs

xvfb-run -a node scripts/test-fab-live.mjs    # 10 · the launcher moves, and moving it
                                              #      does not open the console — a click
                                              #      and a drag start identically
xvfb-run -a node scripts/test-move-live.mjs   # 15 · a REAL Chrome with the extension
                                              #      loaded: the console moves, resizes,
                                              #      remembers and resets. Needs the :8778
                                              #      stub and a patched copy of extension/
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

**A rollup Airtable never computed, and a quarter of the KPIs read zero.**
`Companies.Ever Picked` is declared `MAX(values)` over `Contacts.Ever Picked`,
which is a **checkbox** — and Airtable returns blank for the maximum of a set
of checkboxes. `Companies.Phone Picked` read that rollup, so it was `0` on all
98 companies in the live base while 71 of them had a contact who had picked up.
Every picked-up number on every screen was zero, and nothing looked broken.

Nothing that compares the base to `schema.mjs` could see it: the field was
present, the type was right, the formula text was right, and **the meta API
does not report a rollup's aggregation at all** (that is `d.rollupUnreadable`
in `verify-base.mjs`). The fault existed only in the values.

Fixed on the live base 2026-09-29 by repointing the formula at the rollup that
does work — `Phone Picked = IF({First Picked At}, 1, 0)` — after checking that
`Ever Picked` and `First Picked At` agree on **every** contact row, 0
disagreements in both directions. 0 → 71 of 98. `schema.mjs` carries the new
formula so `repair-base.mjs --update-formulas` cannot revert it. Repairing
`Ever Picked` in place was not an option: **a rollup's aggregation cannot be
changed through the API**, only formulas can. Nothing reads it now.

The check that would have caught it on day one is
`scripts/check-kpi-data.mjs`, which `verify-base.mjs` now runs at the end of
every run: it recomputes each Companies rollup from the contacts underneath it
and reports **DEAD** (blank or 0 on every row while the rows say otherwise)
separately from **DRIFT** (wrong on some rows — usually a link that never got
written), plus the per-row invariants, so a formula pointed at the wrong input
is caught against its own input. `--schema-only` skips it.

**A result window read as the end of the list.** Kylas' company search serves
10,000 rows and stops, while reporting the true total (17,926 on Ayush's
account). The updatedAt-window crawl meant to reach the rest added nothing
there. Now the crawl reads the same search oldest-first as well: the window
caps how far into one ordering it goes, so the two ends cover 20,000 with no
filter rule. `test-company-crawl.mjs` covers:
- a search that refuses the rule;
- bulk-import identical timestamps;
- a search that ignores the sort (reported, not looped).

**A field captured and saved nowhere.** Offsite Timeline was on the call card
from the start, but it was never read from Kylas and never written to Kylas or
Airtable, so it lived only in one browser. Since 1.17 it is written to the
Contacts table's `Offsite Timeline` column (run repair-base to add it) and
rolled up per company for the accounts filter. It is not yet written to Kylas:
the `cfOffsiteTimeline` picklist's expected value format is unverified, and a
rejected value would fail the whole save.

**Heavy work inside a request.** `/companies` ran the whole Kylas crawl inline
when there was no copy yet. Past Kylas' 10,000-row window that is 100+
requests, and Cloudflare refused it: "Too many subrequests by single Worker
invocation" (50 on Free). Requests now only read. The crawl, table copies and
saves' retries run in the 5-minute job, one heavy piece per run.
`test-worker.mjs` §10 counts every route's outside requests and database
queries on a cold instance and fails any above 50.

The same fault had a second door: before a table's D1 copy existed, a
request read it straight from Airtable, page after page, which is 100+ pages
on a synced base. Now `mirrored()` lets a request read at most 5 pages of an
uncopied table. Past that it answers 503 `{building: true}` ("still
copying"). The console shows that message and does not treat it as the
server being offline. Measured on 1,500 companies, 3,000 contacts and 6,000
calls, uncopied: worst request 37.

**Background work nobody waited for jams the instance.** On Workers, anything
still running when a request ends is cancelled. A cancelled fetch is never
settled, and the Airtable and Kylas clients each keep ONE queue per instance,
so every later call on that instance waited behind it for ever. It happened
the first time a queued save started its post-save read-back after the
request's `waitUntil` list had been taken. Two fixes:
- `worker/index.mjs` keeps each request alive until `building()` is empty,
  looping to catch work that other work starts.
- The client queues stop waiting on any one request after 60 s, and every
  fetch has a 30 s timeout.

Any new background work must go through `inFlight()`.

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

**One storage key holding everything.** Every console setting lived in one
`enout.settings` object, and the 10,000-company list is a setting — so reading
`density` parsed megabytes, three times per filter tick. Ticking a Source took
400–750 ms to show and read as "the filter does nothing". Since 1.18 each
setting is its own key (`enout.setting.<name>`, migrated once); a tick is ~90 ms.
The same release stopped a click outside the Source panel from resetting a
"contains" filter.

**Offsite Timeline is derived, never typed** (1.18). `extension/console/offsite.js`
reads the quarters out of the Timeline on offsite rows (event type blank or
containing "offsite"), Past and Now. "Q3" is a calendar quarter; with "FY" in
the text it is the Indian financial year (Q1 = Apr–Jun). The Worker imports the
same file through `scripts/offsite.mjs`; `test-offsite.mjs` pins the parser.
There is no Airtable column for it any more. Since 1.19.2 Kylas' own company
field ("Offsite Timeline (BD - New)", a picklist — its option ids are named
from `/v1/entities/company/fields`) is read into quarters too, and the
Accounts view shows the union. The field is found by its LABEL (its internal
key need not contain "offsite"); `/cache-status` → `offsite` and the crawl's
log line say which field was found and how many companies carry a value. Since
1.19.5 the Company List's "Offsite Timeline" column is read as well — the
team's Kylas Field Map copies Kylas `cfOffsiteTimeline` (company) into it,
~170 rows filled — so the filter works before a crawl carries the field. It is NOT on the call card any more (Ayush,
2026-09-24): an account fact, not a contact field.

**Focus lists and research on the call card** (1.19.3). The focus control
(★ Focus / Not picked / Deprioritize with a reason, Airtable Focus table) is,
since 1.19.8, a large three-way switch in the HEADER beside Save & next,
captioned with the company (a card low in the second pane, then a small pill,
were both missed). Deprioritize opens a reason popover under it. Research is the
team's own curated row — Company Database (`RESEARCH_BASE`) → "Company List",
keyed by "Kylas Company Id" — shown read-only in the THIRD pane in four
sections, the ten fields Ayush named, with "Open in Airtable". Since 1.19.4 it is
its own pane to the RIGHT of Event & vendor (over 1280px wide; top of the
events pane from 960 to 1280; a third tab below 960). The Worker's
AIRTABLE_PAT needs read access to that base. The Accounts view has no focus
panel (it did not survive a BD with 100 picks); the focus filter lists every
focus account, each BD's, the deprioritized and the rest.

**A save's Airtable writes used to wait on each other** (fixed 1.19.1). The
client waited for each reply before sending the next request, so a save was
seven ~350 ms round trips in a row, and Kylas went first even when Airtable
did not need it. Now requests are spaced by START (Airtable's limit is a
rate, 5/s, not a concurrency), `syncContact` sends what does not depend on
what, event rows go ten to a request, and Airtable runs beside Kylas for a
contact that already has a Kylas id. Measured on workerd, mocks at 350 ms
(Airtable) / 200 ms (Kylas), 6,000 companies: save landed 3.8 s → 2.1 s
(existing contact), 3.0 s → 2.1 s (new); the dashboard counts it ~0.1 s
later. `/ladder` is memoised on the mirror stamp: 422 ms → 12 ms warm. The
floor now is Airtable's rate limit. `MOCK_LATENCY_MS` / `MOCK_TRACE` on both
mocks reproduce this.

**"Me" is the signed-in person** (1.20). It used to be whoever owned the
server's Kylas key, for every associate. The Worker now carries the Google
caller through each request (AsyncLocalStorage) and `whoami()` matches that
email to a Kylas user — resolved one by one from the crawl's owner ids, since
Kylas has no list-users endpoint. No match → an empty identity that owns
nothing, and the console says why. No sign-in (local proxy, crons) → the key's
owner, as before.

**The call-back is stored** (1.20): Contacts "Next Call Date"/"Next Call Time"
and Call Log "Next Call Date" (the promise made on that call). Until then it
lived only in the browser. Needs `repair-base` on the live base. From it,
`scripts/progress.mjs` works out each account's furthest stage, SQL date, last
and next call, and whether promised call-backs were kept — the focus pane in
the Today tab, the Next call column/chips, and TAT (pick → SQL days, days
open, call-backs on time %). A focus account stays on the pane until SQL.

**The board's buckets are an ACTION order, not the ladder's.** The 26 rungs are
a funnel; the six call buckets (`docs/stages.json` `families`, 2026-09-29) are
what you would do next, and the two disagree on purpose. `GHOSTED` is rung 20
and is labelled **Discovery Call No-Show** — a meeting to re-book, so it is in
*Meeting in play*, not *Closed*. `NOT_INTERESTED` is rung 10 and never needs a
call again. Offsite Delayed and Offsite Done (Late Reachout) rank *below*
Activation and still sit in *Activation and above*, because a conversation
happened. Anything that sorts the board by rung, or replaces the table with two
comparisons, has misunderstood it — `test-buckets.mjs` asserts exactly that.
The board groups on the **calculated** account stage, so an account whose POCs
sit at CNC, MQL and Follow-up 2 is in the pile you would call a Follow-up 2
account from.

**Every date was UTC, and half of them were a rolling 24 hours.** Fixed
2026-09-29; `scripts/day.mjs` and `extension/console/day.js` are now the only
two places that decide what day something happened on, and
`scripts/test-days.mjs` is the boundary list. Two faults, about twenty sites:

  `new Date(x).toISOString().slice(0, 10)` is the **UTC** day. In IST that is
  yesterday's date until 05:30, so every call on the early shift was missing
  from the Today tab, counted on the previous day by the snapshot — which then
  freezes and is never recounted — rolled into the wrong week and month, and
  made a call-back promised for that morning read as overdue before it was due.

  `Math.floor((Date.now() - t) / 864e5)` is a **rolling day**. A call at 23:00
  yesterday read "Today" at 09:00 this morning, with a green freshness dot, on
  an account nobody had touched since the day before. That one drove the Last
  call column, all five freshness bands, the stale flag and "Days since last
  call".

A date field with no time (Airtable's `Next Call Date`) is never shifted
through a timezone — doing so moves a call-back promised for the 29th onto the
28th. `dayOf` returns a plain date untouched, and that has its own tests.

**Account pipeline stage is CALCULATED, and is not any of the fields it sits
between.** Ayush, 2026-09-29: an account with three contacts has three pipeline
stages, and the account sits at the furthest of them by the 26-rung order in
`docs/stages.json`. Three different things are on the row and they disagree
often — where they do, somebody has worked the account somewhere the other two
cannot see:

  **Pipeline stage** the company's own `Pipeline Stage - BD` in Kylas: one
  value typed on the company record, stale the moment a POC moves.
  **Account stage** the calculation. `scripts/progress.mjs` already worked it
  out for the focus pane and only the `nextCall` it derived was ever sent;
  `/companies` now carries `acctStage`/`acctRung` too. Blank means no contact
  of that account has been saved to the KPI base yet — **not** "nothing is
  happening", and on a base with 40 companies out of 17,924 that is most rows.
  **Demand team stage** Company List's `Account Pipeline Stage`, a reference
  the demand team keeps by hand. Off by default.

**A handler that fires is not a feature that works.** `.viewport` was
`position:absolute; inset:0`, so on the two screens an associate actually uses
— the dashboard and the accounts list — the report covered the console's
header. That header is the handle you drag the console by, and it carries Dock
and Close. The grab cursor was set, the tooltip was set, the mousedown handler
was bound and fired perfectly when a test dispatched an event straight at the
element; a real pointer never reached it, so the console could not be moved,
resized or closed except with Escape. `scripts/test-move-live.mjs` presses at
real coordinates in a real Chrome, which is the only thing that finds this.

**Enrichment reads as "—" for four different reasons, and they look identical.**
The Revenue / LinkedIn / Boolean post / Account stage columns come out of the
demand team's `Company List`, joined to the account on `Kylas Company Id`. Four
things break that chain and every one of them renders an em dash on every row:
`RESEARCH_BASE` or `AIRTABLE_PAT` unset; the D1 copy of that table not built
yet (it is ~150 pages, and `maintain()` builds ONE table per minute, so on a
fresh deploy this is simply "come back in a few minutes"); a column missing
from `ENRICH_FIELDS`; or a join key that does not match, because Company List
holds the id as text and one typed with a stray space joins nothing. **`GET
/enrich-status` answers which one** — counts on both sides, how many ids
actually meet, per-column fill counts, and five sample keys from each. Reach
for it before reading any of the code.

**The version handshake exists for a reason.** `/health` returns the build; the
console warns when it differs. A proxy left running for hours serves yesterday's
code and answers everything cheerfully. **Restart the proxy after editing
`scripts/`** — an afternoon went into a bug that was only a stale process.

---

## 3 · (cont.) THE PUT REPLACES THE RECORD

**`PUT /v1/contacts/{id}` does not merge. What you do not send, you delete.**

Learned on the live account on 2026-09-29, at the cost of one contact's name,
phone and email. `probe-write.mjs` sent one field per request — sound
reasoning (Kylas rejects a whole payload over one bad value with a 400 naming
nothing) and a catastrophic method. A PUT carrying `{remarks,
customFieldValues}` returned **200** and left a record with no `firstName`, no
`lastName`, no `phoneNumbers`, no `emails`. The same rule explains the other
puzzle in that run: a PUT of `{remarks}` alone looked like "200 but nothing
stored" — it stored exactly what it was given and dropped everything else.

This was a production bug, not only a probe bug. `toKylasContact` deleted every
`undefined` key from the body, which reads as "leave it alone" and means
"clear it", and the validator explicitly allows an existing contact to have no
phone on the card. **Any save of a contact whose card lacked a phone would have
wiped the real one**, with a 200 in the log and the associate told it worked.

Since 1.30, the payload is built against `base` — the contact as Kylas holds
it, which the save already fetches for the remarks block:

- no phone on the card → the phone Kylas has, never an empty array
- no designation typed → the designation already on the record
- `cfBatch`, `cfAccountHealthBd`, `cfPreviousOffsiteLocation` → every custom
  field the CRM owns, carried over first so ours overwrite and none are lost
- a value that arrives as `{id, name}` is written back as its id; a blank one
  is left out (both are 400s otherwise)

A failed read of the record now **fails the save** and the queue retries it.
Writing blind would replace the contact with only what the card knows.

`scripts/test-replace.mjs` (27) is the guard: every case in it is something a
save would otherwise have deleted.

## 3a · What the console writes back to Kylas

One `PUT /v1/contacts/{id}` (or a `POST` for a new one) and one
`POST /v1/call-logs/`. No company record is ever written — `updateCompany`
exists in the client and nothing calls it, so **accounts created in Kylas is
zero by design**, and the digest says so rather than printing a number.

| | fields |
|---|---|
| Contact, every save | `firstName` `lastName` `designation` `linkedin` `emails[]` `phoneNumbers[]` `company` `ownerId` `remarks` (between the markers only) `cfPipelineStageBd` `cfSourceOfData` |
| Contact, since 1.29 | the **call-back date** and the **offsite quarter**, under whatever this account calls those fields |
| Call log | `outcome` `callType` `startTime` `duration` `phoneNumber` `notes[]` `relatedTo` |

**The two new ones are resolved, not hardcoded** (`scripts/kylas-write-map.mjs`).
A custom field's name is whatever the admin typed — `cfNextCallDate`,
`cfCallBackOn`, `cfOffsiteTimelineBdNew` — so the field is picked out of the
live field list (already fetched and cached for the picklists) by what it *is*:
a date field whose label talks about the next call, a picklist whose label talks
about the offsite timeline. `Last Called At` is explicitly scored to zero, since
it is also a date field whose label says "call" and writing a future date into
it would rewrite the account's own call history. An account with neither field
gets the payload without them; the save is never failed over a lookup.

The quarter is matched by **reading** each option with the same parser the
console reads free text with — `"Jul - Sep"`, `"Q3 (Jul-Sep)"` and `"JUL_SEP"`
all derive `JUL_SEP` — so the picklist's spelling never has to be known here.

**Still not written:** budget, pax, event type, mode, vendor and service
offering (remarks text only), and salutation.

**Verified on the live account, 2026-09-29** (contact 6258147): the call-back
stored as `cfNextCallDateCallLater = "2026-10-01T10:30:00.000Z"` — 16:00 IST,
the right instant — and the offsite as `cfOffsiteTimeline = [2880426]`, Jul-Sep,
derived from a card that said "Aug, week 2". The account's fields are
`cfNextCallDateCallLater` (DATETIME_PICKER) and `cfOffsiteTimeline`
(MULTI_PICKLIST: 2880424 Jan-Mar, 2880425 Apr-Jun, 2880426 Jul-Sep, 2880427
Oct-Dec); `cfPreviousOffsiteDate` and `cfPreviousOffsiteLocation` are text
fields about the *previous* offsite and are correctly not chosen.

Whether **remarks** stores is still open: alone it does not (that is the
replace rule), and the run restored before reading it back inside a full
payload. The re-run answers it. `scripts/probe-write.mjs`
is the live check, one contact at a time, restoring what it changed:

```sh
KYLAS_KEY=... node scripts/probe-write.mjs --contact <id>            # read-only
KYLAS_KEY=... node scripts/probe-write.mjs --contact <id> --write    # and back again
```

It writes **one field per request**, because Kylas rejects a whole payload over
one bad value with a 400 that names neither the field nor the rule. Its verdict
separates `KEPT` from `DROPPED (200, nothing stored)` — the second is a
permissions or shape problem, and it is the one that would otherwise look like
success.

## 3ab · The nightly push, and what happens to the rows written before it

`scripts/push-kylas.mjs`, in the schedule at **01:45**, after the sync so it
works from a base that was just refreshed:

```sh
node --env-file=.env.local scripts/push-kylas.mjs            # dry run, prints what would move
node --env-file=.env.local scripts/push-kylas.mjs --apply
```

A save writes the call-back and the offsite quarter from 1.29. This is the
other half: every contact saved *before* that, and every contact whose quarter
moved because somebody edited an event row rather than logging a call. Without
it the two fields are right on the contacts worked since the upgrade and blank
on the thousands worked before, which is worse than either — a filter in Kylas
would look like it works and quietly miss most of the pipeline.

It writes **only those two fields**. Not the stage, the name or the phone:
Kylas is the system of record for those, and a nightly job that overwrites them
from a copy is how a CRM loses an edit somebody made in the CRM. Every write is
the whole contact (the PUT replaces), and a contact whose values already agree
is not written at all, so the second night is cheap.

**THE OLD ROWS NEED NO MIGRATION.** The quarter is never stored — it is derived
from the Timeline text each time it is asked for. Until 1.29 the chips offered
*financial*-year quarters (`Q2 FY27`); the picker writes *calendar* ones
(`Jul-Sep`). The parser reads FY as FY, so both land in the same bucket:

| written on the row | derives | written by |
|---|---|---|
| `Q2 FY27` | `JUL_SEP` | the old chips |
| `Jul-Sep`, `Aug`, `Aug, week 2` | `JUL_SEP` | the picker |
| `Q3 FY27` | `OCT_DEC` | the old chips |
| `Oct-Dec`, `Nov` | `OCT_DEC` | the picker |

A bare `Q3` is the calendar quarter and `Q3 FY27` is not — the `FY` token is
what separates them, and both spellings are in the data. `test-offsite.mjs` §3
holds every pair; if it ever fails, every event row written before 1.29 has
silently moved one quarter.

## 3b · The daily write-back email

`scripts/digest.mjs`, sent by the maintenance run once the reported day has
ended (`DIGEST_AFTER_MIN`, default 06:00 IST), claimed in the shared store by
the day's own key so several instances cannot each send it. It counts the
**finished job rows** — what actually reached Kylas — not what was attempted:
contacts updated, contacts created, calls logged, accounts worked, accounts
saved here for the first time, plus every failure by name and every save whose
Kylas half landed while its Airtable half did not.

Set `MAIL_URL`, `MAIL_KEY`, `MAIL_FROM`, `MAIL_TO` (Resend's shape, which most
providers accept). With them unset it logs the digest and sends nothing, which
is also what every test does — nothing here can email anybody by accident.

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
