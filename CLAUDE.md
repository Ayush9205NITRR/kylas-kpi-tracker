# Enout BD Call Console

Claude Code reads this file automatically at the start of every session in this repo. It is the
short version. `UI-SPEC.md` has the full design system, `HANDOFF.md` has the product rules.

## What this is

A data-entry console for BD associates making **100–200 cold calls a day**. It sits **beside**
Kylas CRM — Kylas stays the system of record, this console is where the associate lives during a
dialling session.

`enout-call-console.html` is the reference prototype. Open it in a browser before changing
anything. It is a single self-contained file: inline CSS, vanilla JS, no build step.

## The rule that governs every UI decision

**85% of calls need near-zero typing.** Roughly 65% are no-answer, 20% wrong person, 12% partial,
3% full discovery. Anything that costs a click on every call costs 200 clicks a day.

So: fast on the empty case, granular on the rich one. If a change makes the common case slower, it
is wrong even if it makes the rare case nicer.

## Non-negotiables

Do not undo these without asking. Each was arrived at after a rejected alternative.

1. **Split screen, everything on one page.** Contact left, events right, each scrolling
   independently, tabs below 960px. A wizard / stepper / one-question-per-screen flow was built and
   rejected — a real conversation jumps around and a stepper forces backwards navigation.
2. **Budget, timeline and pax stay free text.** They hold what the prospect actually said —
   "approx 8L, not signed off". Never convert to dropdowns or range pickers.
3. **Event detail is a fill-in-the-blank sentence**, not four labelled boxes:
   `Around ___ people, ___. Budget ___.` Borderless auto-sizing inputs, dashed underline.
4. **One chip per event type, one card per chip.** Tapping a lit chip removes it. No duplicates.
5. **Past / Now lives on the card**, echoed back onto the chip in colour. One chip row, never two.
6. **MQL → Right POC is derived, never typed.** Any of budget | timeline | pax filled on any row,
   past or current → Right POC. Otherwise MQL.
7. **Required fields grow with the stage** and block save. See `HANDOFF.md` §5.
8. **Remarks sits in its own block** at the bottom of the card, on its own background, so it never
   competes with the numbers.

## Colour discipline

One accent — **blue**. Violet carries "past". Rose only marks required. Amber only marks flags.
A five-hue version was built and rejected as rainbow soup. Do not add a hue to distinguish a
section; sections are separated by **structure** (card + header band), not colour.

## Workflow for UI changes

State the change in terms of the layout, not the code: "make the queue rows taller", "the Past
toggle should read as a different state". Then:

1. Read `UI-SPEC.md` for the token or component involved.
2. Change the **token**, not the call site. If a size or colour is hard-coded anywhere, that is a
   bug — move it into `:root`.
3. Keep the type scale at five sizes. Adding a sixth is how the UI drifted before.
4. Re-open the file in a browser and check both light and dark before saying it is done.

## Still open — ask before assuming

- Full `Pipeline Stage - BD` picklist from Kylas; the list in the prototype is a guess.
- `Source of Data`, `Offsite Timeline`, `Salutation` picklists — same.
- Queue ordering. Currently flat. Probably affects connect rate more than any UI change.
- Telephony. `tel:` link today; a real click-to-call makes last-called-at and recording free.
- Screen sizes the BD team actually uses. The split assumes ~1400px.
