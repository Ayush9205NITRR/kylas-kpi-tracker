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
node scripts/test-report.mjs             # 131 · period maths, deltas, rollup merge
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
node scripts/test-sql-schema.mjs         # 104 · the generated SQL is the Airtable base, exactly
node scripts/test-sql-derived.mjs        # 98 · the views compute what Airtable's rollups did
node scripts/test-migration.mjs          # 22 · backfill and reconcile against a live-shaped base
node scripts/test-shadow.mjs             # 24 · the pull-based copy, on the existing cron
node scripts/test-shadow-read.mjs        # 52 · the two lanes answer the same thing
node scripts/test-owner-endpoint.mjs     # 27 · can an ACCOUNT's owner move? The live
                                         #      probe's verdict, in all four worlds its
                                         #      mock can be — including the 200 that
                                         #      changes nothing, which must never read
                                         #      as success
node scripts/test-dialler.mjs            # 30 · real talk time: the one read Kylas allows, the
                                         #      filter, the idempotent write, the gap it cannot
                                         #      close, and the report not double-counting dials
node scripts/test-worker.mjs             # the whole surface on workerd, with subrequest costs

xvfb-run -a node scripts/test-store-build.mjs # 12 · the PACKAGED build, in a real
                                              #      Chrome: what it strips, and that a
                                              #      cross-origin fetch still works with
                                              #      no host permission because the
                                              #      Worker answers CORS properly
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

**Two vocabularies on one screen.** The ladder and Progress call the first
rung **Worked** and count it per period off the report; the Step conversion
table below them called it **Reached**, meaning "at least one call logged",
all time, counted off the companies list. So 2026 showed Worked 539 directly
above Reached 517, and a "Reached -> Right POC" of 10.1% beside the ladder's
own Picked -> Right POC (Ayush, 2026-10-15: "Two different terminology shows
inconsistency"). The four all-time tiles were taken off this page for exactly
this reason; the table below the fold was missed. Step conversion is now built
from `currentByOwner` and `RATE_COLS` — the same rows, period and arithmetic
as the row above it — and `rate(p, c)` was lifted out of `reportSection` as
`stepRate` so there is one definition of a step rather than two. `reached`
survives only on the accounts view's KPI chips, where it means an account's
current furthest rung and the question really is a different one.

**A field nobody fills is not a field.** "Calls connected" was
`outcome && outcome !== "No answer"` over the Call Log's Outcome column — the
1-4 keypress on the call card. That column is BLANK on every row the team has
saved: 589 of 589 over 2026-10-12/13, read from the base. Blank is not "No
answer", so the test was false for all of them and the metric was zero for the
whole team, for ever — and nothing said so, because zero is a number.
Connected now comes from **Stage Set**, which every row does carry, through
`callConnected` in report.mjs: a call whose stage is not in NOT_CONNECTED is a
call somebody answered. That is the same list the Companies picked rung has
always used, so one rule now covers both units. The outcome is still honoured
where a row has no stage. Before trusting a metric built on a column, count
how many rows actually have one.

**`npx wrangler` is whatever was released last.** With no `package.json`, every
deploy fetched the newest wrangler, and on 2026-10-12 that was 4.149.0, which
died before uploading ("Received a malformed response from the API", reading
the deployment list). Wrangler is pinned in `package.json` now (3.114.17,
the version the dry-run builds were checked with): `npm install` once, then
`npm run deploy`. Move the pin deliberately, after `npm run deploy:check`.

**Two lists share one function, and a handler bound there reads the wrong
one.** `companies()` renders both the old Companies view and the Accounts
explorer, and its local `rows` is the Companies view's `all.filter(keep)`,
which the accounts search, operators and chips do not touch. The bulk
handlers (Select these N, Add to Focus, Move contacts) read that `rows`, so on
a searched list of 59, "Select these 59" ticked every account the person held
(Ayush, 2026-10-12: "18062 selected", and a refusal over 250). They now read
`EXPLORER_ROWS`, which `explorerHTML()` sets to exactly what it painted.
Each action takes only the ticked rows in that list, names any ticks left
outside it, and adds to Focus in batches of 250 instead of refusing.
`test-accounts-ux-live.mjs` §4. A handler in `companies()` that reads `rows`
for the explorer is this bug again.

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
| Contact, every save | `firstName` `lastName` `designation` `linkedin` `emails[]` `phoneNumbers[]` `company` `ownerId` `cfPipelineStageBd` `cfSourceOfData`, and **the console's block in the team's Remarks custom field (`cfRemarks`)**. The built-in `remarks` is still sent and is **stored nowhere** (see below). |
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

**THE BUILT-IN `remarks` IS A DEAD FIELD ON THIS ACCOUNT (found 2026-10-18).** The
block was written to the contact's `remarks` for a month, and the first live
`--apply` showed why nobody ever saw it: Kylas answered 200 and a read-back
returned null — the GET of a contact has no `remarks` key at all. The box people
see in the form is the custom field **Remarks (`cfRemarks`, PARAGRAPH_TEXT)**,
the same one "Said before" reads. The Push Log caught it as "Not pushed", which
is what the read-back exists for. The block now goes into that field, found by
label (`kylas-write-map.mjs` `remarks`); what people typed there is kept and, if
it holds rich text, so is their markup (`mergeNote`). A save that Kylas refuses
with the block in it is retried without it and says so (`noteLeftOff`).

**Since 2026-10-18 it also rewrites the contact's Remarks block** (Ayush: "I need
all the data to be pushed in remarks"). Before, a save wrote the block and the
nightly push never touched it, so contacts saved before the console had event
details showed only a stage. Now, for every contact the console holds something
on (event rows, vendor, mode, offering or a call-back), the push renders the
same block a save does — stage, owner, next call, every event row **past and
current with budget, timeline, pax and its note**, vendor, mode, offering — and
cuts it into the Kylas Remarks field (`cfRemarks`) between its two markers; what a
human typed outside the block is kept. A contact the console never touched gets no block.
Rows marked `Removed At` count for nothing, in the block and in the offsite
quarter. Read back like the other two (`Remarks` in the Push Log).

**The two caps are now two.** `PUSH_LIMIT` caps WRITES; `PUSH_READS` (600) caps
contacts LOOKED AT, in a window that moves a day at a time (no state kept). It
used to be one number counting reads, so once the first hundred contacts agreed
with Kylas every night re-read the same hundred and nothing past them was pushed
(seen live: `checked 100, changed 0` on the first night).

**BULK CATCH-UP** (the same `run()` the cron uses, from a terminal, supervised).
Only contacts the console holds something on are candidates, so it is thousands,
not 37,000; the run prints the count and how long reading and writing them takes.
Stages, each one a decision to go on:

```
node --env-file=.env.local scripts/push-kylas.mjs                    # dry run over everyone: counts, examples
node --env-file=.env.local scripts/push-kylas.mjs --apply --limit 20   # 20 writes, read back
node --env-file=.env.local scripts/push-kylas.mjs --apply --limit 300
node --env-file=.env.local scripts/push-kylas.mjs --apply              # the rest
```
It is safe to stop and run again: a contact that already agrees is skipped, and
Ctrl-C finishes the contact in hand and keeps what was pushed. The Push Log is
written every 250 contacts, not once at the end. **A circuit breaker** (nightly
too): once 20 contacts have been written, more than one in ten not fully pushed
stops the run and the run row says "Run stopped". `PUSH_LIMIT` (writes) and
`PUSH_READS` (contacts looked at) stay at 100 / 600 for the nightly cron until a
real night's Push Log has been read; then raise them.

**THE BULK RUN AS A SCHEDULED JOB.** `.github/workflows/push_to_kylas.yml` runs the
same script nightly at 03:17 IST on a GitHub runner (6-hour limit, not a Worker's
minutes), writing with no cap and the circuit breaker on; a red run is emailed by
GitHub. It needs three repository secrets — `KYLAS_KEY`, `AIRTABLE_PAT`,
`AIRTABLE_BASE` — and can be started by hand (Actions -> Push Airtable to Kylas ->
Run workflow) with `apply`, `limit`, `reads` and `contact`; `apply` defaults to a
dry run. The Worker's 02:45 push stays as the small incremental; the two cannot
hurt each other, since whoever runs second finds every contact already agreeing.
Scheduled workflows run from the default branch (it is this one) and GitHub turns
them off after 60 days without a push to the repo.

`node --env-file=.env.local scripts/push-kylas.mjs --contact <kylas id>` prints
what Airtable wants against what Kylas holds, field by field (call-back, offsite
quarter by name, the remarks block), and says SAME or DIFFERENT. Dry run unless
`--apply` is added.

It still writes **no other fields** as values. Not the stage, the name or the phone:
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

**Or a Gmail app password (2026-10-17, Ayush).** Set `MAIL_SMTP_USER` (the Gmail
address) and `MAIL_SMTP_PASS` (the 16-character app password, as a Worker secret)
and the mail goes over SMTP instead (`scripts/smtp.mjs`, `cloudflare:sockets`,
smtp.gmail.com:465, TLS from the first byte). `MAIL_FROM` defaults to the user;
`MAIL_TO` is still required. If both this and `MAIL_URL` are set, SMTP wins. The
conversation is tested against a mock SMTP server (`test-smtp.mjs`); the real
Gmail handshake has not been run from here — the first mail is the live test.
Gmail only lets the authenticated address (or an alias set up in Gmail) be the
sender, so `MAIL_FROM` must be that address.

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

### A company's owner IS settable — and the readback is what lied

**Resolved 2026-10-15, after three wrong answers in a row.** It is settable:

```
PUT /v1/companies/1779587/owner   {"ownerId": 74757}   ->  200 {"id":1779587}
  owner before  82867 Muskan Rajpoot      [read through the SEARCH]
  owner after   74757 Bhaumik Sachdeva    [read through the SEARCH]
```

**The body was right from the first attempt** — `ownerId`, exactly as Kylas'
leads flavour documents it. What was broken was the **readback**:
`GET /v1/companies/{id}` **does not return the owner on this account**, so
every check read "(none)" before and after and called a write that had LANDED
"accepted and ignored". `ownedBy`, the key the record itself carries, **500s**
on this endpoint — so the one shape that looked most promising from
`kylas-airtable-sync` is in fact the wrong one.

**How it went wrong three times, because the pattern matters more than the fact:**

1. The first live run read the owner through the single GET, saw "(none)"
   twice, and reported ACCEPTED AND IGNORED. The write had worked.
2. The next run, against the same account, found it **already on the target** —
   its own earlier work — skipped every shape, and the verdict chain checked
   the contact control *before* it checked for "skipped", so it printed
   "companies do not expose it" having tested the company **zero times**.
3. That verdict was written into `reassign.mjs`' header, STATE.md and the
   console's own message, where it sat for a fortnight telling people to change
   account ownership in Kylas' UI.

**Ayush pushed back three times and was right each time** — the last time by
pointing at `kylas-airtable-sync`, which has carried
`update_company_owner()` → `PUT companies/{id}/owner {"ownerId"}` all along.
A verdict drawn from a read that cannot see the field is worth *less* than no
verdict, because it stops the search.

**What is live now.** `kylas.mjs` has `setCompanyOwner(id, ownerId)` — a
separate method on a separate endpoint — and `reassign.mjs` writes the account
owner after its contacts, reporting `accountOwners` and `accountOwnersFailed`
so a partial result is legible. A refused owner field does not fail the
account: the contacts have already moved and that is the half that decides
whose queue it is in.

**The fence on `updateCompany` stays up.** That is the *replacing* PUT — it
erased lucidity's owner on 2026-09-30, and three such runs in
`kylas-airtable-sync` on 2026-07-01 reassigned companies across a whole account
to the API user (hence its `restore_company_owners.py`). `test-replace` still
asserts nothing calls it, and `test-reassign` asserts the header keeps both
halves straight so the next person neither retries the dangerous endpoint nor
re-abandons the safe one.

Everything below is the history, kept because it is how the API behaves and
because the *replacing* PUT's half of it is still true.

### The replacing PUT: a company's owner is not settable THAT way

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

**How to run it, and what it now prints** (rewritten 2026-10-15, after the
question came back as "Why are the owner not changing"):

```sh
node --env-file=.env.local scripts/probe-reassign.mjs --users     # whose ids these are
node --env-file=.env.local scripts/probe-reassign.mjs --list      # accounts WITH contacts
node --env-file=.env.local scripts/probe-reassign.mjs \
     --company <id from --list> --reassign-endpoint <id from --users>
```

`--users` exists because every flag here takes a Kylas user id and there was no
way to find one from the tool: the id came from memory or a URL, and a typo'd
id is indistinguishable from a broken endpoint — "owner reads 74756" says
nothing about whether 74756 is a person. It is refused up front now, before any
PUT goes out.

The run narrates every attempt — the request line, the body, the HTTP status
**and response body**, the owner before and after **with names**, and a verdict
per attempt. It tries **six** bodies on the company, not one, because "the
endpoint exists" and "this exact body is what it wants" are two claims. The
control write on the contact is **put back** afterwards; the old version moved
somebody's live contact and walked away.

Four verdicts, and only the last exits zero:

| What happened | Verdict |
|---|---|
| nothing moved | `/owner` is a leads endpoint, as documented |
| 200, owner unchanged | **ACCEPTED AND IGNORED** — never read as success |
| contact moved, company did not | the method is right, companies do not expose it |
| both moved | **the company owner IS settable** — the cascade goes back in |

A fifth guard: an account whose contacts are **already** on the target is
declared `INCONCLUSIVE`, not a pass. The first live run reported LANDED on
exactly that, because the readback matched without anything having happened.

`test-owner-endpoint` (27) runs the probe against a mock that can *be* each of
those worlds — `MOCK_OWNER_ENDPOINT=404|ignore|lead|works` — and asserts the
conclusion it draws, because the verdict is the only part of it anybody acts
on. A probe that gets this wrong either builds an account cascade over an
endpoint that silently does nothing, which is how lucidity lost its owner, or
writes off an endpoint that works.

### The live run, 2026-10-15 — and the two faults it exposed in the probe

`--company 1780629 (aristocrat) --reassign-endpoint 82978 (Gurnoor Kaur)`:

```
contact 5358966  PUT /v1/contacts/5358966/owner  {"ownerId":82978}
  -> 200 {"entityId":5358966,"newOwnerId":82978,"oldOwnerId":76689}   LANDED

company 1780629  PUT /v1/companies/1780629/owner {"ownerId":82978}
  -> 200 {"id":1780629}                                              owner unchanged
                 ...as a string                 -> 200, unchanged
                 ...{"ownerId":{"id":N}}        -> 400 generic.error (02803002)
                 ...{"owner":{"id":N}}          -> 500 Generic error
                 ...bare id                     -> 400 generic.error
                 PUT /companies/{id}/owners     -> 404 NOT_FOUND
```

**The contact endpoint is real and clean** — it answers with the old and new
owner, which is a reassignment endpoint behaving properly. The company path
takes the request and does nothing with it. That is the answer, and it matches
Kylas' own collection.

But the run exposed two faults in the probe itself, both now fixed and tested:

**1 · The company readback was blind.** It read `GET /v1/companies/{id}`, which
**does not carry `ownerId` on this account** — the same fact recorded above for
the October batch. So "owner before (none), owner after (none)" said nothing
about the write; `--list` showed aristocrat's owner as 82867 through the SEARCH
in the same session. A verdict drawn from a read that cannot see the field is
not a verdict, which is the exact error the probe exists to avoid. `companyOwner()`
now reads the search first, prints `[via search]`, and when neither read
returns an owner it says **CANNOT TELL** rather than concluding.

**2 · It stranded a live contact.** The control moved Vaibhav Bhandari (5358966)
off **Charu Rathi (76689), a DEACTIVATED user**, and the restore came back 400:
Kylas will not hand a record to an inactive user. The contact was left on the
wrong person. Now the probe checks that the current owner is active *before*
writing — an inactive owner makes the control a one-way trip and that contact
is skipped with the reason named — falls back to `PUT /v1/contacts/{id}` if
`/owner` refuses the way home, and if it still cannot restore, prints the exact
repair command instead of a quiet "NO".

`--set-contact-owner <contactId> --to <userId>` is that repair: both paths,
read back, and it says plainly when the target being deactivated is the reason.
Charu being inactive meant even that could not land, and Ayush set contact
5358966 back by hand in Kylas on 2026-10-15. **The question is closed: an
account's owner is not settable through this API, and the console is right to
refuse.**

### The thing this turned up: records owned by DEACTIVATED users

`--users` on 2026-10-15 listed **46 users, 13 of them inactive** — Nitika Mann,
Prabhjot Juneja, Reema Agarwal, Rohit Roy, Saahil Bhardwaj, Ajay Priyadarshi,
Rashid Imam, Charu Rathi, Tanay Kumar, Ifee Malpani, Devansh Shukla, Gaurav
Kumar, Shreya Bodwal — and contacts are still sitting on them. Vaibhav
Bhandari (5358966) was owned by Charu Rathi, who had been deactivated.

Three consequences, none of them cosmetic:

- **Kylas will not assign a record TO an inactive user** (400, errorCode
  02803002). So any move away from one is one-way: there is no putting it back
  through the API, as the control write found out.
- **Those accounts are in nobody's queue.** A deactivated person does not open
  the console, so whatever they own is not being called by anyone.
- **They still reach the funnel.** `counter()` counts a name the roster has
  never heard of, and Charu Rathi and Gaurav Kumar both showed real numbers in
  the per-associate table while being inactive in Kylas and absent from Team.

**Counted in the KPI copy, 2026-10-15: 24 contacts across 10 companies**, and
only five of the thirteen own anything at all — Shreya Bodwal 9 contacts,
Charu Rathi 5, Tanay Kumar 5, Gaurav Kumar 3, Devansh Shukla 2. Nitika Mann,
Prabhjot Juneja, Reema Agarwal, Rohit Roy, Saahil Bhardwaj, Ajay Priyadarshi,
Rashid Imam and Ifee Malpani hold nothing.

That is the copy, not the account: Companies and Contacts here hold what the
console has saved or synced, and Kylas has ~17,000 companies. The real figure
needs a Kylas read, and the copy's 24 is a floor.

The fix is ordinary work, not new code: move those contacts to live owners with
the console's bulk Re-assign, which is exactly the path that does work. Two
dozen is one sitting. Worth doing before reading another funnel, because until
then some share of the pipeline belongs to people who left — and note that
Charu Rathi and Gaurav Kumar are also absent from the Team table, so their
numbers are counted in the team total under `counter()`'s unknown-name rule
while they have no column.

**A 200 from the company endpoint means the request was well formed. It never
means anything happened.** Read the record back.

### It goes 50 at a time, with the progress on screen

Ayush, 2026-10-15: *"bulk re-assignment abhi ho nahi rahe hai"* — and it was
not, for two reasons at once, on a selection of 276:

| | what happened |
|---|---|
| the count | `plan()` reads the company **and** its contacts per account, so 276 was ~550 Kylas requests at five a second — past the 120s the console waits. "The server took too long to answer." |
| the write | `apply()` REFUSES a batch over `MAX_ACCOUNTS` (200) rather than truncating it, so even a count that landed could not be acted on |
| and | any redraw re-rendered the owner `<select>` empty, which disabled **Move contacts** again mid-flow. `ACC.moveTo` holds the choice now. |

So the console sends **50 accounts a request**, for both halves:

- **Count** — one `reassignPlan` per batch, totals accumulated, `Counting 2/6`
  on a progress bar. Nothing is written.
- **Agree once**, to the whole run, with the batch count stated.
- **Write** — one `reassign` per batch, `Moving 3/6` with contacts moved so far.
  Each batch is **final as it lands** and its accounts are unticked there and
  then, so a failure mid-run keeps everything already moved, leaves the rest
  ticked, and says which batch stopped it: pressing Move again carries on
  rather than starting over.

`MAX_ACCOUNTS` stays at 200 as the server's own fence — 50 is well inside it,
and the cap is what stops a caller that ignores the batching.

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

## 3h · Talk time comes from the Kylas DIALLER APP, not the console's stopwatch

Ayush, 2026-10-15: *"Talk time kahan se utha rahe hoo, galat dikha rahe hai"*,
then decisively: *"Talk time needs to be added -->> through kylas dialer app se
joh talk time aa rahe hai usko list karo."*

The dashboard was summing the console's own stopwatch, which only runs when a
call is dialled from the console's dial button. **7 of 1,379 rows had one**, so
a month of calling read as about three minutes. Nothing was miscalculated; the
number was honest about almost no calls. The first fix was to say so — the
`timed/calls` coverage line under Talk time — and that is still there, because
a coverage of 7/1379 is the thing you want to see.

The real source is the dialler app, and the live account proves the two kinds
of log apart (2026-10-15):

```
#45926805  10:52:09  1m11s  dialler app  · deviceId set · owner Muskan Rajpoot
#45926838  10:53:43     0s  this console · isManual     · owner Enout Super Admin
```

Read the owner column as carefully as the duration. **The dialler's logs carry
the associate who dialled; every log this console writes carries the API key's
user**, which is the whole of the "everything says Enout Super Admin"
complaint: the account has one API key, Kylas attributes a write to the key's
user, and so every console save is logged as that user no matter who saved it.
So this import fixes talk time and gives per-person attribution for it in the
same stroke — without per-associate API keys, which is still the open question
for the *console's* writes.

### The one read Kylas allows, and the gap it can open

`GET /v1/call-logs?size=N` is the **only** shape that returns more than the
account's latest ten. Seventeen were tried (`probe-call-durations.mjs`): `page`
→ 404; `sort`, `startTime`, `relatedToId` are accepted and silently ignored;
`/v1/search/call-log|calllog|call|calls` → 400 "entity type is invalid";
`/v1/search/call_log`, `/v1/search/activity` → 400 "Entity Definition does not
exist"; `/v1/call-logs/search` → 422; `/v1/call-logs/filter`, `/v1/activities`,
`/v1/activity-logs`, `/v1/contacts/{id}/call-logs|activities|timeline` → 404.
`?size=100` returned 100 of 8,655, so the parameter works and nothing else does.

That has one hard consequence, and it is not a style note:

> **If more than N logs arrive between two runs, the ones in the middle are
> lost for ever.** There is no paging and no date filter, so there is no way to
> go back for them.

Three things hold it shut. The import is **idempotent** on the Kylas log id, so
overlapping windows cost nothing. It **checks for the gap** every run — if the
oldest log it just read is newer than the newest it already holds, calls were
placed in between that it will never see, and it says `! GAP` with what to do.
And the cron is **hourly** (`CRON_DIALLER = "10 * * * *"`, offset from the
contacts sync at :40) against `size=1000`, at 300–600 calls a day: the window
overlaps many times over. Do not move that to daily to save requests — daily at
size=1000 is fine right up until a busy day, and the day it is not, the missing
hours cannot be recovered.

### Where it lands

A new Airtable table, **`Dialler Calls`** (`Key` = the Kylas log id, `Called
At`, `Owner`, `Duration` in seconds, `Contact Kylas ID`, `Call Type`, `Device`,
`Recording`, `Imported At`), mirrored into D1 like the rest. `report.mjs` takes
a `dialler` input that bumps **only** `talkSeconds` and `timedCalls` — never
`calls` or `connects`. That separation is the point: *Calls dialled* stays one
per console save and *Connected* stays a function of the stage, so importing
the dialler's logs cannot inflate either. `test-dialler` §4 pins it with two
saves and two dialler calls for the same work: `calls 2, connects 1,
talkSeconds 118`.

A duration is the filter, and it is the right one. The console's writes are 0s
by construction, and a dialler call of zero length is a call that never
connected — not talk time either way.

**Before the first run the table has to exist**: `node scripts/schema.mjs`
against the live base, then
`node --env-file=.env.local scripts/import-dialler-calls.mjs` (dry, reports
what it would write), then `--apply`. After that the cron keeps it current.
Nothing in the console changes; Talk time on the dashboard just starts being
true.

### Two sources were summed, so talk time moved with how many consoles were open

Ayush, 2026-10-15: *"talk time, jitne dher console open hai uske according track
ho rahe hai."* Right, and `report()` was why. **1.64 added the dialler as a
source of talk time and did not remove the old one**, so for two releases both
were summed:

```
for (const d of dialler) bump(..., "talkSeconds", d.secs);   // the dialler app
for (const c of calls)   bump(..., "talkSeconds", c.secs);   // the CONSOLE's stopwatch
```

`c.secs` is the Call Log's `Duration` — the console's own stopwatch, which runs
only on a call dialled from the console's button, in a console somebody had
open. So what it contributed measured *how the team was using the tool*, not how
long anybody talked, and it moved as consoles came and went. Worse, one
conversation seen by both was **counted twice** — the console saying 45s and the
dialler 71s gives 116s for one call — and `timedCalls` was bumped from both, so
the `n/m timed` coverage could exceed the call count it is measured against.

One source now, and it is the one that measures every call it places. The
console still WRITES `Duration` and `Duration Source` to the Call Log and the
Contacts/Companies rollups in Airtable still read them; what stopped is that
number reaching the dashboard. `test-report` is 131 and every `secs` on a call
row in its talk-time fixtures is deliberate bait that must not show up in the
total — plus the one-call-two-sources case, and the no-dialler-rows case that
must read 0 rather than the stopwatch's three minutes.

### "Talk time is not getting mapped" — the screen blamed the wrong thing

Ayush, 2026-10-15, on a dashboard running 1.65: Talk time read **`not timed`**
against all ten associates, with the note *"timed only when dialled from the
console"*.

Both were wrong in the same way. The note described the stopwatch this release
replaced, and `not timed` is a statement about *these calls* — but it was also
what appeared on a base where the `Dialler Calls` table **does not exist**, so
nothing has ever been imported. Those are not the same fact, and the difference
is the difference between "nobody dialled" and "the setup is not finished": the
first sends you to look at the team, the second at `repair-base.mjs`. A wrong
reason is worse than no reason.

`reportData` used to `.catch(() => [])` the Dialler Calls read, which flattened
"absent table" and "empty table" into one empty array. The failure now travels
with the rows, and `/report` carries `dialler: { state, rows, why }` with three
states, each with its own sentence and tooltip on screen:

| state | cell | means |
|---|---|---|
| `missing` | **not set up** | no table — run `repair-base.mjs` |
| `empty` | **not imported** | table exists, cron has not filled it yet |
| `ok` | **not timed** / `n/m timed` | real coverage for these calls |

An older server sends no `dialler` block; that reads as `""` and the cell falls
back to the plain `not timed` it always said, so a console ahead of its server
degrades quietly.

`test-dialler` is 30 and covers the read, the filter, the per-associate credit,
the write, the idempotent re-run, the gap warning, the report not
double-counting, and the whole path end to end through the proxy — where the
20 generated calls arrive as 1,720 seconds split across the three associates
who placed them. Note the `owner=all` in §5: `/report` with no `owner` scopes
to the signed-in person, and these calls belong to the associates, not to the
key's user. That read as "talkSeconds 0, still broken" for a while. It is not.

## 3i · One word for "worked", and the screen that was simply out of date

Ayush, 2026-10-15, over two screenshots: *"We cannot have two different
definitions of how companies are being worked"*, *"agar Anjali ka data mere
console mein nahi dikhta hai kai baar"*, *"New contact kyon aate hai jab mein
new contact add nahi kar sakte"*.

**Read the screenshots before the code.** The console's own link badge in the
second one says **"reload me"** — `API.oldConsole`, which fires only when the
loaded extension is behind the deployed server. Two more tells agree: Talk time
reads `—` where 1.61 renders `not timed`, and Step conversion still heads its
first column **Reached**, which 1.62 replaced. The screen he was objecting to
was three releases old, and the two-vocabulary table on it had already been
fixed. That is worth stating plainly rather than re-fixing: **the badge is the
first thing to read when a complaint is about something that looks already
done.**

**But one genuine second word was left, and it was the one he could still
see.** The Accounts list's KPI column said **Reached** for the identical test
the dashboard calls **Worked** — `co.reached = worked.length > 0`, the local
variable named for what it is, and `handlers.mjs` says the same beside its own
list ("worked" is the reference's "Companies reached"). The two differ only in
WINDOW: this period, or ever. So both now read **Worked**, and the window lives
in `sub` ("some activity this period" / "at least one call logged, ever").

The two keys stay — the two windows are genuinely two numbers — and
`test-kpi-spec` §7, which asserts no rung is named two things, now asserts the
mirror image for this one pair: that they DO share a name, because they are one
definition. The accounts chips come off `RUNG` too (`KPI_LABELS` was a
hand-written seventh copy of the rung names). The Airtable column is still
called `Reached`; renaming it is a base migration for no gain, since nobody
reads the column name.

### An unresolved owner was a confident report of zeros

`/report` filters on a NAME. The id→name step, `ownerName()`, caches
`owners.set(k, k)` — **the id itself as the name** — when Kylas refuses the
lookup, deliberately, so one bad lookup cannot fail a whole fetch. Harmless
where a name is only displayed. As a filter it is not: `owner` becomes
`"1234567"`, no row in the base carries that, every list filters to nothing,
and the dashboard renders a complete report of zeros for somebody who made
ninety calls. **Nothing on screen separated that from a day off** — which is
exactly what "uske data mujhe dikhte nahi hai" looks like.

An id that resolves only to itself is now treated as unresolved and said, not
served. `test-worker` pins both halves: the ghost owner is reported, and the
two legitimate shapes — the team, and asking for nothing, which means you — are
untouched.

Alongside it, the roster join is no longer case-sensitive. `Team.Name` has to
be spelled exactly as the Owner column spells it, and nothing keeps the two in
step: this base holds **"Aditi saini"** and whether Kylas writes "Aditi Saini"
is not ours to decide. One capital letter detached somebody from their roster
row; they stayed counted (an unknown name counts), so the only symptom was a
Team tick that did nothing. `nameKey()` in `airtable.mjs` is now the one
spelling-insensitive comparison, used by `counter()` and by the report's owner
filter.

### "+ New contact" led to a dead end it could have named

A new contact must carry an owner — `missing()` requires it — and the owner
list comes from Kylas through the server. Until it arrives `OWNERS` is `[""]`,
so the dropdown holds nothing but the blank, and `ME` is only set once the
console has learned who is using it. With neither, the button opened a card,
let a whole POC be typed into it, and then refused the save with "Still needed:
Owner" pointing at a box with no options.

The button stays enabled — the list usually lands a moment later, and disabling
it would read as "this console cannot add contacts". What changed is that the
reason is given before the typing instead of after.

## 3j · The base was AHEAD of the schema, and --update-formulas would have undone it

`repair-base.mjs` on 2026-10-15 created `Dialler Calls` and then reported **7
formulas differing from the schema**, offering `--update-formulas` to "fix"
them. Running it would have been a data regression. Every one of the seven was
the LIVE BASE being right and `scripts/schema.mjs` being out of date:

| field | the base | this file |
|---|---|---|
| `Event Rows.Has Any Signal` | excludes a row with `Removed At` | counted removed rows |
| `Event Rows.Is Complete` | same guard | same gap |
| `Contacts.Is Right POC` | `OR(Has Signal, Ever Right POC)` | `Has Signal` alone |
| `Contacts.Right POC Name` | same | same |
| `Contacts.Is Discovery` | `OR(Has Complete Row, Ever Discovery)` | `Has Complete Row` alone |
| `Contacts.Discovery Name` | same | same |
| `Companies.Reached` | `OR(Last Call At, KPI Stage At)` | `Last Call At` alone |

Each difference is load-bearing. Without the `Removed At` guard a row the
console deleted goes on making its contact a Right POC for ever. Without the
`Ever` checkboxes the data rungs are not floors — `Has Signal` rolls up the
LIVE rows, so clearing the budget field takes the rung away again. Without
`KPI Stage At`, every account worked before this console existed reads as never
reached, because it has no Call Log row.

**So the schema was brought up to the base, not the other way round** — and
that exposed the reason the drift had survived: `Event Rows.Removed At`,
`Contacts.Ever Right POC` and `Contacts.Ever Discovery` **were not in
`schema.mjs` at all**. They were in Ayush's base, read by `handlers.mjs` and
`mirror.mjs`, and a fresh `create-base.mjs` would have produced a base without
them. `validate-schema.mjs` caught it the moment the formulas referenced them
("refers to {Removed At}, which does not exist on Event Rows yet"), which is
what that check is for. `Companies.Reached` also had to move after
`Companies.KPI Stage At`, since field order in that file is creation order.

**Two planted faults in `test-validator.mjs` were anchored on the old formula
text**, so they stopped applying and the suite reported 10/10 while silently
running 8. It prints "fault did not apply, test is stale" for exactly this, and
that line is the only reason it was noticed. Re-anchored; 10/10 again, honestly.

**The rule this leaves:** `--update-formulas` writes the schema over the base,
so it is only safe once the schema is known to be the newer of the two. Read
the before/after that `--dry-run` prints and decide per formula. It is never a
default.

## 3k · "Due to the Host Permission… in-depth review", and what actually counts

Ayush, 2026-10-16, from the Chrome Web Store listing form:

> *"Due to the Host Permission, your extension may require an in-depth review
> which will delay publishing."*

**The fact that caught this out: `content_scripts.matches` IS a host
permission.** Chrome counts a content-script match pattern exactly as it counts
a `host_permissions` entry — same install-time warning, same review trigger.
This was found by a test that passed for the wrong reason: the first version of
`test-store-build` put its stub host into `content_scripts.matches` so the
content script had somewhere to run, and then every assertion passed with **no
Origin header and no preflight**, with even the no-CORS control succeeding.
The extension had been granted that host after all. The stub is now reached
only from the console page, so the host appears nowhere in the manifest, which
is the only way to ask the question honestly.

**So emptying `host_permissions` does NOT silence the warning**, because
`https://app.kylas.io/*` in `content_scripts.matches` is still there — and that
one cannot go without removing the thing the product is (the launcher appearing
on Kylas). The only way to zero it is `activeTab` + `scripting` with injection
on click, which trades the auto-appearing launcher for a click. That is a
product decision, not a packaging one, and is **open**.

**REVERSED THE SAME DAY — read this before the table below.** `dist/` holds
every package since 1.17.1, and comparing their manifests settles it: **1.17.1
to 1.67.0, over fifty updates, shipped an IDENTICAL permission set** — same
three permissions, same four host permissions, same content script — and every
one cleared review quickly. **1.68.0 was the first package in that whole
history whose manifest differed**, because this script had started stripping
hosts, and it is the one that sat in "Pending review". Its only other change
was 25 lines of `views.js`. A changed permission set is re-reviewed as a
permission change, even when it is smaller.

So the default is back to **shipping exactly what `extension/manifest.json`
declares** — the shape the store has approved fifty times — and the stripping
below happens only with `--strip-hosts`, as a deliberate one-off when a slower
review is an acceptable price. Never again as a side effect of a routine
release. The lesson generalises: when a process has a long clean record, the
first thing to suspect when it stalls is whatever you changed, including
changes made to "reduce risk".

What `--strip-hosts` does, for when that move is chosen on purpose:

| entry | in the package | why |
|---|---|---|
| `http://127.0.0.1:*/*` | **dropped** | local proxy + Load unpacked; a published build never does this |
| `http://localhost:*/*` | **dropped** | same |
| `https://app.kylas.io/*` | **dropped** | redundant — `content_scripts.matches` already grants it, and nothing fetches it |
| `https://bd.enout.website/*` | **kept** | see below |

**Why `bd.enout.website` stays, although it is provably not needed.**
`test-store-build` starts a real Chrome with a build carrying **no host
permission at all** and shows a cross-origin fetch succeeding — preflight,
`Authorization` header, the server seeing `chrome-extension://<id>` as the
origin — with a negative control proving it is CORS doing the work. A host
permission does not GRANT the fetch; it BYPASSES CORS. The Worker already
answers correctly, so the entry is not what makes the console work:
`ALLOWED_ORIGIN` is.

It stays as the belt to that braces. **If the published extension's id is ever
missing from `ALLOWED_ORIGIN`, the host permission is the only thing standing
between that and every associate opening a dead panel.** Dropping it would make
a wrangler.toml typo fatal in a way it currently is not. Check that the
published id is one of the two in `ALLOWED_ORIGIN` before ever reconsidering.

## 3l · What was pushed to Kylas, what was not, and the field map

Ayush, 2026-10-17: *"have existing data points, let us start tracking everything
… data push hone ke baad: successfully pushed / yeh data push nahi hua"*, and
*"Field mapper — which Airtable field is mapped to which Kylas field, and the
data type constant — end state to be checked."*

**Before this, the nightly push kept nothing.** It wrote to the live CRM, counted
its writes in one number, and the number scrolled away in `wrangler tail`. A
`200` from the contact endpoint was treated as "done", which this repo has been
bitten by before (§3e, `probe-write.mjs` DROPPED).

**The Push Log** (`scripts/push-log.mjs`, table `Push Log`). After every real
run, one row per contact the push touched, plus a `(run)` row. Each says one of:

| Status | means |
|---|---|
| **Pushed** | every value was sent, Kylas accepted it, and a **read-back** of the record shows it there. `Verified` is ticked. |
| **Partly pushed** | some landed, some did not; `Pushed` and `Not Pushed` name both, `Reason` says why. |
| **Not pushed** | nothing landed — Kylas refused the contact, or the value was held back for its type. |

The read-back is one extra `GET /v1/contacts/{id}` per contact written, so at
`PUSH_LIMIT = 100` it is at most 100 more requests a night. Per-field outcome
(`pushed` / `dropped` / `mismatch` / `type` / `refused` / `unread`) is in `Detail`
as JSON. One row per contact per run, **not** per field: the table grows by at
most `PUSH_LIMIT` a day. Old rows can be deleted freely.

**The Field Map** (`scripts/field-map.mjs`, table `Field Map`). One list, as data,
of every datum that leaves for Kylas: the Airtable table and field, its type, the
Kylas field it goes into, and the **kind** of value the code sends. The Kylas
field's type is read into the same vocabulary, and the map holds when they are
equal. Resolved against the live account:

| Status | means |
|---|---|
| `mapped` | the Kylas field exists and is the kind we send |
| `unmapped` | **no such field on this account.** The write leaves the value off and the save still succeeds — the failure that used to be invisible |
| `type` | the field exists but takes a different kind (a name sent to an id-picklist, a day to a date-time…) |
| `unknown` | a Kylas type this file does not read — reported, never guessed |
| `assumed` | a core field the list does not describe; its type is fixed by the API |

Two guards keep the registry honest, both in `test-field-map.mjs`: every Airtable
field it names must exist in `schema.mjs` with that type, and **every field
`toKylasContact` / `toKylasCallLog` actually writes must be on the map.** A field
added to a save and not to the map fails the test.

**Before a send, the type is checked.** `checkValue` holds a value back, and
names it, if it is not the kind its Kylas field takes — so one bad value no longer
costs the contact its write. A *name* sent where a picklist takes an *id* is
reported but not held (`soft`): that is what `cfSourceOfData` has always been sent
as, and changing a live save path is not part of tracking it. **Open question
this surfaces:** `Source of Data` is sent as the console holds it, not as an
option id. If Kylas stores it, nothing is wrong; if it does not, the next
`probe-write.mjs` run says DROPPED. The Field Map row for `source` carries the
note.

**Saves are tracked more lightly, on purpose.** No read-back per save (that is
200 more Kylas requests a day against a tight rate limit). A save whose card holds
a call-back or an offsite quarter that this account has no field for records
`result.unmapped` on its job row, and the digest counts it.

**The morning mail** (`digest.mjs`) now has an "Airtable → Kylas push" section:
pushed / partly / NOT pushed with each contact named, the field-map problems, and
the count of saves that left a value off. The subject gets `⚠` and a count when
anything needs attention. If the `Push Log` table does not exist it says *"Not
tracked yet — run repair-base.mjs"*, never a zero. The window is the **last 24
hours**, not yesterday: the push runs at 02:45 IST, which is *after* the day the
digest reports.

**`GET /field-map`** (admin only) returns the resolved map, the problems, and the
last three days of pushes. `node --env-file=.env.local scripts/field-map.mjs` prints
the same table in a terminal; `--store` also writes the Field Map table.

**To switch it on (Ayush):**
1. `node scripts/repair-base.mjs --dry-run`, then without `--dry-run` — creates
   `Push Log` and `Field Map`. Needs the schema-scoped token (§3j). Until then a
   push still runs and says so in its log; it records nothing.
2. `node --env-file=.env.local scripts/field-map.mjs --store` — fills the Field
   Map now, so the first thing you see is which data points have no Kylas field.
3. `npm run deploy`, so the Worker's nightly push and digest are the new ones.
4. The mail needs `MAIL_URL` `MAIL_KEY` `MAIL_FROM` `MAIL_TO` as Worker secrets
   (`npx wrangler secret list`). Without them the digest is logged, not sent.

**Not built, said plainly:** a per-save read-back; tracking the **call log** writes
(the Kylas call-log entity is not in the contact field list, so its fields are
`assumed`); a console view of the Field Map (the Airtable table and `/field-map`
are the views for now); alerting between digests (the mail is daily).

**The bug that was made here (2026-10-17): a CLI that imports its own importer.**
`field-map.mjs --store` printed only `Warning: Detected unsettled top-level await`
and exited 13. The CLI block did `await import("./push-kylas.mjs")` for
`findOptions`, and `push-kylas.mjs` imports `field-map.mjs`: run as the entry
point, the cycle waits on itself for ever. Every test imported the module, so none
saw it. `findOptions` now lives in `kylas-options.mjs` (push-kylas re-exports it),
and `test-push-track.mjs` §8 runs the CLI as a child process. A script that is both
a module and a CLI may not reach back into a module that imports it.

---

## 3l2 · Month tags on Source of Data (Oct/Nov/Dec offsite & reach-out), 2026-10-21

Two steps, two tools. **1 · Airtable**: `scripts/offsite-month-source.py` reads
Ayush's Oct–Dec sheet and writes the months into Company List's `Source (MQL-SQL)`
(Company Database base), an input of the `Source - Concatenate` formula. Rule:
what is there stays; `lifetime-MQL-SQL` present → months after it; absent →
`lifetime-MQL-SQL <months>`. Never `Source of Data`, which is the sync's COPY of
Kylas. 535 rows written and read back, 2026-10-21. **2 · Kylas**:
`bulk-tag-companies.mjs --view "Oct/Nov/Dec"`, run by the workflow
`tag_company_source.yml` (dry-run → first-one → all), puts the same months on
each company's `cfSourceOfData`, keeping what Kylas holds.

**STRICT: THE OWNER MUST NOT CHANGE (Ayush).** Not through kylas-airtable-sync's
"Assign Companies from Airtable → Kylas" — its company PUT resets the owner and
re-assigns it from Airtable's stale copy. Here the owner is read from Kylas, the
write keeps it (canary first, every run), it is read back, and the first company
that differs stops the run. Company only; contacts untouched.

**THE WRITE IS A ONE-FIELD JSON PATCH, NOT A PUT (found 2026-10-21).** The first
first-one run had every real company refused: 400 02803002 "generic.error".
`--probe 1773567` (workflow step `probe`, throwaway companies only) named why:
the whole-record PUT sends picklists back, Kylas sends them as `{id,name}` and
refuses a bare id (`numberOfEmployees`, `cfAccountHealthBd`), and **one value it
refuses in every shape** — `cfPipelineStageBd` holds a retired option (02801014
"Invalid Custom Field Value"). So no whole-record write could ever land. On a
throwaway with a real owner:

| write | result |
|---|---|
| `PATCH` `application/json-patch+json` `[{op:"add", path:"/customFieldValues/cfSourceOfData", value}]` | 200 · field took · every other field kept · **owner never moved** |
| `PATCH` merge-patch, or plain JSON | 415 |
| `PUT {name, the field}` | took it · **erased every other field** · owner → API user |

The canary now tries `patch` first and the run uses it. Companies whose owner is
**deactivated** (178 of 517) are still skipped by default; `--include-deactivated`
(workflow checkbox) tags them with the same PATCH, reading each back and stopping
at the first change. Nothing can give a record back to a deactivated user, so
that one is Ayush's call.

**Done, 2026-10-21 (runs 39570668797, 39571471041, 39572846046):** 337 of 517
companies tagged in Kylas — 1 + 35 + 301 — every one read back with the owner
it had before, and with the PATCH no owner was moved even for a second. Not
written: **178 with a deactivated owner** (waiting on Ayush: tick
`include_deactivated`, or re-assign them first) and **2 deleted in Kylas**
(1773237 and one more — 404). The first `--all` stopped on the 404; a deleted
company is now skipped.

**The 178 cannot be tagged through the API while their owner is deactivated.**
Run 39579245908 (`include_deactivated`): Kylas refused the very first one,
1776411, with 400 02801020 **"Invalid owner."** — it refuses ANY update to a
record held by a deactivated user, even the PATCH that carries no owner.
Nothing changed. The script now catches it, reads the owner back, and skips the
rest with that reason. The only way in: re-assign those companies to active
users in Kylas (Ayush's call — which person gets which account), then run `all`
again; only they are left, the 337 are skipped as done.

**Reassigning them (Ayush, 2026-10-21): round robin to Sejal, Anjali, Muskan,
Arshdeep, Mayra — never Enout Super Admin — contacts with the account.**
`scripts/reassign-deactivated.mjs`, workflow `reassign_deactivated.yml`
(dry-run → first-one → all; "all" then runs the month tag on them). Only
companies whose Kylas owner is DEACTIVATED are moved; each `--to` name must
match exactly one ACTIVE user; the API user is refused as a target. One-field
owner endpoints only — `PUT /v1/contacts/{id}/owner` for every contact of the
account, then `PUT /v1/companies/{id}/owner` — each read back, first mismatch
stops. Round robin over ids sorted, starting with whoever holds fewest of the
view's companies, so a re-run after a stop keeps the split even. One-way by
nature: nothing can be handed back to a deactivated user.

The live dry run (2026-10-21): 178 accounts from 74753 (69), 74754 (59), 74756
(19), 82993 (19), 76689 (12); 482 contacts — 381 on deactivated users, **92 in
16 accounts already with an active BD**. Ayush: those 16 accounts go to **the
active BD who already holds their contacts** (contacts stay), not the round
robin — `--follow-contacts`, the workflow's default `contacts: follow-active-bd`.
The other accounts round robin with their contacts.

**Done, 2026-10-21 (runs 39585836142 first-one, 39587652033 all):** all 178
accounts moved and read back with their new owner — Sejal (85880) 44 (12 of
them following their contacts), Mayra (74755) 34 (2 following), Arshdeep
(82866) 33, Anjali (83129) 32, Muskan (82867) 31, and 4 to the active BD already
holding their contacts outside the five (74752: 1, 82978: 1, 82994: 2). None to
the API user. **381 contacts** moved with their accounts (every one that sat on
a deactivated user); the 92 already with an active BD stayed. Then the month tag:
**178 of 178 tagged**, owners unchanged. Oct/Nov/Dec is complete: **515 of 517**
companies tagged in Kylas; the other 2 are deleted (1773237, 1783882).
Before-images: the run artifacts `reassign-snapshot-<run id>` (90 days).

**Rubal's lifetime MQL-SQL accounts, 2026-10-21 (run 39659760292).** Ayush:
"Rubal ke saare companies jinme lifetime MQL-SQL set hai, round robin among
BDs." `--from rubal --lifetime-only` (workflow inputs `from`, `lifetime_only`):
Rubal (74752, active) held 2,195 companies in Kylas; **118** carry lifetime
MQL-SQL in Source of Data and all 118 moved and read back — Sejal 27 (4 of them
following their contacts, already hers), Anjali 23, Muskan 23, Arshdeep 23,
Mayra 22 — with **317 contacts** (every one Rubal held on them). The other
2,077 stay with Rubal. Kylas will not filter the company search by owner on
this account, so `--from` reads the whole account (~20 min) before planning.

## 3l3 · Allot — accounts AND contacts, split by %, in the console (1.69.0)

Ayush, 2026-10-21: *"Yeh account allotment ka process UI pe move kar do —
account ke saath contact bhi allot ho sake, and it should be fast, with
progress bar, taki majje aaye karne mein."*

**Console (admins):** tick rows (or *Select these N*) → **Allot**: one or more
people, each with a share (40/60, *split evenly*), a preview of who gets how
many → one confirm → 5 accounts a request, a bar with per-person counts, an
ETA and **Stop**. Moved rows untick, failures stay ticked, and the table shows
the new owner at once (the list is the Airtable copy, which learns it at the
next sync — `applyAllotted()` lays the read-back owner over it until then).
It replaces "Move their contacts to"; one person at 100% is that.

**Server:** `POST /allot` → `reassign.mjs allot()`: one person per account,
decided in the console; **one-field writes only** — `PUT /contacts/{id}/owner`
for each contact, then `PUT /companies/{id}/owner` — never a whole-record PUT
(refused on retired picklist values, and a read per contact); each account's
owner **read back**. **Every contact goes with its account** (1.71.0, §3l5);
until 1.71.0 contacts an active BD already held could stay ("Keep contacts
another active BD already holds", on by default). Never to the API user. `GET /allot-people`: active users only. The old `/reassign` stays for
older builds. Tests: `test-allot` 14, `test-allot-live` 13 (real Chrome).

**The same split from a script:** `select-accounts.mjs` runs the console's own
`/companies` code and keeps the ids a filter shows (owners + offsite quarter);
`reassign-deactivated.mjs --ids --from a,b,c --split sejal:40,mayra:60`; workflow
`allot_accounts.yml`. First use, 2026-10-21: Offsite Q1+Q2+Q3, eight owners
(Gaurav 236, Super Admin 54, Shreya 21, Rubal 12, Tanay 12, Devansh 8, keshav 2,
Charu 1 — the screenshot's counts) → 346 accounts, Sejal 138 / Mayra 208.
**Done (run 39672745871): 346 of 346 read back on their new owner; 180
contacts moved with them** (every one on those owners or a deactivated user);
**320 contacts in 101 accounts stayed with the active BD already working
them.** Before-images + the picked ids: artifact `allot-snapshot-39672745871`.

## 3l4 · "Called, below Activation" — the morning tracker mail (2026-10-22)

Ayush: *"accounts which are called but have been in below activation state in
rung — usko hum tag kar paaye … har din ka update: pehli call -> CNC mein thi,
ab usse track karna"*, by mail. `scripts/below-activation.mjs`, sent by the
Worker's maintenance job once a day after 06:00 IST (same guard as the digest).

**On the list:** called at least once (console Call Log **or** the Kylas dialler —
`Dialler Calls`, joined by Kylas contact id) and the furthest contact under
**rung 13 (Activation)**; left out: Not Interested, Invalid Contact (closed),
Offsite Delayed, Offsite Done (Late Reachout) (a talk was had). No threshold —
tracked from the first call. **The mail:** count, per owner, what changed since
yesterday (climbed to Activation+, newly here, closed), then per owner the
accounts longest stuck first — stage, days since the first call, calls, days
since the last. Yesterday is a snapshot in the shared store, written only when
a mail went (a failed send retries against the same yesterday).

**Sending:** `sendReport()` in digest.mjs — SMTP with `MAIL_SMTP_USER` /
`MAIL_SMTP_PASS` (intended sender **automations@enout.in**, an app password),
to `MAIL_TO_STUCK` or else `MAIL_TO`. Until those secrets exist it logs the
body and sends nothing. `GET /below-activation` (admins) previews it;
workflow **Preview — called, below Activation** prints the live counts (no
names — public logs). Tests: `test-below-activation` 25.

### 3l4b · One mail per BD, and the only secret is the password (2026-10-26)

Ayush: each BD gets their own morning mail; the admins keep the team-wide one; "I will only
enter MAIL_SMTP_PASS, rest all details you have".

* **Per BD** (`scripts/bd-mail.mjs`, sent from `stuckMail()` in handlers.mjs): their accounts that
  are called but below Activation, what changed since yesterday, and "n of your contacts have
  stalled and the reason is still owed" (from `readRcaDue`, pointing at the console's Reasons
  bell). Address = the BD's own Kylas user e-mail, matched on the owner's name. **Skipped, with the
  reason logged:** the API user, a deactivated user, two users sharing a name, no e-mail, an
  address outside `ALLOWED_EMAIL_DOMAIN`. **No mail** when a BD has nothing stuck, no change and
  nothing owed. `MAIL_PER_BD = "0"` turns it off.
* **Admins:** the team-wide mail, unchanged, to `MAIL_TO_STUCK` or else `MAIL_TO`. The daily
  write-back digest is still team-wide, to `MAIL_TO` only.
* **Once only:** each recipient is claimed in the shared store (`below-activation-sent-<day>`,
  `below-activation-bd-<day>-<owner>`) before the send and released on failure; yesterday's snapshot
  is written only when every mail of the day went, so a retry compares against the same yesterday.
* **Config:** `MAIL_SMTP_USER = "automations@enout.in"`, `MAIL_TO` (the three admins) and
  `MAIL_PER_BD` are plain `[vars]` in wrangler.toml. **The one secret:**
  `npx wrangler secret put MAIL_SMTP_PASS` (the app password of automations@enout.in), then
  `npx wrangler deploy`. Until it is set nothing is sent and the body is logged.
* Tests: test-bd-mail.mjs (20), test-worker §15e2.

### 3l4c · The company's offsite quarter = its contacts' quarters, added (2026-10-27)

The digest's audit said 52 companies have a quarter from their contacts, 22 of them differ on the
company in Kylas (nothing writes the company field). Ayush: *"contact se uthao aur company ke existing
mein usko add kar do"* — a **union**: nothing on the company is removed, the contacts' quarters are added.
`scripts/offsite-sync.mjs` (rule, pure, `test-offsite-sync` 10) and `scripts/offsite-to-company.mjs`
(runner). Quarters from the Event Rows exactly as the console derives them; written with the same one-field
JSON PATCH as the Source-of-Data tag (owner never moves; read before and after, first change stops the run).
A **single-select** company field cannot hold two quarters: reported, never overwritten. A company whose
owner is deactivated is refused by Kylas and listed. Workflow **Offsite quarter, contacts to company**:
`dry-run` → `first-one` → `all`. Not run yet: the dry run says what the field is and how many are affected.

## 3l5 · Every contact belongs to whoever owns its account (2026-10-22, 1.71.0)

Ayush: *"all associated contacts for that account should be allotted to
whoever owns that account. Check for that."* It is the rule now, not an option:

- **Allot (console + `/allot`)**: the keep-contacts box is gone and the server
  sends `leaveActive: false` whatever a request carries (1.69/1.70 sent true).
  `allot_accounts.yml` defaults `contacts` to `all`.
- **The check, and the fix for what is already off** — `scripts/align-contacts.mjs`,
  workflow **Contacts follow their account's owner** (`check` → `first-one` →
  `all`, optional `owners`). **Kylas only**: every account from the console's own
  crawl, every contact in one crawl (`contactsChangedSince(null)`, id/owner/company),
  joined (`align.mjs offAccounts()`); only the accounts that are off are read again,
  owner included (`verify()`). A search per account was the first try: at Kylas'
  ~1 request a second that is five hours for 18,000 accounts; the fix is `allot(…, keepOwner)` to the owner the
  account already has — contacts only, one-field writes, and an account whose
  owner has changed since the check is left alone. NOT the Airtable copy: the
  first version nominated from it and would have checked ~1 account in 20 — on
  2026-10-22 the copy held **685 of ~17,900 companies**, and only **1,947 of its
  37,443 contacts** were linked to a company (the console lists from the Kylas
  crawl for exactly that reason, handlers.mjs "a copy that is short"). Accounts on the **Super Admin** or a
  **deactivated** user are only reported: contacts are never moved TO them;
  allot the account first. Plan + before-images: artifact `align-<run id>`.
  Tests: `test-align` 16; `test-allot-live` 14 (no box; Priya's contacts move).
- **Done, 2026-10-22 (runs 39777423782 first-one, 39778418090 all, 39785638932
  the rest):** 18,065 accounts and 37,498 contacts crawled; **1,314 contacts on
  ~494 accounts moved to the account's owner** (Mayra 119 accounts, Sejal 127,
  Gurnoor 59, Arshdeep 60, Muskan 35, Anjali 34, Aditi 33, …; 287 of them had
  been on Sejal). The re-check finds no account on an active BD with a contact
  elsewhere. **Left, by design: 339 accounts** whose own owner is the Super Admin
  (152, 541 contacts on others) or a deactivated user (187, 469) — the account
  needs an owner first. Before-images: artifacts `align-<run id>`.
- **…and the other way round for those (`mode: give-accounts`, Ayush: "jiske paas
  contact hai uske paas account — only in case of above two"), 2026-10-22, runs
  39847571787 + 39849075307:** **214 of the 339** went to the active user holding
  most of their contacts (Vipul 60, Rubal 57, Aditi 22, Sejal 19, Bhaumik 15,
  Mayra 13, Ayush 8, Hisham 8, Gurnoor 4, Arshdeep 3, Akash 2, Vidhi/Vedant/Nikita 1;
  ties to the lower id: 2), **every owner read back**, 105 more contacts followed.
  From: Super Admin 96, Devansh 48, Tanay 22, Gaurav 21, Shreya 16, Charu 9, Ifee 2.
  **125 left**: none of their contacts is on an active user — they need allotting.
- **Only these seven may hold accounts (`mode: give-to-pool`, Ayush, 2026-10-23:
  "Arshdeep, Muskan, Sejal, Mayra, Anjali, Gurnoor, Aditi")**, runs 39930536357
  (check), 39932026409 (first), 39933384737 (all): the 125 left **plus the 153 the
  run above had put on Vipul, Rubal, Bhaumik, Ayush, Hisham, Akash, Vidhi, Vedant
  and Nikita** (found from that run's before-image artifacts, downloaded by the
  workflow itself — `--snapshots`; an account allotted since is left alone) went to
  the seven, **277 accounts, every owner read back, 922 contacts followed**:
  Arshdeep 41, Muskan 40, Sejal 40, Mayra 39, Anjali 39, Gurnoor 39, Aditi 39
  (`pickFromPool()`: the pool member holding most of the contacts, else the one with
  the fewest so far — none of these held any, so it was an even spread). Those nine
  people's OWN older accounts were not touched. `--pool` takes user ids.
- **"X nahi dikh rahi"** — `scripts/find-account.mjs`, workflow **Find an account
  (why is it not showing)**: looks for the name in the Kylas crawl (what the
  console lists) and through contacts' company names, and per hit says owner,
  active or not, contacts and on whom, and which screens show it. Names print as
  `"Boo…" 12 chars` (public logs).

## 3l6 · "Boolean post nahi dikhti" (2026-10-23/24) — why, and why the extension does not have to change

Company Database → Company List keeps the Boolean post in **four** columns
(`Boolean Post link - kylas`, `Boolean - New`, `Boolean Post Link (Demand Team)`,
`Boolean (linked)`); the console read three. Of **1,240** rows whose Source says
Boolean, **864 have a link, 376 have none anywhere** (the screenshot's DDN is one:
Source "Boolean - New", no post in any column — nothing to show) and 9 have no
Kylas Company Id. 107 rows keep it only in `Boolean (linked)`: those were "—".

Fix: `ENRICH_BOOLEAN_COLUMNS` has the fourth (accounts table `bp` — server only), and
the research row is served with a `Boolean (linked)`-only value ALSO under
`Boolean Post link - kylas` (handlers.mjs `curatedResearch`), so **a console that
knows three columns — every extension up to 1.70 — shows it after `npx wrangler
deploy` alone**. Checked in a real Chrome with the **1.70.0 extension** against the new
server (renee-cosmetics, ats-global, cloudextel render; DDN stays "—"). The table
column reads from the D1 copy of Company List, rebuilt once a day, so it follows
within a day; the pane reads Airtable live. Tests: `test-worker` 182.

## 3l7 · Stalled-contact reasons: the bell, who owes, what was said; stage × meeting-mode for everyone (2026-10-26, 1.72.0 → 1.73.0)

Ayush: "table bana do — owner kaun hai pata nahi chalta, aur reason contact ke owner ko bharna hai";
then "BD ke console mein notification aani chahiye, reason submit ho, admin ko poora dikhe, BD ko sirf
uska; meeting-by-stage bhi same".

* **Rule: the BD sees only their own, the admin sees everything — enforced on the server**
  (`nameScope()` in handlers.mjs): `/rca`, `/rca-log` and `/mode-split` ignore `?owner=` for an
  associate and use their own name (a name the server cannot resolve gets nothing, not everything).
  Admin may pass `?owner=` or leave it empty for the whole team.
* **The notification is a bell in the top bar** (`#rcaBtn`, "Reasons n", amber when n > 0), on every
  screen. n = an associate's own stalled contacts; for an admin, the whole team's. Refreshed on sign-in
  and every 15 minutes while the tab is visible. Once per session, when some of the person's own are
  waiting, a toast says so. Nothing is pushed by mail or phone: that needs the MAIL_* secrets (still
  open, §6) — the morning tracker mail is the natural place to add "you owe n reasons".
* **Acting on it:** the bell opens one panel with two tabs. *To give* — who owes (contact, company,
  owner, gate, days) and, if any are the viewer's own, "Give my reasons (n)" which runs the one-click
  chip sheet; the bell count drops as each is saved. *Given* — what was said (reason, note, given by,
  when) from the RCA table, `GET /rca-log` (`readRcaLog`). Admin sees every owner's; a BD their own.
* **Only the owner answers** (`mayAnswerRca`, scripts/rca-owner.mjs): `/rca-answer` 403s anyone but the
  contact's owner; admin is allowed server-side so an orphaned contact is not stranded. `Answered By`
  is the signed-in name, not what the client sent.
* **Meeting mode by stage** (`/mode-split`, `stageModeSplit`, scripts/mode-split.mjs): contacts by the
  stage they are at now × Mode of Meeting (In Person | Virtual | Calls | Text). On every dashboard: an
  admin follows the Who selector (Me / Everyone / a person), a BD gets their own contacts. "With a mode"
  vs "All at stage" shows how many still have none.
* Tests: test-mode-split.mjs (17), test-worker §15f (associate cut to self on all three routes,
  403 on someone else's answer, admin reads the whole log).

## 3l8 · Open accounts — a picked account stays on top until SQL (2026-10-28, 1.74.0)

Ayush: an account a BD has picked must stay in front of them until it moves — Right POC, then a
discovery call, then SQL — "clearly visible", not blocking. Decided: picked = the **first call**
(console Call Log or the Kylas dialler), no click; **shown, never blocking**; English wording; in the
**Accounts (company) pane**, not a separate panel.

* Rule: `scripts/open-accounts.mjs` `needOf(p)` over `accountProgress().byCompany` — `right` (called, no
  Has Signal), `discovery` (Right POC, no Has Complete Row), `sql` (discovery done or a meeting booked,
  not SQL); nothing when never called, SQL reached, or every contact closed. progress.mjs now reads
  Has Signal / Has Complete Row into `p.right` / `p.discovery`.
* Server: `/companies` carries `open: { need, firstCallAt, lastCallAt, calls }` per account (acctFields).
  No new route; owner scoping is the list's own.
* Accounts view (views.js `openStrip`): four cards above the table (Open / Needs Right POC / Needs
  discovery call / Needs SQL — click filters, again clears); open accounts are pinned above every sort
  (Right POC first, oldest pick first); a "Needs …" badge on the company cell; amber row when not
  called in 5+ days. Updates after a save through the existing re-read (savedLanded).
* "+ New contact" removed from the top bar (Ayush).
* Tests: test-open-accounts (11). test-accounts-ux-live has 5 failures that are identical on the
  previous build (tick/narrow cases), not from this change.

## 3l9 · Work today, Created/Updated-by filters, research and Demand-stage removals, faster search (2026-10-29, 1.75.0)

* **Work today** (views.js `todayPlan`/`todayCard`; changed in 1.75.1 per Ayush): only ★ Focus accounts,
  two groups — **Call today** (call-back due today or overdue) and **Tapped, Right POC not identified**
  (called, `open.need === "right"`, oldest tap first; amber if not called in 5+ days). An account in both
  shows under Call today. Card at the top of the Accounts pane; click opens.
* **Filters:** "Created by" / "Last updated by" chip rows under More filters (`cby`/`uby`).
* **Removed (Ayush):** "Account pipeline stage" from Account research, the "Open in Airtable" button, and
  the Demand team stage column + filter everywhere. Account stage unchanged. An old saved `aps` filter no
  longer applies.
* **Search:** the match per account is cached per query (accMatch ran once per chip row per account per
  keystroke); debounce 200→150 ms.
* **KPI status chips checked against Airtable (2026-10-29):** each company is counted once, at the highest
  rung it has reached (Right POC 40, Discovery 16, SQL booked 5, SQL done 8, SQL 41 from Airtable's own
  flags) — the console's 41/16/5/8/40 matches within a day's drift. The flags are not cumulative
  (Discovery is a data rung, booked a stage), which is why the rows do not shrink step by step.

## 3l10 · Work today, the approved full-flow design (2026-10-29, 1.75.2)

Replaces the 1.75.1 Work today card and the four Open-accounts cards (views.js `todayPlan`/`todayCard`;
mock scratchpad `full-flow.png`). One block between the RCA strip and the accounts table, the same height
at any count:
* **Left (indigo panel):** calls to make today = ★ Focus call-backs due/late + done today; progress bar;
  "Your open accounts · N" with Need Right POC / discovery / SQL — each line filters the table (`ACC.openNeed`).
* **Right:** toggle **Call today** | **No Right POC yet** (★ Focus, called, `open.need === "right"`; an
  account in both sits under Call today). Top 5 rows (avatar, one meta line, status pill, opens the account).
  A row that moved off "No Right POC yet" this session stays, green, "Moved to discovery ✓".
* **View all N in table:** sets `ACC.todaySet` ("call" | "poc"), a removable chip "Work today: …" in the
  filter bar, table sorted late-first / oldest-tap-first, scrolls to it. × or Clear all restores.
* **Call card:** "Needs Right POC · tapped 5d ago · 2 calls" under the company name (`Views.openFor`; only
  when the accounts list has been loaded this session).
* The hero number uses `calc(var(--t-name) * 2)` — the one place larger than the five sizes.

## 3l11 · Re-assignment as a background job; "SQL Meeting Booked / Done" (2026-10-29, 1.76.0)

Ayush: allotting from the console "is not scalable" (the work ran inside the request, tab had to stay
open, a 429 or closed tab left it half done); wants it full-proof and rolled out only after a stress test.

* **Engine** `scripts/allot-jobs.mjs`: Start writes a job (D1 `allot_jobs` / `allot_items`, one row per
  account or contact batch) and answers — **12 ms** on a cold Worker isolate in test-worker. Items are claimed
  by one atomic UPDATE, leased 2 min (a dead claim is taken again), retried with back-off on 429/5xx/timeouts
  (6 tries), final with the reason on a data refusal. A newer job for the same account supersedes a queued
  older one. Done = read back: the company owner AND (new) every contact (`allotOne(verifyContacts)`).
* **Who runs it:** the console calls `POST /allot-jobs/step` again and again while open (each a fresh
  invocation, 4 items); the minute cron drains 3 items when nobody is watching. Laptop proxy: a local
  SQLite file (`.allot-jobs.sqlite`, `jobsDb`).
* **Console:** the Allot panel creates the job, shows the new owners at once, a top-bar chip
  "Re-assigning n/N" → "N moved ✓ · k failed"; click → sheet with progress, failures (reason), Retry,
  Download CSV, Cancel. **Move contacts…** on a company (admin): "every contact to the account owner" or
  pick contacts + a person; the company does not move.
* **Stress test** `scripts/test-allot-jobs.mjs` (28, the release gate): 2,000 accounts × 5 contacts nothing
  lost; 30% 429s all finish; 60% 429s → leftovers fail with "429" and Retry; 3 crashes mid-item → resumes,
  no double writes; two admins → newer wins, each account written once; 5% silent drops all caught and
  never shown as done; contacts-only; cancel. Live UI: test-allot-live 16/16 on the job path.
* **Speed, honestly:** the moves are bound by Kylas' API rate. With Kylas answering in 400 ms, one account
  with 5 contacts is ~11 requests ≈ 4.4 s (measured), so 500 accounts ≈ 35–40 min — but in the background
  and resumable. The big speed-up needs Kylas' own bulk call (the one its UI uses); not built — needs the
  request captured once from the Kylas screen.
* Rungs renamed "SQL Meeting Booked" / "SQL Meeting Done" (views.js RUNG + copies, report.mjs).
* **1.77.0 — the re-assignment UI redesign** (approved mock `reassign-ui.png`): ticking rows shows a floating
  bar at the bottom ("N selected · ★ Add to Focus · Re-assign → · Select all · Clear"); Re-assign opens a
  side panel (views.js `openReassign`, outside the accounts view so following a job never redraws 18k rows):
  Accounts + their contacts | Contacts only, one card per person (load, %, what they get), + Add person,
  Split evenly, split bar, summary, one button. The same panel then shows a ring, a bar per person and the
  last few moved (allot-jobs `status` now returns perTo / recent / contacts), and ends with moved / not moved
  + reason, Retry, Download CSV, Close. test-allot-live 18/18.

## 3l12 · Work today on the Dashboard too (1.77.1)

Ayush, 2026-10-29: the same Work today block (`todayCard`) now sits on the Dashboard under the RCA strip, built from the dashboard's own owner scope. Rows open the account; the tabs redraw the dashboard; "View all" and the need lines set the Accounts filter and switch to the Accounts view via `window.showConsoleView` (overlay.js). Checked in Chrome on the mock stack: View all lands on Accounts with the `Work today: Call today` chip.

## 3m · The duplicate check (phone and email, against the whole account)

Ayush, 2026-10-16: *"Duplicate check -> system kya hai.."* and, in the workflow
notes, *"conflict checkups on the basis of email and phone no — if anything is
incorrect, flag them up."* Built 2026-10-17.

**What there was:** the console compared the last ten digits of a phone with the
contacts open in the list, showed an "Already on X" pill, and nothing more.
No email check, nothing past the list on screen, nothing recorded, nothing
blocked or flagged.

**What there is now** (`scripts/dedupe.mjs`, `dedupe-report.mjs`). One question —
*is anybody already holding this phone number or email?* — asked of two sources,
because each is blind somewhere the other is not:

| source | sees | blind to |
|---|---|---|
| the Airtable copy of `Contacts` (the D1 mirror) | every contact the hourly sync has seen | anything created in Kylas in the last hour |
| Kylas search (`multi_field`, `kylas.contactsMatching`) | live | whatever its free text does not index |

A Kylas search hit is only a **candidate**: `classify()` compares the real
`phoneNumbers` / `emails` of every row exactly (last ten digits; lower-cased
email), so a fuzzy hit never becomes "duplicate". The verdict says which sources
answered (`coverage: full / partial / none`); a check that could not look is
`unverified`, never `clear`.

**Verdicts, and what a save does:**

| verdict | when | save |
|---|---|---|
| `existing` | same phone or email, same first name (last name not contradicting), same company or no company to disagree | **refused, 409.** The console offers *Open* and *Create anyway*. |
| `flag` | somebody **else** holds the phone / email (`phone-conflict`, `email-conflict`); or the same person under another company (`other-company`); or the match sits with another BD (`other-bd`) | goes ahead; the flag is recorded |
| `unverified` | nothing to check with, or neither source answered | goes ahead; flagged |
| `clear` | nobody holds either and at least one source answered | goes ahead |

*Create anyway* is allowed and is **kept**: the contact is created and a row of
kind `overridden` is written, so a false positive (a shared landline, two people
with one name) never traps an associate and never disappears either.

**Where it runs.** `POST /check-contact` (read-only, any signed-in user) is what
the console asks while a new contact is typed, once the number or email settles
(600 ms, only when there is no Kylas id). `/save` asks again, authoritatively,
before queueing — so "already in Kylas" is the answer in seconds, not a dead job
minutes later — and `performSave` asks for a save that came in directly. The
server decides whatever the console sent.

**It must never refuse its own retry.** A save whose create already happened
would find the contact it just made. The check therefore runs only when the
journal (`journal.lookup`) has no entry for that save, and is skipped on an
interrupted attempt (`findExisting` owns that case). Pinned in `demo-dedupe.mjs`
steps 18-20.

**What is kept.** Table `Duplicate Flags` (one row per flag, `Status` Open until
an admin resolves it; never deleted) and, on the contact, `Contacts.Duplicate Flag`
and `Duplicate Note`. `result.duplicate` rides on the save job, so the morning
mail counts them ("N new contact(s) were saved as possible duplicates…").

**Run it and read it:** `node scripts/demo-dedupe.mjs` — the real routes against
the mocks, 22 scenarios, each printed as *what was checked / which sources
answered and what each found / verdict / every match and why / what the save will
do*, ending in one expected-vs-got table; exits non-zero if any differ.
`node --env-file=.env.local scripts/dedupe.mjs --phone <n> --email <e> --name <n>`
runs the same check against the **live** account, read-only.

**NOT CONFIRMED, and the one thing to check on the live account:** whether
Kylas' free-text search reaches the phone column. The mock says it does. Run the
CLI above with a number you know is in Kylas and read the `Kylas search` line:
*"0 real matches"* for a known number means it does not, and the Airtable copy is
then the only thing catching phones (still correct, just not live to the minute).

**To switch it on (Ayush):** `repair-base.mjs` (creates `Duplicate Flags` and the
two `Contacts` columns — the same run that creates `Push Log` and `Field Map`),
then `npm run deploy`. Until the table exists a flagged save still succeeds and
logs *"no Duplicate Flags table — run repair-base.mjs"*; the check itself needs
no new table. The console half ships with the next extension release; the
extension version was **not** bumped, because 1.68.1 is in store review and the
console warns when the extension and Worker versions differ.

**The admin screen** (`extension/console/flags.js`, built 2026-10-17). A **Flags**
button in the top bar, shown only to an admin (hidden until `/meta` says so; the
server answers 403 to anybody else) and turning amber with the open count. It
opens one card per contact: each flag with its kind and reason and a link to the
other contact's Kylas record, three answers — *Not a duplicate* (two real people),
*Handled in Kylas* (merged, deleted or fixed there), *Acknowledged* (looked, leaving
it) — and an optional note. The answer applies to **every open flag on the card**.
A Resolved tab shows who, when, what and why, with **Reopen**. Routes:
`GET /dupe-flags?status=Open|Resolved|all`, `POST /dupe-flags-resolve`
(`{keys, resolution, note}` or `{keys, reopen: true}`), both admin-only. A key that
is not in the table is reported and never created; the contact's own
`Duplicate Flag` mark clears when its last flag is resolved and returns on reopen.
`Duplicate Flags` gained `Resolution` and `Resolution Note` (run `repair-base.mjs`).
Checked in a real Chrome in both themes; worker tests §16.

**Not built:** matching on **name + company** with no phone or email (too many honest
twins); a periodic sweep for duplicates that already exist.

---

## 3n · Offsite contact vs company, and the speed of a bulk re-assign

Both from Ayush's 2026-10-16 notes ("Offsite Timeline -> contact <-> company,
Airtable to company is it being mapped (error rate to be determined)" and "Bulk
allotment — UI se fast nahi hai"). Built 2026-10-17.

### The offsite audit (`scripts/offsite-audit.mjs`)

The quarter is typed on a **contact's** event row and written to the **contact** in
Kylas (every save, and the nightly push — the Push Log verifies that half). The
**company's** own offsite field is only ever *read*: nothing writes a company, by
design. So "is Airtable mapped to the company" is a *comparison*, per company, of
three sets of quarters: the contacts' (`offsiteByCompany`), the company's field in
Kylas (`kylasOffsite`), and the team's Company List copy of it (`listOffsite`).

| verdict | meaning |
|---|---|
| `agree` | both have a quarter and it is the same set |
| `partial` | both have one and share some, not all |
| `conflict` | both have one and share none |
| `onlyAirtable` | the contacts say a quarter, the company field is empty — **the mapping gap** |
| `onlyKylas` | the company says one, no contact does |

Rates, each over its own denominator: **mapped** = agree / companies Airtable has a
quarter for; **error** = (partial + conflict) / companies *both* have one for (null,
never 0%, when there is no company with both); **notWritten** = onlyAirtable /
companies Airtable has one for. The Company List vs Kylas comparison is counted
apart — it is the sync's fault, not the mapping's.

`GET /offsite-audit` (admin) and a paragraph in the morning mail. **It reads cached
data only and never starts a Kylas crawl**: on a cold server it says "the Kylas
company list is not cached yet" rather than spending ten minutes of requests on a
report. Open the Accounts view once and ask again. `test-offsite-audit.mjs` counts
the rates by hand on cases of three or four companies.

**What it will most likely say:** a large `notWritten` — nothing writes the company
field — and a small `error`. The first is not a bug; it is the answer to "is it
being mapped". Writing the company field would be a separate decision (the company
PUT that replaces the record is fenced for a reason, §3e; the owner endpoint is the
only company write that is known safe).

### Bulk re-assign speed

**Why it was slow.** Per contact two Kylas requests (read it, PUT it back — the PUT
replaces the record, so the read cannot be skipped), per account one to set its
owner, and the Kylas client sent them **one at a time**: the next began only after
the last had *answered*, then waited out a 450 ms gap. Rate = 1 / max(latency, gap).

**What changed.**
1. The client can keep several requests in flight, **started the same 450 ms
   apart** (`setConcurrency`; opt-in, off by default). The ceiling does not move;
   only the wait for each answer comes off the critical path. It drops back to one
   at a time **by itself on the first 429**, because whether Kylas limits
   concurrency as well as rate has not been measured.
2. `apply()` takes a `concurrency` (`REASSIGN_CONCURRENCY`, default **3** on the
   Worker; `1` is the old behaviour), putting results back in the order the
   accounts were given.
3. A contact the search row already shows on the target is skipped **without the
   read** that used to precede the skip (a re-run of a half-finished batch).
4. `apply()` returns `timing` — ms, accounts, requests, 429s, per contact — and
   logs it, so "how fast" is a number.

**What it buys, measured** (`node scripts/bench-reassign.mjs`, 8 accounts, 16
contacts, against the mock with injected latency):

| Kylas answers in | one at a time | three at a time | |
|---|---|---|---|
| 700 ms | 39.4 s | 25.5 s | **1.55x** |
| 250 ms | 25.0 s | 25.0 s | 1.00x — no gain |

The gain is **latency / gap at best**: it hides latency, it does not raise Kylas'
rate. If the live account answers inside 450 ms it buys nothing, and that is the
number to get first.

**Measure the live account (read-only):**
`node --env-file=.env.local scripts/probe-throughput.mjs` sends ~100 `GET
/v1/users/me`, stops a setting at its first 429, and prints the median answer
time, whether overlapping was accepted, and what to set `REASSIGN_CONCURRENCY` to.
Run it before believing the table above applies to Kylas.

**Not done, deliberately:** skipping the per-contact read before the PUT (a
search row does not carry every field, and the PUT replaces the record — §3
cont.); lowering `KYLAS_GAP` (speeds everything, and the one data point for the
450 is "a burst of 8 drew three 429s").

---

### Meeting type — decided, nothing to build (2026-10-17)

Asked whether `In Person` should become `Physical` and what the "(to be added)"
value was, Ayush answered: keep `In Person`; `Calls` and `Text` are enough. See
`docs/kpi-spec.md` §7. The per-company meeting-mode count the dashboard already
makes (`co.modes` in views.js) is the view; it needs no change.

---

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

- **Switch on push tracking (§3l).** `repair-base.mjs` (creates `Push Log` and
  `Field Map`), then `field-map.mjs --store`, then `npm run deploy`. Check that
  `MAIL_*` are Worker secrets (`npx wrangler secret list`) or the morning mail is
  only logged.
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
- ~~**Create the `Dialler Calls` table**~~ — **DONE 2026-10-15.**
  `repair-base.mjs` created it (and added `Call Rollup.Stage Set`), and the
  first import wrote **134 calls, 110m37s**, split Muskan Rajpoot 84 / Mayra
  Singh 34 / Aditi saini 10 / Anjali Athya 6. Verified by reading the base: 134
  rows, each with the dialler's duration, the associate as Owner, and a device
  id — `motorola edge 40`, `SM-A066B`, `SM-M356B`, `CPH2467`, one per person,
  which is independent proof the attribution is real. Talk time covers
  2026-10-13..15 only, because that is the window the newest 1,000 logs span;
  the hourly cron keeps it current from here. The steps below are kept because
  they are the recipe if the table is ever lost.
- **How it was done** (§3h), which was the whole of why Talk time read blank. `schema.mjs` is DATA, not a script — running it does nothing,
  and saying otherwise cost a day (2026-10-15). The executable is
  **`node scripts/repair-base.mjs --dry-run`**, then without `--dry-run`; it
  creates absent tables and adds absent fields and touches nothing that exists.
  Its PAT needs **`schema.bases:write`**, which a data-only token does not
  have. The base read on 2026-10-15 holds thirteen tables and no Dialler Calls.
  After that the hourly cron fills it on its own, so nothing else is required —
  `node --env-file=.env.local scripts/import-dialler-calls.mjs` (dry, then
  `--apply`) only saves the wait. The dashboard now says which of these three
  it is rather than "not timed": **not set up** (no table), **not imported**
  (table, no rows), **not timed** (rows, but none for these calls).
- **The Chrome Web Store privacy policy URL.** GitHub Pages is already ENABLED
  on this repo (`has_pages: true`, checked 2026-10-16), the repo is public, and
  the policy is `docs/privacy.html`. What is not knowable from here is which
  source Pages serves — the API path is blocked through this session's proxy —
  so a root `privacy.html` redirect was added to make **one** URL work either
  way:

      https://ayush9205nitrr.github.io/kylas-kpi-tracker/privacy.html

  Open it. If it loads, paste it into the store listing's Privacy tab and the
  policy requirement is met. If it 404s, Pages is serving a branch that has
  neither file — switch the source to `main` + `/docs` in
  Settings → Pages, and that URL starts working.

  The policy itself is written and current: short version, what the extension
  handles, what it does not, where the data goes, sign-in, browser storage,
  retention, contact. It must be re-read whenever the extension starts touching
  something new — a policy that no longer describes the software is worse than
  a missing one, because it is a false statement about somebody's data.

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

## 3l13 · The Accounts table had no tick boxes (1.77.2)

Ayush, 2026-10-29: "no option of ticking rows". The explorer table (`explorerHTML`) never rendered the
`.cpick` box — only the older `companies()` list did — so the floating Re-assign bar could only be reached
through "Select these N". The Company cell now carries the box; the existing delegated `.cpick` wiring does
the rest. Checked in Chrome: two ticks → "2 selected · Add to Focus · Re-assign →", row did not open.

## 3l14 · Earlier notes under "Notes from the call"; the "Said before" strip is gone (1.78.0)

Ayush, 2026-10-29, approved mock "v2". `notesHist(a)` (console.js) renders under the `f-rm` textarea: a
card titled Earlier notes, one row per earlier note: avatar initials, **who · when · outcome pill**, then
the note in a bubble, newest first. Two are shown, and "Show all N notes" opens the rest in place. The
rows come from the Kylas call logs (`/history`), Kylas Remarks and past event rows, de-duplicated with
`normNote` against what the box already holds. Nothing renders when there are none. `loadHistory()`
swaps `#nhist` in place when the call logs arrive. The callbar's `.pnote` strip and its CSS are removed.
**Unchanged on purpose:** the textarea still edits the contact's own note (`a.remarks`) and the save
path is untouched. Making the box start empty per call means changing how Remarks is written, so it
was left for a separate change.
