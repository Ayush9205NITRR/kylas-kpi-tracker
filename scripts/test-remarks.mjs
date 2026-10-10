#!/usr/bin/env node
/* THE NOTE THAT WAS INVISIBLE, AND THEN DELETED.
 *
 *   node scripts/test-remarks.mjs
 *
 * Ayush, 2026-10-08: "notes for a number of companies are not showing up."
 *
 * The console writes a machine-written block into Kylas' remarks field, at the
 * TOP, because the field is usually empty. A BD person who then opens that
 * contact in Kylas finds the top full of machine text and types their note at
 * the END, under it. Both halves of this repo then cut the field at the
 * OPENING marker and kept only what was above it, so that note was
 *
 *   invisible   the console's preview showed nothing
 *   destroyed   the next save wrote the field back without it
 *
 * The second is the reason this file exists: a display bug loses a reading, a
 * write bug loses the data. Both sides now cut the block OUT, between its two
 * markers, and keep whatever is on either side.
 *
 * The strip runs TWICE in two languages — stripAuto() in scripts/kylas.mjs for
 * the save, humanNote() in extension/console/console.js for the preview —
 * because the console is a plain script with no build step and cannot import a
 * module from scripts/. So the console's copy is read out of the file and run
 * here, and every case is asserted against BOTH. A fix applied to one and not
 * the other is the bug this guards.
 */
import { readFileSync } from "node:fs";
import { mergeRemarks, stripAuto, MARK_A, MARK_B, callNotes, kylasRemarksOf, toConsoleContact, logIsAbout } from "./kylas.mjs";

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  if (got === want) { pass++; console.log(`  PASS  ${what}`); return; }
  fail++;
  console.log(`  FAIL  ${what}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

/* ── the console's copy, lifted out of the file and made callable ──────
   Read rather than reimplemented: a reimplementation here would pass while
   the shipped console still had the bug, which is the exact failure this is
   meant to catch. */
const src = readFileSync("extension/console/console.js", "utf8");
const block = src.match(/const MARK_AUTO=[\s\S]*?\n\};\n/);
if (!block) {
  console.error("! could not find humanNote in console.js — has it been renamed?");
  process.exit(1);
}
const humanNote = new Function(`${block[0]}\nreturn humanNote;`)();

const both = (what, input, want) => {
  eq(`${what} — server stripAuto`, stripAuto(input), want);
  eq(`${what} — console humanNote`, humanNote(input), want);
};

const BLOCK = `${MARK_A}\nStage      MQL\nOwner      Ayush\n${MARK_B}`;

console.log("the strip, on both sides");
both("no block at all, the note is the whole field",
     "Wants a Goa venue, 2 nights.", "Wants a Goa venue, 2 nights.");
both("a note above the block survives, as it always did",
     `Prefers WhatsApp.\n\n${BLOCK}`, "Prefers WhatsApp.");
/* THE BUG. */
both("a note BELOW the block survives too",
     `${BLOCK}\n\nMet at the expo, wants Udaipur in Feb.`,
     "Met at the expo, wants Udaipur in Feb.");
both("...and notes on both sides are kept, in order",
     `Called twice.\n\n${BLOCK}\n\nSaid budget is signed off.`,
     "Called twice.\n\nSaid budget is signed off.");
both("a block and nothing else is no note",
     BLOCK, "");
both("empty is empty", "", "");
both("an empty field with only whitespace is no note", "   \n\n  ", "");
/* The old shape: a block with no closing marker. There is no way to know where
   it ended, so everything after it goes — which is what the old code did to
   every field. Keeping that identical means no existing record reads
   differently because of this change. */
both("no closing marker: everything after the block still goes",
     `Above it.\n${MARK_A}\nStage      MQL`, "Above it.");

console.log("\nand the save keeps what the strip keeps");
{
  const held = `${BLOCK}\n\nMet at the expo, wants Udaipur in Feb.`;
  const after = mergeRemarks(held, "Stage      MQL");
  eq("the note is still in the field after a save",
     after.includes("Met at the expo, wants Udaipur in Feb."), true);
  eq("...moved above the block, where the next save will keep it",
     after.indexOf("Met at the expo") < after.indexOf(MARK_A), true);
  /* The property that matters: saving twice must not erode the note. */
  eq("...and a second save does not eat it",
     mergeRemarks(after, "Stage      MQL").includes("Met at the expo, wants Udaipur in Feb."), true);
  eq("...nor a third", mergeRemarks(mergeRemarks(after, "x"), "y")
     .includes("Met at the expo, wants Udaipur in Feb."), true);
}
{
  /* One block, never two. A merge that appended would grow the field on every
     save until Kylas refused it. */
  const once = mergeRemarks(mergeRemarks("Note.", "a"), "b");
  eq("exactly one opening marker after two saves", once.split(MARK_A).length - 1, 1);
  eq("exactly one closing marker", once.split(MARK_B).length - 1, 1);
  eq("the human note is still first", once.startsWith("Note."), true);
}
{
  eq("no block means the field is just the note", mergeRemarks("Note.", ""), "Note.");
  eq("nothing at all stays nothing", mergeRemarks("", ""), "");
}

/* ── the notes on earlier calls ──────────────────────────────────────
   Ayush, 2026-10-09: "Previous remarks fetch nahi ho rahe hai." The update an
   associate types after a call lives on the CALL LOG in Kylas, not in the
   contact's remarks field, so the strip now reads call logs too. Kylas'
   collection documents the request but shows no response, so the reader is
   held to every shape it might plausibly be. */
console.log("\nnotes on earlier calls, from Kylas call logs");
{
  const log = (at, notes, extra = {}) => ({ startTime: at, outcome: "connected", notes, ...extra });
  const shapes = {
    "a bare array": [log("2026-10-01T10:00:00Z", [{ description: "One" }])],
    "content": { content: [log("2026-10-01T10:00:00Z", [{ description: "One" }])] },
    "data": { data: [log("2026-10-01T10:00:00Z", [{ description: "One" }])] },
    "records": { records: [log("2026-10-01T10:00:00Z", [{ description: "One" }])] },
  };
  for (const [name, body] of Object.entries(shapes))
    eq(`read from ${name}`, callNotes(body).map((x) => x.text).join(), "One");
  eq("an unknown shape is no history, not a crash", callNotes({ weird: true }).length, 0);
  eq("nothing at all is no history", callNotes(null).length, 0);

  const got = callNotes({ content: [
    log("2026-09-01T10:00:00Z", [{ description: "<div>Wants Goa,&nbsp;2 nights</div><p>Call after Diwali</p>" }],
        { owner: { id: 7, name: "Muskan Rajpoot" } }),
    log("2026-10-05T10:00:00Z", []),                                     /* a no-answer, nothing typed */
    log("2026-10-07T10:00:00Z", ["typed as a plain string"], { outcome: "LEFT_MESSAGE" }),
  ] });
  eq("a call with nothing typed is left out", got.length, 2);
  eq("newest first", got.map((x) => x.at).join(" "), "2026-10-07T10:00:00Z 2026-09-01T10:00:00Z");
  eq("Kylas' rich-text HTML reads as text", got[1].text, "Wants Goa, 2 nights\nCall after Diwali");
  eq("...and says who typed it", got[1].by, "Muskan Rajpoot");
  eq("a plain-string note is kept", got[0].text, "typed as a plain string");
  eq("the outcome reads as words", got[0].outcome, "left message");
}

/* ── the team's Remarks custom field ─────────────────────────────────
   Ayush, 2026-10-10: "Previous Notes — pull it from cfRemarks (custom field
   created for each contact under the name of remarks)". */
console.log("\nthe Remarks custom field (cfRemarks)");
{
  const c = (cf) => ({ id: 1, customFieldValues: cf });
  eq("read from cfRemarks", kylasRemarksOf(c({ cfRemarks: "Met at the expo, call after Diwali" })),
     "Met at the expo, call after Diwali");
  eq("rich text reads as text", kylasRemarksOf(c({ cfRemarks: "<p>Goa,&nbsp;2 nights</p><p>budget 8L</p>" })),
     "Goa, 2 nights\nbudget 8L");
  eq("a field renamed in Kylas still counts if it says remark",
     kylasRemarksOf(c({ cfBdRemarks: "Wants Udaipur" })), "Wants Udaipur");
  eq("cfRemarks wins over another remark-ish field",
     kylasRemarksOf(c({ cfOldRemarks: "old", cfRemarks: "new" })), "new");
  eq("no field is no note", kylasRemarksOf(c({ cfPipelineStageBd: 7 })), "");
  eq("no contact is no note", kylasRemarksOf(null), "");
  eq("NOT the built-in remarks field — that is the console's block",
     kylasRemarksOf({ remarks: "Stage MQL", customFieldValues: {} }), "");
  eq("the console's contact carries it as kylasRemarks",
     toConsoleContact({ id: 9, customFieldValues: { cfRemarks: "Prefers WhatsApp" } }, {}).kylasRemarks,
     "Prefers WhatsApp");
}

console.log("\nwhich call logs belong to the contact");
{
  eq("relatedTo naming this contact", logIsAbout({ relatedTo: { entity: "contact", id: 5815757 } }, "5815757"), true);
  eq("relatedTo naming another contact", logIsAbout({ relatedTo: { id: 1 } }, "5815757"), false);
  eq("a list of relations, this contact among them", logIsAbout({ relatedTo: [{ id: 9 }, { id: "5815757" }] }, "5815757"), true);
  eq("a bare id", logIsAbout({ relatedTo: 5815757 }, "5815757"), true);
  eq("saying nothing is accepted — there is no way to tell", logIsAbout({ id: 1 }, "5815757"), true);
  eq("a note under `note` is read", callNotes([{ startTime: "2026-10-06T09:40:40Z", note: "Call after Diwali" }])[0]?.text,
     "Call after Diwali");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
