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
