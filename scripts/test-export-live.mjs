#!/usr/bin/env node
/* THE SHEET, IN A REAL CHROME.
 *
 *   xvfb-run -a node scripts/test-export-live.mjs
 *
 * NEEDS the stack and the :8778 host stub exactly as test-views-live.mjs says,
 * with a patched extension copy at EXT_DIR and the proxy on :8787.
 *
 * ONE ORDERING TRAP, and it cost a run to find: the proxy caches the company
 * index for COMPANY_TTL_MS (15 minutes). A Companies row written AFTER the
 * proxy started is invisible to /view-contacts until that expires, and the
 * symptom is an empty Contacts table that reads as "the export is broken".
 * This suite seeds its own fixtures, so START THE PROXY AFTER SEEDING, or
 * restart it — the header of test-views-live.mjs has the same shape of note
 * for the same reason.
 *
 * What it proves: a BD can leave with the list. Not that a button exists —
 * that the file on disk holds one row per row on screen, every field, the
 * event rows flattened into their own columns, and the filters applied.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import fs from "node:fs";

const EXT = process.env.EXT_DIR || "/tmp/claude-0/exttest";
const HOST = process.env.HOST_STUB || "http://127.0.0.1:8778";
const BASE = process.env.PROXY || "http://127.0.0.1:8787";
const AT = process.env.MOCK_AIRTABLE || "http://127.0.0.1:9901/v0/appMOCK";
const DL = process.env.DL_DIR || "/tmp/claude-0/export-dl";
const W = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (what, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond || !detail ? "" : `  — ${detail}`}`);
};
fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });

const atPost = (table, fields) => fetch(`${AT}/${encodeURIComponent(table)}`, {
  method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer pat_mock" },
  body: JSON.stringify({ records: [{ fields }] }) }).then((r) => r.json()).catch(() => null);
const api = (path, body) => fetch(BASE + path, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

/* EVERY FIELD THE READER ASKS FOR — readQueue projects CONTACT_READ_FIELDS by
   name and Airtable 422s the whole read if one name exists nowhere, which
   makes a half-written fixture look like an empty view. */
const CO = process.env.EXPORT_CO || "8888";
await atPost("Companies", { "Kylas Company ID": CO, Name: "Sheet Events Co",
  Owner: "Enout Super Admin", "Kylas Owner ID": "74725" });
const made = await atPost("Contacts", {
  "Kylas Contact ID": "990001", Name: "Event Person", Salutation: "", Designation: "VP HR",
  LinkedIn: "", Owner: "Enout Super Admin", "Kylas Owner ID": "74725",
  Phone: "9000000099", Phones: "", Email: "ev@x.com", Emails: "",
  "Source of Data": "COLD_CALLING", Remarks: "Wants Goa", "Next Call Date": "", "Next Call Time": "",
  "Current Stage": "FOLLOW_UP_1", "KPI Rank": "", "Kylas Updated At": "",
  "Vendor Info": "", "Mode of Meeting": "", "Service Offering": false,
  Flagged: false, "Exit Reason": "", Company: [], "Company Kylas ID": CO });
const rid = made?.records?.[0]?.id;
await atPost("Event Rows", { "Row Key": "ev-now-1", Period: "Current", "Event Type": "Employee offsites",
  Budget: "approx 8L, not signed off", Timeline: "March, maybe April", Pax: "around 120", Remarks: "Goa preferred", Contact: [rid] });
await atPost("Event Rows", { "Row Key": "ev-past-1", Period: "Past", "Event Type": "Product launch",
  Budget: "3L", Timeline: "last Sept", Pax: "60", Remarks: "", Contact: [rid] });
const VIEW = `Export suite ${Date.now().toString(36)}`;
await api("/views", { name: VIEW, visibility: "team", companies: [CO] });

const ctx = await chromium.launchPersistentContext((process.env.PROFILE_DIR || "/tmp/claude-0/pexp-") + Date.now(), {
  headless: false, viewport: { width: 1600, height: 950 }, acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-proxy-server"],
});
const page = ctx.pages()[0] || await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
const F = () => page.frames().find((f) => f.url().startsWith("chrome-extension"));

/* A CSV reader, because asserting on the raw text passes for the wrong
   reason the moment a value contains a comma — which "Pax: 60, maybe 80"
   does, and which is exactly what this file is for. */
const parse = (t) => {
  const out = []; let row = [], cur = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r" && t[i + 1] === "\n") { row.push(cur); out.push(row); row = []; cur = ""; i++; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
};
const grab = async (sel) => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), F().locator(sel).click()]);
  const p = `${DL}/${d.suggestedFilename()}`; await d.saveAs(p);
  const raw = fs.readFileSync(p, "utf8");
  return { path: p, raw, grid: parse(raw.slice(1)) };      /* slice(1): the BOM */
};

try {
  await page.goto(`${HOST}/sales/companies/list/`); await W(3500);
  await F().evaluate(async (b) => { await API.setBase(b); }, BASE);
  await page.reload(); await W(6000);
  const f = () => F();
  await f().evaluate(() => window.showConsoleView("companies"));
  let rows = f().locator(".acctable .vr[data-id]");
  for (let i = 0; i < 40 && await rows.count() === 0; i++) { await W(1000); rows = F().locator(".acctable .vr[data-id]"); }
  const total = await rows.count(); await W(1500);

  console.log("\n1 · the accounts sheet");
  ok("the accounts list painted", total > 0, `${total} rows`);
  ok("a Download CSV button is offered", await f().locator("#fCsv").count() === 1);
  const a = await grab("#fCsv");
  ok("the file is named for the list and the day", /accounts-\d{4}-\d\d-\d\d\.csv$/.test(a.path));
  ok("...one row per account on screen", a.grid.length - 1 === total, `${a.grid.length - 1} vs ${total}`);
  ok("...a BOM first, so Excel on Windows reads it as UTF-8", a.raw.charCodeAt(0) === 0xFEFF);
  ok("...Company and the Kylas id lead", a.grid[0][0] === "Company" && a.grid[0][1] === "Kylas company ID", a.grid[0].slice(0, 2).join(","));
  ok("...every catalogued column is present", a.grid[0].length >= 12, `${a.grid[0].length} columns`);
  ok("...and every row is that wide", new Set(a.grid.map((r) => r.length)).size === 1);

  console.log("\n2 · the contacts sheet");
  await f().locator(".vws .vwtab", { hasText: VIEW }).first().click(); await W(2500);
  await f().locator("#halfCon").click(); await W(8000);
  const crows = await f().locator(".ctable .crow").count();
  ok("the contacts table painted", crows > 0, `${crows} rows`);
  ok("a Download CSV button is offered", await f().locator("#conCsv").count() === 1);
  const c = await grab("#conCsv");
  ok("the file is named for the view", c.path.includes("Export-suite"), c.path.split("/").pop());
  ok("...one row per contact on screen", c.grid.length - 1 === crows, `${c.grid.length - 1} vs ${crows}`);
  const head = c.grid[0], col = (n) => head.indexOf(n);
  const want = ["Contact", "Salutation", "Company", "Kylas company ID", "Designation", "Phone",
    "All phones", "Email", "All emails", "LinkedIn", "Stage", "Owner", "Source of data",
    "Last call", "Next call date", "Next call time", "Vendor info", "Mode of meeting",
    "Service offering", "Flagged", "Exit reason", "Remarks", "Kylas contact ID"];
  const missing = want.filter((w) => col(w) < 0);
  ok("...every record field has a column", !missing.length, missing.join(", "));
  ok("...six event types, each with a now and a past column",
     head.filter((h) => / — now$/.test(h)).length === 6 && head.filter((h) => / — past$/.test(h)).length === 6,
     `${head.filter((h) => / — now$/.test(h)).length} / ${head.filter((h) => / — past$/.test(h)).length}`);
  ok("...and every row is that wide", new Set(c.grid.map((r) => r.length)).size === 1);

  console.log("\n3 · the event rows, flattened");
  const r = c.grid.find((x) => x[col("Contact")] === "Event Person");
  const now = r?.[col("Employee offsites — now")] || "", past = r?.[col("Product launch — past")] || "";
  ok("the current offsite lands in its own column, all four answers",
     /around 120/.test(now) && /March, maybe April/.test(now) && /approx 8L, not signed off/.test(now) && /Goa preferred/.test(now), now);
  ok("the past launch lands in its own column", /60/.test(past) && /3L/.test(past), past);
  ok("a past row does not leak into the now column", !/3L/.test(now));
  /* The budget line is free text on purpose (CLAUDE.md §2); an export that
     tidied it into a number would lose "not signed off", which is the half
     of the sentence a BD actually acts on. */
  ok("free text is carried verbatim, not normalised", now.includes("approx 8L, not signed off"));
  ok("an event type nobody tapped stays empty", (r?.[col("Marketing events — now")] || "") === "");

  console.log("\n4 · the filters decide what goes in");
  /* The search box rather than a chip: a chip on a one-contact fixture
     filters to nothing, and nothing is the NEXT assertion, not this one. */
  await f().locator("#conQ").fill("Event Person"); await W(1200);
  const narrowed = await f().locator(".ctable .crow").count();
  ok("the search narrows the table", narrowed > 0 && narrowed <= crows, `${narrowed} of ${crows}`);
  const c2 = await grab("#conCsv");
  ok("...and the sheet holds exactly what the table now shows",
     c2.grid.length - 1 === narrowed, `${c2.grid.length - 1} in file vs ${narrowed} on screen`);

  /* NO BUTTON AT ZERO ROWS. An empty sheet is a worse answer than no sheet:
     it opens, it looks like the export ran, and it says the data is gone. */
  await f().locator("#conQ").fill("nobody matches this at all"); await W(1200);
  ok("filtering to nothing takes the button away, rather than offering an empty file",
     await f().locator(".ctable .crow").count() === 0 && await f().locator("#conCsv").count() === 0);
  await f().locator("#conQ").fill(""); await W(1200);
  ok("clearing the search brings it back", await f().locator("#conCsv").count() === 1);

  console.log("\n5 · nothing a spreadsheet would run");
  /* A cell beginning = + @ is how a CSV gets a spreadsheet to execute
     something. Every exporter quotes it; this one checks. */
  ok("no cell starts with a formula character",
     ![...a.grid.slice(1), ...c.grid.slice(1)].some((row) => row.some((x) => /^[=+@]/.test(x))));
  ok("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
}
