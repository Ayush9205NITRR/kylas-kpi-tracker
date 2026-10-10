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
| Proxy | **DEPLOYED.** `enout-bd-proxy` on `bd.enout.website`, Cloudflare Workers Paid + D1. Version `1.40.0`, 2026-09-30. |
| Crons | **six, live on the Worker** — see below. `scripts/cron.sh` / `install-cron.sh` are the laptop fallback and are still uninstalled. |
| Writes to Kylas | **LIVE, capped.** `PUSH_APPLY = "1"`, `PUSH_LIMIT = "100"`, nightly at 02:45 IST. |
| Associates using it | none yet |

### It is no longer all mocks

For most of this repo's life, every "it works" meant "against the mocks,
verified by a test" — a real bar, since the mocks reproduce Kylas' rate
limiting, its result window, its 500s and Airtable's rejections, but not the
same as a live account. That changed on 2026-09-30. The Worker is deployed,
six cron triggers fire on Cloudflare's schedule, and **one of them writes back
into the live CRM**:

```
30 20 * * *     02:00 IST daily    Kylas -> Airtable, everything
45 18 * * *     00:15 IST daily    freeze yesterday
40 * * * *      hourly             Kylas -> Airtable, contacts only
0 21 * * SUN    02:30 IST Monday   roll up the call log
15 21 * * *     02:45 IST daily    Airtable -> KYLAS. WRITES. capped at 100.
* * * * *       every minute       D1 copies current, save queue drained,
                                   Sync-now flag picked up
```

The every-minute one is not optional plumbing: without it Sync now silently
does nothing (the flag is set and never read), failed saves never retry, and
the mirror never fills. If the Accounts pane and the ladder both look frozen,
check that trigger before anything else.

**The nightly push is the one that can destroy data.** A `PUT` on the Kylas
contacts endpoint REPLACES the record (§3 cont.), and this repo has already
lost one contact's name, phone and email to exactly that. `PUSH_LIMIT = "100"`
is what stands between a bad shape and the whole account, and it does not come
off until a real night's run has been read back with `npx wrangler tail` and
the write-back email agrees with it. Backing the whole thing out is one line —
comment `PUSH_APPLY` in `wrangler.toml` and redeploy.

`VERSION` in `wrangler.toml` must equal `extension/manifest.json`; the console
compares them and says "restart the proxy" when they differ. It had drifted to
1.27.1 against an extension at 1.40.0, so that warning was crying wolf for long
enough to be ignored. Both are 1.40.0 now — which makes `/health` the honest
answer to "did my deploy land".

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
node scripts/test-kpi-spec.mjs           # 34 · docs/kpi-spec.md §0 — the table the team reads
                                         #      to settle "what counts as worked" — asserted
                                         #      against the code it describes, both ways
node scripts/test-kpi-data.mjs           # 37 · the values check: a dead rollup, drift, and a
                                         #      formula reading the wrong field
node scripts/test-offsite.mjs            # 45 · Offsite Timeline out of event-row text, and the
                                         #      old FY chips landing where the new picker does
node scripts/test-replace.mjs            # 39 · the PUT replaces the record, so every field the
                                         #      card is silent about is carried over from it —
                                         #      for the save AND for the nightly push
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

xvfb-run -a node scripts/test-ui-live.mjs     # 50 · the three things that only exist on
                                              #      screen: draggable pane widths, the
                                              #      quarter→month→week picker, and the
                                              #      board's Buckets/Stages columns. Needs
                                              #      the stack, the :8778 stub, a patched
                                              #      extension copy AND API.setBase — see
                                              #      its header, every line of which was
                                              #      learned by it blaming the product
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

**A remembered answer is never re-asked.** The company crawl remembers which
request shape Kylas accepted (`company-shape` in the store) and goes straight
to it on every cold start. 1.58 added a shape above the remembered one (lean
fields + Kylas' audit fields, for the Created/Updated filters) — and no server
would ever have tried it. The key is now `company-shape-v2`, so each probes
once; a new shape above the remembered one needs the key moved again.

**A save made with the accounts view open asked Kylas for every company.**
`savedLanded()` re-read the list with `force`, which sends `?fresh=1`, which
sets `companies-want-fresh`, which makes the next minute's `maintain()` crawl
all ~17,925 companies — and while the Airtable copy is short (298, 2026-10-09)
the list is served from Kylas, so the crawl stays switched on all day. Eight
people saving meant a full crawl roughly every minute, sharing Kylas' rate
limit with their own saves and opens: Ayush's "rate limits are getting hit,
server crashes" (2026-10-10). Fixed in 1.57 at both ends: the console never
sends fresh from a save, and the server will not honour fresh more often than
`COMPANY_FRESH_FLOOR_MS` (10 min) — the floor is what protects against
consoles not yet updated. `test-worker` §15c fails without it (3 crawls).

**The same view had a loop with no save at all.** Every paint called
`ensureCompanies`, whose callback paints. With a stale list held and the
fetch failing (a 429), that was paint → fetch → fail → paint as fast as the
server could refuse. A failed fetch now waits 30s, doubling to 5 min.

**`redraw()` is async; focusing after it focused the old element.** The search
box's debounce did `redraw(); box.focus()`, and the rebuild happened after a
few awaits — so the caret left the search after every pause in typing, and the
next keys went to the console's shortcuts: Enter SAVED the hidden record, 1–4
set its stage, C dialled it. `keepPlace()` awaits the paint and restores focus,
caret and scroll; the shortcuts are ignored while a view is open; the full
daily contact crawl keeps to 20:00–08:00. `test-console-ux-live.mjs` drives
all of it in Chrome.

**A stale dev stack did not fail the tests, it BECAME their fixture.** The
mocks are spawned with `stdio:'ignore'`, so a mock that died on EADDRINUSE
said nothing — and every request then went to the mock already running on that
port, whatever it had been seeded with. On 2026-09-29 a dev stack holding 64
companies made `test-worker` §6b ("a base the sync has never filled") fail
three checks, **identically on code from before the change under test**, and
an hour went into reading the product for a fault that was a port.

Both mocks now exit 98 with the port number and how to find the process, and
`test-worker` refuses to start when anything is already answering on 9900 or
9901 — and watches for a spawned mock that exits during startup. Note `ss` is
not reliable in this container for sockets opened by backgrounded subshells;
the guard asks the port over HTTP instead, which is what actually matters.

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

It came back on 2026-10-09 with a bigger number. `sync-kylas.mjs` read Contacts
with `maxPages: 200`, which is 20,000 rows, and the live base held 37,249. A
contact past row 20,000 read as never seen, so its KPI Rank could be written
DOWN, and a stage moved in Kylas was not logged as a move. The console's new
contacts are appended at the end of the table, which is exactly the part that
was cut off. Fixed in Worker 1.56.1:

- the watermark is now one sorted row;
- the previous-stage read looks contacts up by id, or reads the whole table
  with `throwIfMore`.

`test-sync-scale.mjs` runs the real job over 25,001 rows. So a ceiling needs
`throwIfMore` as well as a `maxPages`: a prefix that does not throw is not a
read of the table.

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

**A MULTI-picklist is an array, and an array has no `.id`.** Kylas hands a
multi-select back as an array of values, and the carry-over read it with the
helper that reads `{ id, name }` — which returns `undefined` for an array.
`undefined` meant "no value", the field was left out, and **the payload
replaces the record**: a save on a contact whose Offsite Timeline had been set
silently cleared it. It also made the nightly push rewrite the same value
every night, because `undefined` never equals `[2880426]`. Found on 2026-09-29
by running the push against the mocks for the first time; `cfValue` in
kylas.mjs and `idOf` in push-kylas.mjs map arrays element by element, and
test-replace §9 pins both.

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

On the Worker it is `CRON_PUSH = "15 21 * * *"` — **02:45 IST**, 45 minutes
after the sync so it reads a base that was just refreshed and cannot race it.
On a laptop crontab it is 01:45 local. Both run the same `run()`.

A save writes the call-back and the offsite quarter from 1.29. This is the
other half: every contact saved *before* that, and every contact whose quarter
moved because somebody edited an event row rather than logging a call. Without
it the two fields are right on the contacts worked since the upgrade and blank
on the thousands worked before, which is worse than either — a filter in Kylas
would look like it works and quietly miss most of the pipeline.

**A contact Kylas no longer has is not a failure.** The KPI base keeps a row
for every contact ever saved; Kylas' copy can be deleted or merged away, and
then the id 404s for ever. Those are counted as *gone* and named, not as
failures — a nightly job that exits non-zero every night is one nobody reads.
A rising `gone` count is the real signal: the two stores are drifting apart.

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

## 3bb · "120 allotted" — a synced-but-short copy served as the whole account

**The worst bug of the session, and it reached Ayush.** The day the first real
sync ran, the console went from **17,925 allotted to 120**.

`/companies` decides between Kylas and the Airtable copy on one question: *has
the sync ever run?* That was written to stop a base nobody had synced — which
still holds a handful of rows, because the console writes a company on the
first save there — being served as the whole account. It does stop that. It
does not stop the case that actually happened: the sync ran, wrote what one
Worker invocation could of 17,925 companies, recorded the run, and from then on
the console served the fraction. The code even said so in the log — `mirror is
17,805 SHORT of Kylas' count` — and served it anyway.

The sync records what Kylas reported the account holds, so the comparison is
free. Since 2026-09-30 the copy is served only when it is **both** within
`MIRROR_ENOUGH` (0.9) of that total **and** short by no more than
`MIRROR_SHORT_BY` (25) rows. Both tests have to fail before the copy is
refused, because a fraction alone misjudges the small end: eight of nine is 89%
and plainly the same account a moment behind, while 120 of 17,925 is 0.7% and
plainly is not. Below the mark the list comes from Kylas exactly as it did
before the first sync, KPIs joined on as always.

**And the hourly contacts-only sync was erasing the number the check needs.**
`recordRun` wrote `kylas.reportedTotal: null` on every contacts-only run,
because that run does no company search — so the guard would have been
disabled within an hour of each nightly run. The company half of the record is
carried forward now.

`test-worker` §11 covers both directions. It must use cold-worker ids nothing
else in the file uses: `coldWorker` memoises per query string and
`createHandlers` memoises per module, so a reused number gets a module another
section has already warmed — including the five-minute sync-state cache, which
is the one thing the section is about.

## 3c · Why the dashboard was a day behind

The ladder reads Airtable (through the D1 copy), and work done **straight in
Kylas** only reaches Airtable when the sync runs. The chain, with its real
numbers:

| step | was | now |
|---|---|---|
| Kylas → Airtable (stage changes) | **once a day, 02:00 IST** | hourly at :40, contacts only |
| Airtable → D1 copy | delta every 10 min | unchanged |
| D1 → dashboard | memo, 60 s TTL, keyed on the copy's stamp | unchanged |
| a save made IN the console | **~3 s** — measured, test-worker §9a2 | and whichever view is open repaints itself |

So a stage changed in Kylas at 11:00 appeared on the ladder at 02:00 the next
morning — up to **fifteen hours**, and it read as "the dashboard is slow" when
nothing about the dashboard was slow.

**REPORT_TTL is NOT what gates a console save, and reading it as though it were
is how "about a minute" got said out loud.** `memo()` takes a `ttl` and a
`key`, and when a key is present — the mirror's stamp, which is what runs on
D1 — the TTL is never consulted: the held value is served while the stamp is
unchanged and rebuilt the moment it moves. A save's Airtable writes move the
stamp through `onWrite`, so the next read after the writes land is already the
new answer. The 60 s TTL only applies to a deployment with no D1 binding.

Measured rather than reasoned about, because that is how it was got wrong:
**save answered in 3126 ms, dashboard showed it 3129 ms after the save began.**
Three milliseconds between them. test-worker §9a2 keeps it honest.

**"Refresh" is the only button**, on the ladder and on Accounts both. There used
to be a second one, "Sync now", and the difference between them was that one
re-read what the proxy already held while the other went back to Kylas for more
— which is the architecture leaking into the toolbar. Nobody outside
`views.js` could pick between two buttons that both mean "make these numbers
current", so Refresh does both: it re-reads immediately, and asks for a Kylas
sync in the same click.

The sync is *asked for*, not waited on. It does NOT run the crawl inside the
request — that is the "Too many subrequests" failure this codebase has already
paid for. `POST /sync-now` sets a flag the every-minute maintenance job picks
up, so the wait is under a minute; asking twice while one is pending is a no-op
server-side, so leaning on the button costs nothing. The button says
"syncing Kylas…" while that is outstanding and repaints itself 75 s later,
through `repaintOpenView` — by then the associate may be looking at something
else, and that is the one function that knows what is open and when a repaint
would land under somebody's hands.

The ask is allowed to fail and the re-read still happens: a proxy too old to
know `/sync-now`, or one that cannot reach Kylas, must still refresh what it
has. The failure lands in the button's `title`, not in a dialog.

Beside it, the ladder still states how old the Kylas side is ("Kylas synced
12m ago"), amber past ninety minutes, because otherwise a small number cannot
be told apart from a sync that has not run. That is a **label now, not a
control**.

`CRON_SYNC_FAST` (`40 * * * *`) runs the same sync with `only: "contacts"`.
Contacts are incremental — `contactsChangedSince` — so a quiet hour is a
request or two. The company crawl has no since-filter (it reads Kylas' whole
company list and filters locally, ~100 requests) and stays on the nightly run:
a company that appeared today is rarely what moves today's ladder.

## 3d · One name per rung, and MQL is not printed

Two naming faults, both found by Ayush looking at the screen (2026-09-30).

**"Bucketing should not have two names of same state."** Four lists on the
dashboard described the same six rungs in their own words — the ladder said
*SQL meeting booked*, the stacked bar's legend said *SQL booked*, the metric
column said *SQL booked* and the conversion step said *Discovery → SQL
booked*, and `report.mjs`' email said *SQL meeting booked* again. Same for
*Companies reached* / *Reached only* / *Reached*, and *Right POC connected* /
*Right POC*. Nothing was wrong with any single label; the fault was that
there were five lists of them.

`views.js` `RUNG` is now the only place a rung is named, and `FUNNEL`,
`BUCKETS`, `STEPS` and `REPORT_METRICS` are all built from it. The names are
short, because they are column headers and legend keys read at a glance; the
sentence that defines each one lives in `sub`, which is what `sub` is for — a
name and its definition are not two names. `report.mjs` `METRICS` was brought
into line so the email and the screen agree.

The bucket that used to be called **"Reached only"** is now just "Reached".
The exclusivity — the segments are the *furthest* rung each company got to, so
they are disjoint and sum to the total — is a property of the chart, not of
the state, so it is said once in the legend's heading ("Stopped at") instead
of being smuggled into one state's name.

**MQL is no longer printed.** It is the *absence* of a signal, so on a roster
where nearly every contact is one, the badge put the same word on every row
and took the space beside the stage, which is the fact somebody is actually
scanning for. "Right POC" is the news; MQL is the background. Rule 6 says
MQL → Right POC is **derived, never typed** — not that it must always be on
screen. It is still computed, still saved, still what the funnel counts; only
the chrome went. The card's badge renders as an *empty* element rather than a
missing one, so `refreshQual` stays a text swap and never inserts a node while
somebody is typing beside it (`.qual:empty{display:none}`).

## 3e · Handing accounts over — what Kylas allows, and what it does not

Ayush, 2026-09-30: *"I can select multiple accounts, then reassign, and when I
reassign the associated contacts also get reassigned to that specific
individual."*

**The contacts move. The account's own owner does not, and cannot.**

### A company's owner is not settable through this API

Found the hard way, on a live account, which is the only reason it is known:

```
PUT /v1/companies/{id}   { ..., "ownerId": 74756 }   ->  200 OK
GET /v1/companies/{id}                               ->  ownerId: (none)
```

Kylas **accepts** the request and **silently drops** the field. Because the PUT
replaces the record, *ignored* means **erased** — lucidity (1777441) came out of
the first real write with no owner at all, and no API call could put one back.
It had to be fixed in Kylas' own UI.

Everything was tried before concluding this. Seven encodings: a bare number, a
string, `{id}`, `{id,name}`, under `owner`, and PATCH twice (415, then 400).
Nine endpoints: per-record and bulk `assign`, `/owner`, `bulk-update`,
merge-patch, json-patch — every one 404, 400, or **200 that changed nothing**.

Then Ayush supplied Kylas' own Postman collection, which settles it:

- **Update Company**'s documented body contains **no `ownerId` at all**.
- Ownership is a *separate endpoint* there — `PUT /v1/leads/{id}/owner` with
  `{"ownerId": N}`, documented as **"Reassign Lead"** — and the collection
  documents that flavour **only for leads**.

One loose end worth chasing: the blind hunt got `PUT /companies/{id}/owner` →
**200** while `POST` on the same path → **404**, and a path that does not exist
answers 404 to both. `probe-reassign.mjs --reassign-endpoint <userId>` tests
that shape on a **contact first** — where ownership is known to be settable —
so the method is validated before companies are judged by it. If the company
lands, the account cascade goes back in.

**A 200 from the company endpoint means the request was well formed. It never
means anything happened.** Read the record back.

### So the fence went back up

`test-replace` asserted that nothing in the tree called `updateCompany`, with
the note *"the day it stops being true is the day contacts start moving on
their own."* That fence came down for this feature and went back up the same
day — now covering `reassign.mjs` too, since that is the file that tried. The
note stands unamended. It cost one account its owner to prove.

### What the feature actually is

`scripts/reassign.mjs` moves the **contacts** on the selected accounts.
Contacts take `ownerId` as a plain number; the save path has always done it and
`test-replace` pins it. The console says so on the control itself and again in
the confirm dialog — a button that quietly does less than its label is how this
went wrong the first time.

Five rules, each paid for:

1. **The whole record, read immediately before the write.** The PUT replaces,
   and nothing Kylas computes for us is sent back. `metaData` — Kylas' internal
   id→name cache — was missing from `SERVER_KEYS` on the first live run and
   contributed to a 400 naming neither field nor rule.
2. **Nothing written until it is counted.** `POST /reassign` without `apply` is
   a dry run. Select-all on 17,925 must never be one keystroke from thousands
   of writes.
3. **`MAX_ACCOUNTS = 200`, refused not truncated.** "Moved 200 of 500" does not
   say which 200.
4. **One failure never aborts the rest**, and is reported per account and per
   contact.
5. **Admins only**, dry run included.

**The near miss, kept as a test.** The first body builder ran push-kylas' `idOf`
over every top-level field, and `idOf` collapses anything carrying a `.value` —
which a phone number does. `{type:"MOBILE", value:"9…", primary:true}` would
have gone back as `"9…"`, stripping the type and primary flag off every phone
and email it touched. Only an object whose keys are *just* `id` and `name` is a
lookup now.

**The mock was more permissive than Kylas, twice.** It merged whatever it was
handed — so a bare-number `ownerId` echoed back and every test passed. It also
swallowed `PUT /v1/companies/{id}` entirely, because the GET route matched
first and had no method check: 200 returned, nothing written. Both fixed. A
mock that reports success for a write it dropped is how a bulk operation ships
"verified".

`test-reassign.mjs` is 56; `test-worker` §12 covers the HTTP edge (the 403 case
needs a **cold worker** — `ADMINS` is read once when the module is built, so
passing `ADMIN_EMAILS` to a warm one passes for the wrong reason).

## 3f · The call-back that "got wiped" was never written to the screen

Ayush, 2026-10-04: *"next call date is getting wiped — if I set it, the next
time it does not pull up, rather asks me to assign it again."*

Nothing was wiped. The save wrote the call-back into Kylas on **every** save —
`cfNextCallDate`, resolved per account by label — and `toConsoleContact`, the
Kylas → console mapper, returned a **hardcoded** `nextCallDate: ""`. A contact
served from the Airtable copy carried its promise; the same contact served
from **Kylas** arrived blank, and the associate was asked for a date they had
already given. Write-only, for as long as the field has existed.

The fix is `nextCallFrom()` in `kylas-write-map.mjs` — `nextCallValue()` read
backwards, undoing the same timezone shift. 10:00 promised in Delhi is stored
`04:30Z`; reading the UTC clock straight off would show every call-back five
and a half hours early, and a date-only field must NOT be shifted at all or
midnight UTC lands on the previous day. Both directions are round-tripped in
`test-write-map` (44), including the midnight crossing.

The mapper needs the resolved write map passed in, because the field has no
fixed key — it is discovered per account by label. Both `/companies` and
`/contact` now pass it, and a failure to resolve it costs the call-back and
nothing else.

**Why every test passed while this was broken.** None read a contact back
through the Kylas path *with a call-back set* — there was no value to miss.
`test-worker` §13 does, and it needs three things to be honest, each learned
by getting it wrong: `READ_SOURCE=kylas` (the Airtable copy answers otherwise
and the mapper under test is never reached), a **cold** worker to carry that
env, and a **429 retry on the setup call** — the mock throttles the test's own
arrange step, and the first run blamed the mapper for a field that had never
been set. Verified by reverting the fix: `nextCallDate=""`, one failure.

**The same shape is still open.** `offsiteTimeline: ""` is hardcoded in the
same mapper (REQ-04). The company-level offsite read covers the console today,
so this is not the same live fault — but it is the same class, and it is the
next place to look if a quarter ever "disappears".

## 3g · REQ-04, the interim half: the offsite quarter reads back

The console SET the offsite quarter on Kylas from the first release that had
it, and never read it: `toConsoleContact` returned a hardcoded
`offsiteTimeline: ""`. The same one-way street the call-back was on (§3f).

**It cost far less, and that was worth establishing before fixing it.** The
quarter is DERIVED, not stored: `offsiteOf()` recomputes it from the timeline
text the associate typed — "Aug, week 2" → Jul–Sep — and that text round-trips
properly through Airtable's Event Rows. So nobody lost work, which is why this
sat open while the call-back did not. What had no way in was a quarter set in
**Kylas directly**, by somebody working there rather than in the console.

`offsiteFrom()` is `offsiteValue()` inverted. It matches through the option's
own LABEL rather than a remembered id, for the same reason `optionForQuarter`
does: the ids differ per account, and the spelling of "Jan - Mar" is nobody's
to standardise. Quarters come back in the console's order, never the order
Kylas happened to store them in, so two contacts holding the same pair read
identically.

**What is still open.** The card and the Airtable column hold ONE quarter, so
the mapper returns the first and keeps the rest on `offsiteTimelineAll`.
Showing and editing more than one — the multi-value UI — is the remainder of
REQ-04. The data now survives the trip either way, which is the half that
could not be added later without a migration.

`test-write-map` is 58: every quarter round-trips, two quarters come back as
both and in the console's order, a `{id}` wrapper is unwrapped, a
single-select account works, and five kinds of nothing read as no quarter
rather than throwing.

## 4 · Invariants that look arbitrary and are not

- **The account's stage label is the RUNG's name, not the contact's current
  one.** `KPI Rank` only rises, so it holds the furthest a contact ever got;
  `Current Stage` holds where it sits today. A POC who reached Discovery and
  was later re-dialled to a no-answer makes those disagree, and the account
  used to sort at rung 26 while reading "CNC (Could Not Connect)" — the order
  right, the words wrong, and the words are what gets read. `STAGE_AT_RUNG`
  (built from `STAGE_RUNG`, so the two cannot drift) names the rung instead.
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
