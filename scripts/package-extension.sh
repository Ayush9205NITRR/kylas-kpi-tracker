#!/bin/sh
# Build the .zip the Chrome Web Store wants.
#
#   scripts/package-extension.sh
#
# Writes dist/enout-call-console-<version>.zip, where <version> is read from the
# manifest so the file name and the manifest can never disagree.
#
# WHAT IT LEAVES OUT, and why each one matters to a reviewer:
#   README.md      developer notes. Not part of the product, and it describes
#                  the proxy and the Airtable schema — detail that belongs in
#                  the repo, not in a package strangers can unzip.
#   .DS_Store      a macOS artefact that has failed more store uploads than any
#                  real problem.
#
# It also REFUSES to build if the tree is dirty on the files being packaged.
# Shipping a zip built from uncommitted edits is how a version goes out that
# nothing in git can reproduce.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO"

SRC="$REPO/extension"
[ -f "$SRC/manifest.json" ] || { echo "! no extension/manifest.json — wrong directory?" >&2; exit 1; }

VERSION=$(node -p "require('$SRC/manifest.json').version")
NAME=$(node -p "require('$SRC/manifest.json').name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-\$/g,'')")
OUT="$REPO/dist/$NAME-$VERSION.zip"

# ── is the tree clean where it matters ─────────────────────────────────
if command -v git >/dev/null 2>&1 && [ -d "$REPO/.git" ]; then
  DIRTY=$(git status --porcelain -- extension | head -5)
  if [ -n "$DIRTY" ]; then
    echo "! extension/ has uncommitted changes:" >&2
    echo "$DIRTY" | sed 's/^/    /' >&2
    echo "  Commit them first, or this zip is a build nothing can reproduce." >&2
    [ "${1:-}" = "--force" ] || exit 1
    echo "  (--force given, continuing anyway)" >&2
  fi
fi

# ── sanity: the things a reviewer rejects for ──────────────────────────
# Cheaper to fail here than to wait a week for a human to say the same thing.
if grep -rqE "https?://(?!127\.0\.0\.1|localhost)" --include=*.html "$SRC" 2>/dev/null; then :; fi
REMOTE=$(grep -rhoE "(src|href)=\"https?://[^\"]+\"" "$SRC"/console/*.html "$SRC"/content/*.js 2>/dev/null || true)
if [ -n "$REMOTE" ]; then
  echo "! a shipped file references a remote resource:" >&2
  echo "$REMOTE" | sed 's/^/    /' >&2
  echo "  The store form asks whether you use remote code. Bundle it instead." >&2
  exit 1
fi
if grep -rqE "eval\(|new Function|importScripts" --include=*.js "$SRC"; then
  echo "! a shipped script uses eval/new Function/importScripts — the store treats" >&2
  echo "  that as remote code and it will slow or fail review." >&2
  exit 1
fi

# ── the things the STORE rejects for, checked before upload ────────────
# A rejection costs days of review queue, so each of these is worth a second
# here. They are the ones that have an objective answer; the judgement calls
# (screenshots, the single-purpose statement) are in docs/webstore.md.
FAIL=0
note() { echo "! $1" >&2; FAIL=1; }

# Icons. Without these Chrome draws the generic puzzle piece and the listing
# has no 128 to show. This was missing until 2026-09-20.
for S in 16 32 48 128; do
  [ -f "$SRC/icons/icon$S.png" ] || note "extension/icons/icon$S.png is missing — run: node scripts/gen-icons.mjs"
done
node -e '
  const m = require("'"$SRC"'/manifest.json");
  if (!m.icons || !m.icons["128"]) { console.error("! manifest has no icons.128"); process.exit(1); }
' || FAIL=1

# A description over 132 characters is truncated in the store listing.
DESC_LEN=$(node -p "require('$SRC/manifest.json').description.length")
[ "$DESC_LEN" -le 132 ] || note "description is $DESC_LEN chars; the store truncates past 132"

# Every host permission has to be justified on the form. Listing them here
# means writing those justifications is a matter of reading, not remembering.
echo "  host permissions to justify on the form:"
node -p "require('$SRC/manifest.json').host_permissions.map(h => '    ' + h).join('\n')"
echo "  permissions to justify:"
node -p "(require('$SRC/manifest.json').permissions||[]).map(h => '    ' + h).join('\n')"

[ "$FAIL" = "0" ] || { echo "" >&2; echo "Fix the above, then run this again." >&2; exit 1; }

mkdir -p "$REPO/dist"
rm -f "$OUT"

# -x excludes; run from inside extension/ so paths in the zip are relative to
# the manifest, which is what the store requires.
( cd "$SRC" && zip -q -r -9 "$OUT" . \
    -x "README.md" -x "*/.DS_Store" -x ".DS_Store" )

SIZE=$(du -h "$OUT" | cut -f1)
echo "built $OUT  ($SIZE)"
echo
echo "  files:"
unzip -Z1 "$OUT" | sed 's/^/    /' | head -20
COUNT=$(unzip -Z1 "$OUT" | wc -l | tr -d ' ')
[ "$COUNT" -gt 20 ] && echo "    ... $((COUNT - 20)) more"
echo
echo "Next: docs/webstore.md — listing, screenshots and the permission justifications."
echo "Upload at chrome.google.com/webstore/devconsole -> Package -> Upload new package."
