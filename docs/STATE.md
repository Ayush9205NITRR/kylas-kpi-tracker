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

---

## 5 · Open — ask Ayush, do not guess

1. **The team roster is live but empty on your base.** `Team` is a new table;
   until somebody ticks it, every owner counts — which is the old behaviour, so
   nothing breaks by ignoring it. Open the dashboard as Everyone and use the
   **Team** button beside the ladder.
2. **One proxy or eight?** Per-laptop works today with no code change but puts
   the Kylas key and Airtable PAT on every machine and makes the nightly sync
   depend on a laptop being awake. A shared proxy needs a host added to
   `host_permissions` and **must** have Cloudflare Access or Tailscale in front
   — it has no auth of its own. Asked three times, unanswered.
3. **The call-back date never leaves the browser.** `nextCallDate` is
   overlay-owned and blanked on read, so an account where the prospect said
   "call me after the AGM" is indistinguishable from a neglected one. Needs a
   `Next Call At` column, a writer, and a company-level rollup. This is the last
   unbuilt piece of Ayush's own "stays in my loop until it gives me a date".
4. **The RCA reason lists are drafts.** `docs/rca-reasons.json`, written to get
   the mechanism working. Ayush said he would rewrite them.
5. **Which Contact and Companies-table fields to cut.** He said he would send a
   list; it never came. The conservative cuts already made are in the log.
6. **`Source of Data` and `Salutation` picklists** are guesses. Offsite Timeline
   is settled — Kylas only accepts quarters and Ayush confirmed that stands.
7. **Google Workspace?** Decides whether the store listing can be "private to
   your organisation", which is the right setting for an internal tool.

## 6 · Ayush's to-do, outside this repo

- **Rotate the Airtable PAT** — `pat7TsKhwZPyqTMG5…` was pasted in plain text in
  a chat. Never committed (verified), but treat it as burned.
- **Run `repair-base.mjs`** on the live base. Until then saves lose their KPI
  rows with a 422 on `Phones`, and the `RCA` table does not exist.
- Then `seed-transitions.mjs`, then `migrate-ever-picked.mjs`. **That order** —
  the second reads what the first writes.
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
