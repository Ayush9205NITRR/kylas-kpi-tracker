# Putting the proxy in the cloud

Step by step, from nothing to a working server. About an hour, most of it
waiting for DNS.

**What you end up with.** The proxy runs on Cloudflare instead of on a laptop.
There is no machine to keep awake, nothing to patch, and nothing to restart.
Your team installs the Chrome extension and signs in once; after that they do
nothing. Start on the free tier — see part 2 — and expect either $0 or $5 a
month.

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

## Part 2 · Stay on Free

**There are two different "plans" in Cloudflare and it is easy to pay for the
wrong one.**

The plan chooser you meet when adding a domain — Free / Pro $20 / Business
$200 — is the plan for the **website**. It sells firewall rules, image
optimization and CDN tuning. None of this uses any of them. **Choose Free.**
Its own description lists what matters here: Workers, D1, DNS and SSL
included.

The **Workers** paid plan is a separate $5/month, and you probably do not need
that either. An earlier version of this guide said you did, because the
duplicate-guard was going to live in KV, which allows only 1,000 writes a day
— about a third of what this team produces. It lives in D1 now, chosen for
correctness rather than cost, and D1's free allowance is far above ~1,600
saves a day.

So deploy on Free and let the system tell you if it needs more. The one limit
that might eventually bite is processing time on the heaviest dashboard
queries; Cloudflare reports that plainly when it happens, and $5 fixes it
that day. Paying in advance for a ceiling you may never reach is not
prudence.

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

## Part 6 · Put the login in front

Dashboard → **Zero Trust** → **Access** → **Applications** → **Add an
application** → **Self-hosted**.

1. **Application name**: `BD Call Console`
2. **Session duration**: 24 hours is reasonable. Shorter means signing in more.
3. **Domain**: `bd.enout.website`
4. Add a policy:
   - **Name**: `Enout staff`
   - **Action**: Allow
   - **Include** → **Emails ending in** → `@enout.in`
5. Under **Settings → CORS**, allow your extension's origin
   (`chrome-extension://…`), allow credentials, and allow the `GET`, `POST`
   and `OPTIONS` methods. Without this the browser blocks the extension before
   the request is even sent.

**How people sign in.** If you have Google Workspace on enout.in, add Google
as an identity provider under **Settings → Authentication** and they click
"Sign in with Google". If you do not, Cloudflare's built-in **One-time PIN**
needs no setup at all — it emails a six-digit code. Either is fine.

Test it: open `https://bd.enout.website/health` in a browser. You should be
asked to sign in, and afterwards see the JSON.

---

## Part 7 · Update the extension

The published extension only knows how to talk to a laptop. One line changes.

1. In `extension/manifest.json`, add `"https://bd.enout.website/*"` to
   `host_permissions`, and raise `version`.
2. Build it: `scripts/package-extension.sh`
3. Upload the zip at **chrome.google.com/webstore/devconsole** → your item →
   **Package** → **Upload new package**, and submit.
4. Review usually takes a few days. Updates are faster than first submissions.

While you wait, everything keeps working on localhost exactly as it does now.

When the update ships, each associate clicks the connection badge in the
console once and points it at `https://bd.enout.website`. After that it is
remembered.

---

## Part 8 · Check it properly

With the extension updated and signed in:

1. Open a company in Kylas. The console should fill with contacts.
2. Log a call on a test contact. It should say saved.
3. Confirm it in Kylas and in Airtable.
4. **Close your laptop's proxy entirely** (`kill` it) and log another call. It
   should still work. That is the whole point of this exercise.

---

## When it goes wrong

**`curl` returns 404 rather than 403.** The custom domain did not attach. Check
`routes` in `wrangler.toml` matches the domain, and that part 1 says Active.

**500, "No DB (D1) or KV binding".** The `database_id` in `wrangler.toml` is
wrong or still says FILL ME. The server refuses to start rather than keep the
duplicate-guard in memory, where a restart would lose it.

**500, "Set KYLAS_KEY".** The secret did not save. Run
`npx wrangler secret list` to see what it actually has.

**The console says offline, but `curl` works.** Almost always the CORS settings
in part 6.5, or an `ALLOWED_ORIGIN` that does not match your real extension id.

**Saves work but the dashboard is empty.** Unrelated to hosting — the Airtable
base has not had `repair-base.mjs` run on it.

**Seeing yesterday's behaviour.** Compare the `version` in `/health` with the
extension's. They come from the same number, so a mismatch means the deploy
did not land.

---

## What is not done yet

Honest list, so nothing is a surprise:

1. **The nightly jobs do not run on Cloudflare yet.** The sync, the call-log
   rollup and the snapshot are still scripts that need a machine. They are
   written into `wrangler.toml` as commented-out schedules, and they stay
   commented out until the jobs themselves are ported — a cron firing into a
   Worker that cannot answer it produces a daily failure and no sync. **Until
   then, keep running them wherever they run now.**
2. **The Access token's signature is not verified.** `REQUIRE_ACCESS` checks
   the assertion is *present*, which catches a misconfigured route or a DNS
   record pointing past the login. It would not stop someone who could reach
   the Worker's origin directly. So do not publish this on a second hostname
   that bypasses Access.
3. **Nobody has run this against a live Kylas account.** Every "it works" above
   means "it works against the mocks, verified by a test" — a real bar, since
   the mocks reproduce Kylas' rate limiting and Airtable's rejections, but not
   the same as your account.
