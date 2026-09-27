# TAT — turnaround time

Ayush, 2026-09-27: *"I get the notification, and once I get the notification
how am I able to see and act so that I am reducing TAT… how do you measure
TAT… potentially yeh mereko kis cheez mein help kar rahe hai voh bta dena."*

Structure only. No code has been changed.

---

## 0 · The short version

**Almost all of this already exists.** `arrivalsByCompany()` in
`scripts/report.mjs` already returns, for every company, the date it first
reached each rung:

```
"1776620": { worked: "2026-08-02T…", picked: "…", right: "2026-08-09T…",
             discovery: "2026-09-04T…", booked: "…", done: "…", sql: "…" }
```

A TAT is the gap between two of those dates. Nothing new has to be captured for
four of the five you listed, and `/ladder` already serves this object.

**And the RCA gates are already TAT thresholds.** `scripts/rca.mjs`:

```js
{ key: "rightNoDiscovery", from: "right", to: "discovery", days: 30, … }
{ key: "discoveryNoBooking", from: "discovery", to: "booked", days: 21, … }
```

TAT and RCA are the same measurement read two ways. RCA asks *"why is this one
stuck?"*; TAT asks *"how long does this normally take?"* Same pair of rungs,
same dates. Building TAT is mostly **surfacing a number the system already
computes**, not a new pipeline.

---

## 1 · What each one measures, and what you do about it

This is the "kis cheez mein help kar raha hai" answer. A TAT is only worth
showing if a bad number has an action attached; one that does not is a number
people learn to scroll past.

| TAT | Question it answers | A bad number means | What you actually change |
|---|---|---|---|
| **Created → first reachout** | How long does a lead sit before anybody calls it? | Leads are rotting in the queue | Allocation and daily pace. This is the fastest thing on the page to fix and usually the biggest win |
| **First reachout → Right POC** | How hard is it to find the decision-maker? | Bad contact data, or too few attempts before giving up | Data source, and a persistence rule (how many attempts before a CNC is final) |
| **Right POC → Discovery** | We reached the right person — can we get the meeting? | The *ask* is weak, or scheduling is friction | The pitch at the end of the first call; calendar links; who books it |
| **Discovery → SQL** | Are discovery calls actually qualifying? | Discovery is happening but not converting | The discovery script and what counts as qualified |
| **First reachout → SQL** | End to end: how far ahead of a target must we start? | — | This is the **planning** number, not a coaching one. It tells you the lead time on a revenue goal |

Two things worth saying plainly:

- **The first row is not on your list and is probably the most valuable.** You
  listed "first reachout from created at to Right POC", which reads as
  ambiguous between *created → Right POC* and *reachout → Right POC*. They are
  different measures with different owners: the first includes queue latency
  (a management problem), the second does not (a skill problem). Keep them
  apart or a slow month will be blamed on the wrong thing.
- **The last row is a planning number, not a performance one.** Do not put it
  next to the others as though somebody is accountable for it — it is the sum
  of four things, and a person cannot act on a sum.

---

## 2 · How to measure it, and the trap

### The trap: only counting the ones that finished

The obvious calculation — average `discovery − right` over companies that
reached discovery — is **systematically wrong**, and wrong in the direction
that flatters you.

The companies still stuck at Right POC are excluded, because they have no
discovery date yet. So a month in which only your two fastest accounts
converted shows a *better* TAT than a month in which ten converted including
some slow ones. The number improves as things get worse.

This is survivorship, and it is the single thing that will make a TAT dashboard
mislead. Two rules keep it honest:

**Rule 1 — always show the ones still waiting, next to the ones that finished.**

```
Right POC → Discovery      median 9 days        (41 companies converted)
Still waiting              17 companies, oldest 62 days
```

Neither number alone is honest. Together they are.

**Rule 2 — report by COHORT, not by completion date.**

> Of the companies that reached Right POC **in July**, 60% reached Discovery
> within 30 days.

This is a fixed denominator that cannot be gamed by slow accounts dropping out,
and it is directly comparable month to month. It is the number to trend.

### Median, not mean

Sales cycles are long-tailed. One account that took eight months destroys a
mean and tells you nothing about the typical case. Use **median**, and show
**p75** beside it so the tail is visible rather than hidden.

### Companies, not contacts

Same unit as every other rung, for the same reason: two qualifying contacts at
one account is one arrival. `arrivalsByCompany()` already dedupes this.

### Working days, not calendar days

A Friday-to-Monday gap is one working day, not three. On measures where the
median is under a week — which "created → first reachout" certainly is —
calendar days make the weekend look like a performance problem.

---

## 3 · What exists and what does not

| Needed | Status |
|---|---|
| Date a company first reached each rung | **Exists** — `arrivalsByCompany()`, served by `/ladder` |
| First reachout date | **Exists** — `Contacts.First Worked At` |
| Right POC / Discovery dates | **Exists** — `First Right POC At`, `First Discovery At` (added 2026-09-21) |
| SQL / booked / done dates | **Exists** — from `Stage Transitions` |
| Thresholds per rung pair | **Exists** — `RCA_GATES` in `scripts/rca.mjs` |
| **Company created date** | **MISSING.** No `Created At` on Companies or Contacts. Kylas returns `createdAt` on both and `kylas.mjs` already carries it through as `_kylas.createdAt` — it is simply never written to Airtable. One column on each table, one line in the writer, one backfill from Kylas. |
| Median / p75 / cohort maths | **Missing** — pure computation over data already in hand |
| Anywhere to display it | **Missing** — section 4 |

So: one new column, some arithmetic, and the display. No new capture, no schema
redesign, no change to how calls are logged.

---

## 4 · How to display it — three surfaces, three questions

Three, because they answer different questions for different people at
different moments. Putting all of it in one table is how a dashboard becomes
wallpaper.

### 4.1 On the account, while you are calling it

One line on the company strip. Not a chart — a sentence, in the place where
behaviour can actually change:

```
Right POC 11 days ago · usually 9 · nobody has booked discovery
```

This is the one that reduces TAT, because it is the only one visible at the
moment somebody could act. The comparison (`usually 9`) is what makes it mean
something; `11 days` alone is a fact with no scale.

Colour it only past the threshold, and use the amber you already use for
"dropped" rather than a new hue.

### 4.2 On the dashboard, beside the ladder

**One extra column on the table you already have**, not a second table:

| Rung | Team | Step conv. | **Median days** |
|---|---|---|---|
| Companies reached | 42 | — | — |
| Phone picked | 38 | 90% | 1 |
| Right POC connected | 31 | 82% | 4 |
| Successful discovery call | 19 | 61% | 9 |
| SQL meeting booked | 11 | 58% | 12 |

Median days **from the rung above**, over the companies counted in that cell.
In the same table for the reason the step-conversion fix on 2026-09-22 exists:
two tables that count the same thing will eventually disagree, and then nobody
trusts either.

Under it, the honest denominator:

```
17 companies are between Right POC and Discovery right now — oldest 62 days.
```

### 4.3 The cohort trend — is this getting better?

One chart, monthly, one line per rung pair:

> % of each month's arrivals that converted within the threshold

This is the only view that answers "are we improving", and it is the one to
look at once a month rather than every day. It needs the daily snapshots that
`snapshot.mjs` already writes.

### 4.4 The work list

Sorted by days waiting, longest first. This is not a report — it is what
somebody works through on a Monday:

```
Kritsnam Analytics   Right POC   62 days   Priya      [open]
Shorehouse Retail    Discovery   34 days   Rubal      [open]
```

The Focus lists tab is the natural home; it is already a list of accounts with
a reason attached.

---

## 5 · The notification loop — how a nudge actually reduces TAT

This was the first half of your question, and it is the part most likely to be
built and then not work.

### A notification after the threshold is a post-mortem

Today's RCA gate fires at **30 days** for Right POC → Discovery. If the median
is 9 days, then by day 30 the account is already three times the normal age and
the outcome is largely decided. That gate is the right design for *"explain
what went wrong"* and the wrong one for *"stop it going wrong"*.

**To reduce TAT, the nudge has to arrive around the median, not the gate.** Two
signals, not one:

| Day | Signal | Purpose |
|---|---|---|
| ~median (9) | **Nudge** — "this usually converts by now" | Change the outcome |
| threshold (30) | **RCA** — "explain why this did not" | Learn, and clear the board |

### The nudge is only useful if the action is one click away

A notification that says "account X is slow" and leaves you to find it has
spent your attention and bought nothing. The loop has to be:

```
notification  →  opens that account in the console, already scoped
              →  the one line from 4.1 is on screen
              →  dial / book / deprioritise, in that view
```

Deprioritise matters as much as dial: an account that should not be chased is
one whose TAT clock should stop, and today the only way to stop it is to
convert it. Without that, the work list fills with accounts nobody intends to
call and people stop reading it.

### Instrument the nudge itself

The thing that is always forgotten. When the nudge ships, the question
immediately becomes "did it help", and that is only answerable if you can
compare:

- median TAT for cohorts **before** the nudge existed
- median TAT for cohorts **after**

So record, per account, whether a nudge fired and when. One column. Without it
you will have an opinion about whether alerts work and no way to settle it —
and the honest default answer is that most alerting does nothing, so this is
worth being able to prove either way.

---

## 6 · Suggested order

1. **Nothing** — read the numbers first. Compute the five medians once, by
   hand, off `/ladder`, and look at them. Some will be uninteresting, and those
   should not be built. This costs an hour and may remove half of this page.
2. `Kylas Created At` on Companies and Contacts, plus the backfill. Unlocks the
   most valuable measure and is the only new capture on the page.
3. The median column on the ladder (4.2) and the line on the account (4.1).
   Same computation, two surfaces, one is where the behaviour is.
4. The work list (4.4) — it is a sort of data you already have.
5. The nudge at the median (5), **with** the did-it-fire column.
6. The cohort trend (4.3), last: it needs a few months of snapshots before it
   says anything.

Steps 1 and 2 are where the value is concentrated. Everything after 3 is
refinement, and step 1 may well tell you to stop.
