#!/bin/sh
# Keep the proxy running, without anybody having to run it.
#
#   scripts/install-agent.sh            print what it WOULD install, change nothing
#   scripts/install-agent.sh --apply    start it now, and at every login
#   scripts/install-agent.sh --remove   stop it and take it back out
#   scripts/install-agent.sh --status   is it running, and what has it logged
#
# WHY THIS EXISTS. Ayush, 2026-09-22: "Do people need to run server in their own
# machine?" Today, yes — and the honest reading of that question is not "can we
# avoid a server" but "nobody should have to think about one". An associate who
# has to open Terminal before their first call will, one morning, not.
#
# So: a launchd agent. It starts at login, restarts if it dies, and writes to
# logs/proxy.log. Nothing about the security model changes — the proxy still
# listens on 127.0.0.1 only, the Kylas key and the Airtable PAT still never
# leave the machine, and each associate's own key still decides who they are.
# That last part is why this is a stopgap and not the answer: see
# docs/central-server.md for what a shared server actually takes.
#
# macOS only. launchd is the thing that starts programs at login there; the
# Linux equivalent is a systemd user unit and is not written here because
# nobody on this team runs one.
#
# NODE IS FOUND HERE, ONCE. launchd does not run your shell: no ~/.zshrc, no
# nvm, and a PATH of about four entries. An agent that says "node: command not
# found" into a log nobody reads is the same failure cron.sh was written to
# avoid, so the absolute path is resolved now and baked into the plist.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

LABEL="in.enout.bdconsole.proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO/logs"

MODE="show"
case "${1:-}" in
  --apply)  MODE="apply" ;;
  --remove) MODE="remove" ;;
  --status) MODE="status" ;;
  "")       MODE="show" ;;
  *) echo "usage: $0 [--apply|--remove|--status]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "! This installs a launchd agent, which is macOS only." >&2
  echo "  On Linux, run the proxy under a systemd user unit, or just" >&2
  echo "  \`node scripts/proxy.mjs\` in a terminal." >&2
  exit 1
fi

# ── the things that must be true before this is worth installing ───────
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  echo "! node is not on your PATH. Install it, then re-run." >&2
  exit 1
fi
# The REAL path. `command -v node` under nvm gives a shim inside a version
# directory that is stable enough, but a symlink into a "current" alias is not:
# the next nvm use repoints it and launchd keeps the old one.
NODE=$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")

if [ ! -f "$REPO/.env.local" ]; then
  echo "! $REPO/.env.local does not exist, so the proxy would start with no" >&2
  echo "  Kylas key and no Airtable PAT. Copy .env.local.example to" >&2
  echo "  .env.local and fill it in first." >&2
  exit 1
fi

case "$MODE" in
  status)
    if [ -f "$PLIST" ]; then echo "plist   $PLIST"; else echo "plist   not installed"; fi
    # launchctl print is the modern form; list is the one that works everywhere.
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "launchd $(launchctl list | grep "$LABEL" | awk '{print "pid "$1", last exit "$2}')"
    else
      echo "launchd not loaded"
    fi
    printf 'health  '
    curl -fsS --max-time 3 http://127.0.0.1:8787/health >/dev/null 2>&1 \
      && echo "answering on 8787" || echo "NOT answering on 8787"
    [ -f "$LOG_DIR/proxy.log" ] && { echo; echo "last 12 lines of $LOG_DIR/proxy.log:"; tail -12 "$LOG_DIR/proxy.log"; }
    exit 0
    ;;
  remove)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed. The proxy will not start at login any more."
    echo "Run it by hand with: node $REPO/scripts/proxy.mjs"
    exit 0
    ;;
esac

mkdir -p "$LOG_DIR"

# ── the plist ──────────────────────────────────────────────────────────
# KeepAlive with SuccessfulExit=false: restart it when it CRASHES, but not when
# somebody deliberately stops it. Plain `KeepAlive: true` fights you — kill the
# proxy to debug something and launchd brings it straight back.
#
# ProcessType Background so macOS does not throttle it the way it throttles
# something it thinks is interactive.
PLIST_BODY=$(cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/scripts/proxy.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/proxy.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/proxy.log</string>
</dict>
</plist>
XML
)

if [ "$MODE" = "show" ]; then
  echo "Would write $PLIST:"
  echo
  echo "$PLIST_BODY" | sed 's/^/    /'
  echo
  echo "node:  $NODE"
  echo "repo:  $REPO"
  echo "log:   $LOG_DIR/proxy.log"
  echo
  echo "Nothing was changed. Re-run with --apply."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
# Unload an older copy first, or launchctl load refuses with "already loaded"
# and you are left running whatever was there before.
launchctl unload "$PLIST" 2>/dev/null || true
printf '%s\n' "$PLIST_BODY" > "$PLIST"
launchctl load "$PLIST"

echo "installed $PLIST"
echo "waiting for the proxy to answer…"
i=0
while [ "$i" -lt 20 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo
    echo "up. It will start again at every login, and restart if it crashes."
    echo "  logs      tail -f $LOG_DIR/proxy.log"
    echo "  check     scripts/install-agent.sh --status"
    echo "  stop it   scripts/install-agent.sh --remove"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

# Not answering. Say what to look at rather than claiming success.
echo >&2
echo "! installed, but nothing is answering on 8787 after 20s." >&2
echo "  The agent is loaded; the proxy is what did not come up." >&2
echo "  Look at: tail -30 $LOG_DIR/proxy.log" >&2
echo "  Most often: .env.local has no AIRTABLE_PAT / KYLAS_KEY, or 8787 is taken." >&2
exit 1
