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

The palette is **`docs/bd-ladder-reference.html`**, verbatim — Ayush supplied it as the design and
asked for it unchanged. It replaced a blue-accent scheme on 2026-09-19. Values live in
`console.css` `:root`; there is exactly one `:root`, and `production.css` declares no tokens of
its own.

One accent — **indigo `--blue`** (the name is historical; the value is the reference's `#4338CA`).
Rose only marks required. Amber — the reference's marigold — only marks flags. "Past" is neutral
grey, because the accent is violet now and past cannot be violet too.

Two systems are allowed a hue of their own, and no third one is:

- **the rung ramp** `--r0..--r5`, one hue stepped in lightness, for the six funnel rungs. Used by
  the ladder's step numbers, the KPI status chips and the board.
- **the freshness scale** `--f-fresh` … `--f-never`, green → olive → marigold → red → grey. This is
  the one place a second hue is earned: it encodes **time**, and a single-hue ramp cannot say
  "called this week" and "not since March" at its two ends.

Do not add a hue to distinguish a section; sections are separated by **structure** (card + header
band), not colour. A five-hue version of the *chrome* was built and rejected as rainbow soup, and
that still holds — the two scales above are data, not decoration.

## Type

Two faces, both **bundled** in `extension/console/fonts/` — never linked from a CDN, because a
font fetched on every open is a DNS lookup and a handshake before the first glyph.

- `--display` Bricolage Grotesque: headings, and the numbers meant to be read first.
- `--f` Instrument Sans: everything else.

Still **five sizes**. Adding a sixth is how the UI drifted before.

## Workflow for UI changes

State the change in terms of the layout, not the code: "make the queue rows taller", "the Past
toggle should read as a different state". Then:

1. Read `UI-SPEC.md` for the token or component involved.
2. Change the **token**, not the call site. If a size or colour is hard-coded anywhere, that is a
   bug — move it into `:root`.
3. Keep the type scale at five sizes, and to two faces. Adding a sixth size or a third face is how
   the UI drifted before.
4. Re-open the file in a browser and check both light and dark before saying it is done.

## Still open — ask before assuming

- Full `Pipeline Stage - BD` picklist from Kylas; the list in the prototype is a guess.
- `Source of Data`, `Offsite Timeline`, `Salutation` picklists — same.
- Queue ordering. Currently flat. Probably affects connect rate more than any UI change.
- Telephony. `tel:` link today; a real click-to-call makes last-called-at and recording free.
- Screen sizes the BD team actually uses. The split assumes ~1400px.
