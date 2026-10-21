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

    An exact company name (against the Kylas company name) is the strongest thing
    we have, so it decides on its own — even when the email domain is shared with
    another Kylas company (a group's sites, a parent and its subsidiary). With no
    name hit the email domain decides, and a domain on two Kylas companies is
    AMBIGUOUS: listed with its candidates, never guessed. A short name or label
    ('te', 'aam') is a coincidence waiting to happen, so it only counts beside the
    other key."""
    key, lab = norm_name(company["name"]), company["label"]
    by_n = by_name.get(key, []) if len(key) >= 4 else []
    by_l = by_label.get(lab, []) if len(lab) >= 5 else []
    if 2 <= len(lab) < 5 and by_n:                      # a short label counts only beside a name hit
        by_l = [r for r in by_label.get(lab, []) if r in by_n]

    def ids(rs):
        return {kid_of(r) for r in rs} - {""}

    ids_n, ids_l = ids(by_n), ids(by_l)
    if len(ids_n) == 1:                                  # the name settles it
        kid = next(iter(ids_n))
        how = "name" + ("+email-domain" if kid in ids_l else "")
        return "matched", kid, [r for r in by_n + by_l if kid_of(r) == kid], how
    if len(ids_n) > 1:
        return "ambiguous", ",".join(sorted(ids_n)), by_n, "name"
    if len(ids_l) == 1:
        kid = next(iter(ids_l))
        return "matched", kid, [r for r in by_l if kid_of(r) == kid], "email-domain"
    if len(ids_l) > 1:
        return "ambiguous", ",".join(sorted(ids_l)), by_l, "email-domain"
    if by_n or by_l:                                     # rows exist, none has a Kylas id
        return "no-kylas-id", "", by_n + by_l, "+".join(h for h, rs in (("name", by_n), ("email-domain", by_l)) if rs)
    return "none", "", [], ""


def suggestions(company, rows, limit=3):
    """For a company that did not match cleanly: the nearest Company List companies,
    one per Kylas id, so a person can pick. Scored on the name against the Kylas
    company name and the site's label."""
    import difflib
    key, lab = norm_name(company["name"]), company["label"]
    if not key:
        return []
    best = {}
    for r in rows:
        kid = kid_of(r)
        if not kid:
            continue
        f = r["fields"]
        for cand in {norm_name(f.get("Company Name - Kylas")), host_label(f.get("Website")) or host_label(f.get("Name"))}:
            if not cand or cand[0] != key[0]:           # cheap pre-filter: same first letter
                continue
            score = difflib.SequenceMatcher(None, key, cand).ratio()
            if lab and cand == lab:
                score = max(score, 0.9)
            if score >= 0.72 and score > best.get(kid, (0,))[0]:
                best[kid] = (score, f.get("Company Name - Kylas") or "", f.get("Name") or f.get("Website") or "")
    top = sorted(best.items(), key=lambda kv: -kv[1][0])[:limit]
    return [f"{kid} | {n} | {u} | {sc:.2f}" for kid, (sc, n, u) in top]


def candidates_of(rows):
    """One line per Kylas id among `rows` — for the ambiguous ones."""
    seen = {}
    for r in rows:
        kid = kid_of(r)
        if kid and kid not in seen:
            f = r["fields"]
            seen[kid] = f"{kid} | {f.get('Company Name - Kylas') or ''} | {f.get('Name') or f.get('Website') or ''}"
    return list(seen.values())[:5]


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

def plan(companies, rows, decisions=None):
    """-> (changes, review). changes: one per Company List row to write.

    Two sheet companies can be ONE Kylas company ("Smytten" and "Smytten Pvt Ltd"),
    each with its own months. Their months are merged per Kylas id before anything
    is written; otherwise whichever came first would claim the rows and the other's
    months would be lost without a word.
    `decisions` is {sheet company (lowercase): kylas id} — a person's picks from the
    review file."""
    decisions = decisions or {}
    by_label, by_name = build_index(rows)
    by_kid = collections.defaultdict(list)
    for r in rows:
        if kid_of(r):
            by_kid[kid_of(r)].append(r)
    groups, review = {}, []
    for c in companies:
        pick = decisions.get(c["name"].lower())
        if pick and pick in by_kid:
            status, kid, hit, how = "matched", pick, by_kid[pick], "your pick"
        else:
            status, kid, hit, how = match(c, by_label, by_name)
        if status != "matched":
            sug = candidates_of(hit) if status == "ambiguous" else suggestions(c, rows)
            row = {"company": c["name"], "months": ", ".join(c["months"]), "status": status, "kylas_company_ids": kid,
                   "matched_by": how, "choose": ""}
            for i in range(3):
                row[f"candidate_{i + 1}"] = sug[i] if i < len(sug) else ""
            review.append(row)
            continue
        g = groups.setdefault(kid, {"months": set(), "names": [], "how": set()})
        g["months"].update(c["months"])
        g["names"].append(c["name"])
        g["how"].add(how)
    changes = []
    for kid, g in groups.items():
        months = sorted(g["months"], key=MONTHS.index)
        for r in by_kid[kid]:
            cur = r["fields"].get(TARGET) or ""
            new = new_source(cur, months)
            changes.append({"record": r["id"], "company": " / ".join(g["names"]), "kylas_company_id": kid, "months": ", ".join(months),
                            "matched_by": "+".join(sorted(g["how"])), "current": cur, "new": new, "changes": new != cur,
                            "source_of_data_untouched": r["fields"].get("Source of Data") or ""})
    return changes, review


def read_decisions(path):
    """The review file, with a person's picks in its `choose` column: a Kylas company
    id (digits), copied from a candidate, or anything else to leave it out."""
    out = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            v = (row.get("choose") or "").strip()
            if re.fullmatch(r"\d+", v):
                out[(row.get("company") or "").strip().lower()] = v
    return out


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
    ap.add_argument("--decisions", help="the review CSV with a Kylas company id typed in its `choose` column for the ones you settled")
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

    decisions = read_decisions(a.decisions) if a.decisions else {}
    if decisions:
        print(f"Decisions: {len(decisions)} pick(s) read from {a.decisions}")
    changes, review = plan(companies, rows, decisions)
    todo = [c for c in changes if c["changes"]]
    already = len(changes) - len(todo)
    kylas_cos = len({c["kylas_company_id"] for c in changes})
    print(f"\n  matched   {len(companies) - len(review)} of {len(companies)} companies -> {kylas_cos} Kylas companies  ({len(changes)} Company List rows, duplicates included)")
    print(f"  to change {len(todo)} row(s) · already correct {already}")
    print(f"  for review {len(review)}: " + ", ".join(f"{k} {v}" for k, v in
          collections.Counter(r['status'] for r in review).most_common()))
    exists = sum(1 for c in todo if LIFETIME.search(c["current"]))
    print(f"  of the rows to change, {exists} already carry lifetime-MQL-SQL (month added), {len(todo) - exists} do not (tag added)")
    for c in todo[:6]:
        print(f"    {c['company'][:30]:30} {c['current']!r} -> {c['new']!r}")

    os.makedirs(a.out, exist_ok=True)
    pv, rv = os.path.join(a.out, "offsite-source-preview.csv"), os.path.join(a.out, "offsite-source-review.csv")
    if a.decisions and os.path.abspath(a.decisions) == os.path.abspath(rv):
        rv = os.path.join(a.out, "offsite-source-review-remaining.csv")   # never overwrite the file the picks are typed in
    write_csv(pv, changes, ["company", "months", "kylas_company_id", "record", "matched_by", "current", "new", "changes", "source_of_data_untouched"])
    write_csv(rv, review, ["company", "months", "status", "kylas_company_ids", "matched_by", "candidate_1", "candidate_2", "candidate_3", "choose"])
    print(f"\n  wrote {pv}\n  wrote {rv}  (NOT written: ambiguous, no match, or no Kylas id.\n  Type the right Kylas company id from a candidate into its `choose` column, then run again with --decisions {rv})")

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
