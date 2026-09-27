# Exhaust the account before you get another one

Ayush, 2026-09-27: *"if I touch an account doing x no of calls daily, how do I
make sure that if an account has been tapped even once I should not leave that
account until it is exhausted — the goal is to exhaust the account, where
people keep demanding new accounts where it is just not possible for me to
[supply them]."*

Plan only. No code has been changed.

---

## 0 · The short version

Three things, and the second one is urgent.

**The measurement already exists.** Call Log links to Contact, Contact links to
Company (`schema.mjs:468-470`). So "how many contacts on this account has
anybody actually dialled, and how many times" is a join over tables that are
already there, not a new capture.

**But it is being destroyed every thirty days.** `rollup-calls.mjs` prunes Call
Log into Call Rollup, which is keyed `Day|Owner|Outcome` and carries **no
contact link**. Attempt history older than `CALL_RETAIN_DAYS` is gone, per
contact, permanently. Exhaustion is a question about an account's whole
history, so today it is unanswerable beyond one month — and every week this
waits is another week of it deleted. This is the same shape as the TAT gap:
captured, then thrown away just before it becomes useful.

**And the enforcement is not a report.** A report is an argument you have every
Monday. What answers *"people keep demanding new accounts"* is a **cap on how
many accounts a person can hold open at once** — then "give me more" stops
being a negotiation and becomes "which of your 22 open accounts should I
close?", which the system can answer.

---

## 1 · Define "exhausted" first, because you cannot enforce what you cannot define

**Exhaustion is a property of the CONTACT SET, not of the company.** An account
with six contacts where one person got one dial is not a touched account — it
is one-sixth of an account. Almost all of the "I already tried them" problem
lives in that gap.

A **contact** is resolved when any of:

- **Promoted** — `Ever Right POC`, or the stage moved up. Not exhausted, won.
- **Terminally closed** — `Exit Reason` set, Wrong POC, do-not-call, left the
  company.
- **Attempt ceiling reached** — N attempts, no connect (below).

An **account** is exhausted when every known contact is resolved *and* no new
contact has been found on it. It then leaves the queue by one of three doors,
all of them legitimate and all of them recorded:

| Door | Means | Already built? |
|---|---|---|
| **Converted** | moved up the ladder | yes — the rungs |
| **Exhausted** | everybody resolved, nobody bit | **no** |
| **Deprioritised** | a human decided it is not worth it | yes — Focus, with reasons |

The middle door is the missing one. Without it people use Deprioritise for
everything, and then you cannot tell "we worked it properly and it's dead" from
"we couldn't be bothered" — which are the two things this whole exercise exists
to separate.

### An attempt is a day, not a dial

Five dials in ten minutes on a Tuesday afternoon is **one attempt**. So the
ceiling counts:

> N attempts, on N **distinct days**, spanning at least D days, across at least
> two **times of day** (before/after ~1pm), with no connect.

Call Log already has `Called At`, so all three are free. Without the
distinct-day rule the ceiling is reachable in a coffee break and the whole
policy is theatre.

---

## 2 · Set N from your own data, not from a number that sounds right

Do not pick 5 because five is what people say. **Compute the connect rate by
attempt number** from Call Log:

> Of contacts reaching a 1st attempt, what share connected? A 2nd? A 6th?

If the 6th attempt still connects 9% of the time, a ceiling of 4 is throwing
away real money. If the 3rd connects 1%, a ceiling of 6 is burning the day.
Set N where the marginal connect rate stops paying for the dial.

**This is an afternoon's work and it decides the entire policy.** It may also
tell you the real problem is somewhere else — the common finding is that the
drop-off is between attempt 1 and attempt 2, in which case the fix is not a
ceiling at all, it is that nobody is making a second call.

Do this before building anything.

---

## 3 · What exists and what does not

| Needed | Status |
|---|---|
| Which contact each call was to | **Exists** — `Call Log → Contact` link |
| Which company each contact is on | **Exists** — `Contacts → Company` link |
| Outcome and timestamp per call | **Exists** — `Outcome`, `Called At` |
| Whether a contact was ever reached / is closed | **Exists** — `Ever Picked`, `Ever Right POC`, `Exit Reason` |
| The deprioritise door, with reasons | **Exists** — Focus / Focus History |
| **Attempt count per contact that survives the prune** | **MISSING, and actively being lost** — see below |
| The exhausted door | **Missing** — one button, one reason list |
| Account coverage (tried / untried / resolved) | **Missing** — pure computation over the above |
| A cap on open accounts | **Missing** — §5 |

### The one real gap

The fix is **not** longer retention. The prune exists for a good reason: at
1,200 calls a day, 90 days is ~54,000 rows and Airtable counts records across
the whole base — `CALL_RETAIN_DAYS=30` is already a deliberate concession.

The fix is **three counters on the Contact**, written on every save, which
survive the prune because they are not call rows:

```
Attempts              number, monotonic
Distinct Attempt Days number, monotonic
Last Attempt At       dateTime
```

Same idiom as `KPI Rank` / `KPI Rank At` — a durable derived value the proxy
maintains, never a formula. Cheap, and it makes exhaustion answerable over the
account's whole life instead of over the last thirty days.

This is the most urgent item on the page, and the smallest.

---

## 4 · The numbers

### On one account — what the BD sees

```
6 contacts · 4 tried · 1 connected · 2 never dialled
NOT EXHAUSTED — 2 contacts nobody has called · last touch 9 days ago
```

**"Never dialled" is the whole thing.** Today an account reads as worked
because somebody on it got a dial, and the two people who would actually have
taken the call are invisible.

### Per BD — what the dashboard shows

Three numbers, and they only mean anything together:

- **Accounts opened** — ≥1 dial. This is today's "Companies reached".
- **Exhaustion rate** — closed-out ÷ opened.
- **Abandoned** — opened, not resolved, no dial in 14 days, not deprioritised.

**Abandoned is the number that names your problem.** Right now a BD scores well
on Companies reached by touching forty accounts once each. Abandoned makes
exactly that visible, with names on it, and it is probably the single highest-
leverage number in this document.

### Depth, as a shape and not as a mean

Mean dials per account hides everything. Show the distribution:

```
accounts opened by attempts made
  1 attempt   ████████████████████  62
  2–3         ██████                19
  4–6         ███                    8
  7+          █                      3
```

A team that exhausts looks like a hump. A team that skims looks like that — a
spike at one. You can read the problem off the shape in a second, which is not
true of any average.

---

## 5 · The enforcement — a cap, not a report

This is the actual answer to *"people keep demanding new accounts"*.

> **A BD holds at most K open accounts. A new one is released only when one
> closes** — converted, exhausted, or deprioritised with a reason.

Three doors, all fine, all recorded. Nobody is trapped with an account they
believe is dead; they just have to say so, once, and that costs five seconds.

**Why a cap rather than a metric:** a metric is an argument, and you will have
it again next week. A cap is not an argument. The request changes shape on its
own — from "give me more accounts" to "which of my open ones can I close?" —
and the system can answer that, because it knows which of them have contacts
nobody has dialled.

### Where it lives: reorder the queue

`/queue` already exists. Change what it serves, in this order:

1. Open accounts with an **overdue follow-up** (the RCA gates and the TAT work
   list already identify these)
2. Open accounts with an **undialled contact** ← the exhaust-it slot
3. **New** accounts — and only when the person is under the cap

The BD never faces an empty screen; they face their own unfinished work. That
is the behaviour change, and it requires no willpower and no meeting.

### Choosing K

Roughly: daily dial capacity × cycle length ÷ attempts per account. Start
around 25 and move it from the **abandoned** count, not from opinion. If
abandoned goes to near zero, K is right or too low; if it stays high, K is
still too high.

---

## 6 · The three ways this gets gamed

A metric with somebody's name on it will be gamed, and a plan that does not say
how is a plan that makes behaviour worse.

| The move | What stops it |
|---|---|
| Mark everything exhausted, or deprioritise on sight | Deprioritise already demands a reason. Add a **monthly human review of ten sampled closures**. The audit is the control; the reason field on its own is just a dropdown. |
| Pad the dial count — five calls in five minutes | The distinct-day and time-of-day rule in §1. An attempt is a day. |
| Stop opening new accounts, to protect the rate | **Never show exhaustion rate without accounts opened.** Neither number is published alone. |
| Open only the easy accounts so they close fast | Watch exhaustion rate against SQL rate. Rising exhaustion with flat SQL means people are closing accounts, not working them. |

---

## 7 · The tension with TAT — say it out loud now

Capping the queue will make **created → first reachout** worse, because
unallocated leads sit longer. That is the honest trade, it will appear on the
TAT page the week the cap ships, and somebody will call it a regression.

Split that measure before it happens:

- **created → allocated** — a management number. Is the list being handed out?
- **allocated → first reachout** — the BD's number. Once it is yours, how fast
  do you touch it?

A working cap pushes the first up and leaves the second flat. If the second
degrades too, K is set too low — and that is a real signal rather than an
argument about whether the cap was a good idea.

---

## 8 · Display

- **On the account, while calling** — the coverage strip from §4, one line. And
  beside Focus / Deprioritise, an explicit **Exhausted** button with its own
  short reason list. The third door has to be one click, or people use
  Deprioritise for everything and the distinction you built this for is lost on
  day one.
- **On the queue** — the cap, always visible: `19 of 25 open · 6 slots`. Seeing
  the slot count is most of the behaviour change, before any rule is enforced.
- **On the dashboard** — opened / exhaustion rate / abandoned per BD, with the
  depth histogram beneath.
- **Nothing else.** One strip, one counter, one row and one chart. This is not a
  fifth tab.

---

## 9 · Order

1. **Nothing.** Run the connect-rate-by-attempt-number query (§2). It sets N,
   and it may relocate the problem entirely. An afternoon.
2. **The three counters on Contacts** (§3). Do this next regardless of
   everything else on this page: until it exists, every month quietly deletes
   the history the rest depends on.
3. **Account coverage and the "never dialled" count** on the account strip.
   Pure computation on top of (2).
4. **Abandoned, on the dashboard.** This alone may solve most of it — people
   change when the number has their name on it, well before any cap exists.
5. **Reorder the queue** so open work comes before new accounts. Behaviour
   change with no policy fight.
6. **The cap, last** — once (4) has shown you what K should be.

Steps 2 and 4 are where the value is concentrated. The cap is the thing you
asked for, but it belongs at the end: a cap chosen from a guess will be wrong,
and being wrong once is how a good rule gets argued away.
