# Kylas API — what the Postman collection establishes

Source: `docs/Kylas_APIs_Public.postman_collection.json`. Base URL `https://api.kylas.io`.
Auth is a single `api-key` header (key issued at
`app.kylas.io/setup/integrations/api-keys/list`). There is also
`PUT /v1/users/login?view=access-token` for user-credential access tokens.

Everything below is read off the collection. Anything marked **verify** needs one
call against a live key before it is load-bearing.

---

## 1. Endpoints that matter for the console

### Contacts
| Purpose | Call |
|---|---|
| Create | `POST /v1/contacts` |
| Read | `GET /v1/contacts/{id}` |
| Update | `PUT /v1/contacts/{id}` |
| Search | `POST /v1/search/contact?sort=updatedAt,desc&page=0&size=10` |
| Field schema incl. custom | `GET /v1/entities/contact/fields?entityType=contact&custom-only=false` |
| Create a custom field | `POST /v1/entities/contact/fields?entityType=contact` |

Contact body carries `salutation` (picklist **id**, e.g. `1751`), `firstName`,
`lastName`, `designation`, `department`, `company` (lookup **id**, e.g. `894`),
`linkedin`, `emails[] {type, value, primary}`,
`phoneNumbers[] {type, code, dialCode, value, primary}`, `dnd`, `stakeholder`,
and `customFieldValues` as a flat `{fieldName: value}` map.

Types are upper-case enums: `OFFICE`/`PERSONAL`, `MOBILE`/`WORK`/`HOME`.
The prototype uses title case — needs a mapping layer.

### Search — this is the queue engine
`POST /v1/search/contact` takes a `fields[]` projection (including
`customFieldValues`) plus a `jsonRule` query-builder tree:

```json
{ "fields": ["firstName","lastName","ownerId","company","designation","id","customFieldValues"],
  "jsonRule": { "condition": "AND", "valid": true,
    "rules": [ { "id":"multi_field","field":"multi_field","type":"multi_field",
                 "input":"multi_field","operator":"multi_field","value":"vishnu" } ] } }
```

`multi_field` is free-text search across the record. Per-field rules with real
operators are what the queue ordering needs — **verify** the operator vocabulary
(`equal`, `in`, `less`, `between`, …) and that `ownerId` / date fields are
filterable. Page size up to 100 is used elsewhere in the collection.

### Call logs — native, and better than expected
| Purpose | Call |
|---|---|
| Create | `POST /v1/call-logs/` |
| Update | `PATCH` or `PUT /v1/call-logs/{id}` |
| Fetch for a contact | `GET /v1/call-logs/{contact_id}?relatedToType=contact` |

```json
{ "outcome": "connected", "callType": "outgoing",
  "startTime": "2022-09-02T08:05:44.370Z", "duration": "420",
  "phoneNumber": "9848022338",
  "notes": [ { "description": "..." } ],
  "relatedTo": { "entity": "contact", "id": 112936, "phoneNumber": "9848022338" },
  "callRecording": { "url": "...", "fileName": "...", "data": "" } }
```

This maps one-to-one onto the console's call bar: outcome buttons → `outcome`,
the timer → `startTime` + `duration`, remarks → `notes[]`. **Verify** the allowed
`outcome` values — the four console outcomes must map onto them.

### Webhooks
`POST /v1/webhooks/` with `{name, requestType, url, authenticationType,
authenticationKey, events[], active}`. Events confirmed present in the collection:
`CONTACT_CREATED`, `CONTACT_UPDATED`, `CONTACT_DELETED` (and the LEAD_/DEAL_
equivalents). Auth types beyond `NONE` exist — **verify** which, so the receiver
can be authenticated.

### Supporting
- `GET /v1/users/me`, `GET /v1/users/{id}` — owner list and identity.
- `GET /v1/fields/{field_id}` — standard picklist values.
- `POST /v1/tasks/` — `{type, status, reminder, assignedTo, dueDate, name}`.
- `POST /v1/notes/relation` — notes against a record.
- `GET /v1/pipelines/search` — pipelines and their stage ids.

---

## 2. The one blocking modelling question

**Pipelines and stages are a Lead/Deal concept, not a Contact concept.**
Stage changes go through `POST /v1/leads/{id}/pipeline-stages/{stageId}/activate`.
There is no contact equivalent anywhere in the collection.

So `Pipeline Stage - BD` is one of:

- **(a)** a custom picklist field on Contact, set via `customFieldValues` on
  `PUT /v1/contacts/{id}` — the console stays contact-shaped, §4 of the handoff
  holds, outcome buttons are a plain field write; or
- **(b)** these records are actually **Leads** in Kylas, in which case every
  endpoint above shifts to `/v1/leads/*`, stage changes use the `activate` call,
  and `POST /v1/leads/{id}/convert` matters once a lead qualifies.

Both are buildable and roughly equal in effort. They are not interchangeable
afterwards. This has to be answered before schema work starts.

---

## 3. What this changes about the architecture

**Custom fields are createable over the API.** `POST /v1/entities/{entity}/fields`
with `{displayName, type, pickLists, filterable, sortable, required}`. So the
handoff's "overlay store" shrinks: `vendorInfo`, `serviceOffering` and
`modeOfMeeting` are scalars and should become Kylas custom fields — provisioned
by a setup script, readable in Kylas' own reports and filters, no join needed.

**The overlay store is still needed, for two things only:**
1. `event_rows` — past/current are *repeating* rows per contact. `customFieldValues`
   is a flat map; it cannot hold a variable-length list. These live in Postgres,
   keyed on `kylas_contact_id`.
2. `contacts_cache` — a local mirror so navigation and search never wait on Kylas.

**Call logging goes native.** Every Save & next writes a real Kylas call log.
Dials, duration and outcome then exist in Kylas' own reporting, and the app keeps
a mirrored row for fast KPI aggregation.

**Webhooks make the cache honest.** `CONTACT_UPDATED` → invalidate that row. No
polling, no staleness window that matters at this volume.

**Picklists are numeric ids, not strings.** `salutation: 1751`, `company: 894`.
The console's `STAGES`/`SOURCES`/`SALUTATION` arrays become id↔label maps
hydrated at boot from `/v1/entities/contact/fields` and cached. This also
answers handoff §8.1–8.3 without anyone typing a list out by hand — the real
picklists come from the API.

---

## 4. Revised write path

```
keystroke → local state + debounced draft to IndexedDB        (0 ms, no network)
Enter     → UI advances immediately                            (optimistic)
          → job into outbox
outbox    → POST /save  → ① insert call_log + event_rows       } local txn, authoritative
                          ② PUT  /v1/contacts/{id}             } retried
                          ③ POST /v1/call-logs/                } retried
```

Local write is synchronous and authoritative; both Kylas writes are async and
retryable. A Kylas outage degrades to a sync backlog, never to lost call notes.

Volume at 3 reps × 100 calls/day ≈ 600 writes/day. **Verify** the published rate
limit, but this is not a scale problem.

---

## 5. Still open

1. **Lead or Contact** — §2 above. Blocking.
2. `outcome` enum on call logs — must cover the four console outcomes.
3. `jsonRule` operator vocabulary + which fields are filterable/sortable
   (decides how much queue ordering runs server-side).
4. Webhook `authenticationType` options.
5. Rate limits.
6. Whether V/W account scores live in Kylas as custom fields or outside it.
7. Telephony: is Exotel/Knowlarity/Ozonetel wired in? `callRecording.url` on the
   call-log body implies the integration path exists.

---

## 6. Observed from a live Kylas screen (2026-09-16)

A screenshot of a real company page settles several guesses:

- **Record URLs** are `app.kylas.io/sales/companies/details/<id>` and, by the
  same shape, `/sales/contacts/details/<id>`. The extension matches on these.
- **Companies and Contacts are separate related entities**, with a Contacts
  table on the company page — as §1 assumed.
- Company-level fields seen: `Source of Data`, `Owner`, `Number of Employees`,
  `Website`, **`Priority (BD)`**, `Boolean Post link`. `Priority (BD)` may be
  where the V/W account score already lives — worth checking before building
  queue ordering.
- An **overlay already exists** on the company page showing `TOTAL POCS`,
  `CONNECTED`, `MQL`, a `CNC (Could Not Connect) - 1` badge, and
  `STATUS OF REACHOUT — Stale | Last Call: 2026-04-17`, alongside enrichment
  fields (annual revenue, employees, funding).

**OPEN — vocabulary.** That overlay counts **MQL**; the ladder in `kpi-spec.md`
has no MQL rung, and its "Right POC" and "Successful Discovery" rungs have no
counterpart there. One vocabulary has to win, or the two surfaces will report
different numbers for the same company. Which is authoritative?

**OPEN — overlap.** If that overlay is being replaced, the console's company
strip is its successor and should carry the same tiles. If both are staying,
they need to agree on definitions.

---

## 7. The fetch design — company page in, contacts out

The overlay opens on a company page, so the company is the **anchor**, but the
data it needs is the **contacts**. Two calls:

```
url: /sales/companies/details/1776620
       │
       ├─ GET  /v1/companies/1776620          → name, owner, Priority (BD), custom fields
       └─ POST /v1/search/contact             → that company's contacts, in full
```

Everything in the console's company strip — total POCs, connected, right POC,
discovery, status of reachout — is computed from the contacts that come back.
Nothing is read from the company record except its own attributes. That matches
the data model: company numbers are rollups of contacts, never entered directly.

Session mode is the same call with a different filter: contacts owned by the
current user, due first, paginated.

### The one unverified piece

Every search example in the Postman collection uses `multi_field`, which is
free-text across the record. There is **no example of a per-field rule**, so the
operator vocabulary for `company equals 1776620` is inferred, not confirmed:

```json
{ "condition": "AND", "valid": true,
  "rules": [ { "id": "company", "field": "company", "type": "integer",
               "input": "select", "operator": "equal", "value": 1776620 } ] }
```

Two fallbacks if that shape is rejected:

1. `GET /v1/companies/{id}` may already return its contacts inline — the Kylas
   UI shows a Contacts table on the company page, so the detail response may
   carry them. That would be **one call and no query syntax at all**, and is the
   better answer if it holds.
2. Free-text search on the company name, filtered client-side by company id.
   Works, but wasteful and fuzzy.

## 8. Probing every endpoint at once

`scripts/probe-kylas.mjs` exercises all nineteen calls this project needs and
prints a pass/fail table.

```
KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620 --contact 112936
```

Reads only, by default — GETs and searches, nothing created, updated or deleted.
Covered:

| Area | Calls | Settles |
|---|---|---|
| Identity | `users/me`, `users/{id}` | owner ids for the picker |
| Schema | `entities/contact/fields`, `entities/lead/fields`, `fields/{id}`, `pipelines/search` | the real picklists, and whether BD stage lives on Contact or Lead |
| Company | `companies/{id}`, `search/company` | whether contacts come back inline, and what `Priority (BD)` holds |
| Contact search | free text, four company-filter shapes, owner filter, sort + page | which filters the query builder actually accepts |
| Contact | `contacts/{id}`, `call-logs/{id}` | the full record shape and existing call history |
| Limits | eight parallel requests | whether the writer has to queue |

Because no per-field search example exists in the collection, the probe **tries
four shapes** for "contacts at this company" and reports the first that works,
rather than assuming one.

### Writes

```
KYLAS_KEY=... node scripts/probe-kylas.mjs --company 1776620 --contact 112936 --write
```

Opt-in, and best pointed at a test contact. Three writes:

- **Remarks round trip** — reads the contact, saves the original to
  `kylas-probe/contact-*-original.json`, writes the marker block, then restores
  the original. This is the mechanism that gets overlay data into Kylas without
  paying for new fields, so it is worth proving.
- **Call log** — created, and **cannot be deleted through the API**; there is no
  delete endpoint. The probe says so before writing, and the test log must be
  removed by hand in Kylas.
- **Webhook** — created inactive against an unreachable URL, then deleted.
  Fully reversible, and confirms `CONTACT_UPDATED` is available.

Every raw response lands in `./kylas-probe/`.

---

## 9. First live run — 2026-09-16

Read-only probe against the real account (user 74725). What it settled:

### Resolved

**BD stage lives on Contact, not Lead.** `Pipeline Stage - BD` is a Contact
field. This closes the blocking question in §2 — the console stays
contact-shaped, the field map in `HANDOFF.md` §4 holds, and outcome buttons are
a plain field write. No move to `/v1/leads/*`.

**Contacts do not come back with the company.** `GET /v1/companies/{id}`
returned no inline contact array, so opening a company page is two calls: the
company, then a contact search. Fallback 1 in §7 is out.

**The company already carries BD custom fields.** On company `1776620`:

```
cfBatch · cfPipelineStageBd · cfSourceOfData · cfAccountHealthBd
cfLastCalledAtDate · cfWebsite
```

This matters. `cfPipelineStageBd` and `cfLastCalledAtDate` are company-level
versions of two things the Airtable model computes as rollups, and
`cfAccountHealthBd` may be the account score that queue ordering needs. They
already exist, so they cost nothing to use.

> **OPEN — who owns the company rollup.** If Kylas is already maintaining
> `cfPipelineStageBd` and `cfLastCalledAtDate` on the company, the overlay
> should write them rather than compute a parallel answer in Airtable that
> disagrees. If nothing maintains them today, Airtable stays the source and the
> overlay pushes the result into these fields. Either is fine; both at once is
> not. Ask Ayush which.

### Rate limiting is tight

Six of eight parallel requests returned 429, and **sequential calls a few
hundred milliseconds apart were also throttled** — the run lost nine endpoints
to it. Consequences:

- The probe now queues every call with a gap and retries a 429 with a widening
  wait, instead of reporting its own impatience as a broken endpoint.
- The burst test moved to the very end; running it mid-probe poisoned everything
  after it.
- **The production writer must queue.** This is the constraint that decides the
  proxy's shape: saves go into an outbox and drain at a fixed rate, which is
  what `architecture.md` §4 already assumes.

### Still unknown

- `POST /v1/search/contact` filtered by company returned `400 Invalid Type` for
  `type: "integer"`. The field and operator are evidently right; the type is
  not. The probe now reads the declared type from the contact schema and tries
  that first, plus `long`, `lookup`, `string` and `in`.
- `GET /v1/pipelines/search` returned 400. Probably lead-only, and not needed
  now that BD stage is a Contact field.
- Everything from `contacts/{id}` downward was lost to 429 and has not been seen.

---

## 10. `metaData.idNameStore` — the lookup table Kylas ships with every record

A raw contact carries its own id→name map:

```json
"metaData": { "idNameStore": {
  "company":           { "1770964": "renewbuy" },
  "ownerId":           { "74752": "Rubal Sansanwal" },
  "cfPipelineStageBd": { "2862826": "LinkedIn Outreach Initiated" }
} }
```

Every lookup on the record resolves from here. That matters twice over:

- **Accuracy.** `company` comes back as the bare id `1770964`; the name only
  exists in this map. Without reading it the Company field renders blank next to
  a contact that plainly has one.
- **Cost.** Resolving owner ids by calling `/v1/users/{id}` spends requests
  against a limit that 429s on the fourth call in a second. The name is already
  in the payload.

`metaData` must be named in the search `fields` list or it does not come back —
search returns only what is asked for.

## 11. Custom fields are per-account, so do not hardcode their values

`cfSourceOfData` is a **custom** field, not the standard `Source` picklist. On
this account its values are `Round-Robin`, not the
`GOOGLE | FACEBOOK | LINKEDIN | …` the standard field offers. Anything
hardcoded against the wrong list renders real data as "Choose".

The proxy therefore reads `/v1/entities/contact/fields` once and serves the
picklists to the console, which adopts them at runtime. Standard fields can stay
in `docs/stages.json`; account-specific ones cannot.

Broken again on 2026-09-17: console.js still shipped
`["","GOOGLE","FACEBOOK","LINKEDIN","EXHIBITION","COLD_CALLING"]` as the
starting value for SOURCES, and `adoptPicklists` fell through to the standard
`source` field when `cfSourceOfData` was absent. An associate picked "Google"
from that list and wrote a value the account does not use. A plausible-looking
default is worse than an empty one — it cannot be told apart from real data.
SOURCES now starts as `[""]` and only `cfSourceOfData` replaces it.

Two general rules fall out, both learned the hard way here:

1. A `<select>` must keep a value it does not recognise rather than silently
   dropping it. A blank field reads as "no data" when the truth is "the list is
   wrong".
2. Field casing matters: Kylas stores email and phone types uppercase
   (`OFFICE`, `MOBILE`), so a title-case list never matches.

---

## 12. Field validation — what Kylas will and will not accept

Added 2026-09-18 after `POST /v1/contacts` and `PUT /v1/contacts/6129324` both
came back with:

```
400 {"code":"002008","message":"Invalid Mobile Number.","errorDetails":[]}
```

The number in question was `+918319585041`. Kylas' own UI displayed it exactly
like that, so the country code was sitting inside `phoneNumbers[].value`.

**The rule.** `value` is the NATIONAL number; the country lives in `dialCode`
(and `code`, the ISO pair). `{ dialCode: "+91", value: "+918319585041" }` is the
country code twice and is refused. Because the console wrote back whatever the
field held, a contact created once that way could never be updated again — the
same 400 on every PUT, for the life of the record.

**The error tells you nothing.** No field name, no rule, no `errorDetails`. An
associate 140 calls into a day cannot act on it, and the save is lost behind it.
So the rules now run BEFORE the write, in one place — `scripts/gen-fields.mjs`,
generated into `scripts/fields.mjs` and `extension/console/fields.js` so the
browser and the writers cannot drift.

### Permissible entries, per field

| Field | Type | Accepted | Rejected |
|---|---|---|---|
| Phone | `{type, code, dialCode, value, primary}` | national digits only in `value`; +91 → exactly 10, starting 6-9 for `MOBILE`, 2-9 for `WORK`/`HOME` | a `+`, spaces, a trunk `0`, a repeated country code, 9 or 11 digits |
| Email | `{type, value, primary}` | one `@`, a dotted domain, a 2+ char TLD; stored lowercase | spaces, two `@`, no domain dot, a leading/trailing dot |
| Name | `firstName` + `lastName` | split on the LAST space; one word becomes `lastName` (Kylas requires it) | digits (a phone pasted into the name box), `Test`/`Temp`/`NA`/`-` |
| LinkedIn | `linkedin` | any linkedin.com URL, `https` forced | another host |
| Designation, vendor info | text | ≤255 / ≤1000 chars | longer (truncated, reported, not blocking) |
| Stage, Source, Salutation, Mode | picklist **value id** | a value this account actually offers | anything else — reported, never dropped (see §11) |
| Next call date / time | `YYYY-MM-DD` / `HH:MM` | — | any other shape |
| Budget, timeline, pax, remarks | free text | **everything**, exactly as said | nothing. Never validate these — CLAUDE.md non-negotiable 2 |

**Blocking vs reported.** A value Kylas would refuse, or one that makes the
record unfindable, blocks the save and is named on the field. A stale picklist
value or an over-long designation is reported and written anyway: it is our
list that is wrong, not their data.

**Where it runs.** The console gates the save (`missing()`) so the error appears
on the box; `/save` re-checks and answers **422 with a `problems[]` list**, for
an older extension or a queued outbox job. A 4xx never enters the outbox —
retrying a rejected value forever is not an outage, and it blocks every save
queued behind it.

`scripts/mock-kylas.mjs` now reproduces the 400 for any `value` that is not
bare national digits, so this cannot regress silently. `scripts/test-fields.mjs`
holds the cases.

### 12a. A server-side filter needs something to filter by

Found while testing the above. Three of the five `/v1/search/company` shapes
filter server-side on `ownerId`. Asked for *everyone* (the team view), `ownerId`
is `null` and those shapes sent a rule asking for owner "null" — an empty page,
so the Everyone view showed nothing. Masked on this account only because those
three shapes 500 here anyway; the day Kylas fixes that endpoint the team
dashboard would have gone blank. The filtering shapes are now skipped entirely
when there is no owner.


---

## 13. `/v1/search/company` stops at whatever page cap you set

Found in Ayush's proxy log, 2026-09-18:

```
company search: 5000 across 25 page(s)
```

5000 = 25 pages × 200, which was exactly `MAX_PAGES × PAGE`. **The crawl stopped
at the cap, not at the end of the data.** Every owner count in that session
(27, 82, 104) was computed over a list that was short by an unknown amount, and
nothing said so — the same failure as the page-0-only search that reported 19 of
Arshdeep's companies as all of them, one layer up.

The cap now defaults to 60 pages (12,000) via `KYLAS_MAX_PAGES`, and hitting it
is reported: the client records `lastCompanySearch().truncated`, the proxy logs
it and puts `truncated` in the response, and both console views show an amber
warning saying the counts are short. A cap is still right — a runaway loop
against a rate-limited API is worse — but hitting one has to be loud.

### One crawl per account, not one per owner

The same log shows `5000 across 25 page(s)` eight times in one session, ~16s
each, for data that had not changed. The proxy cached the result keyed on
**owner** — which reads as prudent and was the same mistake the console had:
no shape that works on this account can filter server-side, so asking for one
owner pages the whole account anyway, and then asking for "everyone", or for a
second name, pages it all over again.

The crawl is now keyed `"all"` and an owner is a filter over it. Verified
against 1,504 companies: three requests (all / owner A / owner B) → **one**
crawl, 751 + 753 = 1504.
