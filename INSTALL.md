# Installing the call console

About five minutes. You need **Google Chrome** and **Node 18 or newer**
(`node --version` to check). There is nothing to build and no `npm install` —
the extension has no dependencies.

---

## 1 · Get the code

```bash
git clone -b claude/adoring-feynman-chhiyt \
  https://github.com/Ayush9205NITRR/kylas-kpi-tracker.git
cd kylas-kpi-tracker
```

Already cloned? Just `git pull`.

Note the full path — you will need it in the next step:

```bash
pwd          # e.g. /Users/ayushtiwari/kylas-kpi-tracker
```

## 2 · Load it into Chrome

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension`** folder inside the repo —
   `kylas-kpi-tracker/extension`, **not** the repo root

You should see **Enout BD Call Console 0.1.0**. If it shows an error, see
Troubleshooting below.

## 3 · Open it

Go to any page on **app.kylas.io**. A blue **Call console** button appears at
the bottom right.

| | |
|---|---|
| Click the button | opens the console |
| `Option`+`Shift`+`E` | opens or closes it (`Alt`+`Shift`+`E` on Windows) |
| The toolbar icon | same thing |
| `Esc` | closes it |

Open it on a **company** page — `app.kylas.io/sales/companies/details/…` — and
it scopes to that company. That is what it is designed around.

At this point it works, but on sample data. It is not yet talking to Kylas.

---

## 4 · Connect it to Kylas

The console never holds your API key. A small program on your machine holds it
and does the talking.

**Get a key** at
[app.kylas.io/setup/integrations/api-keys/list](https://app.kylas.io/setup/integrations/api-keys/list).

**Start the proxy**, from the repo folder:

```bash
KYLAS_KEY=paste_your_key_here node scripts/proxy.mjs
```

Leave that terminal window open — closing it stops the connection. You should
see:

```
proxy on http://127.0.0.1:8787
routes: /health  /company  /queue  /contact
```

Now reload the Kylas tab and open the console. The badge in the top bar should
read **Kylas**. Open a company page and its real contacts load.

### Starting it again later

The proxy does not start by itself. Each time you want the live connection:

```bash
cd kylas-kpi-tracker
KYLAS_KEY=... node scripts/proxy.mjs
```

To avoid retyping the key, put it in a file the repo already ignores:

```bash
echo 'export KYLAS_KEY=paste_your_key_here' > .env.local
# then each time:
source .env.local && node scripts/proxy.mjs
```

---

## 5 · Check it is working

Open the console and look at the top bar:

| Badge | Meaning |
|---|---|
| **Kylas** (green) | connected — hover to see which account |
| **offline** (amber) | the proxy is not running, or not reachable. Click it to change the address. |

Offline is not broken — the console still works on whatever it already holds.
Nothing is lost; it just will not fetch or, later, write.

**Data** in the top bar shows everything captured so far and exports it as JSON.
**Dashboard** shows calls by day, week and month.

---

## Troubleshooting

**"Manifest file is missing or unreadable"**
You selected the repo root. Select the `extension` folder inside it.

**No button on the Kylas page**
The extension only runs on `app.kylas.io`. Check the address, then reload the
tab — a newly installed extension does not appear in tabs that were already
open.

**Badge says offline**
Is the proxy terminal still open? Test it directly:

```bash
curl http://127.0.0.1:8787/health
```

Expect `{"ok":true,...}` with your name. If it says the port is in use,
something else is on 8787 — run `PORT=8788 KYLAS_KEY=... node scripts/proxy.mjs`
and click the offline badge to point the console at `http://127.0.0.1:8788`.

**Proxy exits with "Set KYLAS_KEY"**
The key did not reach it. Put `KYLAS_KEY=...` on the same line as the `node`
command, before it.

**Changed the code?**
Press the refresh arrow on the extension card at `chrome://extensions`, then
reload the Kylas tab.

---

## Trying it without Kylas

To see the whole thing working against a fake CRM — no key, and the real one
untouched:

```bash
node scripts/mock-kylas.mjs                                    # terminal 1
KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=x node scripts/proxy.mjs   # terminal 2
```

The console then fetches from the mock exactly as it would from Kylas.

---

## What it does and does not do yet

**Does:** loads companies and contacts from Kylas, captures calls and event
detail, computes the company rollup live, keeps everything through a refresh,
and exports it.

**Does not yet:** write anything back. Nothing you do in the console changes
Kylas or Airtable. Capture is safe to use for real today; the writer is next.
