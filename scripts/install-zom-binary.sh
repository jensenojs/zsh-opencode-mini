#!/bin/bash
# Install the zom fork binary of opencode (inline resume, cwd follow,
# composer prefill, ctrl+z suspend, key passthrough) from GitHub Releases.
# The zsh plugin picks it up automatically (no config needed); to pin it
# explicitly instead, set shell.binary to the printed path.
set -euo pipefail

REPO="jensenojs/opencode"
DEST="$HOME/.local/bin"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  TARGET=darwin-arm64 ;;
  Darwin/x86_64) TARGET=darwin-x64 ;;
  Linux/x86_64)  TARGET=linux-x64 ;;
  Linux/aarch64) TARGET=linux-arm64 ;;
  *) echo "unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

echo "==> resolving latest zom release ($TARGET)"
URL="https://github.com/$REPO/releases/latest/download/opencode-zom-$TARGET"
mkdir -p "$DEST"
TMP=$(mktemp)
curl -fL --progress-bar "$URL" -o "$TMP"
chmod +x "$TMP"
mv "$TMP" "$DEST/opencode-zom"

echo "==> installed: $DEST/opencode-zom ($("$DEST/opencode-zom" --version 2>/dev/null | head -1))"
echo "    the plugin uses it automatically on the next shell;"
echo "    or pin it: config.jsonc shell.binary = \"$DEST/opencode-zom\""
