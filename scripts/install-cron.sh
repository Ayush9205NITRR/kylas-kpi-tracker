#!/bin/sh
# Install (or show) the schedule.
#
#   scripts/install-cron.sh            print what it WOULD install, change nothing
#   scripts/install-cron.sh --apply    write it into your crontab
#   scripts/install-cron.sh --remove   take it back out
#
# THE SCHEDULE, in the machine's LOCAL time
#   00:30 daily    snapshot   yesterday is over, freeze it
#   01:00 daily    sync       Kylas -> Airtable
#   13:00 daily    sync       again, so an afternoon's CRM edits reach the
#                             console before the next morning
#   02:00 Sunday   rollup     Call Log retention, after that night's sync
#
# Nothing overlaps, and every job takes a lock anyway.
#
# It edits ONLY the block between the markers below. Your other cron entries
# are read, kept and written back untouched — `crontab scripts/cron.tab` would
# replace the lot, and on a shared machine that is somebody else's backup job
# gone.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUNNER="$REPO/scripts/cron.sh"

BEGIN="# >>> enout bd console >>>"
END="# <<< enout bd console <<<"

MODE="show"
case "${1:-}" in
  --apply)  MODE="apply" ;;
  --remove) MODE="remove" ;;
  "")       MODE="show" ;;
  *) echo "usage: $0 [--apply|--remove]" >&2; exit 2 ;;
esac

[ -x "$RUNNER" ] || chmod +x "$RUNNER" 2>/dev/null || true

# ── find node the way CRON will not ────────────────────────────────────
# Doing this here, once, beats every job failing at 01:00 with "node: command
# not found". If node lives somewhere cron cannot see — nvm, homebrew, asdf —
# the path is pinned into .env.local so the runner does not have to guess.
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  echo "! node is not on your PATH here either. Install it, then re-run." >&2
  exit 1
fi
if ! grep -q "^export NODE_BIN=" "$REPO/.env.local" 2>/dev/null; then
  case "$NODE" in
    /usr/bin/node|/bin/node) : ;;   # cron finds these unaided
    *)
      if [ "$MODE" = "apply" ] && [ -f "$REPO/.env.local" ]; then
        echo "export NODE_BIN=$NODE" >> "$REPO/.env.local"
        echo "pinned NODE_BIN=$NODE into .env.local (cron's PATH would not find it)"
      else
        echo "note: node is at $NODE, which cron's PATH does not include."
        echo "      --apply will add 'export NODE_BIN=$NODE' to .env.local."
      fi
      ;;
  esac
fi

BLOCK=$(cat <<EOF
$BEGIN
# Managed by scripts/install-cron.sh — edit the times here, not by hand, or
# the next --apply will overwrite them. Times are this machine's local time.
30 0 * * *   $RUNNER snapshot
0 1 * * *    $RUNNER sync
0 13 * * *   $RUNNER sync
0 2 * * 0    $RUNNER rollup
$END
EOF
)

current=$(crontab -l 2>/dev/null || true)
without=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0 == b { skip = 1 }
  skip != 1 { print }
  $0 == e { skip = 0 }
')

if [ "$MODE" = "show" ]; then
  echo "Would install into your crontab:"
  echo
  printf '%s\n' "$BLOCK"
  echo
  if printf '%s\n' "$current" | grep -qF "$BEGIN"; then
    echo "(replacing the existing block; your other entries are untouched)"
  else
    echo "(adding a new block; your other entries are untouched)"
  fi
  echo
  echo "Run it for real:  $0 --apply"
  echo "Try a job first:  $RUNNER sync    # then read logs/sync.log"
  exit 0
fi

if [ "$MODE" = "remove" ]; then
  printf '%s\n' "$without" | crontab -
  echo "removed. Remaining entries:"
  crontab -l 2>/dev/null || echo "  (none)"
  exit 0
fi

# apply
printf '%s\n%s\n' "$without" "$BLOCK" | sed '/^$/N;/^\n$/D' | crontab -
echo "installed:"
crontab -l 2>/dev/null | sed -n "/$(printf '%s' "$BEGIN" | sed 's/[]\/$*.^[]/\\&/g')/,/$(printf '%s' "$END" | sed 's/[]\/$*.^[]/\\&/g')/p"
echo
echo "Logs: $REPO/logs/{sync,rollup,snapshot}.log"
echo "The dashboard also shows the sync's age — if it stops running, the"
echo "companies list says so rather than quietly going stale."
