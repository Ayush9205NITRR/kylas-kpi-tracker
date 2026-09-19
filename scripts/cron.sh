#!/bin/sh
# One entry point for every scheduled job.
#
#   scripts/cron.sh sync       Kylas -> Airtable   (twice a day)
#   scripts/cron.sh rollup     Call Log retention  (weekly)
#   scripts/cron.sh snapshot   freeze yesterday    (daily)
#
# Run it by hand first. It behaves identically from a terminal and from cron,
# which is the point: a job that only works when you run it yourself is not
# scheduled, it is a rehearsal.
#
# WHY A WRAPPER AND NOT THREE CRONTAB LINES
# cron does not run your shell. There is no ~/.zshrc, no nvm, PATH is about
# four entries, HOME may be unset and the working directory is not the repo.
# The usual result is a cron that has "been running for weeks" and has never
# once completed — every run dying on `node: command not found` into an email
# nobody reads. So this resolves all of it explicitly and says which part
# failed.
#
# POSIX sh on purpose: this has to work on the associates' Macs (where /bin/sh
# is not bash) and on a Linux server, without either being special.

set -eu

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "usage: $0 sync|rollup|snapshot" >&2
  exit 2
fi

# ── where am I ─────────────────────────────────────────────────────────
# From cron the working directory is $HOME, not the repo, so every path here
# is derived from the script's own location rather than from where it was run.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO"

LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$JOB.log"
LOCK="$LOG_DIR/.$JOB.lock"

stamp() { date "+%Y-%m-%d %H:%M:%S%z"; }
say() { echo "[$(stamp)] $*" >> "$LOG"; }

# ── one at a time ──────────────────────────────────────────────────────
# mkdir is atomic on every filesystem that matters, which `[ -f ] && touch` is
# not. A sync that overran its slot and met the next one would page the whole
# account twice and fight over the same watermark.
STALE_HOURS=6
if ! mkdir "$LOCK" 2>/dev/null; then
  # A killed run leaves the directory behind for ever, and the job then never
  # runs again — silently, which is the worst of both. Anything older than a
  # run could plausibly take is treated as wreckage.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$((STALE_HOURS * 60)) 2>/dev/null)" ]; then
    say "! removing a lock older than ${STALE_HOURS}h — a previous run was killed"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { say "! could not take the lock, giving up"; exit 1; }
  else
    say "already running (lock held) — skipping this slot"
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT INT TERM

# ── credentials ────────────────────────────────────────────────────────
if [ ! -f "$REPO/.env.local" ]; then
  say "! no .env.local in $REPO — see INSTALL.md §4. Nothing ran."
  exit 1
fi
# shellcheck disable=SC1091
. "$REPO/.env.local"

missing=""
[ -n "${AIRTABLE_PAT:-}" ] || missing="$missing AIRTABLE_PAT"
[ -n "${AIRTABLE_BASE:-}" ] || missing="$missing AIRTABLE_BASE"
# Only the sync talks to Kylas; the other two are Airtable-only.
if [ "$JOB" = "sync" ]; then
  [ -n "${KYLAS_KEY:-}" ] || missing="$missing KYLAS_KEY"
fi
if [ -n "$missing" ]; then
  say "! .env.local is missing:$missing — nothing ran."
  exit 1
fi

# ── node ───────────────────────────────────────────────────────────────
# NODE_BIN can be set in .env.local, which is what install-cron.sh writes when
# it finds node somewhere cron would not look (nvm, homebrew, asdf).
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node /opt/node22/bin/node; do
    [ -x "$candidate" ] && { NODE="$candidate"; break; }
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  say "! node not found. cron's PATH is $PATH"
  say "  Add 'export NODE_BIN=/full/path/to/node' to .env.local (which node)."
  exit 1
fi

# ── what each job actually is ──────────────────────────────────────────
case "$JOB" in
  sync)     set -- scripts/sync-kylas.mjs --apply ;;
  # 30 days, not the script's own default of 90. 90 days at this team's volume
  # is ~54,000 raw rows, which is over a Team base on its own — the script says
  # so when you run it. Passed explicitly so the number is visible in the log
  # rather than depending on which default wins.
  rollup)   set -- scripts/rollup-calls.mjs --apply --days "${CALL_RETAIN_DAYS:-30}" ;;
  snapshot) set -- scripts/snapshot.mjs ;;
  *)        say "! unknown job '$JOB'"; exit 2 ;;
esac

say "start: $JOB ($* ) node=$NODE"
started=$(date +%s)

# The job's own output goes to the log verbatim. Losing it to /dev/null is how
# a sync that has been reporting "the Kylas list is INCOMPLETE" every night for
# a month goes unnoticed.
if "$NODE" "$@" >> "$LOG" 2>&1; then
  say "ok: $JOB in $(( $(date +%s) - started ))s"
  status=0
else
  status=$?
  say "! FAILED: $JOB exited $status after $(( $(date +%s) - started ))s"
fi

# ── keep the log readable ──────────────────────────────────────────────
# Unbounded, this is the file that fills the disk in a year. Trimmed rather
# than rotated because there is nothing here worth keeping for a year — the
# base itself records what the sync did.
MAX_LINES=5000
lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$lines" -gt "$MAX_LINES" ]; then
  tail -n "$MAX_LINES" "$LOG" > "$LOG.trim" && mv "$LOG.trim" "$LOG"
fi

exit "$status"
