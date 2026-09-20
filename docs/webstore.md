# Publishing to the Chrome Web Store

## Read this first: which listing, and whether to list at all

**This extension does nothing on its own.** It talks only to
`http://127.0.0.1:8787`, a Node proxy the user runs themselves, holding *their*
Kylas API key and *their* Airtable PAT. A stranger who installs it from a public
listing gets a button that opens a panel saying the proxy is unreachable, and
there is nothing they can do about it — there is no hosted backend to sign into.

That rules out a **Public** listing. Not because review would fail, though it
might, but because the product would not work for anybody who found it.

Three honest options:

| | who can install | needs | good for |
|---|---|---|---|
| **Private** | only your Google Workspace domain | a Workspace account on the developer console | the BD team. **Recommended.** |
| **Unlisted** | anyone with the link, not searchable | nothing extra | a team without Workspace, or a pilot |
| **Load unpacked** | whoever you walk through it | nothing | what you do today |

Private is the right answer for an internal tool: it is the only one where the
audience and the people who can actually run the proxy are the same set.

The rest of this assumes Private or Unlisted.

## One-time setup

1. A **Google account** for the developer registration. Use a shared/company
   one — the listing belongs to whoever registers it, and a personal account
   makes that person a single point of failure.
2. Register at
   [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
   and pay the **one-time $5 USD** fee.
3. For a **Private** listing, the console must be attached to your Google
   Workspace. Under *Account*, set the publisher to the Workspace organisation.
   Without that, Private is not offered and Unlisted is the fallback.
4. **Host the privacy policy at a public URL.** The store requires one and will
   not accept a link to a file in a private repo. `docs/` in this repo is ready
   for GitHub Pages: Settings → Pages → Source `main` (or the current branch),
   folder `/docs`. That serves `docs/privacy.html`. Paste the resulting URL into
   the listing.

## Build the package

```bash
node scripts/gen-icons.mjs        # only if the accent colour changed
sh scripts/package-extension.sh
```

It refuses to build from a dirty tree — a zip built from uncommitted edits is a
version nothing in git can reproduce. It also fails on the things the store
rejects for: missing icons, a description over 132 characters, a reference to
remote code. It prints the permissions you will have to justify on the form.

Output: `dist/enout-bd-call-console-<version>.zip`.

## The listing

**Assets you have to produce** — the store will not let you submit without them:

- **Icon 128×128** — `extension/icons/icon128.png`, already generated.
- **At least one screenshot**, 1280×800 or 640×400, PNG or JPEG. Take these
  against the mock stack, not against live data: a screenshot of the console
  full of real prospects' names and mobile numbers is a disclosure, and it is
  permanent and public once the listing is up. `scripts/mock-kylas.mjs` plus
  `scripts/test-focus-live.mjs --seed` give you invented companies to shoot.
- Small promo tile 440×280 is optional and not needed for Private/Unlisted.

**Fields:**

- *Category*: Workflow & Planning.
- *Single purpose*: one sentence, and it must match what the code does. Suggested:
  > Logs cold-call outcomes and qualification data against contacts in the
  > Kylas CRM, from an overlay on the Kylas web app.
- *Description*: the manifest's 132-character limit applies to the short one;
  the long description should say plainly that a local helper process is
  required, so nobody installs it expecting it to work alone.

**Permission justifications.** The form asks for one per permission. Drafts:

- `storage` — "Holds the call queue, drafts and per-day counters locally, so a
  call in progress survives a page reload. Nothing is sent anywhere."
- `https://app.kylas.io/*` — "The extension's entire purpose: it overlays the
  Kylas CRM web app and reads the record id from the page URL."
- `http://127.0.0.1:*/*` and `http://localhost:*/*` — "The only network
  destination. A helper process on the user's own machine holds the API keys, so
  that no API key is ever shipped inside the extension where anyone who installs
  it could read it."

That last one is the honest answer and also the strongest: putting the keys in
a local process rather than in the bundle is a security decision, not a
workaround, and saying so is better than hoping it goes unnoticed.

**Data-use disclosures.** Tick truthfully: the extension handles *personally
identifiable information* (contact names, phone numbers, emails) and
*user-generated content* (call notes). Then tick that it is **not sold**, **not
used for anything unrelated to the single purpose**, and **not used for
creditworthiness or lending**. `PRIVACY.md` already says all of this.

## Submit

Developer console → **Add new item** → upload the zip → fill the listing →
choose the visibility (Private / Unlisted) → **Submit for review**.

Review is usually days rather than hours, and is slower on a first submission
from a new account. A rejection arrives by email naming the policy clause.

## Updating later

1. Bump `version` in `extension/manifest.json` — the store rejects a re-upload
   of a version it already has.
2. `sh scripts/package-extension.sh`
3. Upload under *Package* → *Upload new package*, then submit again.

Installed copies update themselves within a few hours. **The proxy does not** —
it is a separate process on someone's laptop, and a console newer than its proxy
is the mismatch the staleness banner in `extension/console/api.js` reports. A
release that changes a proxy route needs somebody to restart the proxy too.
