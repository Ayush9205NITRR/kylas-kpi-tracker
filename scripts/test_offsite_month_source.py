#!/usr/bin/env python3
"""THE MONTH TAG ON "Source (MQL-SQL)": the rule, the matching, and a whole run
against the mock Airtable.

    python3 scripts/test_offsite_month_source.py        (needs: pip3 install openpyxl)
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("oms", os.path.join(HERE, "offsite-month-source.py"))
oms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oms)

passed = failed = 0


def ok(what, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {what}")
    else:
        failed += 1
        print(f"  FAIL  {what}  {detail}")


def eq(what, got, want):
    ok(what, got == want, f"got {got!r}, want {want!r}")


print("\n1 · the rule")
eq("lifetime-MQL-SQL exists: the month is added", oms.new_source("lifetime-MQL-SQL", ["October"]), "lifetime-MQL-SQL October")
eq("...several months", oms.new_source("lifetime-MQL-SQL", ["October", "November", "December"]), "lifetime-MQL-SQL October, November, December")
eq("it does not exist: 'lifetime-MQL-SQL <month>'", oms.new_source("", ["November"]), "lifetime-MQL-SQL November")
eq("...beside another source, which is kept", oms.new_source("GPTW", ["November"]), "GPTW + lifetime-MQL-SQL November")
eq("what is already there is never dropped", oms.new_source("GPTW\n + lifetime-MQL-SQL, lifetime-MQL-SQL", ["October"]),
   "GPTW\n + lifetime-MQL-SQL, lifetime-MQL-SQL October")
eq("a differently spelt tag still counts as existing", oms.new_source("Lifetime MQL/SQL", ["October"]), "Lifetime MQL/SQL October")
once = oms.new_source("lifetime-MQL-SQL", ["October", "November"])
eq("twice is the same as once", oms.new_source(once, ["October", "November"]), once)
eq("a month added to the sheet later is added, not stacked", oms.new_source(once, ["October", "November", "December"]),
   "lifetime-MQL-SQL October, November, December")
added = oms.new_source("GPTW", ["October"])
eq("a tag we added on the first run is recognised on the second", oms.new_source(added, ["October"]), added)
eq("text that merely ends in a month is not eaten", oms.new_source("Connect in October", ["November"]), "Connect in October + lifetime-MQL-SQL November")

print("\n2 · host labels and names")
eq("a plain site", oms.host_label("https://gdwaldner.com"), "gdwaldner")
eq("a subdomain", oms.host_label("https://lifeinsurance.adityabirlacapital.com/x"), "adityabirlacapital")
eq("a co.in", oms.host_label("http://www.ajatus.co.in"), "ajatus")
eq("an email host", oms.host_label("attentive.ai"), "attentive")
eq("a company name loses its noise words", oms.norm_name("GD Waldner India Pvt. Ltd."), "gdwaldner")

print("\n3 · matching")
R = lambda i, name, kid, kname="", src="": {"id": i, "fields": {"Name": name, "Kylas Company Id": kid, "Company Name - Kylas": kname, oms.TARGET: src}}
rows = [R("r1", "https://gdwaldner.com", "1780525", "GD Waldner India", "lifetime-MQL-SQL"),
        R("r2", "https://attentive.com", "1776743"), R("r3", "https://attentive.com", "1776743", "", "lifetime-MQL-SQL"),
        R("r4", "https://acmecorp.com", "10"), R("r5", "https://acmecorp.in", "11"),
        R("r6", "https://te.com", "12"), R("r7", "https://nokylasid.com", "")]
bl, bn = oms.build_index(rows)
C = lambda name, label="": {"name": name, "months": ["October"], "label": label}
eq("by email domain", oms.match(C("Waldner Group", "gdwaldner"), bl, bn)[:2], ("matched", "1780525"))
eq("by name alone", oms.match(C("GD Waldner India"), bl, bn)[:2], ("matched", "1780525"))
st, kid, hit, how = oms.match(C("Attentive.ai", "attentive"), bl, bn)
eq("a company in Company List twice is one match, both rows", (st, kid, len(hit)), ("matched", "1776743", 2))
eq("two different Kylas companies on one label is AMBIGUOUS, not guessed", oms.match(C("Acme Corp", "acmecorp"), bl, bn)[:2], ("ambiguous", "10,11"))
eq("a 2-letter label alone is a coincidence, not a match", oms.match(C("Tech Edge", "te"), bl, bn)[0], "none")
eq("no row at all", oms.match(C("Nobody Ltd", "nobody"), bl, bn)[0], "none")
eq("a row with no Kylas id cannot be pushed", oms.match(C("No Kylas", "nokylasid"), bl, bn)[0], "no-kylas-id")

print("\n3b · the other companies: merging, names that win, and picks")
R2 = lambda i, name, kid, kname="", src="": {"id": i, "fields": {"Name": name, "Kylas Company Id": kid, "Company Name - Kylas": kname, oms.TARGET: src}}
rows2 = [R2("a1", "https://smytten.com", "100", "Smytten", "lifetime-MQL-SQL"),
         R2("b1", "https://groupco.com", "200", "Group Co Hotels"), R2("b2", "https://groupco.in", "201", "Group Co Foods"),
         R2("c1", "https://hitechradiators.com", "300", "Hi-Tech Radiators Pvt Ltd", "lifetime-MQL-SQL"),
         R2("d1", "https://zzz-a.com", "400", "Zeta Alpha Pvt"), R2("d2", "https://zzz-b.com", "401", "Zeta Alpha Ltd")]
comps = [{"name": "Smytten", "months": ["October"], "label": "smytten"},
         {"name": "Smytten Pvt Ltd", "months": ["December"], "label": "smytten"},          # the SAME Kylas company, other months
         {"name": "Group Co Foods", "months": ["November"], "label": "groupco"},            # the domain is shared, the name is not
         {"name": "Hi-Tech Radiators Private Limited", "months": ["October"], "label": "gmail"},
         {"name": "Zeta Alpha", "months": ["October"], "label": ""},                       # two Kylas companies, one name: ambiguous
         {"name": "Wholly Unknown", "months": ["November"], "label": ""}]
ch, rv = oms.plan(comps, rows2)
by = {c["record"]: c for c in ch}
eq("two sheet companies that are one Kylas company: months MERGED, not lost", by["a1"]["new"], "lifetime-MQL-SQL October, December")
eq("the exact name wins over a shared domain", (by.get("b2") or {}).get("kylas_company_id"), "201")
eq("...and the other company on that domain is not touched", "b1" in by, False)
eq("'Pvt Ltd' vs 'Private Limited' is the same company", (by.get("c1") or {}).get("new"), "lifetime-MQL-SQL October")
st = {r["company"]: r for r in rv}
eq("two Kylas companies with the same name are ambiguous", st["Zeta Alpha"]["status"], "ambiguous")
ok("...with both candidates listed for a person to choose", "400" in st["Zeta Alpha"]["candidate_1"] + st["Zeta Alpha"]["candidate_2"] and "401" in st["Zeta Alpha"]["candidate_1"] + st["Zeta Alpha"]["candidate_2"], str(st["Zeta Alpha"]))
eq("an unknown company has no suggestion and no guess", (st["Wholly Unknown"]["status"], st["Wholly Unknown"]["candidate_1"]), ("none", ""))
ch2, rv2 = oms.plan(comps, rows2, {"zeta alpha": "401"})
eq("a person's pick settles it", {c["record"]: c["new"] for c in ch2}["d2"], "lifetime-MQL-SQL October")
eq("...and it leaves the review list", "Zeta Alpha" in {r["company"] for r in rv2}, False)
near = oms.suggestions({"name": "Hitech Radiator", "months": [], "label": ""}, rows2)
ok("a near name is SUGGESTED for review (not applied)", bool(near) and near[0].startswith("300"), str(near))

print("\n4 · a whole run against the mock Airtable")
try:
    import openpyxl
except ImportError:
    print("  (openpyxl not installed: skipped)")
    openpyxl = None
if openpyxl:
    PORT = 9974
    mock = subprocess.Popen(["node", "scripts/mock-airtable.mjs"], cwd=os.path.dirname(HERE), env={**os.environ, "PORT": str(PORT)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        H = {"Authorization": "Bearer x", "Content-Type": "application/json"}
        api = f"http://127.0.0.1:{PORT}"
        def call(method, path, body=None):
            for _ in range(20):
                try:
                    req = urllib.request.Request(api + path, method=method, headers=H, data=None if body is None else json.dumps(body).encode())
                    with urllib.request.urlopen(req, timeout=10) as r:
                        return json.loads(r.read() or b"{}")
                except urllib.error.HTTPError as e:
                    if e.code == 429:
                        time.sleep(0.3); continue
                    raise
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.25)
            raise RuntimeError("mock did not answer")
        call("GET", "/__count")
        base = "appMOCK"
        table = "/v0/%s/Company%%20List" % base
        full = lambda name, kid, kname, mql, sod="", conc="": {"Name": name, "Website": "", "Kylas Company Id": kid, "Company Name - Kylas": kname,
                                                           "Source (MQL-SQL)": mql, "Source of Data": sod, "Source - Concatenate": conc}
        seed = [full("https://smytten.com", "1783866", "Smytten", "lifetime-MQL-SQL", "lifetime-MQL-SQL, lost deal"),
                full("https://smytten.com", "1783866", "Smytten", "lifetime-MQL-SQL"),
                full("https://gomobi.io", "1781400", "GoMobi", "", "GPTW"),
                full("https://untouched.com", "5", "Untouched", "lifetime-MQL-SQL")]
        for s in seed:
            call("POST", table, {"records": [{"fields": s}]})
            time.sleep(0.25)
        d = tempfile.mkdtemp()
        x = os.path.join(d, "s.xlsx")
        wb = openpyxl.Workbook()
        wb.active.title = "Summary"
        for tab, rowsx in {"October": [("smytten", "a@smytten.com"), ("GoMobi", "b@gomobi.io")], "November": [("smytten", "a@smytten.com")],
                           "December": [("Ghost Co", "g@ghostco.com")]}.items():
            ws = wb.create_sheet(tab)
            ws.append(["Sr.", "Company", "Category", "Why it matched", "POC", "Phone", "Email"])
            for i, (co, em) in enumerate(rowsx):
                ws.append([str(i), co, "MQL", "Offsite", "Someone", "999", em])
        wb.save(x)
        env = {**os.environ, "AIRTABLE_PAT": "pat_mock", "AIRTABLE_API": api, "AIRTABLE_COMPANY_BASE_ID": base}
        run = lambda *a: subprocess.run([sys.executable, os.path.join(HERE, "offsite-month-source.py"), "--xlsx", x, "--out", d, *a],
                                        env=env, capture_output=True, text=True, timeout=120)
        dry = run()
        ok("the dry run succeeds and says it changed nothing", dry.returncode == 0 and "Nothing was changed" in dry.stdout, dry.stdout + dry.stderr)
        rowsnow = call("GET", table)["records"]
        ok("...and nothing was written", [r["fields"]["Source (MQL-SQL)"] for r in rowsnow] == ["lifetime-MQL-SQL", "lifetime-MQL-SQL", "", "lifetime-MQL-SQL"])
        ok("...Ghost Co is in the review file, not guessed", "Ghost Co" in open(os.path.join(d, "offsite-source-review.csv")).read())
        ap = run("--apply")
        ok("--apply succeeds and reads every value back", ap.returncode == 0 and "0 do not" in ap.stdout, ap.stdout + ap.stderr)
        after = {(r["fields"]["Name"], i): r["fields"] for i, r in enumerate(call("GET", table)["records"])}
        vals = [r["fields"]["Source (MQL-SQL)"] for r in call("GET", table)["records"]]
        eq("Smytten, in Oct and Nov: the month is concatenated on BOTH duplicate rows", vals[:2], ["lifetime-MQL-SQL October, November"] * 2)
        eq("GoMobi had no lifetime tag: 'lifetime-MQL-SQL October'", vals[2], "lifetime-MQL-SQL October")
        eq("an account not in the sheet is untouched", vals[3], "lifetime-MQL-SQL")
        recs = call("GET", table)["records"]
        eq("'Source of Data' (the Kylas copy) is NEVER written", [r["fields"]["Source of Data"] for r in recs][:3], ["lifetime-MQL-SQL, lost deal", "", "GPTW"])
        again = run("--apply")
        ok("a second run changes nothing", "to change 0" in again.stdout, again.stdout)
        undo = sorted(f for f in os.listdir(d) if f.startswith("offsite-source-undo-"))
        ok("the undo file was written before the write", len(undo) == 1)
        back = run("--undo", os.path.join(d, undo[0]))
        vals2 = [r["fields"]["Source (MQL-SQL)"] for r in call("GET", table)["records"]]
        eq("--undo puts every old value back", vals2, ["lifetime-MQL-SQL", "lifetime-MQL-SQL", "", "lifetime-MQL-SQL"])
    finally:
        mock.kill()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
