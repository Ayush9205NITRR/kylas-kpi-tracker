# Enout BD Call Console — production handoff

Hand this file plus `enout-call-console.html` to the Claude Code instance that will build the
production version. The HTML is a **working, clickable prototype** — the layout, interaction model
and validation rules are settled. Everything behind them is mocked.

---

## 1. What this is

A data-entry console that sits **beside Kylas CRM**, not on top of it. BD associates make ~100 cold
calls a day; Kylas' own contact form is too slow for that volume. This console is the surface they
live in during a dialling session. Kylas stays the system of record.

Open `enout-call-console.html` in a browser. No build step, no dependencies, no server. It is a
single file: inline CSS, inline vanilla JS, one Google Fonts link (IBM Plex Sans + Mono).

Things worth clicking before you write any code:

- Press `1`–`4` — the outcome buttons in the call bar. `1` (no answer) collapses the right pane.
- Load "Devanshi Kalro" from the queue — a fully populated record.
- Load "Arjun Sethi" — pipeline stage `Qualifying`, so **Mode of meeting is hidden**.
- Shrink the window below 900px — the split becomes two tabs.
- `?` for the keyboard sheet.

---

## 2. Layout

```
┌──────────────────────────────────────────────────────────────┐
│ top bar — today's call count / target                        │
├──────────────────────────────────────────────────────────────┤
│ call bar — who · dial + timer · outcome 1-4 · Save & next    │
├──────────┬─────────────────────────┬─────────────────────────┤
│ queue    │ LEFT PANE               │ RIGHT PANE              │
│          │ Basic information       │ Event & vendor          │
│ search   │                         │                         │
│ filters  │ POC (grid)              │ Past    (n rows)        │
│ contacts │ Source                  │ Current (n rows)        │
│          │ Stage & follow-up       │ Vendor & offering       │
├──────────┴─────────────────────────┴─────────────────────────┤
│ footer — validation msg · flag · reset · Save & next         │
└──────────────────────────────────────────────────────────────┘
```

Each of the three columns scrolls independently. The queue collapses via the **Queue** button.
Below 900px the two panes become tabs; below 860px the queue hides.

---

## 3. Data model

```js
contact = {
  kid,                  // Kylas contact id
  salutation, pocName, company, linkedin, designation,
  emails: [{ type, value, primary }],          // type: Office | Personal | Other
  phones: [{ type, cc, value, primary }],      // type: Mobile | Work | Home | Other
  stage,                // Pipeline Stage - BD
  nextCallDate, nextCallTime,
  source, remarks, offsiteTimeline, owner,

  past:    [ eventRow ],   // overlay-owned
  current: [ eventRow ],   // overlay-owned
  vendorInfo,              // Internal | Vendor Exists | First Event | No Info
  serviceOffering,         // boolean — single checkbox
  modeOfMeeting,           // In Person | Virtual | Calls | Text

  done, flagged            // session-local, see §7
}

eventRow = { eventType, budget, timeline, pax, remarks }
```

`eventType` is a single select. `budget`, `timeline`, `pax`, `remarks` are **long text** — free
form on purpose. Associates capture what the prospect actually said ("Approx 8L, not approved"),
not a normalised number. Do not turn these into pickers.

Event rows hang off the **contact**, not the company. Two POCs at the same company keep separate
event histories.

---

## 4. Kylas field map

| Console field | Kylas field | Direction |
|---|---|---|
| Salutation, Name, Designation | `salutation`, `first_name`, `designation` | read + write |
| Email | `emails[] {type, value, primary}` | read + write |
| Phone number | `phone_numbers[] {type, dial_code, value, primary}` | read + write |
| Company | `company` (lookup) | read + write |
| LinkedIn | `linkedin` | read + write |
| Source of data | `source_of_data` | read + write |
| Owner | `owner_id` | read + write |
| Pipeline stage — BD | `pipeline_stage_bd` | read + write |
| Next call date + time | `next_call_date` | read + write |
| Remarks | `remarks` | read + write |
| Offsite timeline | `offsite_timeline` | read + write |
| Past / Current event rows | — | **overlay store**, keyed on `contact_id` |
| Vendor info | — | overlay store |
| Service offering (bool) | — | overlay store |
| Mode of meeting | — | overlay store |

**No Kylas schema change is required.** Everything the overlay adds lives in its own store and
joins back on `contact_id`.

Ayush has the Postman collection for the Kylas API — ask him for it rather than guessing endpoints.

---

## 5. Rules that must survive the rewrite

These were designed deliberately. Keep them.

**Outcome → stage.** The call bar's four buttons are the only way an associate sets a stage. They
never pick from the stage dropdown during a call.

| Key | Outcome | Sets `pipeline_stage_bd` to |
|---|---|---|
| `1` | No answer | Could Not Connect |
| `2` | Wrong POC | Wrong POC |
| `3` | Right POC | Qualifying |
| `4` | Discovery | Discovery Call Done |

**No-answer short circuit.** When stage is `Could Not Connect`, the right pane collapses to a one
line note. ~65 of 100 calls end here; they must cost two keystrokes.

**Mode of meeting is conditional.** Renders only when stage is one of `MEETING_STAGES`. See §8 —
this list is a placeholder.

**Required before save:** POC name, at least one phone number, owner. Nothing else blocks.

**One entry vs many.** Email and phone render as a bare input when there is one of them (type
selector moves up into the label row). A second entry switches both to full rows with a primary
radio and delete. This is what makes the two-column grid fit.

---

## 6. Speed features — the point of the whole thing

Budget per call is roughly 25 seconds of data entry. These earn it:

- **Click-to-call** — `tel:` link, starts the call timer.
- **Keyboard path** — `1`–`4` outcome, `Enter` save + next, `C` dial, `F` flag, `J`/`K` queue
  navigation, `/` search, `?` help.
- **Save & next auto-advance** — saves, picks the next queue record, resets both panes to top,
  returns to the Basic tab on narrow screens. Undo lives in the toast for 4 seconds.
- **Quick-insert chips** under Budget / Timeline / Pax. Clicking appends a phrase to the existing
  text, it does not replace it. `QUICK` in the source holds the phrase lists.
- **Date chips** — Tomorrow / +3 days / Next week on next call date.
- **Flag for cleanup** (`F`) — mark a record mid-call, batch-fix the flagged ones at end of day.
  Separates dialling from typing, which is the single biggest win at this volume.
- **Pace counter** — calls logged today against target.

---

## 7. What is mocked — replace all of it

| Prototype | Production |
|---|---|
| `DATA` array, ~7 invented contacts | Kylas API. All names, numbers and emails are fake. |
| `saveNext()` → toast only | PATCH to Kylas + write to the overlay store |
| `done`, `flagged` in memory | Persist. `done` should mean "logged in this session", not a field. |
| Queue order = array order | Real priority order — see §8 |
| Search filters the local array | Server-side search |
| No auth | Session + per-owner record scoping |
| No autosave | Autosave drafts. Losing a call's notes to a refresh is unacceptable. |
| Call timer is decorative | Wire to telephony if available — see §8 |

Everything else — layout, CSS, interaction, validation, conditional rendering — is intended as-is.

Port it to whatever stack the team already runs. If there is no existing frontend, plain
React + Vite is fine; there is nothing here that needs more.

---

## 8. Open decisions — ask Ayush, do not guess

1. **`Pipeline Stage - BD` full picklist.** The prototype has a guessed list in `STAGES`. Get the
   real values from Kylas.
2. **Which stages open Mode of meeting.** `MEETING_STAGES` is a placeholder. Ayush said he would
   confirm these.
3. **`Source of Data`, `Offsite Timeline`, `Salutation` picklists** — same, currently guesses.
4. **Queue ordering.** Currently flat. This is the highest-leverage unbuilt thing: the order the
   100 numbers get dialled in decides the connect rate. Candidate rule — next-call-date due first,
   then V-score/W-score (Ayush has an existing account scoring model), then the rest.
5. **Telephony.** Is Exotel / Knowlarity / Ozonetel wired into Kylas? If so, replace the `tel:`
   link with a real click-to-call, and `last_called_at` plus call recording become automatic.
   Manual dialling costs ~15 minutes across 100 calls.
6. **Screen sizes.** The split screen assumes ~1400px. If the BD team is on 13" laptops, default
   the queue to hidden and consider a 60/40 split instead of 50/50.

---

## 9. Starting the other session

```bash
mkdir enout-console && cd enout-console
cp ~/Downloads/enout-call-console.html .
cp ~/Downloads/HANDOFF.md .
git init && git add -A && git commit -m "Prototype + handoff"
claude
```

Opening prompt:

> Read HANDOFF.md, then open enout-call-console.html and click through it in a browser before
> writing anything. It is a settled UI prototype for a BD call console that sits beside Kylas CRM.
> I want it rebuilt for production against the real Kylas API — I have the Postman collection.
> Keep the layout, keyboard model and validation rules exactly as they are. Section 8 lists
> decisions still open; ask me those before you start.
