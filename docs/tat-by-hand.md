# TAT in a spreadsheet — the sample, the formulas, the answer key

Ayush, 2026-09-27: *"sample data how would it look, what formula to use and
how can I calculate it."*

This is step 1 of `docs/tat.md` — **compute the numbers before building
anything.** Some of the five will turn out to be boring, and those should not
be built. An afternoon here can delete half a feature.

- **`docs/tat-sample.csv`** — 28 accounts, 4 BDs, deliberately shaped so every
  trap shows up in it.
- **`scripts/tat-from-csv.mjs`** — the answer key. Run it, build the sheet,
  compare. If they disagree, a formula is typed wrong, and finding that now is
  much cheaper than finding it after a number with somebody's name on it has
  been shown in a meeting.

```
node scripts/tat-from-csv.mjs docs/tat-sample.csv --today 2026-09-28
node scripts/tat-from-csv.mjs docs/tat-sample.csv --today 2026-09-28 --working
node scripts/tat-from-csv.mjs export.csv --cohort rightToDiscovery
```

It uses the same `tat.mjs` the product will use. A separate implementation for
the spreadsheet stage would be a second set of answers, and on the day the
dashboard ships nobody would know which was right.

---

## 1 · What the data looks like

Seven columns. **A blank means it has not happened yet** — that is a row the
arithmetic must keep, not skip.

| | A Company | B BD | C Created At | D First Call | E Right POC | F Discovery | G SQL |
|---|---|---|---|---|---|---|---|
| 2 | Alta Foods | Priya | 2026-08-03 | 2026-08-04 | 2026-08-06 | 2026-08-11 | 2026-08-25 |
| 3 | Beacon Textiles | Priya | 2026-08-07 | 2026-08-11 | 2026-08-14 | 2026-08-21 | 2026-09-04 |
| 7 | Fenwick Group | Priya | 2026-08-01 | 2026-08-03 | 2026-08-05 | | |
| 9 | Hexa Logistics | Priya | 2026-09-20 | | | | |
| 26 | Vriddhi Chemicals | Devansh | 2026-09-01 | 2026-09-02 | 2026-09-04 | | |

Row 7 reached Right POC on 5 August and has sat there ever since. Row 9 has
never been called at all. **Those two rows are the point.** A sheet that only
looks at completed journeys cannot see either of them, and they are where the
problem is.

You can export exactly these seven columns out of Airtable today, except
`Created At` — see §7.

---

## 2 · Set up the sheet

Put the as-at date in **`$P$1`** — `2026-09-28` for the sample. Use a cell,
not `TODAY()`, so the sheet gives the same answer tomorrow and can be checked
against the answer key.

Then six calculated columns. **Closed and open go in SEPARATE columns.** If you
put "days so far" for an unfinished step in the same column as finished ones,
`MEDIAN` mixes the two and the number means nothing at all.

| Col | Meaning | Formula (row 2, fill down) |
|---|---|---|
| **H** | Created → First Call | `=IF(OR($C2="",$D2=""),"",INT($D2)-INT($C2))` |
| **I** | First Call → Right POC | `=IF(OR($D2="",$E2=""),"",INT($E2)-INT($D2))` |
| **J** | Right POC → Discovery | `=IF(OR($E2="",$F2=""),"",INT($F2)-INT($E2))` |
| **K** | Discovery → SQL | `=IF(OR($F2="",$G2=""),"",INT($G2)-INT($F2))` |
| **L** | Right POC → Disc, **still waiting** | `=IF(AND($E2<>"",$F2=""),INT($P$1)-INT($E2),"")` |
| **M** | …and past the 30-day gate | `=IF(AND($L2<>"",$L2>=30),1,0)` |

`INT()` strips the time so a call at 23:50 and one at 00:10 next morning is one
day. Repeat L and M for whichever other steps you care about.

---

## 3 · The summary block — one step, all BDs

BD names in `$R$3:$R$6`, `TEAM` in `$R$7`. This is for **Right POC →
Discovery** (column J); swap the column letter for the others.

| Col | | Per BD (row 3) | Team (row 7) |
|---|---|---|---|
| S | **n** (finished) | `=IFERROR(COUNT(FILTER($J$2:$J$29,$B$2:$B$29=$R3)),0)` | `=COUNT($J$2:$J$29)` |
| T | **median** | `=IFERROR(MEDIAN(FILTER($J$2:$J$29,$B$2:$B$29=$R3)),"")` | `=MEDIAN($J$2:$J$29)` |
| U | **p75** | `=IFERROR(SMALL(FILTER($J$2:$J$29,$B$2:$B$29=$R3),CEILING(0.75*$S3)),"")` | `=SMALL($J$2:$J$29,CEILING(0.75*$S$7))` |
| V | **waiting** | `=IFERROR(COUNT(FILTER($L$2:$L$29,$B$2:$B$29=$R3)),0)` | `=COUNT($L$2:$L$29)` |
| W | **oldest** | `=IFERROR(MAX(FILTER($L$2:$L$29,$B$2:$B$29=$R3)),"")` | `=MAX($L$2:$L$29)` |
| X | **overdue** | `=SUMIFS($M$2:$M$29,$B$2:$B$29,$R3)` | `=SUM($M$2:$M$29)` |
| Y | **vs team** | `=IF($S3<5,"thin",$T3-$T$7)` | — |

### Three things in there that are not obvious

**`SMALL(…, CEILING(0.75*n))` and not `PERCENTILE`.** Sheets' and Excel's
`PERCENTILE` interpolates between two observations and will disagree with the
code. `SMALL` with `CEILING` picks the nearest actual value — so "the slowest
quarter took at least this long" points at a real account somebody can open.

**`=IF($S3<5,"thin",…)`.** A median over four accounts is a coin flip with
somebody's name on it. Below five, show no comparison at all.

**Columns S and V always travel together.** That is the whole discipline. See
§5 for what happens when they don't.

### On Excel before 365 (no `FILTER`)

Array formulas, entered with **Ctrl+Shift+Enter**. Note the `*($J$2:$J$29<>"")`
— without it, blanks become zeros and drag every median to the floor:

```
n       =SUM(($B$2:$B$29=$R3)*($J$2:$J$29<>""))
median  =MEDIAN(IF(($B$2:$B$29=$R3)*($J$2:$J$29<>""),$J$2:$J$29))
```

---

## 4 · The answer key

Sample data, as at 2026-09-28, calendar days. Your sheet should match this
exactly.

**Right POC → Discovery** — gate 30 days

| BD | n | median | p75 | vs team | waiting | oldest | overdue |
|---|---|---|---|---|---|---|---|
| Devansh | 5 | **5** | 5 | **−0.5** | **4** | 24 | 0 |
| Neha | 2 | 1.5 | 2 | *thin* | 0 | – | 0 |
| Priya | 5 | **9** | 11 | **+3.5** | 2 | 54 | 1 |
| Rubal | 6 | 7 | 10 | +1.5 | 0 | – | 0 |
| **TEAM** | 18 | 5.5 | 9 | — | 6 | 54 | 1 |

Check one by hand. Priya's five finished steps are 5, 7, 9, 11 and 20 days;
sorted, the middle one is **9**. p75 is `CEILING(0.75 × 5)` = the 4th value =
**11**. Team is 18 values, so the median is the mean of the 9th and 10th =
(5 + 6) ÷ 2 = **5.5**.

**Read the Devansh row against the Priya row.** Devansh has the fastest median
on the team, half a day quicker than everybody. He also has four accounts
stalled and Priya has two. On the median alone he is the best performer in the
company. He is the problem. That is §5.

---

## 5 · The trap, in your own sheet

Run the cohort view on the same file:

```
month      arrived  in gate      %  still open   settled
2026-08         14       13  92.9%           1   yes
2026-09         10        5    50%           5   no — still inside the gate
```

August converted 13 of 14 inside 30 days. September has converted 5 of 10.
**The month got twice as bad and the medians barely moved**, because the
accounts that went wrong have no end date and so are in nobody's average.

Two formulas keep you honest. In the row block:

| Col | Meaning | Formula |
|---|---|---|
| **N** | month it reached Right POC | `=IF($E2="","",TEXT($E2,"YYYY-MM"))` |
| **O** | converted inside the gate? | `=IF($E2="","",IF(AND($F2<>"",INT($F2)-INT($E2)<=30),1,0))` |

Then per month:

```
arrived  =COUNTIF($N$2:$N$29,"2026-08")
in gate  =SUMIFS($O$2:$O$29,$N$2:$N$29,"2026-08")
%        =in gate / arrived
```

**That denominator is locked once the month ends.** Nobody can improve it by
letting accounts rot, which is exactly what a median over completed
conversions allows.

One caution: **do not read the newest month.** September's accounts have not
all had their 30 days yet, so its number can only go up. A cohort chart always
slopes down at the right-hand edge and somebody always reads that as a
collapse. The answer key prints `settled: no` for exactly this reason.

---

## 6 · Working days

`NETWORKDAYS` counts both endpoints, so subtract the start day to match the
code:

```
=IF(OR($C2="",$D2=""),"",NETWORKDAYS($C2,$D2)-NETWORKDAYS($C2,$C2))
```

Fri → Mon gives **1**, which is right. Same day gives 0.

It changes the answer more than you would expect. Created → first reachout,
same data:

| | n | median | p75 | Priya vs team |
|---|---|---|---|---|
| calendar days | 26 | 1 | 2 | **+1** |
| working days | 26 | 1 | 1 | **0** |

Priya reads a day slower than the team on calendar days and **level** on
working days. Nothing she did changed. On any step whose median is under a
week, the weekend *is* the number — so put the unit on the screen, or people go
and fix the wrong thing.

Holidays: `NETWORKDAYS(start, end, $holidays)` takes a third argument. Worth a
small range of Indian holidays before anyone is measured on this.

---

## 7 · The one column you do not have yet

Six of the seven come out of Airtable today. **`Created At` does not exist on
Companies or Contacts.** Kylas returns it and `kylas.mjs:769` already carries
it through as `_kylas.createdAt` — it is simply never written to the base.

So for a first pass, either:

- export `createdAt` straight from Kylas and `VLOOKUP` it in by company id, or
- leave column C blank and compute the four steps that do not need it. The
  script handles a missing `Created At` — those rows just do not appear in the
  two Created rows of the output.

Landing it properly is two lines in `schema.mjs`, two in `sync-kylas.mjs` and a
backfill. Worth doing, because "created → first reachout" is usually the
largest and the cheapest of the five to fix.

---

## 8 · What to do with the result

1. Build the sheet. Check it against §4.
2. Point it at a real export.
3. **Look at the five medians and ask which ones surprise you.** The ones that
   do not are not worth a dashboard.
4. Look at `waiting` and `overdue` before you look at any median. That is where
   the work is — the answer key's work list names the accounts.
5. Then read `docs/tat.md` §6 for the build order, which starts with the two
   things that turned out to matter.
