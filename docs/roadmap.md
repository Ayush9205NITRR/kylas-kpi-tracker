# The longer term — how it runs, what is left, what it costs

Ayush, 2026-09-22: *"For longer term, how does it work? Help me with this — a
plan, how long, no of tokens required to build."*

Written against the repo as it stands: 24,349 lines, 22 test suites, thirteen
commits since the last version bump.

---

## 1 · How it works once it is running

Nothing here is speculative — it is all built. This is the operating model.

### Every day, without anybody doing anything

| When | What | Runs |
|---|---|---|
| 00:30 | freeze yesterday's numbers | `snapshot.mjs` |
| 01:00 | Kylas → Airtable | `sync-kylas.mjs` |
| 13:00 | Kylas → Airtable again, so an afternoon's CRM edits reach the console by morning | `sync-kylas.mjs` |
| Sun 02:00 | compact the Call Log past the retention window | `rollup-calls.mjs` |

One entry point, `scripts/cron.sh`, installed by `scripts/install-cron.sh
--apply`. **Never yet installed on a real machine** — that is on the list below,
not done.

### Every associate, every call

Open Kylas, click a company, the console opens itself. Log the call, Save &
next. The save writes Kylas (contact, stage, call log) and Airtable (company,
contact, event rows, call log, stage transition) in one request, and if the
network is down it queues in the browser and drains later.

Their proxy starts at login (`install-agent.sh`), so none of them runs a server.

### Every month

The ladder answers "what moved", the step conversion answers "whose funnel
leaks", the RCA list answers "which accounts owe an explanation". All three
read the same report, so they cannot disagree.

### What will break, and what catches it

| It breaks when | What catches it |
|---|---|
| Kylas adds or renames a pipeline stage | `docs/stages.json` is the one source; `gen-stages.mjs` regenerates both sides and refuses to emit if a milestone floor names a stage that does not exist |
| Somebody edits the Airtable schema by hand | `verify-base.mjs` diffs the live base against `schema.mjs` |
| A column the KPIs need goes missing | the console's standing banner, added 2026-09-22 |
| The console and the proxy drift apart | the build hash each prints, compared on every boot |
| A migration is run from the wrong clone | the build line every hand-run script prints |
| Call Log outgrows the base | the weekly rollup; history is compacted, not deleted |

That list is the actual answer to "how does it work longer term". The system is
not hard to operate; it is hard to operate *blind*, and most of this session
went into making it not blind.

---

## 2 · What is left, in the order it matters

### Phase 0 — Use it. No code.

**This is the bottleneck, and it is not a build task.** Every "it works" in this
repo means "it works against the mocks". Nothing is in production, and no
associate has made a single call through it.

1. Rotate the Airtable PAT (it was pasted in a chat).
2. `repair-base.mjs --dry-run` → `--apply` → `--update-formulas` → `verify-base`.
3. `seed-transitions` → `migrate-ever-picked` → `migrate-first-worked` →
   `migrate-first-qualified`, in that order.
4. `install-cron.sh --apply` on one machine that is always on.
5. `install-agent.sh --apply` on your own Mac. Make twenty real calls.
6. Then two more associates. Then the rest.

Until step 5 happens, everything below is building on an untested foundation.
**Cost: zero tokens, about a day of your time.**

### Phase 1 — The central server

The design is in `docs/central-server.md`. What it takes:

| Piece | Roughly |
|---|---|
| Sessions: sign-in page, signed httpOnly cookie, middleware in front of every route but `/health` | 250 lines + tests |
| User store: email → Kylas user id → that person's Kylas key, encrypted at rest | 300 lines + tests |
| `whoami()` becomes "who is this session", not "who owns the process key" — and every route that scopes by owner follows | 200 lines, touching `proxy.mjs` (1,706 lines today) |
| CORS narrowed to the extension's origin, credentials allowed, rate limit, audit line | 150 lines |
| Every existing live suite updated to authenticate | 300 lines across 6 files |
| Deploy: droplet or Tailscale, Caddy, a systemd unit, a deploy script | 150 lines + a runbook |

Call it **1,100 lines of product and 800 of tests**, against a session that just
produced 2,300 and 1,600. So: **a little under twice this session**, with more
design risk, because auth is the one area where a mistake is not a bug but an
incident.

### Phase 2 — Operate it

- Backup and restore for the user store — it is the only state on that box not
  already in Airtable or Kylas.
- An onboarding script: add an associate, take their Kylas key, verify it.
- Is-it-up checking. A proxy that has been down since Tuesday is worse than one
  that was never installed, because the numbers look like a quiet week.
- Publish to the Web Store, or decide Load unpacked is fine for eight people.
  (It probably is. The store buys automatic updates and costs a review queue.)

**Maybe half a session.**

### Phase 3 — The questions nobody has answered

`docs/kpi-spec.md` still carries five items marked **OPEN**, and they change the
numbers:

- Does a company reached in March still count in April's "reached"?
- Phone-picked rate over companies *reached*, or companies *dialled*?
- Does "Successful discovery" require Remarks as well as the three fields?
- What is rung 5, "Active Requirement Call"?
- Key `2` sets `DISQUALIFIED_WRONG_POC` — is that right?

These are decisions, not code. Each is an hour of your thinking and under an
hour of mine. **Answer them before the numbers are used to manage anybody**,
because changing a definition after three months of history means the history
means something different either side of the change.

---

## 3 · How long, and what it costs to build

### Calendar

| Phase | My time | Your time |
|---|---|---|
| 0 · go live | none | a day, spread over a week |
| 1 · central server | 2–3 working sessions | an hour to buy the box and point DNS |
| 2 · operate | half a session | an afternoon |
| 3 · the open questions | under a session | a few hours of decisions |

"A session" means one continuous run like this one: thirteen commits, 4,108
insertions, every suite green at the end.

### Tokens

Stated honestly, because a precise number here would be invented: I can see a
per-turn budget, not a running total for the conversation. What I can give you
is what drives the cost and how this session compares.

**What a session like this one costs, roughly: 1.5 – 3 million tokens.** The
spread is wide because it depends almost entirely on three things:

1. **Screenshots.** Each image is expensive, and this session read about
   fifteen. They earn it for UI work — the `.locked` CSS collision was only
   ever going to be caught by looking — but a screenshot of an error message
   costs ten times what pasting the text costs.
2. **Re-reading large files.** `views.js` is 2,800 lines, `console.js` 1,854,
   `proxy.mjs` 1,706. Changing something in one of them means reading round it
   first, every time.
3. **Rounds spent on the wrong question.** The migration guard that reported
   "the columns do not exist" on a base where they did cost the better part of
   an hour, twice — once to find it, once because the fix was pulled into the
   wrong clone. Both are now impossible, which is what the build stamps are
   for.

So, by phase:

| Phase | Rough tokens | Why |
|---|---|---|
| 0 · go live | **~0** | You run commands; I read output only if something fails |
| 1 · central server | **3 – 5M** | Nearly twice this session's code, and auth wants more care per line than UI does |
| 2 · operate | **0.5 – 1M** | Mostly scripts and a runbook; little file-reading |
| 3 · open questions | **0.3 – 0.8M** | Each is a small change in a known place, once you decide |
| **Total to a running, centrally-served system** | **~4 – 7M** | |

### How to spend less of it

- **Paste text, not pictures, for anything that is text.** An error, a log, a
  command's output.
- **Batch.** Four asks in one message costs far less than four messages, because
  the reading-round-the-code cost is paid once.
- **Let the tests report.** 22 suites now cover this; "test-signals fails on the
  second case" is cheaper and more precise than a description of the symptom.
- **Phase 0 first.** Real usage will change what Phase 1 should be. Building
  the server before anybody has made a call through the console risks building
  the wrong server well.

---

## 4 · The recommendation, in one line

Do Phase 0 this week and make twenty real calls yourself before anything else is
built — then Phase 1 is a decision made with evidence instead of a guess, and
half the things on this page may turn out not to matter.
