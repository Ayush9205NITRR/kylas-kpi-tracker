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

## Already have 0.1.0 installed?

Skip to **[Updating](#updating)** at the bottom. It is three commands.

---

## 1 · Get the code

```bash
git clone -b claude/adoring-feynman-chhiyt \
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

The card should read **Enout BD Call Console 0.3.0**. An older number means a
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
| `/sales/companies/list` | the filterable companies list |

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
history and out of git:

```bash
cat > .env.local <<'EOF'
export KYLAS_KEY=paste_your_kylas_key
export AIRTABLE_PAT=paste_your_airtable_pat
export AIRTABLE_BASE=appEwJu0bleHh9b8t
EOF
```

> Never paste a key into a chat, a commit, or a screenshot. If one does get
> out, revoke it at the link above and issue a new one — rotating takes a
> minute, and a leaked PAT with `schema.bases:write` can rewrite the base.

## 5 · Bring the Airtable base up to date

The schema gains fields as the KPIs get defined. Check yours matches:

```bash
source .env.local
node scripts/verify-base.mjs
```

If it lists anything missing:

```bash
node scripts/repair-base.mjs --dry-run     # read the list first
node scripts/repair-base.mjs               # then apply
node scripts/verify-base.mjs               # confirm
```

Expect `✓ Companies 19/19` and `✓ Contacts 36/36`.

`repair-base.mjs` only **adds** absent fields, in dependency order. It changes
nothing already there. Read the dry run before applying anyway — a rollup
created before the formula it reads points at nothing, silently.

## 6 · Start the proxy

```bash
source .env.local && node scripts/proxy.mjs
```

Leave the terminal open — closing it stops the connection. You should see:

```
06:47:27 airtable: appEwJu0bleHh9b8t
06:47:27 proxy on http://127.0.0.1:8787
06:47:27 routes: /meta  /health  /company  /queue  /save  /targets  /contact
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

## Updating

```bash
cd kylas-kpi-tracker
git pull
source .env.local && node scripts/verify-base.mjs     # schema may have moved
```

**Restart the proxy too** — `Ctrl-C` in its terminal, then start it again. It
does not reload its own code, so a new route (like `/companies`) does not exist
in a process started before it was written.

Then in Chrome: `chrome://extensions` → the **refresh arrow** on the card →
reload the Kylas tab.

All three matter. Chrome caches the old code until you hit refresh, the proxy
keeps running whatever it started with, and a new version may expect Airtable
fields the base does not have yet. If `verify-base` lists anything missing, run
`repair-base.mjs` as in step 5.

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

Port already in use? Run it elsewhere and click the offline badge to point the
console at the new address:

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
container. They hardcode paths and will not run on macOS as they stand.
