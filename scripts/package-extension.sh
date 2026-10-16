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

mkdir -p "$REPO/dist"
rm -f "$OUT"

# ── THE STORE BUILD DROPS THE DEV-ONLY HOST PERMISSIONS ────────────────
# extension/manifest.json keeps http://127.0.0.1:*/* and http://localhost:*/*
# because `npm run proxy` + Load unpacked is how this is developed, and a
# developer must not have to hand-edit the manifest to test.
#
# A PUBLISHED build has no use for them. The console talks to
# bd.enout.website; nothing a store user does reaches a loopback address. And
# "unnecessary permissions" is one of the few things a Chrome Web Store
# reviewer rejects outright, so shipping two localhost grants invites exactly
# the kind of manual look that turns a two-day review into a two-week one.
#
# So the zip is built from a COPY with those two stripped, and the source
# manifest is left alone. Done in node rather than sed because a manifest is
# JSON and a regex over JSON is how a trailing comma ships.
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp -R "$SRC/." "$BUILD/"
# DROPPED: the two loopback hosts, and app.kylas.io.
#   The loopback pair is the local proxy + Load unpacked, which a published
#   build never does. app.kylas.io is REDUNDANT: the content script is injected
#   by content_scripts.matches, which is its own grant, and nothing here
#   fetches app.kylas.io — every network call is made from console/api.js
#   inside the console iframe (no fetch in background.js or content/inject.js).
#
# KEPT: bd.enout.website. test-store-build proves the fetch works through plain
#   CORS with no host permission at all, so this entry is not what makes the
#   console work — ALLOWED_ORIGIN on the Worker is. It stays as the belt to
#   that braces: if the published extension id is ever missing from
#   ALLOWED_ORIGIN, this is what keeps the console alive instead of every
#   associate opening a dead panel.
#
# NOTE FOR THE NEXT EDITOR: no apostrophes inside the node -e block below. It
# is single-quoted for the shell, and one apostrophe in a comment ends the
# quote and turns the next bracket into a syntax error. That is how this broke.
STRIPPED=$(node -e '
  const fs = require("fs");
  const f = process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  const drop = (h) => /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(h)
                   || /^https:\/\/app\.kylas\.io\b/.test(h);
  const gone = (m.host_permissions || []).filter(drop);
  m.host_permissions = (m.host_permissions || []).filter((h) => !drop(h));
  if (!m.host_permissions.length) {
    console.error("! stripping would leave host_permissions empty");
    process.exit(1);
  }
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
  process.stdout.write(gone.join(" "));
' "$BUILD")

# -x excludes; run from inside the copy so paths in the zip are relative to
# the manifest, which is what the store requires.
( cd "$BUILD" && zip -q -r -9 "$OUT" . \
    -x "README.md" -x "*/.DS_Store" -x ".DS_Store" )

SIZE=$(du -h "$OUT" | cut -f1)
echo "built $OUT  ($SIZE)"
[ -n "$STRIPPED" ] && echo "  host permissions left out of the package (dev-only, or already granted elsewhere): $STRIPPED"
echo
echo "  files:"
unzip -Z1 "$OUT" | sed 's/^/    /' | head -20
COUNT=$(unzip -Z1 "$OUT" | wc -l | tr -d ' ')
[ "$COUNT" -gt 20 ] && echo "    ... $((COUNT - 20)) more"
echo
echo "Upload it at chrome.google.com/webstore/devconsole -> Package -> Upload new package."
