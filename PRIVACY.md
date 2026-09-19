# Privacy policy — Enout BD Call Console

_Last updated: 19 September 2026_

This is the privacy policy for the **Enout BD Call Console** Chrome extension, published by Enout
for use by its own business development team.

## The short version

The extension sends nothing to us. It has no analytics, no telemetry, no crash reporting and no
account system. Its only network destination is a helper process running on the user's own
computer, at `http://127.0.0.1`.

## What the extension handles

While an associate is logging a call, the console holds the details of the CRM contact they are
calling. That includes **personally identifiable information** belonging to the prospect:

- name, salutation and job title
- phone numbers and email addresses
- the company they work for, and its LinkedIn URL
- notes typed during the call, the call's outcome and its duration

This data originates in the organisation's own Kylas CRM. The extension does not obtain it from
any other source and does not enrich it from anywhere.

It also reads two things from the Kylas page it is open on: the **URL path**, to know which CRM
record is showing, and the **text of the record's heading**, to label that record in the console.
It reads no other page content, and it reads nothing at all on any site other than
`app.kylas.io`.

## What it does not handle

No health information. No financial or payment information. No passwords or credentials — the
organisation's Kylas API key and Airtable token are held by the local helper process and are never
placed in the browser. No location. No personal communications. No browsing history: the extension
is inert on every site except the CRM, and it does not record which pages a user visits.

## Where the data goes

One place: a helper process the organisation runs on the associate's own machine, or on a machine
inside its own network. From there it is written to the organisation's own **Kylas CRM** and its
own **Airtable** base, which are the systems the data came from and belongs to.

No data is transmitted to Enout as the extension's publisher, to any server we operate, or to any
third party. There is no advertising, no profiling and no resale of any kind.

## What is stored in the browser

`chrome.storage` holds the associate's working state: the contacts currently being worked, notes
typed but not yet saved, a local log of calls made, and preferences such as the chosen grouping
and density. This exists so a refresh or a closed tab does not lose notes taken during a live
call, and so that saves made while the helper is unreachable can be queued and sent when it
returns.

This data stays on the associate's own device. It can be cleared at any time by removing the
extension, or from the console's own Data panel.

## Retention

The extension keeps its browser-side copy only as long as the associate is working those records;
it is replaced as the queue moves on and is deleted with the extension. Retention of the CRM data
itself is governed by the organisation's own Kylas and Airtable retention settings, not by this
extension.

## Who this is for

The extension is an internal tool for Enout's business development team. It is not a consumer
product and is not intended for use outside the organisation.

## Contact

Questions about this policy: **ayush@enout.in**
