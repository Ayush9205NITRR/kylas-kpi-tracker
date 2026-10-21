#!/usr/bin/env python3
"""MONTH TAGS ON THE SOURCE OF DATA — Oct / Nov / Dec offsite and reach-out accounts.

Ayush, 2026-10-21: the Oct–Dec offsite & reach-out sheet is in Airtable, and he
wants each account's source to say which month(s) it is in. His rule:

    "Source of Data mein jo hai woh rehne do.
     If 'lifetime MQL-SQL' exists   -> add the month (concatenate).
     If it does not                 -> 'lifetime MQL-SQL {month_name}'."

WHERE THIS WRITES, AND WHY THERE. Company List has two source columns that look
alike and are not:

    "Source of Data"        a COPY of what Kylas holds (kylas-airtable-sync's company
                            sync writes it). Editing it changes nothing in Kylas, and
                            the next sync puts Kylas' value back. NOT TOUCHED here.
    "Source - Concatenate"  a FORMULA over seven input columns, one of them
                            "Source (MQL-SQL)". It is what the "Kylas Field Map" pushes
                            to Kylas' cfSourceOfData.

So the month goes into "Source (MQL-SQL)", the input that already carries
"lifetime-MQL-SQL". The formula picks it up; the existing Airtable -> Kylas job
(kylas-airtable-sync, "Assign Companies from Airtable -> Kylas", mode fields) then
carries it to Kylas. Nothing here talks to Kylas.

    python3 scripts/offsite-month-source.py --xlsx Oct_Dec_Offsite_Reachout.xlsx
        DRY RUN. Writes offsite-source-preview.csv and offsite-source-review.csv.
        Changes nothing.
    python3 scripts/offsite-month-source.py --xlsx ... --apply
        Writes the changes, after saving every old value to offsite-source-undo-*.json.
    python3 scripts/offsite-month-source.py --undo offsite-source-undo-<stamp>.json
        Puts every old value back.

NEEDS: AIRTABLE_PAT in the environment (a token that can read and write the Company
Database base) and `pip3 install openpyxl`. The sheet is read here and never leaves
this machine: no company, POC, phone or email from it is written anywhere but the two
CSV files next to where you run this, and those hold company names and ids only.

IDEMPOTENT. A month suffix this script wrote is recognised and rebuilt, so running it
twice gives the same value, and a month added to the sheet later is added, not stacked.
"""
import argparse
import collections
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DEFAULT = "app55PsyRKqkf2CAQ"        # the Company Database base (RESEARCH_BASE)
TABLE = "Company List"
TARGET = "Source (MQL-SQL)"
READ_FIELDS = ["Name", "Website", "Company Name - Kylas", "Kylas Company Id", TARGET,
               "Source of Data", "Source - Concatenate"]
TAG = "lifetime-MQL-SQL"

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
_M = "(?:" + "|".join(MONTHS) + ")"
_MONTH_LIST = rf"{_M}(?:\s*,\s*{_M})*"
LIFETIME = re.compile(r"lifetime\s*-?\s*mql\s*[-/]?\s*sql", re.I)
# a month list this script wrote: right after the lifetime tag, at the end
OWN_SUFFIX = re.compile(rf"(lifetime\s*-?\s*mql\s*[-/]?\s*sql)\s+{_MONTH_LIST}\s*$", re.I)

GENERIC_MAIL = {"gmail", "yahoo", "hotmail", "outlook", "rediffmail", "icloud", "live",
                "protonmail", "aol", "ymail", "msn"}
NAME_NOISE = {"pvt", "ltd", "limited", "private", "llp", "inc", "india", "the", "and", "co",
              "company", "corp", "corporation", "plc"}


# ── the rule ──────────────────────────────────────────────────────────────

def new_source(current, months):
    """`current` is the column as it stands; `months` the month names, in order.
    Existing text is kept. See the module header for the two cases."""
    cur = (current or "").strip()
    mtxt = ", ".join(months)
    base = OWN_SUFFIX.sub(r"\1", cur).strip()              # drop a suffix we wrote before
    if LIFETIME.search(base):
        return f"{base} {mtxt}"                             # exists: concatenate the month
    tag = f"{TAG} {mtxt}"                                   # does not: lifetime-MQL-SQL <month>
    return f"{base} + {tag}" if base else tag


# ── reading the sheet ─────────────────────────────────────────────────────

def read_sheet(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    order = [ws.title for ws in wb.worksheets if ws.title in MONTHS]
    if not order:
        raise SystemExit(f"no tab named after a month in {path} (tabs: {[w.title for w in wb.worksheets]})")
    cos = {}
    for tab in order:
        rows = list(wb[tab].iter_rows(values_only=True))
        hdr = [str(h or "").strip() for h in rows[0]]
        ci, ei = hdr.index("Company"), (hdr.index("Email") if "Email" in hdr else None)
        for r in rows[1:]:
            name = str(r[ci] or "").strip()
            if not name:
                continue
            c = cos.setdefault(name.lower(), {"name": name, "months": [], "labels": collections.Counter()})
            if tab not in c["months"]:
                c["months"].append(tab)
            for e in re.split(r"[,;/\s]+", str(r[ei] or "").lower()) if ei is not None else []:
                if "@" in e:
                    lab = host_label(e.split("@", 1)[1])
                    if lab and lab not in GENERIC_MAIL:
                        c["labels"][lab] += 1
    for c in cos.values():
        c["months"].sort(key=MONTHS.index)
        c["label"] = c["labels"].most_common(1)[0][0] if c["labels"] else ""
    return list(cos.values()), order


# ── matching a sheet company to Company List rows ─────────────────────────

def host_label(url):
    """'https://lifeinsurance.adityabirlacapital.com/x' -> 'adityabirlacapital';
    'www.ajatus.co.in' -> 'ajatus'."""
    u = re.sub(r"^[a-z]+://", "", (url or "").strip().lower())
    host = re.split(r"[/?:#]", u)[0]
    host = re.sub(r"^www\d?\.", "", host)
    parts = [p for p in host.split(".") if p]
    if len(parts) < 2:
        return ""
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "ac", "gov", "edu"} and len(parts[-1]) == 2:
        return parts[-3]
    return parts[-2]


def norm_name(s):
    words = [w for w in re.split(r"[^a-z0-9]+", (s or "").lower()) if w and w not in NAME_NOISE]
    return "".join(words)


def build_index(rows):
    by_label, by_name = collections.defaultdict(list), collections.defaultdict(list)
    for r in rows:
        f = r["fields"]
        for lab in {host_label(f.get("Website")), host_label(f.get("Name"))}:
            if lab:
                by_label[lab].append(r)
        for nm in {norm_name(f.get("Company Name - Kylas")), norm_name(f.get("Name"))}:
            if nm:
                by_name[nm].append(r)
    return by_label, by_name


def kid_of(r):
    v = str(r["fields"].get("Kylas Company Id") or "").strip()
    try:
        return str(int(float(v)))
    except ValueError:
        return v


def match(company, by_label, by_name):
    """-> (status, kylas_id, rows, how). status: matched | ambiguous | none | no-kylas-id.
    A short name or domain label ('te', 'aam') is a coincidence waiting to happen, so it
    only counts when it agrees with the other key."""
    key, lab = norm_name(company["name"]), company["label"]
    by_n = by_name.get(key, []) if len(key) >= 4 else []
    by_l = by_label.get(lab, []) if len(lab) >= 5 else []
    if len(lab) < 5 and len(lab) >= 2 and by_n:           # a short label counts only beside a name hit
        by_l = [r for r in by_label.get(lab, []) if r in by_n]
    cand = {}
    for how, rs in (("name", by_n), ("email-domain", by_l)):
        for r in rs:
            cand.setdefault(r["id"], [r, set()])[1].add(how)
    if not cand:
        return "none", "", [], ""
    ids = {kid_of(r) for r, _ in cand.values()}
    rows = [r for r, _ in cand.values()]
    how = "+".join(sorted({h for _, hs in cand.values() for h in hs}))
    if "" in ids and len(ids) == 1:
        return "no-kylas-id", "", rows, how
    ids.discard("")
    if len(ids) > 1:
        return "ambiguous", ",".join(sorted(ids)), rows, how
    return "matched", ids.pop(), [r for r in rows if kid_of(r)], how


# ── Airtable ──────────────────────────────────────────────────────────────

class Airtable:
    def __init__(self, pat, base, api="https://api.airtable.com"):
        self.pat, self.base, self.api = pat, base, api.rstrip("/")

    def _call(self, method, url, body=None):
        for attempt in range(8):
            req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Authorization": f"Bearer {self.pat}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    return json.loads(res.read() or b"{}")
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8", "replace")
                if e.code == 429 and attempt < 7:
                    time.sleep(min(2 ** attempt, 30))
                    continue
                raise SystemExit(f"Airtable {method} {e.code}: {text[:300]}")
        raise SystemExit("Airtable kept rate limiting")

    def list_all(self, table, fields):
        out, offset = [], None
        while True:
            q = [("pageSize", "100")] + [("fields[]", f) for f in fields] + ([("offset", offset)] if offset else [])
            res = self._call("GET", f"{self.api}/v0/{self.base}/{urllib.parse.quote(table)}?{urllib.parse.urlencode(q)}")
            out += res.get("records", [])
            offset = res.get("offset")
            if not offset:
                return out
            time.sleep(0.22)

    def patch(self, table, records):
        for i in range(0, len(records), 10):
            self._call("PATCH", f"{self.api}/v0/{self.base}/{urllib.parse.quote(table)}", {"records": records[i:i + 10]})
            time.sleep(0.22)


# ── the run ───────────────────────────────────────────────────────────────

def plan(companies, rows):
    """-> (changes, review). changes: one per Company List row to write."""
    by_label, by_name = build_index(rows)
    changes, review, seen = [], [], set()
    for c in companies:
        status, kid, hit, how = match(c, by_label, by_name)
        if status != "matched":
            review.append({"company": c["name"], "months": ", ".join(c["months"]), "status": status,
                           "kylas_company_ids": kid, "matched_by": how, "rows": len(hit)})
            continue
        # every Company List row of this Kylas company: duplicates share one Kylas value
        for r in rows:
            if kid_of(r) != kid or r["id"] in seen:
                continue
            seen.add(r["id"])
            cur = r["fields"].get(TARGET) or ""
            new = new_source(cur, c["months"])
            changes.append({"record": r["id"], "company": c["name"], "kylas_company_id": kid, "months": ", ".join(c["months"]),
                            "matched_by": how, "current": cur, "new": new, "changes": new != cur,
                            "source_of_data_untouched": r["fields"].get("Source of Data") or ""})
    return changes, review


def write_csv(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--undo")
    ap.add_argument("--base", default=os.environ.get("AIRTABLE_COMPANY_BASE_ID", BASE_DEFAULT))
    ap.add_argument("--out", default=".", help="where the CSV and undo files go")
    a = ap.parse_args(argv)

    pat = os.environ.get("AIRTABLE_PAT")
    if not pat:
        raise SystemExit("AIRTABLE_PAT is not set")
    at = Airtable(pat, a.base, os.environ.get("AIRTABLE_API", "https://api.airtable.com"))

    if a.undo:
        old = json.load(open(a.undo))
        at.patch(TABLE, [{"id": rid, "fields": {TARGET: v}} for rid, v in old.items()])
        print(f"Put back {len(old)} value(s) of '{TARGET}'.")
        return 0
    if not a.xlsx:
        raise SystemExit("--xlsx is required")

    companies, tabs = read_sheet(a.xlsx)
    print(f"Sheet: {len(companies)} unique companies across {', '.join(tabs)}")
    rows = at.list_all(TABLE, READ_FIELDS)
    print(f"Company List: {len(rows)} rows read")

    changes, review = plan(companies, rows)
    todo = [c for c in changes if c["changes"]]
    already = len(changes) - len(todo)
    matched = len({c["company"] for c in changes})
    print(f"\n  matched   {matched} of {len(companies)} companies  ({len(changes)} Company List rows, duplicates included)")
    print(f"  to change {len(todo)} row(s) · already correct {already}")
    print(f"  for review {len(review)}: " + ", ".join(f"{k} {v}" for k, v in
          collections.Counter(r['status'] for r in review).most_common()))
    exists = sum(1 for c in todo if LIFETIME.search(c["current"]))
    print(f"  of the rows to change, {exists} already carry lifetime-MQL-SQL (month added), {len(todo) - exists} do not (tag added)")
    for c in todo[:6]:
        print(f"    {c['company'][:30]:30} {c['current']!r} -> {c['new']!r}")

    os.makedirs(a.out, exist_ok=True)
    pv, rv = os.path.join(a.out, "offsite-source-preview.csv"), os.path.join(a.out, "offsite-source-review.csv")
    write_csv(pv, changes, ["company", "months", "kylas_company_id", "record", "matched_by", "current", "new", "changes", "source_of_data_untouched"])
    write_csv(rv, review, ["company", "months", "status", "kylas_company_ids", "matched_by", "rows"])
    print(f"\n  wrote {pv}\n  wrote {rv}  (companies NOT written: ambiguous, no match, or no Kylas id)")

    if not a.apply:
        print("\nDry run. Nothing was changed. Add --apply to write.")
        return 0
    if not todo:
        print("Nothing to write.")
        return 0
    stamp = time.strftime("%Y%m%d-%H%M%S")
    undo = os.path.join(a.out, f"offsite-source-undo-{stamp}.json")
    json.dump({c["record"]: c["current"] for c in todo}, open(undo, "w"))
    print(f"\n  old values saved to {undo}  (undo: --undo {undo})")
    at.patch(TABLE, [{"id": c["record"], "fields": {TARGET: c["new"]}} for c in todo])
    back = {r["id"]: (r["fields"].get(TARGET) or "") for r in at.list_all(TABLE, READ_FIELDS)}
    bad = [c for c in todo if back.get(c["record"], "") != c["new"]]
    print(f"  wrote {len(todo)} row(s); read back: {len(todo) - len(bad)} match, {len(bad)} do not")
    for c in bad[:5]:
        print(f"    ! {c['company']}: wanted {c['new']!r}, Airtable holds {back.get(c['record'])!r}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
