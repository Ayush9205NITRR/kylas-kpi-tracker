# Enout BD Call Console — Chrome extension

An overlay that sits on top of Kylas. Company-first: open it on a company page
and it shows that company's rolled-up state and its contact roster; the data is
entered against contacts, and the company view is derived from them.

## Install

See **[INSTALL.md](../INSTALL.md)** in the repo root for the step-by-step,
including connecting it to Kylas. In short: `chrome://extensions` → Developer
mode → Load unpacked → select this `extension/` folder.

`Alt+Shift+E` or the toolbar button toggles it. **Dock** narrows it to a side
panel (the split collapses to tabs, by design). `Esc` closes the overlay, or
dismisses the shortcut sheet if one is open. `?` lists the shortcuts.

## How it attaches

```
content/inject.js   injects a shadow-root host into the Kylas page
                    → iframe → console/console.html
```

The console runs in an **iframe**, so it has its own document: Kylas' CSS cannot
reach it and it cannot disturb Kylas. The only thing read from the host page is
the record id in the URL:

```
/sales/companies/details/1776620   → company view, queue scoped to its contacts
/sales/contacts/details/<id>       → that contact, scoped to its company
```

No DOM scraping for data, so a Kylas front-end release cannot break the capture.
A company's *display name* is read from the page heading as a convenience only —
if that misses, the heading falls back to `Company <id>` and nothing else changes.
Kylas is a single-page app, so the content script watches for navigation and
retargets the console without a reload.

## What is real and what is not

Real: the layout, the keyboard model, validation, conditional rendering, the
company rollup, and **local persistence** — contacts, drafts and an append-only
call log survive a refresh, held in `chrome.storage.local`.

Not real yet: the contact list is still the seven invented records from the
prototype, and nothing is sent anywhere. No Airtable, no Kylas writes.

**Data → Export JSON** dumps everything captured so far. That is the point of
this build: run it against real calls for a few days, export, and check the shape
before any of it is wired to Airtable or Kylas.

## Company view

Everything in the strip is computed from the contacts held for that company and
moves the moment a call is saved:

| Tile | Rule |
|---|---|
| Total POCs | contacts on the company |
| Connected | stage is not CNC and not one of the initiated stages |
| Right POC | any of event type / budget / timeline / pax filled, past or current |
| Discovery | one complete event row |
| Status of reachout | Fresh ≤ 14 days, Stale beyond, from the last logged call |

These mirror `docs/kpi-spec.md`. The badge next to the company name is the
ladder rung. Once the proxy exists these come from Airtable instead of being
recomputed in the browser, and the rules stop being duplicated.

## Two modes

A switch sits above the roster.

- **Company** — follows the Kylas page you are on. The roster is that company's
  contacts and the strip above shows its rolled-up state. Good for working one
  account.
- **Session** — one flat queue across every company, in call order, ignoring
  which Kylas page is open. `Save & next` crosses company boundaries. This is
  the mode for a dialling run.

Opening the console on a company page starts you in Company mode. The company
strip and scope banner hide in Session mode, since neither applies.

### Call order

Session order is, in turn: anyone due today or overdue (oldest promise first),
then contacts never called, then the rest longest-untouched first. Rows due now
carry a **due** badge.

This is a placeholder for the real priority rule. It lives in one function —
`sessionRank` in `console.js` — so swapping in the V/W score touches nothing
else.

## Keyboard

| Key | Does |
|---|---|
| `1` `2` `3` `4` | Set the call outcome |
| `E` `B` `T` `X` | Jump to event type / budget / timeline / pax on the current row |
| `R` | Jump to the event remarks |
| `C` | Dial the primary number |
| `Enter` | Save and advance |
| `J` `K` | Next / previous in the roster |
| `F` | Flag for cleanup |
| `/` | Search · `?` shortcuts · `Esc` close |

`E`/`B`/`T`/`X`/`R` create the current event row if there is not one yet, so a
connected call never needs the mouse. They are inert while a field has focus.

## Call duration

Three states, kept distinct because a fabricated number would poison the
average-duration metric:

| `durationSource` | Means |
|---|---|
| `dialed` | Dialled from the console — a real measured duration. |
| `estimated` | Dialled elsewhere. Timed from the outcome keypress to the save, and shown in the call bar with a `~` so nobody mistakes it for measured. |
| `none` | Saved with no outcome set. `duration` is `null`, never `0`. |

Wire up telephony (handoff §8.5) and everything becomes `dialed`.

## Data hygiene

- **Duplicates.** Phone numbers are compared on their last 10 digits, so `+91`,
  a trunk `0` and spacing cannot hide a match. A hit shows under the phone field
  with a jump to the existing record. It warns rather than blocks — a shared
  switchboard number is legitimate.
- **Pasted numbers** are normalised on blur: a leading `+91`, a bare `91` or a
  trunk `0` is stripped so it does not double against the country code beside it
  and leave the `tel:` link dialling nothing.
- **Owner** defaults to whoever last picked one and is remembered across
  sessions, so a new contact does not ask again.

## Adding a new contact

`+ New contact` sits in the top bar and above the roster. Inside a company scope
the new POC inherits that company, so it is added *under* the company you are
looking at.

A new record has no Kylas id, so the left pane shows a **New** banner saying so
rather than letting it look like an existing record that failed to load. Name,
phone and owner are required before Save will take it; Save then appends it to
the roster with a **NEW** badge and the company tiles move.

### How it will append to Kylas

The record is marked `pendingCreate`, and its call-log entry carries
`createdHere: true` with an empty `kid`. That flag is the whole signal the
writer needs:

| State | Kylas call |
|---|---|
| has a `kid` | `PUT /v1/contacts/{kid}` |
| `pendingCreate`, no `kid` | `POST /v1/contacts` |

On create, the company is passed as the lookup id already in `companyId` — the
same id that was in the page URL — so the contact lands attached to the right
company with no matching step. Kylas returns the new contact id, the proxy
writes it back to `kid` and clears `pendingCreate`, and the record becomes an
update from then on.

Nothing is sent yet. The flags are recorded now so that when the writer is
added, no record captured in the meantime is ambiguous about whether it needs
creating or updating.

## Files

```
manifest.json          MV3
background.js          relays the toolbar button and Alt+Shift+E
content/inject.js      shadow host, iframe, URL watching, handoff
console/console.html   the console page
console/console.css    the prototype's styles, unchanged
console/color.css      palette — blue primary, violet company, meaning hues
console/overlay.css    overlay chrome and the data sheet
console/console.js     the prototype's logic, plus persistence and company view
console/store.js       chrome.storage / localStorage; swap for the proxy later
console/overlay.js     host messaging, company handoff, the data sheet
```

`console/console.html` also opens directly in a browser tab for testing, falling
back to `localStorage`.

## Known gaps

- Stage, source, salutation and offsite-timeline picklists are still the
  prototype's guesses. Real values come from
  `GET /v1/entities/contact/fields?custom-only=false`.
- The existing Kylas company overlay shows a **MQL** count. The ladder in
  `kpi-spec.md` has no MQL rung — the vocabularies need reconciling.
- Fonts load from Google Fonts. Offline they fall back to the system stack;
  bundle them locally if that matters.
- `duration` is the decorative timer until telephony is wired in.

## Fetching from Kylas

The console holds no API key. It talks to a small proxy that does:

```
extension  ──http──▶  proxy (your machine)  ──https──▶  Kylas
                        holds KYLAS_KEY
```

Start it:

```bash
KYLAS_KEY=... node scripts/proxy.mjs          # listens on 127.0.0.1:8787
```

The badge in the console's top bar shows the link: **Kylas** when connected,
**offline** when not. Click it while offline to point at a different address.

Without the proxy the console still works on whatever it already holds — a dead
proxy degrades to offline, never to a blank screen.

### Routes

| Route | Returns |
|---|---|
| `/health` | whether the key works, and who it belongs to |
| `/company?id=` | the company plus its contacts, already in console shape |
| `/queue?owner=` | every contact for an owner, for session mode |
| `/contact?id=` | one contact, mapped, with the raw record alongside |

The proxy queues every call ~450 ms apart and retries a 429 with a widening
wait, because Kylas throttles even sequential requests. The handlers are plain
functions over `fetch`, so the same code deploys to a Cloudflare Worker with
only the server shell replaced.

### Merging, not replacing

A refetch merges onto what is already held rather than overwriting it. Kylas
owns the contact fields; the overlay keeps `past`, `current`, `vendorInfo`,
`serviceOffering`, `modeOfMeeting`, `nextCallDate`, `flagged` and the rest of
its own. A blank from Kylas never clears a value an associate has typed but not
yet synced.

### Testing it without a key

```bash
node scripts/mock-kylas.mjs                                   # fake Kylas on 9900
KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x node scripts/proxy.mjs
node scripts/test-fetch-live.mjs                              # drives the extension
```

The mock returns the shapes the live probe actually saw, including the awkward
ones: stages as numeric picklist ids, company as a nested object, a contact with
no phone or stage at all, and 429s above four requests a second.
