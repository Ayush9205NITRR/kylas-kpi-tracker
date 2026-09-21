#!/bin/sh
# Build the copy of the extension the live browser tests load.
#
#   scripts/build-test-extension.sh [dest]        # default /tmp/claude-0/exttest
#
# The shipped manifest matches https://app.kylas.io/* and nothing else, which
# is right for the product and useless for a test: the fake Kylas the live
# suites drive is http://127.0.0.1:8778. Chrome will not inject a content
# script into a host the manifest does not name, and the symptom is not an
# error — no frame ever appears and every locator times out. That cost an hour
# once, so the patch lives here instead of in somebody's shell history.
#
# Only the two match lists change. Everything else is the real extension, so a
# test still proves something about the thing that ships.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DEST=${1:-/tmp/claude-0/exttest}

[ -f "$REPO/extension/manifest.json" ] || { echo "! no extension/manifest.json" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$REPO/extension" "$DEST"

node -e '
  const fs = require("fs");
  const p = process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  const HOST = "http://127.0.0.1:8778/*";
  const add = (list) => list.includes(HOST) ? list : [...list, HOST];
  m.content_scripts.forEach((c) => { c.matches = add(c.matches); });
  (m.web_accessible_resources || []).forEach((w) => { w.matches = add(w.matches); });
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$DEST"

echo "built $DEST (manifest also matches http://127.0.0.1:8778/*)"
