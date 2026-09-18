# KPI specification

Written from Ayush's definitions. Everything marked **OPEN** is a definitional
gap that will change the numbers — these need answers before the formulas are
built, not after.

---

## 1. Airtable schema

Five tables. Two are append-only logs; three are current-state.

### `Contacts`
| Field | Type | Notes |
|---|---|---|
| `Kylas Contact ID` | text, unique | join key, primary source of identity |
| `Name`, `Designation`, `LinkedIn`, `Owner` | text | mirrored from Kylas |
| `Company` | link → Companies | |
| `Current Stage` | single select | mirror of Kylas pipeline stage |
| `Previous Stage` | single select | set on every transition |
| `First Call At` | rollup MIN(`Stage Transitions.Changed At`) | §2 |
| `Last Call At` | rollup MAX(`Stage Transitions.Changed At`) | §2 |
| `Event Rows` | link → Event Rows | |
| `Vendor Info`, `Mode of Meeting` | single select | overlay-owned |
| `Service Offering` | checkbox | overlay-owned |
| `Has Signal` | rollup `OR(values)` of `Event Rows.Has Any Signal` | §5 |
| `Has Complete Row` | rollup `OR(values)` of `Event Rows.Is Complete` | §6 |
| `KPI Stage` | formula | §8 — the ladder |
| `KPI Rank` | formula | numeric form of the above, for MAX rollups |

### `Companies`
| Field | Type | Notes |
|---|---|---|
| `Kylas Company ID`, `Name` | text | |
| `Contacts` | link → Contacts | |
| `First Call At` | rollup MIN(`Contacts.First Call At`) | |
| `Last Call At` | rollup MAX(`Contacts.Last Call At`) | §3 — "companies reached" |
| `Reached` | formula `Last Call At` is not blank | |
| `Phone Picked` | rollup `OR(values)` of `Contacts.Picked` | §4 |
| `Right POC Contacts` | rollup `ARRAYJOIN(values)` over contacts where right-POC | §5 |
| `Right POC` | formula `Right POC Contacts` is not blank | §5 |
| `Discovery Contacts` | rollup `ARRAYJOIN(values)` over contacts with a complete row | §6 |
| `Successful Discovery` | formula `Discovery Contacts` is not blank | §6 |
| `Company KPI Stage` | rollup `MAX(values)` of `Contacts.KPI Rank`, mapped to label | §8 |

### `Event Rows`
One row per past or current event. Hangs off the **contact**, not the company.

| Field | Type |
|---|---|
| `Contact` | link → Contacts |
| `Period` | single select — `Past` \| `Current` |
| `Event Type`, `Budget`, `Timeline`, `Pax`, `Remarks` | long text |
| `Has Any Signal` | formula — §5 |
| `Is Complete` | formula — §6 |

### `Stage Transitions` — append-only
| Field | Type |
|---|---|
| `Contact` | link → Contacts |
| `From Stage`, `To Stage` | single select |
| `Changed At` | datetime |
| `Owner` | text |
| `Source` | single select — `Console` \| `Kylas webhook` |

### `Call Log` — append-only, recommended, see §2
| Field | Type |
|---|---|
| `Contact` | link → Contacts |
| `Called At` | datetime |
| `Outcome` | single select — the four console outcomes |
| `Duration` | number, seconds |
| `Owner` | text |
| `Stage Set` | single select |

---

## 2. First Call At / Last Call At

**As specified.** Each contact carries a current and a previous pipeline stage.
When the stage changes, current shifts into previous and `Last Call At` is stamped
at the moment of the change. `First Call At` is the first such stamp.

**Implementation.** Do not maintain this as two mutable columns. Append a row to
`Stage Transitions` on every change and derive both as rollups —
`MIN(Changed At)` and `MAX(Changed At)`. Same numbers, but it is self-healing if a
write is missed, it survives backfill, and the transition history is what Root
Cause Analysis actually needs: you can see that a contact sat at `Qualifying` for
41 days before moving, which two mutable columns can never tell you.

> **OPEN — this definition undercounts calls.**
> A stage change is not the same event as a call. Two cases break it:
> - Second and third no-answers on a contact already at `Could Not Connect`. The
>   stage does not change, so `Last Call At` stays frozen at the first attempt.
>   A contact dialled six times looks untouched since attempt one.
> - A connected call that confirms the existing stage — real contact, no movement.
>
> Both inflate "days since last touched" and understate dialling effort, which is
> exactly what the pace counter is meant to prove.
>
> Fix: write a `Call Log` row on **every** save, and define
> `Last Call At = MAX(Call Log.Called At)`, keeping
> `Last Stage Change At = MAX(Stage Transitions.Changed At)` as a separate field.
> You get both, and the funnel stops lying about activity. Kylas' native
> `POST /v1/call-logs/` gives you this for free on the CRM side anyway.
>
> Decide: keep as specified, or switch `Last Call At` to call-based.

---

## 3. Companies Reached

```
Company.Last Call At  = MAX(linked Contacts.Last Call At)
Company.Reached       = Last Call At is not blank
Companies Reached     = COUNT(Companies where Reached)
```

For a period: `COUNT(Companies where Last Call At within [from, to])`.

> **OPEN.** "Reached this month" — does a company count if it was reached in
> March and not since? Above, it counts in March only. Confirm that is what you
> want for the monthly number.

---

## 4. Phone Picked

**As specified:** picked when the pipeline stage is not `Could Not Connect`.

```
Contact.Picked        = Current Stage != "Could Not Connect"
Company.Phone Picked  = OR(linked Contacts.Picked)
Phone Picked Rate     = Companies picked / Companies reached
```

> **OPEN — current stage vs ever.**
> Reading `Current Stage` means a contact who picked up, was qualified, then
> later got re-dialled to a no-answer and moved back to `Could Not Connect` is
> counted as never having picked up. Deriving it from `Stage Transitions`
> instead — *did this contact ever hold a stage other than CNC and the initiated
> stages* — is monotonic and cannot regress. Recommended, and free once the
> transitions table exists.
>
> **OPEN — denominator.** Rate over companies *reached*, or over companies
> *dialled*? These differ by every company where dialling never produced a stage
> change at all. Reached is the more flattering number; dialled is the true one.
>
> **OPEN — level.** Company counts as picked if *any* contact picked up. Stated
> as "account pipeline stage", so confirming company-level is intended.

---

## 5. Right POC

**As specified:** a contact is a right POC if **any** event-row signal field is
non-empty, in either the past or current section.

```
Event Rows.Has Any Signal =
    OR( Budget != "", Timeline != "", Pax != "" )

Contact.Is Right POC      = OR(Event Rows.Has Any Signal)
Company.KPI Stage         ≥ "Right POC" if any contact qualifies
Company.Right POC Contacts = names of every qualifying contact
```

The company-level name list is the `ARRAYJOIN` rollup in §1.

**Settled.** Event type is excluded along with remarks: choosing "Employee
offsites" from a dropdown says nothing about whether they have a requirement,
and an associate typing "call back Monday" in remarks is not qualification
signal. Only budget, timeline and pax count.

---

## 6. Successful Discovery Call

**As specified:** one *whole* row — past or current — is filled.

```
Event Rows.Is Complete =
    AND( Budget != "", Timeline != "", Pax != "" )

Contact.Successful Discovery = OR(Event Rows.Is Complete)

Company.Discovery Contacts    = names of every contact with a complete row
Company.Successful Discovery  = Discovery Contacts is not blank
```

Cumulative by construction: a complete row has all three fields filled, so it
also satisfies §5's "any one of them". Discovery is therefore always a subset of
Right POC and the funnel reads straight down without an explicit `OR`.

Segmented by `Mode of Meeting`, giving the in-person / virtual / text split.

> **OPEN — what "whole row" includes.** Above requires all four signal fields and
> ignores `Remarks`. If `Remarks` must also be filled, the count will drop
> noticeably. Confirm.
>
> **SETTLED 2026-09-18 — mode of meeting values.** Four, as the schema has
> them: `In Person | Virtual | Calls | Text`. Ayush confirmed this list is
> accurate, so the `Video | Audio | In-Person` wording in the dashboard spec is
> superseded. `Virtual` and `Calls` stay separate. The stacked chart builds its
> segments from the data rather than a hardcoded list, so nothing needed to
> change in the code — `extension/console/console.js` and
> `scripts/schema.mjs` already carried exactly these four.

---

## 7. The SQL milestones — settled 2026-09-17

Three stage-driven milestones, each a **floor** on the ladder. Because `KPI Rank`
only ever rises, "ever reached X" and "is at or past X" are the same question, so
a floor needs no member list and no history lookup — the rank *is* the
high-water mark.

| Milestone | Floor | Counts these stages |
|---|---|---|
| **SQL Meeting Booked** | rung 19 · Discovery Call Booked | Booked, No-Show, Closing Loops - Low Value, Done - Awaiting Client Inputs, SQL |
| **SQL Meeting Done** | rung 21 · Closing Loops - Low Value | Closing Loops - Low Value, Done - Awaiting Client Inputs, SQL |
| **SQL** | rung 23 · SQL | SQL |

"Booked" is deliberately *regardless of outcome* — a call that was booked and
then no-showed still counts as booked. "Done" means the call was actually held,
which is why Closing Loops - Low Value is in it: you held the call and concluded
the account was not worth pursuing.

Defined once in `docs/stages.json` under `milestones`, as a floor stage code per
milestone. `gen-stages.mjs` emits `MILESTONE` for both the browser and node, and
refuses to emit if a floor names a stage that does not exist — a missing floor
would compile to `undefined`, make every comparison false, and read as "nobody
ever got there" rather than as a broken table.

**Reschedule Pending was retired from the pipeline on 2026-09-17.** Before that
it sat at rung 21, inside the Booked range but absent from Ayush's stage set —
the one place his three sets were not a clean threshold. With it gone each floor
matches his sets exactly. The ladder is now 1..23.

### Stage-driven is not the same as data-driven

These three come from the **stage**. Right POC (§5) and Successful Discovery (§6)
come from the **event data**. They can disagree: a contact can sit at SQL with no
complete row, and a contact with a complete row can still be at Follow-up. The
company funnel is therefore made cumulative explicitly — each rung implies the
one below — or the rates come out above 100%.

### Required at the point of the claim

A complete row *is* the Successful Discovery claim, so the moment one appears the
console requires the three things that qualify it before it will save:

1. **Who handles this for them today?** — `Vendor Info`
2. **What did I pitch?** — `Service Offering`
3. **Mode of meeting** — `Mode of Meeting`

Gating at save is deliberately **not** the same as folding these into
`Is Complete`. Blocking the save collects the data; adding them to the test would
silently withhold the credit from someone who did fill budget, timeline and pax.

> **OPEN — "What did I pitch?"** `Service Offering` is a checkbox today ("I
> pitched what Enout does"), so it cannot be *missing* — unchecked is a valid
> answer, and requiring it to be ticked manufactures a true. Ayush's wording is
> "the service or solution pitched", which wants a value. Needs a field-type
> decision before it can be enforced.
>
> **SETTLED 2026-09-18 — Mode of Meeting values.** `In Person | Virtual |
> Calls | Text` is the real list; see §6. The dashboard spec's
> `Video | Audio | In-Person` is superseded.

---

## 8. The ladder

Every metric above is a rung. Making them an ordered ladder — where each rung
implies all the ones below — is what turns them into a funnel with conversion
rates between steps, and what lets a company inherit `MAX` across its contacts.

| Rank | KPI Stage | Condition |
|---|---|---|
| 0 | Not reached | no calls logged |
| 1 | Reached | `Last Call At` not blank |
| 2 | Phone Picked | stage ever ≠ CNC |
| 3 | Right POC | any event-row signal field filled |
| 4 | Successful Discovery | any complete event row |
| 5 | Active Requirement Call | **OPEN** |
| 6 | SQL Call Booked | from pipeline stage |
| 7 | SQL Call Held | **deferred** |
| 8 | SQL Accepted | from pipeline stage |

```
Company.KPI Rank  = MAX(linked Contacts.KPI Rank)
Company.KPI Stage = label for that rank
```

> **Compute the rank as highest-ever, not current.**
> If it reads current state, a contact that reached SQL Call Booked and then went
> cold drops back down the ladder, and your funnel leaks backwards — month-on-month
> the count at each rung can *fall*, which makes conversion rates meaningless and
> RCA impossible. Highest-ever is monotonic: it only ever moves up, and "SQL
> booked in March, dead in April" is then a separate *status* field, not a lower
> rank. This is the single most important modelling decision in the spec.

---

## 9. Everything still needed

Blocking the formulas:
1. Last Call At — stage-change-based as specified, or call-based (§2)
2. Right POC — exact field list, remarks in or out (§5)
3. "Whole row" — which fields must be filled (§6)
4. Mode of meeting — three values or four (§6)
5. Active Requirement Call — definition (§7)
6. Which pipeline stages mean SQL Call Booked and SQL Accepted (§7)
7. Highest-ever vs current for the KPI ladder (§8) — recommendation: highest-ever

Blocking the build, not the formulas:
8. Are BD prospects Contacts or Leads in Kylas (see `kylas-api-notes.md` §2)
9. Kylas API key, for the real picklists
10. Airtable base — existing one to extend, or a new one to create

---

## 10. Per-contact call history

Every call is a row in `Call Log` linked to the contact, so the contact carries
its own history as rollups rather than as a separate summary anyone has to keep
in step:

| Field on `Contacts` | How |
|---|---|
| `Call Count` | `COUNTA` of linked calls |
| `First Call At` / `Last Call At` | `MIN` / `MAX` of `Called At` |
| `Talk Seconds` | `SUM` of `Measured Seconds` |
| `Measured Calls` | how many of those calls were actually timed |
| `Avg Call Seconds` | `Talk Seconds / Call Count` |

`Call Log.Duration Source` separates a measured duration from an inferred one.
A rollup cannot filter on a sibling field, so `Measured Seconds` is a formula on
the call row that zeroes out anything not `dialed`, and the sum runs over that.
Without it, inferred seconds would inflate real talk time and the average would
look precise while being partly made up.

`Companies` sums both `Call Count` and `Talk Seconds` from its contacts, so
effort per account is visible next to the outcome per account.

## 11. Testing the schema before building it

The Airtable Meta API has no dry run, and a bad field definition fails partway
through, leaving a half-built base to delete by hand. So the schema is data
(`scripts/schema.mjs`) with two checks around it:

```
node scripts/validate-schema.mjs         # no network: types, options, ordering, formula refs
node scripts/test-validator.mjs          # checks the validator catches 10 planted faults
node scripts/create-base.mjs --dry-run   # prints every request without sending
```

Afterwards, and whenever the schema gains a field:

```
AIRTABLE_PAT=... AIRTABLE_BASE=app... node scripts/verify-base.mjs   # what is missing
AIRTABLE_PAT=... AIRTABLE_BASE=app... node scripts/repair-base.mjs   # add only that
```

`create-base.mjs` refuses a base whose tables already exist, deliberately — a
half-merge is worse to unpick than a refusal. `repair-base.mjs` is the other
half: it changes nothing already there, adds only what is absent, and handles
the link-reverse rename the same way.

Then build it, either into a base you already made or into a fresh one:

```
AIRTABLE_PAT=pat... AIRTABLE_BASE=appEwJu0bleHh9b8t node scripts/create-base.mjs
AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE=wsp...        node scripts/create-base.mjs
```

Into an existing base it checks the six table names are free and refuses if any
is taken, rather than half-merging into what is there. It cannot delete the
default `Table 1` — the Meta API has no delete-table call — so remove that by
hand afterwards.

The PAT needs `schema.bases:write` and `schema.bases:read`, and must be scoped
to that base. Create one at airtable.com/create/tokens. Keep it out of chat and
out of the repo — pass it as an environment variable as above.

The validator replays creation in order and fails on: a primary field of a type
Airtable will not accept, missing required options, duplicate or
case-colliding field names, formula or rollup fields declared inside the initial
create call, rollups routed through a field that is not a link, rollups onto a
column the linked table does not have, formulas referring to fields that do not
exist yet, unbalanced brackets or quotes, and links that do not declare their
reverse.

That last one found a real bug: Airtable creates the other half of a link
itself, with a name it chooses, and every rollup here travels back down those
reverse links. They are now declared explicitly and `create-base.mjs` renames
the generated field to match.

## 12. Seeding the base from captured data

```
AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/seed-base.mjs export.json --dry-run
AIRTABLE_PAT=pat... AIRTABLE_BASE=app... node scripts/seed-base.mjs export.json
```

`export.json` is the file the console's **Data → Export JSON** button produces.

The seeder is the proxy's write path in miniature: resolve the company, write
the contact linked to it, append its event rows and calls, and compute the KPI
rank from the ladder. Writing it first is how the real writer stops being
guesswork — the mapping, the ordering and the link handling are all exercised
against a live base before any of it runs behind a network endpoint.

It writes only stored fields. Rollups and formulas are computed by Airtable, and
sending them would be rejected.

Running it answers the question the schema alone cannot: do the rollups produce
the right numbers on real captured shapes. If Companies shows sensible Last Call
At, Right POC Contacts and KPI Stage after a seed, the data model holds.

---

## 13. The funnel — settled

The funnel is the stage order Ayush gave, read bottom to top. Rung 24 is
furthest along, rung 1 is untouched.

| Rung | Stage | Rung | Stage |
|---|---|---|---|
| 24 | SQL | 12 | Offsite Delayed |
| 22 | Discovery Call Done | 11 | Offsite Done (Late Reachout) |
| 21 | Closing Loops - Low Value | 10 | Not Interested |
| 20 | Discovery Call No-Show | 8 | CNC 3 |
| 19 | Discovery Call Booked | 7 | CNC 2 |
| 18 | Follow-up 1 | 6 | CNC 1 |
| 17 | Follow-up 2 | 5 | Disqualified |
| 16 | Follow-up 3 | 4 | Invalid |
| 15 | Followup - CNC | 3 | NDM |
| 14 | MQL | 2 | POC Changed |
| 13 | Activation | 1 | LinkedIn Outreach Initiated |

**Call order is the same list reversed**: `callOrder = 25 - rung`. That identity
is asserted in the code, so the two orderings cannot drift apart. It also makes
sense — a contact further along is a contact worth calling sooner.

I argued earlier that these had to be two different orderings, on the grounds
that Closing Loops sitting third looked like a priority signal rather than
progress. That was wrong: a contact at Closing Loops has been qualified and
talked to, and one at Discovery Call No-Show has booked a call. Both genuinely
are further along the funnel than MQL.

`KPI Rank` is still monotonic — the MAX rule in §8 stands, so a contact that
slips backwards keeps the rung it earned.

Standing alongside the rung, unchanged:

- `Is Right POC` — any event signal field filled (§5)
- `Has Complete Row` — a full event row (§6)

These stay separate because they come from the overlay's own data, not from the
stage, and answer a different question: whether real qualification detail was
captured, regardless of where the stage sits.

### Writing a stage

Kylas sets a picklist **by value id**, not by code — sending
`cfPipelineStageBd: "MQL_MARKETING_QUALIFIED_LEAD"` will not work, it needs
`2862828`. All 24 ids are in `docs/stages.json` and reach both the console and
the scripts through `scripts/gen-stages.mjs`.

---

### Stages that are not rungs

Seven values are dead ends: `CLOSING_LOOPS_LOW_VALUE`, `GHOSTED`,
`NOT_INTERESTED`, `INVALID_CONTACT`, `DISQUALIFIED_WRONG_POC`,
`NOT_A_DECISION_MAKER_NDM`, `POC_ORGANIZATION_CHANGED`.

Landing on one is an **outcome, not a rung**. They are recorded in
`Contacts.Exit Reason` and never lower `KPI Rank` — otherwise a contact
disqualified in April would erase the MQL it earned in March, and the funnel
would leak backwards. This is the monotonic rule from §8, applied to the real
list.

Five more are holding states — `CONNECT_LATER`, `FOLLOW_UP_1/2/3`,
`OFFSITE_DELAYED`, `OFFSITE_DONE_LATE_REACHOUT`. They keep whatever rank was
already earned. (`RESCHEDULE_PENDING` was retired from the pipeline 2026-09-17.)

### Outcome buttons, remapped

| Key | Outcome | Sets `cfPipelineStageBd` to |
|---|---|---|
| `1` | No answer | the next CNC: `CNC_1 → CNC_2 → CNC_3 → FOLLOWUP_CNC` |
| `2` | Wrong POC | `DISQUALIFIED_WRONG_POC` |
| `3` | Right POC | `MQL_MARKETING_QUALIFIED_LEAD` |
| `4` | Discovery | `DISCOVERY_CALL_BOOKED` |

Kylas models repeat no-answers as distinct stages, so key `1` **walks the
ladder** rather than writing the same value each time. That also answers the
concern in §2 for the first three attempts — a second no-answer is now visible
in the stage itself, not only in the call log.

> **OPEN.** Key `2` currently sets `DISQUALIFIED_WRONG_POC`, but
> `NOT_A_DECISION_MAKER_NDM` also exists. Which should the button set? And
> should key `4` set Discovery **Booked** or Discovery **Done**?
