# Installing the call console

About ten minutes. You need **Google Chrome** and **Node 18 or newer**
(`node --version` to check). There is nothing to build and no `npm install` —
the extension has no dependencies.

Two halves, and you need both:

| | Holds | Runs |
|---|---|---|
| **The extension** | the UI | in Chrome |
| **The proxy** | your API keys | in a terminal on your machine |

The keys never enter the browser. That is the whole reason the proxy exists —
an extension's code is readable by anyone who installs it.

---

## Already have an older version installed?

Skip to **[Updating](#updating)** at the bottom. It is three commands.

---

## 1 · Get the code

```bash
git clone -b claude/practical-cray-0y2ep1 \
  https://github.com/Ayush9205NITRR/kylas-kpi-tracker.git
cd kylas-kpi-tracker
```

Note the full path — you need it in the next step:

```bash
pwd          # e.g. /Users/ayushtiwari/kylas-kpi-tracker
```

## 2 · Load it into Chrome

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension`** folder inside the repo —
   `kylas-kpi-tracker/extension`, **not** the repo root

The card should read **Enout BD Call Console 1.5.0**. An older number means a
stale copy is still loaded — remove it, or you will be testing the wrong code.

## 3 · Check the UI loads

Go to any page on **app.kylas.io**. A **Call console** button appears bottom
right.

| | |
|---|---|
| Click the button | opens the console |
| `Option`+`Shift`+`E` | opens or closes it (`Alt`+`Shift`+`E` on Windows) |
| `Esc` | closes it |

It also opens **by itself** on a company or contact page, once per record — if
you dismiss it, it stays dismissed for that record.

Three pages behave differently, by design:

| URL | What you get |
|---|---|
| `/sales/companies/details/…` | the console, scoped to that company |
| `/sales/home` | the dashboard — day, week, month |
| `/sales/companies/list` | accounts, and the focus lists, as two tabs |

At this point it works on **sample data**. It is not talking to Kylas yet.

---

## 4 · Get your keys

**Kylas API key** —
[app.kylas.io/setup/integrations/api-keys/list](https://app.kylas.io/setup/integrations/api-keys/list)

**Airtable PAT** — [airtable.com/create/tokens](https://airtable.com/create/tokens).
It needs these scopes, on the base `appEwJu0bleHh9b8t`:

- `data.records:read`
- `data.records:write`
- `schema.bases:read`
- `schema.bases:write` — only needed for `repair-base.mjs`

Put them in the file the repo already ignores, so they stay out of your shell
history and out of git. There is a template with every variable and its
default:

```bash
cp .env.local.example .env.local
$EDITOR .env.local              # paste the two keys at the top
```

Or write the three required lines directly:

```bash
cat > .env.local <<'EOF'
export KYLAS_KEY=paste_your_kylas_key
export AIRTABLE_PAT=paste_your_airtable_pat
export AIRTABLE_BASE=appEwJu0bleHh9b8t
EOF
```

**`.env.local` is gitignored, so a fresh clone will not have one.** That is the
point of it — the file has never left the machine that made it. If you have
cloned again, look for the old one before issuing new keys:

```bash
find ~ -name .env.local -not -path '*/node_modules/*' 2>/dev/null
```

**You no longer need to `source` it.** Every script reads `.env.local` itself,
searching up from its own directory, so this works from anywhere in the repo:

```bash
node scripts/proxy.mjs
```

`source .env.local && node scripts/proxy.mjs` still works and still wins — a
variable already set in the shell is never overwritten by the file. Keep using
it if you prefer; nothing written down elsewhere has to change.

If a key is missing, the script now names the file it actually read and what
that file set, rather than telling you to set a variable.

> Never paste a key into a chat, a commit, or a screenshot. If one does get
> out, revoke it at the link above and issue a new one — rotating takes a
> minute, and a leaked PAT with `schema.bases:write` can rewrite the base.

## 5 · Bring the Airtable base up to date

The schema gains fields as the KPIs get defined. Check yours matches:

```bash
node scripts/verify-base.mjs
```

`verify-base.mjs` checks names, types, **every formula's text, every rollup's
aggregation and every select's choice list.** It used to check only names and
types, which is how a stale ladder formula sat in the base for weeks under a
clean tick.

If it lists anything **missing**:

```bash
node scripts/repair-base.mjs --dry-run     # read the list first
node scripts/repair-base.mjs               # then apply
node scripts/verify-base.mjs               # confirm
```

If it lists a **FORMULA** as drifted:

```bash
node scripts/repair-base.mjs --update-formulas
```

Not the default, and deliberately so: adding a field is safe, whereas rewriting
a formula changes what every existing row reports. `--dry-run` prints the old
and the new text side by side first.

If a drifted formula is a **KPI Stage**, the stored rank numbers are on the old
ladder too and the formula alone is not enough:

```bash
node scripts/migrate-ladder.mjs            # reads the plan, writes nothing
node scripts/migrate-ladder.mjs --apply
```

See `docs/kpi-spec.md` §9 for why, and for the order to run all of this in.

A **ROLLUP**, a select's **CHOICES** or a wrong **type** cannot be changed
through the Airtable API at all — the update endpoint takes `options.formula`
and nothing else. `verify-base` names them and says so; fix those in the
Airtable UI, or delete the field and re-run `repair-base.mjs` to have it
recreated from the schema.

`repair-base.mjs` also **creates a missing table** — `Focus`, `Focus History`
and `Research` are new, and each is self-contained, so one run makes all three.
A missing table that something links *into* needs a second run: `diffBase` does
not report the fields of a table that does not exist yet, so the link is
invisible to the run that creates it. The script says so when it applies.

Otherwise `repair-base.mjs` only **adds** absent fields, in dependency order,
and only changes an existing one when you pass `--update-formulas`. Read the dry run
before applying anyway — a rollup created before the formula it reads points at
nothing, silently.

## 6 · Start the proxy

```bash
source .env.local && node scripts/proxy.mjs
```

Leave the terminal open — closing it stops the connection. You should see:

```
06:47:27 airtable: appEwJu0bleHh9b8t
06:47:27 proxy on http://127.0.0.1:8787
06:47:27 routes: /meta  /health  /company  /companies  /users  /kpi-debug  /ladder
06:47:27         /focus  /research  /report  /snapshots  /queue  /save  /rca
06:47:27         /rca-answer  /team  /team-save  /targets  /contact
```

**Read the first line.** If it says `airtable: not configured … KPIs will not be
written`, your env vars did not reach the process. Kylas will still work and
saves will still appear to succeed — but nothing reaches Airtable, so no KPI is
computed. This is the most common setup failure and the least visible.

Confirm both halves:

```bash
curl -s http://127.0.0.1:8787/targets
# {"kylas":true,"airtable":true,"base":"appEwJu0bleHh9b8t"}
```

Both must be `true`.

Now reload the Kylas tab. The badge in the console's top bar should read
**Kylas**, and a company page loads its real contacts.

## 7 · One real save

Open a company, pick a contact, set a stage, hit **Save**. Then look at the
Airtable **Companies** row.

The proof is not that the contact appeared. It is that **`Last Call At`,
`Right POC Contacts`, `Discovery Contacts` and `KPI Stage` populated by
themselves** — those are rollups over the contact, with nothing typed at company
level. That is the thing this whole design is for.

> A Kylas **call log cannot be deleted through the API**. Use a contact you do
> not mind leaving a stray log on.

---

## 7b · One-off repairs, if you are upgrading an existing base

Two faults were found by running the console end to end on 2026-09-19. The code
is fixed; these repair rows written before it. Both are dry by default and both
are safe to run twice.

```bash
source .env.local
node scripts/seed-transitions.mjs          # read the plan
node scripts/seed-transitions.mjs --apply
node scripts/migrate-ever-picked.mjs       # read the plan
node scripts/migrate-ever-picked.mjs --apply
```

**Order matters.** `migrate-ever-picked` decides whether a contact ever
answered by looking for a connected stage in Stage Transitions. If the console
logged calls before it wrote transitions, that evidence is missing, and a
contact who answered in July and has since drifted back down the Could Not
Connect ladder gets wrongly cleared. `seed-transitions` rebuilds the missing
history from Call Log, which recorded `Stage Set` on every save all along —
Kylas itself has no stage history to give, so this is the only real source.

Seeding back-fills real arrivals, so **past weeks in the report will gain
numbers**. That is the correction, not a side effect: the arrivals happened,
nothing was recording them. The current week is unaffected.

## 8 · Schedule the background jobs

Three jobs keep the base current and bounded. They run on whichever machine
holds `.env.local` — the same one that runs the proxy, or a small server if you
would rather it not depend on somebody's laptop being open.

```bash
scripts/cron.sh sync          # run each one by hand FIRST
scripts/cron.sh snapshot
scripts/cron.sh rollup
cat logs/sync.log             # everything they print lands here
```

Then install the schedule. It prints what it would do and changes nothing until
you add `--apply`:

```bash
scripts/install-cron.sh
scripts/install-cron.sh --apply
```

| when (local time) | job | what it does |
|---|---|---|
| 00:30 daily | `snapshot` | freezes yesterday for the trend chart |
| 01:00 daily | `sync` | Kylas → Airtable |
| 13:00 daily | `sync` | again, so afternoon CRM edits reach the console |
| 02:00 Sunday | `rollup` | Call Log retention, after that night's sync |

`--remove` takes it back out. It edits only its own marked block, so other
entries in your crontab are left alone.

**Retention is 30 days of raw calls, not the script's own default of 90.** At
1,200 calls a day, 90 days is ~54,000 rows and Airtable counts records across
the whole base — over a Team base before a single contact. Change it with
`export CALL_RETAIN_DAYS=45` in `.env.local`; `scripts/rollup-calls.mjs` prints
the projected steady state every run, so you can see whether the window still
fits as the team grows.

### If a job stops running

The dashboard shows how old the mirror is, and the companies list says when it
is short — a sync that has quietly died shows up there rather than as numbers
that are subtly out of date. For the detail:

```bash
tail -40 logs/sync.log
```

Three failures worth knowing, because they are the ones that happen:

- **`node not found`** — cron's PATH is not your shell's. `install-cron.sh`
  pins `NODE_BIN` into `.env.local` when it spots this, but if you installed
  node afterwards, add `export NODE_BIN=$(which node)` yourself.
- **`already running (lock held)`** — a previous run overran its slot. Normal
  once; every night means the sync is taking longer than twelve hours and
  wants looking at.
- **`.env.local is missing: …`** — the file is there but a key is not.

---

## Updating

```bash
cd kylas-kpi-tracker
git fetch origin
git checkout claude/practical-cray-0y2ep1     # once; `git pull` after that
source .env.local && node scripts/verify-base.mjs     # schema may have moved
```

`verify-base` is the one that decides how much work this is. Read what it
says before running anything else:

| it says | do |
|---|---|
| `Everything in the schema is present` | nothing — go straight to the restarts below |
| `MISSING TABLE Focus` / `Focus History` / `Research` | `node scripts/repair-base.mjs --dry-run`, read it, then without the flag |
| `MISSING TABLE` for anything else | the same, then **run `repair-base.mjs` a second time** — a link into a table that did not exist is invisible to the run that creates it |
| a **FORMULA** drifted | `node scripts/repair-base.mjs --update-formulas` |
| a drifted formula named **KPI Stage** | that, then `migrate-ladder.mjs` and `migrate-ladder.mjs --apply` — the stored ranks are on the old ladder too |
| a **ROLLUP**, **CHOICES** or a wrong **type** | the Airtable UI; the update endpoint takes only `options.formula` |

Then `verify-base.mjs` again, and do not go on until it is clean. A console
writing to a field the base does not have reports the write as succeeding.

**Restart the proxy too.** Press `Ctrl-C` in the terminal it is running in,
then start it again. It
does not reload its own code, so a new route does not exist in a process
started before it was written — `/focus` and `/research` are new in 1.5.0, and
an old proxy answers both with a 404 that reads in the console as "could not
record that".

Then in Chrome: `chrome://extensions` → the **refresh arrow** on the card →
reload the Kylas tab.

All three matter, and skipping one is the usual reason an update "does not do
anything". Chrome serves the old console until you hit the refresh arrow, the
proxy keeps running the code it started with, and a new version may expect
Airtable fields the base does not have yet.

---

## Troubleshooting

**"Manifest file is missing or unreadable"**
You selected the repo root. Select the `extension` folder inside it.

**Card shows an older version**
Chrome is showing a stale copy. Hit the refresh arrow; if it persists, **Remove**
and **Load unpacked** again.

**No button on the Kylas page**
The extension only runs on `app.kylas.io`. A newly installed extension does not
appear in tabs that were already open — reload the tab.

**Badge says offline**
Not broken: the console keeps working on what it already holds, it just cannot
fetch or write. Check the proxy terminal is still open, then:

```bash
curl http://127.0.0.1:8787/health      # expect {"ok":true,...} with your name
```

**"Port 8787 is already taken"**
An older proxy is still running. It keeps answering the extension with the code
and key it started with, so the console can look broken in ways that have
nothing to do with your setup — a stale process is why a valid key once read as
"Invalid API key". Stop it, then start again:

```bash
kill $(lsof -t -iTCP:8787 -sTCP:LISTEN)
```

```bash
source .env.local && node scripts/proxy.mjs
```

Or run the new one elsewhere and click the offline badge to point the console
at it:

```bash
source .env.local && PORT=8788 node scripts/proxy.mjs
```

**Proxy exits with "Set KYLAS_KEY"**
The key did not reach it. Did you `source .env.local` in *this* terminal? Each
new terminal needs it again.

**Saves succeed but Airtable stays empty**
Check the proxy's first line and `/targets`, as in step 6. If both say Airtable
is configured, look at the save's response — a failed Airtable write is
reported as `airtableError` rather than hidden, so the message will say why.

---

## Trying it without touching production

The full write path against fake APIs — no real keys, your real data untouched:

```bash
node scripts/mock-kylas.mjs        # terminal 1, :9900
node scripts/mock-airtable.mjs     # terminal 2, :9901

# terminal 3
KYLAS_KEY=test KYLAS_BASE=http://127.0.0.1:9900 KYLAS_GAP=50 \
AIRTABLE_PAT=pattest AIRTABLE_BASE=appTEST \
AIRTABLE_BASE_URL=http://127.0.0.1:9901 AIRTABLE_GAP=50 \
node scripts/proxy.mjs
```

The mocks reproduce the awkward parts of the real APIs on purpose — stage as
both id and code, company as a bare id, `idNameStore`, rate limits above 5
requests a second. Passing here is not passing because the mock is lenient.

Inspect what was written:

```bash
curl -s http://127.0.0.1:9900/__writes -H 'api-key: x'             # Kylas side
curl -s http://127.0.0.1:9901/__writes -H 'Authorization: Bearer x' # Airtable side
```

No-credential checks, any time:

```bash
node scripts/validate-schema.mjs     # 6 tables, 101 fields, consistent
node scripts/test-validator.mjs      # 10/10 faults caught
```

---

## What it does now

**Does:** loads companies and contacts from Kylas · captures calls, duration and
event detail · **writes back to Kylas**, into the remarks field between markers,
creating no custom field · **writes the granular data to Airtable**, where the
company KPIs are computed by rollup · dashboard by day, week and month ·
filterable companies list · queues saves when offline and drains them when the
connection returns.

**Does not yet:** click-to-call. The phone number is a `tel:` link, so call
duration is entered by hand unless the dialler supplies it.

`scripts/test-*-live.mjs` are Playwright harnesses written for a Linux
container. They hardcode paths and will not run on macOS as they stand — the
newest, `test-focus-live.mjs`, also needs `channel:'chromium'`, because
Playwright's bundled build does not load MV3 extensions and the symptom is not
an error but a frame that never appears.

The no-credential checks in the list above do run anywhere, and
`scripts/test-schema-diff.mjs` needs full git history — it fails on a shallow
clone with `invalid object name`, which is the clone and not the code.
