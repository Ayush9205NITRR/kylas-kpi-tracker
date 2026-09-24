# Putting the proxy in the cloud

Step by step, from nothing to a working server. About an hour, most of it
waiting for DNS.

**What you end up with.** The proxy runs on Cloudflare instead of on a laptop.
There is no machine to keep awake, nothing to patch, and nothing to restart.
Your team installs the Chrome extension and signs in once; after that they do
nothing. Cost: the Cloudflare zone is Free; the **Workers Paid plan ($5 a
month) is required** — see part 2.

**What is verified.** Everything in parts 1–5 has been built and run against
Cloudflare's real runtime (`workerd`) with a real D1 database — including the
case that matters most: the same save sent twice creates one contact, not two.
What has *not* been tested is your account, your domain and your DNS, which is
what parts 1, 6 and 7 are about.

---

## Before you start

| | |
|---|---|
| A domain you own | `enout.website` — you have this |
| A Cloudflare account | free to create, and the Free plan is the right one |
| Node on your machine | `node --version` should print 20 or higher |
| Your Kylas API key | app.kylas.io → Setup → Integrations → API Keys |
| Your Airtable token | the one already in your `.env.local` |
| Your extension's ID | `chrome://extensions`, with Developer mode on |

**Never paste the Kylas key or the Airtable token into a chat, a commit, or a
screenshot.** Part 4 puts them in from your own terminal. If one has ever been
pasted anywhere, treat it as burned and issue a new one.

---

## Part 1 · Point the domain at Cloudflare

The login gate cannot be attached to a free `*.workers.dev` address, so this
step is not optional.

1. Sign in at **dash.cloudflare.com** and click **Add a domain**.
2. Enter `enout.website`. Choose the **Free** plan.
3. Cloudflare reads your existing DNS records and shows them. Check nothing is
   missing — especially mail records if that domain receives email.
4. It shows you two nameservers. Go to wherever you bought the domain and
   replace the existing nameservers with those two.
5. Wait. Usually minutes, occasionally a few hours. Cloudflare emails you when
   it is active, and the dashboard says **Active**.

Do not continue until it says Active.

---

## Part 2 · Which plans

**There are two different "plans" in Cloudflare and it is easy to pay for the
wrong one.**

The plan chooser you meet when adding a domain — Free / Pro $20 / Business
$200 — is the plan for the **website**. It sells firewall rules, image
optimization and CDN tuning. None of this uses any of them. **Choose Free.**
Its own description lists what matters here: Workers, D1, DNS and SSL
included.

The **Workers Paid** plan ($5/month, Workers & Pages → Plans) IS needed. An
earlier version of this guide said deploy on Free and wait to be told; that
was wrong, and the Dashboard is what proved it. Building the team report reads
every row of four Airtable tables — around a hundred requests to Airtable at
this team's size — in one request, and the Free plan allows 50 outbound
requests and 10 ms of processing per request. On Free the report cannot be
built at all. Paid raises both far past what this needs.

What $5 does not change: the report still takes up to a minute to build from
Airtable. The Worker keeps the finished report in the D1 database and shares
it for `REPORT_TTL_MS` (15 minutes), so one person per window waits for it and
everyone else gets it at once. D1 and the save journal fit in the included
allowance.

---

## Part 3 · Create the database

From the repository folder:

```sh
npx wrangler login
npx wrangler d1 create enout-bd
```

The first opens a browser to authorise. The second prints something like:

```
database_id = "a1b2c3d4-...."
```

**Copy that id.**

This database holds one thing: the record of which contacts have already been
created in Kylas. It is what stops a retry after a dropped connection creating
the same person twice.

---

## Part 4 · Fill in the config

Open `wrangler.toml`. Three lines say `FILL ME`:

```toml
database_id = "paste the id from part 3"
ALLOWED_ORIGIN = "chrome-extension://your-extension-id"
AIRTABLE_BASE = "appXXXXXXXXXXXXXX"
```

- **database_id** — from part 3.
- **ALLOWED_ORIGIN** — your extension's id from `chrome://extensions`. This is
  the only origin the server answers; anything else is refused by the browser.
- **AIRTABLE_BASE** — the `app…` id, the same one in your `.env.local`.

Leave `REQUIRE_ACCESS = "1"` alone. Setting it to `0` serves your CRM to
anyone who finds the address.

Now the two secrets, one at a time. Each command prompts, you paste, it goes
straight to Cloudflare encrypted:

```sh
npx wrangler secret put KYLAS_KEY
npx wrangler secret put AIRTABLE_PAT
```

These never enter `wrangler.toml`, which is committed to git. A secret written
into a file is in the repository history for ever, and the only cure is a new
key.

---

## Part 5 · Deploy

```sh
npx wrangler deploy
```

It prints the address it published to. Check it is alive:

```sh
curl https://bd.enout.website/health
```

Expect `{"error":"not authenticated"}` with status 403. **That is success** —
the server is running and correctly refusing anyone who has not signed in. You
have not set up the sign-in yet, which is part 6.

If you get anything else, see *When it goes wrong* below.

---

## Part 6 · Sign-in with Google

Cloudflare Access would have done this, but it asks for a card on file even on
its free tier. So the Worker checks identity itself: the extension signs the
associate in with Google, and the Worker verifies the resulting token against
Google's published keys. Nothing to pay for, and nobody has to install
anything.

At **console.cloud.google.com**, with a project selected:

**Branding** — app name `Enout BD Call Console`, your address as support
email.

**Audience** — **Internal** if you have Google Workspace on enout.in: only
your organisation can sign in, and there is no warning screen. **External**
otherwise, with each associate added under Test users; it works, but they each
click past a "Google hasn't verified this app" screen once.

**Data Access → Add or remove scopes** — add `openid`,
`.../auth/userinfo.email` and `.../auth/userinfo.profile`. All non-sensitive,
so no Google review.

**Clients → Create client**
- Application type: **Web application** — NOT "Chrome Extension". The Worker
  verifies a signed ID token, which is the web sign-in flow; a Chrome
  Extension client returns an opaque access token that the verifier rejects.
- Authorized redirect URI, exactly, trailing slash included:
  `https://infkkmfegekmocfgjlhahdlheccojkdb.chromiumapp.org/`

That address is Chrome's own callback for extension sign-in, derived from the
extension's id.

Copy the **Client ID** into `GOOGLE_CLIENT_ID` in `wrangler.toml` — already
done for the current one. It is not a secret: it names the application rather
than authorising anything, and its job is to be the value every token is
checked against, so that a Google token minted for somebody else's app cannot
be used as a login here. The client **secret** beside it is not used and
should not be copied anywhere.

Redeploy after any change here: `npx wrangler deploy`.

## Part 7 · Update the extension

The published extension only knows how to talk to a laptop. One line changes.

1. Already done: `host_permissions` carries `https://bd.enout.website/*`, the
   `identity` permission is added, and the version is 1.7.0.
2. Build it: `scripts/package-extension.sh`
3. Upload the zip at **chrome.google.com/webstore/devconsole** → your item →
   **Package** → **Upload new package**, and submit.
4. Review usually takes a few days. Updates are faster than first submissions.

While you wait, everything keeps working on localhost exactly as it does now.

When the update ships, each associate clicks the connection badge in the
console once and points it at `https://bd.enout.website`. After that it is
remembered, and opening the console asks them to sign in with Google — once,
then silently for as long as their Google session lasts.

---

## Part 8 · Check it properly

With the extension updated and signed in:

1. Open a company in Kylas. The console should fill with contacts.
2. Log a call on a test contact. It should say saved.
3. Confirm it in Kylas and in Airtable.
4. **Close your laptop's proxy entirely** (`kill` it) and log another call. It
   should still work. That is the whole point of this exercise.

---

## Part 9 · Fill Airtable from Kylas, once

**Why.** The console reads companies and contacts from Airtable, not Kylas:
Airtable (and the copy of it in D1) answers in milliseconds, and Kylas'
search is rate-limited and slow. Airtable is only worth reading once the
Kylas sync has filled it. On 2026-09-24 the base held **3 companies and 4
contacts**, which are the ones the console wrote itself. The sync had never
run. Until it does, the console lists companies straight from Kylas, which is
correct but is the slow path.

The nightly cron runs the sync, but the **first** run copies the whole account
and is too big for one Worker invocation. Run that first one from your laptop,
in the project folder, where `.env.local` already holds the keys:

```
node --env-file=.env.local scripts/sync-kylas.mjs            # dry run: prints what it would write
node --env-file=.env.local scripts/sync-kylas.mjs --apply    # writes it
```

**Read the dry run's counts before `--apply`.** Every Kylas company and
contact becomes an Airtable record, and Airtable caps records per base by plan
(the Free plan is 1,000; paid plans are much higher). Check the limit in your
workspace's billing page. If the counts exceed it, stop and ask; do not apply.

If `--apply` is interrupted, run it again. It writes oldest-first and resumes
from where it stopped.

After that the nightly cron keeps it current: a night's changes are small.
Within five minutes of the apply finishing, the maintenance cron has copied
the base into D1 and the Dashboard lists companies from it. To check, open the
Dashboard: its company count should match Kylas. `npx wrangler tail` also
shows each table's `mirror: … built — N row(s)` line.

---

## How reads stay fast (for whoever maintains this)

- **The D1 copy of Airtable** (`scripts/mirror.mjs`). Every table the console
  reads lives in D1 as well. Requests read D1 and never page through Airtable.
  It stays current in three ways:
  - every write this server makes is copied in as it happens;
  - every 5 minutes, while someone is using the console, it picks up edits
    made elsewhere;
  - after the nightly sync it rebuilds everything.
- **Kylas answers** (who the key belongs to, picklists, the company crawl)
  are kept in D1 too, and shared by every instance.
- **The `*/5 * * * *` cron** does all the refreshing. When nobody has used
  the console for an hour, it makes no outside request at all.
- **`/cache-status`** says how many rows each table holds, how old each copy
  is, when the sync last ran, and how many saves are queued, done or dead.

## How saves stay fast (1.16)

- **Answered as soon as they are stored.** A save goes into a queue in D1
  (`scripts/save-queue.mjs`) and the console gets its reply in about 10 ms.
  Kylas and Airtable receive it behind the reply, in the same couple of seconds
  as before; nobody waits for that part any more.
- **Saves for one contact run in order, one at a time**, so a new contact is
  created in Kylas exactly once however fast the saves come.
- **Failures:**
  - A value Kylas refuses (400/404/409/422) is final. The console shows it on
    the row.
  - Anything else is retried from the 5-minute job: at 1 min, 5 min, 15 min,
    1 h, 3 h and 6 h, then given up and reported on the row.
- **The console asks how each save went.** It polls `/save-status` and fills in
  the Kylas id, or the reason a save failed, when it arrives. It remembers what
  it is waiting for, so closing the console loses nothing.
- **Consoles older than 1.16** don't send `queue: true`, so they still get the
  finished save in the reply, exactly as before.

---

## When it goes wrong

**`curl` returns 404 rather than 403.** The custom domain did not attach. Check
`routes` in `wrangler.toml` matches the domain, and that part 1 says Active.

**500, "No DB (D1) or KV binding".** The `database_id` in `wrangler.toml` is
wrong or still says FILL ME. The server refuses to start rather than keep the
duplicate-guard in memory, where a restart would lose it.

**500, "Set KYLAS_KEY".** The secret did not save. Run
`npx wrangler secret list` to see what it actually has.

**500, "AUTH is not set".** Deliberate: there is no default, because a server
holding these credentials must not be one forgotten variable away from being
open. Set `AUTH` in `wrangler.toml` and redeploy.

**401 "not signed in" in the console.** The token was refused. The reason is
in the Worker's log rather than the response — deliberately, since naming the
failed check helps whoever is probing as much as whoever is debugging. Run
`npx wrangler tail` and look for `! auth refused:`. The usual causes are a
`GOOGLE_CLIENT_ID` that does not match the one the extension was built with,
and an address outside `ALLOWED_EMAIL_DOMAIN`.

**The console says offline, but `curl` works.** Almost always the CORS settings
in part 6.5, or an `ALLOWED_ORIGIN` that does not match your real extension id.

**The Dashboard lists only a handful of companies, or opens slowly.** The
Kylas sync has never filled Airtable (part 9). Until it has, the list comes
from a Kylas crawl that the 5-minute cron refreshes.

**Numbers look a few minutes behind an edit made directly in Airtable.**
Expected. Edits made outside the console reach the copy within about ten
minutes. Rollup changes caused by those edits reach it after the nightly
rebuild. Saves made in the console show at once.

**Saves work but the dashboard is empty.** Unrelated to hosting — the Airtable
base has not had `repair-base.mjs` run on it.

**A nightly job never runs.** The schedules live in two places in
`wrangler.toml` — `[triggers] crons` and the `CRON_*` vars that say which job
each one is — and they must match character for character. A mismatch is not
an error: the job simply never happens. The Worker logs `! cron "..." matches
no job` along with all three settings, so `npx wrangler tail` names it.

**Seeing yesterday's behaviour.** Compare the `version` in `/health` with the
extension's. They come from the same number, so a mismatch means the deploy
did not land.

---

## What is not done yet

1. **Nobody has run this against a live Kylas account.** Everything verified
   means "verified against the mocks, by a test" — a real bar, since the mocks
   reproduce Kylas' rate limiting and Airtable's rejections, and the Worker
   itself was run on Cloudflare's own runtime against a real D1 database. It
   is still not your account.
2. **The subrequest ceiling has not been met in anger.** A Worker may make a
   limited number of outbound requests per invocation — far fewer on the free
   plan than on the paid one — and a full Kylas crawl is dozens of pages plus
   an Airtable write per ten rows. The nightly sync is incremental, so an
   ordinary night is small; the run that will find the ceiling is the FIRST
   one, or one after a long outage. If a scheduled run fails with a limit
   error, the $5 plan raises it by twenty times, and the fix after that is to
   make the job resume across invocations rather than finish in one.
3. **The Airtable base has never had `repair-base.mjs` run on it.** Still
   costing you on every save: `Phones` is dropped, the `RCA` and `Team` tables
   do not exist, and every company open scans the whole Contacts table for
   want of a rollup. The sync no longer dies without it — a missing watermark
   column is treated as "we have nothing yet" — but it will do a full pull
   every night instead of an incremental one until you run it.
