#!/bin/sh
# Bring up the four processes the live browser suites drive, from scratch.
#
#   scripts/live-stack.sh /tmp/focus-seed.json
#   node scripts/test-focus-live.mjs
#
# FROM SCRATCH IS THE POINT. The suites write — they pick accounts, drop them,
# save research — so a second run against a mock left over from the first
# starts from a base the first one changed, and the failures it produces name
# assertions that are fine ("a picked account reads as picked" on an account
# the last run deprioritized). Restarting the mock is not housekeeping, it is
# the precondition. The proxy is restarted with it because it memoizes reads
# and would otherwise serve the old base's rows to the new one.
#
#   9900  mock Kylas          9901  mock Airtable
#   8787  the proxy           8778  a fake Kylas page to inject into
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SEED=${1:-}
LOGS=${LIVE_LOGS:-/tmp/claude-0}
FAKE=${FAKE_KYLAS:-/tmp/claude-0/fakekylas/server.mjs}

[ -n "$SEED" ] || { echo "usage: $0 <seed.json>   (make one with test-focus-live.mjs --seed)" >&2; exit 1; }
[ -f "$SEED" ] || { echo "! no such seed: $SEED" >&2; exit 1; }
mkdir -p "$LOGS"

# The bracket keeps the pattern from matching this script's own command line.
for P in "[m]ock-airtable.mjs" "[m]ock-kylas.mjs" "[s]cripts/proxy.mjs"; do
  pkill -f "$P" 2>/dev/null || true
done
sleep 1

cd "$REPO"
# MOCK_AIRTABLE_NOFIELD passes through, so a caller can stand up a base that is
# one repair-base behind — which is the state Ayush's actually is, and the one
# where a save reports success and the KPI it fed never moves.
MOCK_AIRTABLE_SEED="$SEED" MOCK_AIRTABLE_NOFIELD="${MOCK_AIRTABLE_NOFIELD:-}" \
  node scripts/mock-airtable.mjs > "$LOGS/ma.log" 2>&1 &
node scripts/mock-kylas.mjs > "$LOGS/mk.log" 2>&1 &
sleep 1

# ENV_FILE=/dev/null so a real .env.local on the machine cannot point this at
# the real Airtable base. These suites write.
# RESEARCH_TABLE names a table in the seed, not the real tbl2Jje9EBC4Cqydw. The
# mock serves every base from one map, so the two "bases" share rows — but it
# rate-limits PER base id, as Airtable does, so the distinct id here is what
# makes the two-client pacing behave the way it will in production.
KYLAS_BASE=http://127.0.0.1:9900 KYLAS_KEY=test \
AIRTABLE_BASE_URL=http://127.0.0.1:9901 AIRTABLE_PAT=pat_test AIRTABLE_BASE=appTEST \
RESEARCH_BASE=appRESEARCH RESEARCH_TABLE="Apollo Research" \
ENV_FILE=/dev/null node scripts/proxy.mjs > "$LOGS/px.log" 2>&1 &

# The fake Kylas page only has to exist once; leave a running one alone.
if ! curl -fs -o /dev/null http://127.0.0.1:8778/ 2>/dev/null; then
  [ -f "$FAKE" ] && (cd "$(dirname "$FAKE")" && node "$(basename "$FAKE")" > "$LOGS/fk.log" 2>&1 &)
fi

"$SCRIPT_DIR/build-test-extension.sh" >/dev/null
rm -rf /tmp/claude-0/pfocuslive

sleep 3
for U in "http://127.0.0.1:8787/health" "http://127.0.0.1:8778/"; do
  curl -fs -o /dev/null "$U" || { echo "! $U is not answering — see $LOGS" >&2; exit 1; }
done
grep -q "airtable: appTEST" "$LOGS/px.log" || { echo "! proxy did not pick up the mock Airtable — see $LOGS/px.log" >&2; exit 1; }
echo "stack up: mocks 9900/9901, proxy 8787, fake Kylas 8778, extension built"
