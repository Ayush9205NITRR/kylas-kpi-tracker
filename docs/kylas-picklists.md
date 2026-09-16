# Real Kylas picklists

Pulled live on 2026-09-16 via `scripts/probe-kylas.mjs` from
`GET /v1/entities/contact/fields?custom-only=false` and `GET /v1/fields/{id}`.
These replace every guessed list in the prototype. **The code on the left is what
the API stores and what everything joins on** — labels are display only.

## `cfPipelineStageBd` — Pipeline Stage - BD  (PICK_LIST, 24 values)

| Code | Label | Role |
|---|---|---|
| `YET_TO_BE_MINED` | Yet to be mined | start |
| `CNC_COULD_NOT_CONNECT` | CNC 1 | no answer |
| `CNC_COULD_NOT_CONNECT_2` | CNC 2 | no answer |
| `CNC_COULD_NOT_CONNECT_3` | CNC 3 | no answer |
| `FOLLOWUP_CNC` | Follow-up CNC | no answer |
| `CONNECT_LATER` | Connect later | parked |
| `RESCHEDULE_PENDING` | Reschedule pending | parked |
| `FOLLOW_UP_1` | Follow-up 1 | working |
| `FOLLOW_UP_2` | Follow-up 2 | working |
| `FOLLOW_UP_3` | Follow-up 3 | working |
| `MQL_MARKETING_QUALIFIED_LEAD` | MQL | progress |
| `ACTIVATION` | Activation | progress |
| `DISCOVERY_CALL_BOOKED` | Discovery booked | progress |
| `DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS` | Discovery done | progress |
| `SQL_SALES_QUALIFIED_LEAD` | SQL | progress |
| `OFFSITE_DELAYED` | Offsite delayed | parked |
| `OFFSITE_DONE_LATE_REACHOUT` | Offsite done, late reachout | parked |
| `CLOSING_LOOPS_LOW_VALUE` | Closing loops, low value | exit |
| `GHOSTED` | Ghosted | exit |
| `NOT_INTERESTED` | Not interested | exit |
| `INVALID_CONTACT` | Invalid contact | exit |
| `DISQUALIFIED_WRONG_POC` | Wrong POC | exit |
| `NOT_A_DECISION_MAKER_NDM` | Not a decision maker | exit |
| `POC_ORGANIZATION_CHANGED` | POC changed org | exit |

There is also a separate standard `Pipeline Stage` field with six values
(`YET_TO_BE_MINED`, `CNC_COULD_NOT_CONNECT`, `MQL_MARKETING_QUALIFIED_LEAD`,
`ACTIVATION`, `SQL_SALES_QUALIFIED_LEAD`, `NOT_INTERESTED`). The console uses
the **BD** one.

## Other picklists

| Field | Values |
|---|---|
| `Salutation` | `MR` `MRS` `MISS` |
| `Source` | `GOOGLE` `FACEBOOK` `LINKEDIN` `EXHIBITION` `COLD_CALLING` |
| `Offsite Timeline` (**MULTI_PICKLIST**) | `JAN_MAR` `APR_JUN` `JUL_SEP` `OCT_DEC` |

Offsite Timeline accepts more than one value, so it is a multi-select, not the
single dropdown the prototype used.

## Custom fields seen

- On **Contact**: `cfBatch`, `cfPipelineStageBd`, `cfSourceOfData`
- On **Company**: `cfBatch`, `cfPipelineStageBd`, `cfSourceOfData`,
  `cfAccountHealthBd`, `cfLastCalledAtDate`, `cfWebsite`

## Search syntax — settled

`company` and `ownerId` both report type `LOOK_UP` in the schema, but the search
query builder rejects that with `400 Invalid Type`. **`type: "long"` works.**

```json
{ "condition": "AND", "valid": true,
  "rules": [ { "id": "company", "field": "company", "type": "long",
               "input": "select", "operator": "equal", "value": 1776620 } ] }
```

Confirmed returning the right contact for company `1776620`. The declared schema
type is not the query type — do not pass `LOOK_UP`.

## Rate limit

A burst of 8 parallel requests returned three 429s. **450 ms between sequential
calls ran clean** through 15 endpoints. The writer must queue.

---

## Call order (given 2026-09-16)

Ayush's ranking of all 24 stages, 1 = call first. Mapped onto the codes; every
one is accounted for with nothing left over.

| # | Stage | Code |
|---|---|---|
| 1 | SQL | `SQL_SALES_QUALIFIED_LEAD` |
| 2 | Discovery Call Done - Awaiting Client Inputs | `DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS` |
| 3 | Closing Loops - Low Value | `CLOSING_LOOPS_LOW_VALUE` |
| 4 | Reschedule Pending | `RESCHEDULE_PENDING` |
| 5 | Discovery Call No-Show | `GHOSTED` ⚠️ |
| 6 | Discovery Call Booked | `DISCOVERY_CALL_BOOKED` |
| 7–9 | Follow-up 1 / 2 / 3 | `FOLLOW_UP_1/2/3` |
| 10 | Followup - CNC | `FOLLOWUP_CNC` |
| 11 | MQL | `MQL_MARKETING_QUALIFIED_LEAD` |
| 12 | Activation | `ACTIVATION` |
| 13 | Offsite Delayed | `OFFSITE_DELAYED` |
| 14 | Offsite Done (Late Reachout) | `OFFSITE_DONE_LATE_REACHOUT` |
| 15 | Not Interested | `NOT_INTERESTED` |
| 16 | Connect Later | `CONNECT_LATER` |
| 17–19 | CNC 3 / 2 / 1 | `CNC_COULD_NOT_CONNECT_3/_2/` |
| 20–23 | Disqualified / Invalid / NDM / POC Changed | `DISQUALIFIED_WRONG_POC`, `INVALID_CONTACT`, `NOT_A_DECISION_MAKER_NDM`, `POC_ORGANIZATION_CHANGED` |
| 24 | LinkedIn Outreach Initiated | `YET_TO_BE_MINED` ⚠️ |

⚠️ Two were matched by elimination rather than by name — every other stage
matched directly and these were the only pair left. Re-running the probe now
prints `CODE = Display name`, which confirms them outright.

### This is also the funnel

Read the other way up, the same list is the funnel: `rung = 25 - callOrder`.
A contact further along is a contact worth calling sooner, so one ordering
serves both. The identity is asserted in the code, so they cannot drift.

All 24 picklist value ids are now known — a write sends the id, not the code.
They live in **`docs/stages.json`**, which is the single source of truth for
stage codes, ids, display names and funnel position.

```
node scripts/gen-stages.mjs
```

regenerates `extension/console/stages.js` (browser) and `scripts/stages.mjs`
(node) from it. The console runs in a page and the scripts run in node, so the
table has to exist twice; generating both from one file is what stops a stage
renamed in one place and not the other from silently mis-ranking contacts.
`scripts/test-stages-live.mjs` loads the extension in a real browser and checks
every id, rung and label against `stages.json`.

The order turned out to be the funnel itself, not a separate priority list — see
docs/kpi-spec.md §13. `callOrder = 25 - rung`, asserted in the code.
dialling order — and **not** the KPI ladder. Using it as the funnel would make a
contact moving from MQL to "Closing Loops - Low Value" look like an advance.
