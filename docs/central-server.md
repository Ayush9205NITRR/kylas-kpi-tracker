# One server, instead of eight laptops

Ayush, 2026-09-22: *"Do people need to run server in their own machine… I want
to connect to a common server. Where people just have to install chrome
extension, server se connected ho baki."*

Yes, today they do. This is what it takes to stop, what to buy, and what has to
be built before anything is exposed.

---

## 1 · What stands in the way

Two things, and neither is a setting.

### The proxy has no authentication

The only headers it sets are CORS ones, and they allow any origin:

```js
res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
```

There is no token, no session, no allowlist. The process holds the Kylas API
key and the Airtable PAT. **Putting it on a public address as it stands gives
anyone who finds the URL full read and write on the CRM** — every contact,
every phone number, and the ability to move stages and write call logs.

This is not a criticism of the design. It was written to listen on `127.0.0.1`,
where the operating system is the access control and there is nothing to
authenticate. It stops being true the moment it has a public address.

### Everybody would become the same person

`whoami()` is `kylas.me()`, resolved from the proxy's single API key:

```js
async function whoami() { ... const me = await kylas.me(); ... }
```

Every per-person behaviour hangs off it:

| What | Reads |
|---|---|
| "Me" vs "Everyone" on the dashboard | `scopeOwner()` → `whoami()` |
| admin vs associate | `roleOf(me)` |
| "Picked today by …" on a focus row | `setBy`, from the console's `who()` |
| "Updated by …" on research | `updatedBy`, same |
| Who owes an RCA | the owner on the contact |

One shared key makes all of that one person. The screenshots already show it:
everything says `crmadmin@enout.in`. **Per-person KPIs are the product**, so a
shared server that loses them has removed the reason the system exists.

`docs/architecture.md` called this out before any of it was built:

> Real access control needs the proxy deployed once, centrally, with a login in
> front of it and per-user keys held server-side. That is the same change
> already wanted for the eight-laptop problem.

---

## 2 · The shape that works

```
  Chrome extension                  kpi.enout.in (one small VM)
  ┌────────────────┐   HTTPS        ┌──────────────────────────────┐
  │ console iframe │ ─────────────► │ Caddy  (TLS, one line of      │
  │                │  session       │        config)                │
  │ no keys at all │  cookie        │   │                           │
  └────────────────┘                │   ▼                           │
                                    │ proxy.mjs + auth              │
                                    │   sessions                    │
                                    │   user ──► Kylas key  (on disk│
                                    │            Airtable PAT  only)│
                                    └──────────────────────────────┘
                                              │            │
                                          Kylas API    Airtable
```

Nothing sensitive reaches a browser. The extension holds a session cookie and
the server URL, and that is all. Each associate's requests are executed with
**their own** Kylas key, so identity, scoping and attribution keep working
exactly as they do today — which is the whole point of doing it this way rather
than the quick way.

### What has to be built

1. **Sessions.** A sign-in page on the server, a signed httpOnly cookie, and a
   middleware that rejects anything without one. Every route except `/health`
   goes behind it.
2. **A user store.** For each associate: their email, their Kylas user id, and
   their Kylas API key, encrypted at rest. The key replaces the single global
   `KYLAS_KEY` on a per-request basis — `whoami()` becomes "who is this
   session", not "who owns the process key".
3. **CORS narrowed.** `Allow-Origin` becomes the extension's own origin, and
   `Allow-Credentials` so the cookie travels. Today's `|| "*"` is the opposite
   of what a public server wants.
4. **Rate limiting and an audit line.** Who called what, when. On a shared
   server this is the only record of who did what; on a laptop the laptop was
   the record.
5. **The extension points at it.** `API.setBase()` already exists and is
   stored per browser, so this part is genuinely done — but the manifest needs
   `https://kpi.enout.in/*` in `host_permissions`, and that is a new
   justification on the Web Store form.

Item 2 is the one that decides whether this is worth doing. Without it you have
a shared server and no KPIs.

---

## 3 · What to get

Sized for eight associates. This is not a heavy workload — the proxy's cost is
Airtable's rate limit, not CPU.

| | What | Why this one | Cost |
|---|---|---|---|
| **Server** | DigitalOcean droplet, 1 vCPU / 1 GB, Ubuntu LTS | The proxy is one node process with a few caches. 1 GB is comfortable; the caches described in `proxy.mjs` are a few thousand rows. | ~$6/mo |
| **Domain** | A subdomain you already own — `kpi.enout.in` | You have enout.in. A subdomain needs one A record, no new registration. | £0 |
| **TLS** | Caddy | It gets and renews Let's Encrypt certificates with a two-line config and no cron. nginx + certbot is the same job with more parts. | £0 |
| **Backups** | Droplet snapshots, weekly | The user store is the only state on this box that is not in Airtable or Kylas. Small, but losing it means re-entering eight API keys. | ~$1/mo |

Alternatives worth knowing about:

- **Fly.io / Render.** Cheaper to start and they handle TLS, but the proxy
  keeps warm caches in memory and both will sleep or recycle an idle instance —
  which turns a 2ms dashboard back into a cold one several times a day. A
  droplet that simply stays up suits this better.
- **A Mac in the office.** No public exposure at all, which removes most of
  section 1's risk. But it only serves the office network, so remote days and
  VPN break it. If everyone is in the office every day, this is genuinely the
  lower-risk choice.
- **Tailscale instead of public HTTPS.** Put the droplet (or the office Mac) on
  a private network and the extension talks to it over that. You still need
  per-user identity — section 1's second problem is unaffected — but the whole
  of the first problem goes away, because there is no public address to find.
  **If you want one server soon and safely, this is the shortest path.**

---

## 4 · Order of work

1. **Now: the local agent.** `scripts/install-agent.sh --apply` makes the proxy
   start at login and restart if it dies. Nobody runs a server; it is just
   there. No security or identity change at all. This is what unblocks the team
   this week.
2. **Then: sessions and the user store** on a branch, against the mock stack,
   with the existing live suites proving nothing regressed.
3. **Then: the box.** Droplet, DNS, Caddy, deploy, and the extension pointed at
   it for one person before eight.
4. **Last: turn off the laptops.** `install-agent.sh --remove`, one at a time,
   as each person is switched over.

Steps 2 and 3 are the real work. Step 1 is an afternoon and buys all the time
needed for them.

---

## 5 · What does not change

Worth stating, because it is easy to assume a shared server means a rewrite.

- Airtable stays the KPI store, and the schema does not move.
- Kylas stays the system of record.
- The console, the ladder, the migrations and every test in `scripts/` are
  unaffected. The only thing that changes is who the proxy thinks it is talking
  to, and where it listens.
