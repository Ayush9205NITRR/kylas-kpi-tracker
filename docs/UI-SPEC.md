# UI spec — Enout BD Call Console

Everything visual in `enout-call-console.html`, written down so it can be rebuilt in any stack
without guessing. Read `CLAUDE.md` first for the rules that govern these choices.

---

## 1. Tokens

All of it lives in `:root`. Change a token, never a call site.

```css
:root{
  /* surfaces — chrome is darkest, panels lightest */
  --ground:#EEF2F8;  /* app background, pane scroll areas */
  --panel:#FFFFFF;   /* cards, bars, inputs */
  --panel2:#F6F8FC;  /* card header bands, remarks block, muted fills */
  --panel3:#E9EEF6;  /* segmented-control track, progress track */

  --line:#DFE5EF;    /* hairlines, card borders */
  --line2:#C7D0DF;   /* input borders, button borders */

  --text:#16202E;    /* headings, values */
  --text2:#55637A;   /* labels, secondary */
  --text3:#8B98AB;   /* placeholders, meta, inactive */

  /* the one accent */
  --blue:#2563EB; --blueSoft:#E8EFFE; --blueLine:#A6C1F7;
  --onBlue:#FFFFFF; --blueDeep:#1D4FD0;   /* hover / pressed */

  /* "past" — a real hue, not grey */
  --slate:#7C3AED; --slateSoft:#F2ECFE; --slateLine:#C3A9FA; --onSlate:#FFFFFF;

  --rose:#D01F3E;  --roseSoft:#FCE8EC;    /* required + error ONLY */
  --amber:#A85F0C; --amberSoft:#FCF1DF;   /* flag-for-cleanup ONLY */

  /* type scale — five sizes, nothing else. RETUNED 2026-09-18, see below. */
  --t-meta:12px;   /* record ids, counts, chip captions, field labels */
  --t-label:13px;  /* buttons, queue secondary, table cells */
  --t-body:14px;   /* inputs, values, the person's name in a row */
  --t-sec:17px;    /* card headings, the person you are calling */
  --t-name:21px;   /* dashboard figures — the only display size */

  /* weight — three, and the heaviest is for a number read first */
  --w-body:400; --w-med:500; --w-strong:600; --w-max:700;

  --f:"Plus Jakarta Sans","Helvetica Neue",Arial,sans-serif;
  --r:8px;         /* inputs, buttons, chips, cards — one radius */
  --sh:0 1px 2px rgba(22,40,70,.04);
}
```

**Naming convention.** `--x` is the solid, `--xSoft` the tinted background, `--xLine` the border,
`--onX` the text that sits on the solid. Any new state colour follows the same four.

**Weights.** 400 body, 500 input values and secondary, 600 labels and buttons, 700 emphasis,
**800 for anything ≥ `--t-sec`**. Plus Jakarta Sans is wide, so everything at 800 also takes
`letter-spacing:-.028em`. Without that the headings read loose.

**Dark mode** redefines only the tokens, twice: once under
`@media (prefers-color-scheme:dark){:root:not([data-theme="light"])}` and once under
`:root[data-theme="dark"]`. Never define a colour only inside one of those blocks.

---

## 2. Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ .bar      logo · Calls n/target · ACCOUNT ROLLUP · Queue/Shortcuts/…   │  auto
├───────────────────────────────────────────────────────────────────────┤
│ .callbar  Name + qual badge · ☎ dial · meta strip ·      Save & next   │  auto
├────────────┬──────────────────────────┬───────────────────────────────┤
│ .queue     │ #paneL  Basic information│ #paneR  Event & vendor        │  1fr
│  368px     │                          │                               │
│            │  Who you're calling      │  Events                       │
│  search    │  Where they came from    │  Before you hang up           │
│  filters   │  Where this stands       │                               │
│  contacts  │                          │                               │
├────────────┴──────────────────────────┴───────────────────────────────┤
│ .foot     what's still needed  ·  Flag · Reset · Save & next           │  auto
└───────────────────────────────────────────────────────────────────────┘
```

`.app` is `height:100%; display:grid; grid-template-rows:auto auto 1fr auto`. The three columns
each scroll independently — this is the point of the layout, so the phone number stays visible
while the associate types event detail.

**Breakpoints**

| Width | What changes |
|---|---|
| ≤1280px | account rollup drops company name and contact count |
| ≤1120px | queue hides (still reachable via the Queue button) |
| ≤1080px | call-bar meta strip wraps to its own line |
| ≤980px | account rollup hides entirely |
| ≤960px | the two panes become tabs (`Basic info` / `Event & vendor`) |
| ≤640px | two-column field grids collapse to one |

Field grids also collapse via `@container (max-width:540px)` — the pane is a container, so a grid
folds when the *pane* is narrow, not just the window. Keep `container-type:inline-size` on
`.pscroll`.

---

## 3. Components

### Section card
Every section is a card. Structure separates sections, colour never does.
```html
<section class="card">
  <div class="cardH"><h2>Who you're calling</h2><span class="sub">2 tagged</span></div>
  <div class="cardB grp"> …fields… </div>
</section>
```
Header band is `--panel2` with a `--line` bottom border, heading at `--t-sec`/800. Body padding
22px, `.grp` stacks children with `gap:22px`.

### Field
```html
<div class="f">
  <label for="x">Company <span class="req">*</span></label>
  <input class="in" id="x">
</div>
```
Inputs: 34px min-height, 7/10 padding, `--t-body`, weight 400, `--line2` border, focus is
`--blue` border + 3px `--blueSoft` ring. The asterisk is rendered **dynamically** from
`isReq(a,id)` — a field is only starred while it is actually required at the current stage.

### Compact type selector
Email and phone put their type picker in the label row (`.fhead` + `select.mini`) so the value
input keeps the full width. With one entry the row is just the value; a second entry switches both
to full rows with a primary radio and a delete. This is what makes the two-column grid fit.

### Event chip
```html
<button class="tc now-on"><i class="dot"></i>Employee offsites</button>
```
`.past-on` → violet fill scheme, `.now-on` → blue. Unlit chips carry a grey dot. Chip state is
derived from whether a card exists, never stored separately.

### Event card
```html
<div class="ev is-now">
  <div class="evh">
    <div class="seg"><button aria-pressed="false">Past</button><button aria-pressed="true">Now</button></div>
    <span class="t">Employee offsites</span><button class="del">×</button>
  </div>
  <div class="evb">
    <p class="sent">Around <span class="bl"><input></span> people, … </p>
    <div class="strip"><!-- phrase chips, on focus only --></div>
  </div>
  <div class="evnote"><label>Remarks</label><textarea></textarea></div>
</div>
```
Three bands: tinted header (state colour), body (the sentence), remarks on `--panel2`. Border and
header tint both follow `.is-past` / `.is-now`.

**Blanks** (`.bl input`) are borderless with a 2px dashed underline, centred, weight 700, and
auto-size in JS: `width = max(min, (value||placeholder).length * 9 + 22)`. Focus turns the
underline solid blue and fills `--blueSoft`.

**Phrase chips** appear in `.strip` only while a blank has focus, scoped to that blank. They
**append** to the text, never replace. `onmousedown → preventDefault` so focus survives the click.

### Queue row
```html
<button class="qi q-poc">
  <span class="n">Priyank Tewari</span>
  <span class="c">nutritap · Head of People Ops</span>
  <span class="row">
    <span class="badge poc">Right POC</span>
    <span class="stage">Qualifying</span>
    <span class="marks"><i class="li">in</i> ⚑ ✓</span>
  </span>
</button>
```
State reads twice: a 6px left stripe (`.q-poc` blue / `.q-mql` grey) and one badge. Stage is plain
text, not a pill — it is secondary and a pill made it compete. Name 21px/800, company 16px/500.

### Account rollup
Sits in the top bar. Counts the three metrics across **all contacts at the same company**, not this
session. Cumulative: an SQL contact also counts in Discovery and Right POC, so the funnel reads
straight down.

---

## 4. States and semantics

| Meaning | Treatment |
|---|---|
| Active / upcoming / interactive | `--blue` |
| Past, already happened | `--slate` (violet) |
| Required, missing | `--rose` — only ever this |
| Flagged for cleanup | `--amber` — only ever this |
| Inactive, placeholder, meta | `--text3` on `--panel2` |

Nothing else gets a colour. If a new state needs one, argue for it first.

---

## 5. Motion

Almost none, on purpose. Dial button: `transform:scale(.97)` on press, and a ringing icon while a
call request is out. Meter width transitions 0.3s. Everything else is instant — at 200 calls a day
an animation is a delay. All of it respects `prefers-reduced-motion`.

---

## 6. Copy rules

Labels are questions an associate would actually ask, not field names.

| Not this | This |
|---|---|
| Vendor Info | Who handles this for them today? |
| Next Call Date | Call them back on |
| Designation | Role |
| Source of Data | Came from |
| Enout service offering | I pitched what Enout does |

Validation never scolds before you act. At rest the footer reads what is still needed as **clickable
links** — clicking one scrolls to that field and focuses it. Save is disabled until the list is
empty.

---

## 7. Checklist for any UI change

- [ ] Changed a token, not a call site
- [ ] Still five type sizes
- [ ] No new hue
- [ ] No-answer call still costs two keystrokes
- [ ] Works at 400px and at 1600px
- [ ] Both light and dark checked in a browser


---

## The 2026-09-18 calm-down

Ayush: *"the UI still looks very cluttered, which looks like a console, a proper
mechanical console… not very motivating, not very clean."* He named Lusha and
Airtable.

He was right, and the cause was measurable rather than a matter of taste.

**Body text was 18px and labels 17px** — about a third larger than any modern
SaaS grid, and at that size nothing can recede. Every label competed with every
value. **Almost everything was weight 700 or 800**; when everything is bold,
bold stops meaning anything. Every card had a border *and* a shadow, so the page
read as stacked panels rather than one surface. Micro-labels were uppercase and
letterspaced, which is the single most "instrument panel" tic there is.

What changed — tokens, not call sites, per CLAUDE.md:

| | before | after |
|---|---|---|
| scale | 14 / 17 / 18 / 23 / 27 | **12 / 13 / 14 / 17 / 21** |
| weights in use | 700, 800 everywhere | **400 · 500 · 600** |
| card | border + shadow, r14 | one hairline, r8 |
| input | 57px tall, 14/17 padding | 34px tall, 7/10 |
| queue row | card, r12, 6px bar, shadow | list row, r6, 3px bar |
| dial button | 21px in a 60px slab | 14px in a 32px button |
| micro-labels | UPPERCASE + .04em | sentence case |

Measured on the call console afterwards: **400×78, 500×40, 600×27** — not one
700 or 800 on screen — and **5 cards visible without scrolling where 2 fitted
before**.

### The contrast this exposed

Shrinking the scale is exactly what turns a borderline grey into an unreadable
one, so every ink token was re-checked against all three surfaces in both
themes. Three failed AA at the new size and were darkened:

| token | was | now | why |
|---|---|---|---|
| `--text3` | #8D929B, 3.1:1 | **#696E76**, 4.8:1 | muted ink is now 12px |
| `--amber` | #B4690E, 4.2:1 | **#A85F0C**, 4.6:1 | under AA already |
| `--rose` | #DC2647, 4.48:1 | **#D01F3E**, 5.0:1 | marks required fields |

All seven ink tokens now clear 4.5:1 on white, `--panel2` and `--ground` in
light, and on `--panel`, `--panel2` and `--ground` in dark.

**Not changed:** one accent, violet for past, rose for required, amber for
flags; five type sizes; split screen; structure separates sections, not colour.
Every non-negotiable in CLAUDE.md survives — this was a retune of the scale
those rules are expressed in, not a new design.
