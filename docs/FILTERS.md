# What you can ask of each column

The accounts list filters the way Airtable does: **pick a column, and the
operators you are offered are the ones that column's type can answer.** A
number does not offer "contains"; a link does not offer "is between"; a date
offers windows relative to today, because "due in the next three days" is a
question that has to keep meaning the same thing tomorrow.

There is one place this is decided — `ACOLS` in `extension/console/views.js`.
Each column carries an `ff` block naming its type and how to read the raw
value off a company. **A column IS a filter field.** They used to be two
lists, and a column added to one and forgotten in the other is invisible: the
column appears, and the only thing that goes wrong is that you cannot filter
on it, which nobody reports as a bug.

`scripts/test-filter-types.mjs` fails if this page and that table disagree.

---

## The six types

| type | operators | value control |
|---|---|---|
| **Text** | contains · does not contain · is · is not · is empty · is not empty | a text box |
| **Single select** | is any of · is none of · is empty · is not empty | a checklist built from the data |
| **Multiple select** | has any of · has none of · is empty · is not empty | a checklist; a row matches if it holds *any* picked value |
| **Number** | is at least · is at most · is · is between · is empty · is not empty | a text box that reads `10M`, `1.2b`, `40`, `₹4.2 Cr` |
| **Date** | is · is before · is after · is within the next *N* days · was in the last *N* days · is empty · is not empty | a date picker, or a day count |
| **Link** | has a link · has none · URL contains · URL does not contain | nothing, or a text box |

---

## Every column, and what it is

| column | type | reads | notes |
|---|---|---|---|
| Company | Text | `name` | |
| Pipeline stage | Single select | Kylas' `Pipeline Stage - BD`, or the POCs' best rung | the checklist includes **No stage** — thousands of allotted accounts have never been given one, and leaving it out makes them unreachable |
| Owner | Single select | `owner` | |
| Source of Data | Single select | `source` | |
| Offsite | Multiple select | `offsite` | the one genuinely multi-valued column: a company can name two quarters, so the checklist means *has any of*, not *is* |
| KPI status | Single select | the derived rung | |
| Last call | **Date** | `lastCalledAt` | the cell shows a band; the filter holds the date. "Before 1 April" and "cold" are different questions |
| Next call | **Date** | `nextCall` | the promised call-back. `is within the next 0 days` is today alone |
| Priority | Number | `enrich.pri` | the team's own `at_priority` |
| Revenue | Number | `enrich.rev` | **US dollars**, as Apollo stores them. Nothing is converted |
| Rev / employee | Number | `enrich.rpe` | dollars |
| Employees | **Single select** | `enrich.emp` | Apollo hands over a *band* (`51-200`), never a count — so it is a select however much it looks like a number. Ordered by where each band starts, not alphabetically |
| Total funding | Number | `enrich.fund` | dollars |
| Latest round | Number | `enrich.amt` | dollars. Apollo writes `0` for "no round", which is read as *unknown*, never as zero |
| Funding stage | Single select | `enrich.type` | the latest round's type |
| Account stage | Single select | `enrich.aps` | the **demand team's** `Account Pipeline Stage`, not Kylas'. The two disagree often, and where they do somebody has worked that account somewhere the other side cannot see |
| LinkedIn | Link | `enrich.li` | |
| Boolean post | Link | `enrich.bp` | whichever of the three Boolean columns is filled |

### Three fields that are not columns

The table shows these inside another column's cell, and they earn a filter row
of their own because a band and a date answer different questions.

| field | type | reads |
|---|---|---|
| Focus list | Single select | the ★ on the company name — focus, not picked, deprioritized |
| Last call, banded | Single select | the freshness dot — ≤ 7 days, 8–30, 31–90, 90+, never |
| Days since last call | Number | the same date, as a count |

---

## Rules that hold for every type

- **Empty is not zero, and it is not the smallest.** A company with no revenue
  figure is not "below $10M", it is unknown. It drops out of every
  comparison — `is at least`, `is at most`, `is between`, `is before`,
  `is after` — rather than sorting to one end of it. `is empty` is how you ask
  for it.
- **A half-written condition filters nothing.** A row with no value yet is
  ignored, so the table does not empty itself while you are still typing.
- **An operator a field no longer offers is ignored too.** A shared link
  outlives the build it was made in, and `Next call` used to be a set of
  buckets before it was a date. A leftover condition narrows nothing rather
  than silently emptying the list.
- **Today is this machine's today**, not UTC — an associate in Delhi filtering
  for "due today" at nine in the morning means their today.
- **The chips and the builder both apply**, ANDed. The chips stay because each
  one says what it would give *before* you click it, which a builder can only
  tell you afterwards.
