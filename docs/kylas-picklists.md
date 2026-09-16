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
