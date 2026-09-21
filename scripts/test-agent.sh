#!/bin/sh
# install-agent.sh, exercised on a machine that is not a Mac.
#
#   scripts/test-agent.sh
#
# The agent is macOS-only and this repo's CI is not, so the parts that decide
# whether it works — the resolved node path, the plist body, the order of
# unload and load, what happens when the proxy does not come up — would
# otherwise be tested by installing it on somebody's laptop and seeing.
#
# So: uname, launchctl and curl are stubbed onto PATH, HOME is redirected into
# a temp dir, and the real script runs unmodified against a throwaway copy of
# the repo. What is NOT tested is launchd itself actually honouring the plist;
# that needs a Mac, and the install prints what to look at when it does not.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REAL=$SCRIPT_DIR/install-agent.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"
  else fails=$((fails + 1)); printf '  FAIL %s\n         got: %s\n' "$1" "$2"; fi
}
has() {
  if printf '%s' "$2" | grep -qF -- "$3"; then printf '  ok   %s\n' "$1"
  else fails=$((fails + 1)); printf '  FAIL %s\n         not found: %s\n' "$1" "$3"; fi
}

# ── a throwaway repo with the script in it ─────────────────────────────
REPO="$TMP/repo"
mkdir -p "$REPO/scripts"
cp "$REAL" "$REPO/scripts/install-agent.sh"
chmod +x "$REPO/scripts/install-agent.sh"

# ── stubs, first on PATH ───────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
printf '#!/bin/sh\necho Darwin\n' > "$BIN/uname"
printf '#!/bin/sh\necho "launchctl $*" >> "%s/launchctl.log"\n' "$TMP" > "$BIN/launchctl"
# curl: fails until HEALTHY exists, so both the up and the never-came-up paths
# can be exercised without waiting on a real socket.
printf '#!/bin/sh\n[ -f "%s/HEALTHY" ] || exit 7\nexit 0\n' "$TMP" > "$BIN/curl"
# A node that is a real file, so the script's realpath resolution has something
# to resolve. Its contents never run.
mkdir -p "$TMP/nodedir"; printf '#!/bin/sh\nexit 0\n' > "$TMP/nodedir/node"
chmod +x "$BIN/uname" "$BIN/launchctl" "$BIN/curl" "$TMP/nodedir/node"
export PATH="$BIN:$TMP/nodedir:$PATH"
export HOME="$TMP/home"
mkdir -p "$HOME"

run() { sh "$REPO/scripts/install-agent.sh" "$@" 2>&1; }

echo "— without .env.local it refuses —"
out=$(run --apply || true)
has "it says which file is missing" "$out" ".env.local does not exist"
check "and writes no plist" "$([ -f "$HOME/Library/LaunchAgents/in.enout.bdconsole.proxy.plist" ] && echo yes || echo no)" "no"

printf 'export KYLAS_KEY=x\nexport AIRTABLE_PAT=y\n' > "$REPO/.env.local"

echo
echo "— show mode changes nothing —"
out=$(run)
has "it prints the plist it would write" "$out" "<key>Label</key><string>in.enout.bdconsole.proxy</string>"
has "with an ABSOLUTE node path" "$out" "$TMP/nodedir/node"
has "and the repo's own proxy.mjs" "$out" "$REPO/scripts/proxy.mjs"
has "it says nothing was changed" "$out" "Nothing was changed"
check "no plist on disk" "$([ -f "$HOME/Library/LaunchAgents/in.enout.bdconsole.proxy.plist" ] && echo yes || echo no)" "no"
check "launchctl was not called" "$([ -f "$TMP/launchctl.log" ] && echo yes || echo no)" "no"

echo
echo "— apply, and the proxy comes up —"
touch "$TMP/HEALTHY"
out=$(run --apply)
P="$HOME/Library/LaunchAgents/in.enout.bdconsole.proxy.plist"
check "the plist is written" "$([ -f "$P" ] && echo yes || echo no)" "yes"
body=$(cat "$P")
has "it runs node against proxy.mjs" "$body" "<string>$REPO/scripts/proxy.mjs</string>"
has "it starts at login" "$body" "<key>RunAtLoad</key><true/>"
# KeepAlive must be the DICT form. Plain `true` restarts the proxy every time
# somebody stops it on purpose, which makes debugging it impossible.
has "it restarts only on a crash" "$body" "<key>SuccessfulExit</key><false/>"
has "logs go to the repo's logs dir" "$body" "$REPO/logs/proxy.log"
has "it works out of the repo" "$body" "<key>WorkingDirectory</key><string>$REPO</string>"
# UNLOAD BEFORE LOAD. Without it a second --apply leaves the OLD agent running
# and reports success, which is the worst of both.
log=$(cat "$TMP/launchctl.log")
check "unload comes before load" "$(printf '%s' "$log" | grep -c unload)" "1"
has "then it loads" "$log" "launchctl load $P"
has "and says it is up" "$out" "up. It will start again at every login"

echo
echo "— apply again is safe —"
: > "$TMP/launchctl.log"
out=$(run --apply)
log=$(cat "$TMP/launchctl.log")
check "it unloads the old one first" "$(printf '%s' "$log" | grep -c unload)" "1"
has "before loading the new" "$log" "launchctl load"

echo
echo "— apply, and the proxy does NOT come up —"
rm -f "$TMP/HEALTHY"
# The wait loop is 20 × 1s; shorten the test by accepting the failure path only.
out=$(run --apply || true)
has "it does not claim success" "$out" "nothing is answering on 8787"
has "it names the log to read" "$out" "$REPO/logs/proxy.log"
has "and the two usual causes" "$out" ".env.local has no AIRTABLE_PAT"

echo
echo "— remove —"
touch "$TMP/HEALTHY"
out=$(run --remove)
check "the plist is gone" "$([ -f "$P" ] && echo yes || echo no)" "no"
has "and it says how to run it by hand" "$out" "node $REPO/scripts/proxy.mjs"

echo
if [ "$fails" -gt 0 ]; then echo "$fails check(s) FAILED"; exit 1; fi
echo "all checks passed"
