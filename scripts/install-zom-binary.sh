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

echo "==> checking latest zom release ($TARGET)"
URL="https://github.com/$REPO/releases/latest/download/opencode-zom-$TARGET"

# 无状态对账：latest 资产的 Last-Modified vs 本机二进制的 mtime。
# 资产比已装二进制新才重下；拿不到对方时间就照旧下载（手动跑的兜底）。
# /releases/latest/download/ 302 到具体 tag 的资产 URL，Last-Modified 取最后跳。
LASTMOD=$(curl -fsIL "$URL" 2>/dev/null | grep -i '^last-modified:' | tail -1 | cut -d' ' -f2- | tr -d '\r' || true)
if [ -x "$DEST/opencode-zom" ] && [ -n "$LASTMOD" ]; then
  case "$(uname -s)" in
    # BSD strptime 的 %Z 解析不了 GMT，去掉时区字段、按 UTC 读
    Darwin) asset_epoch=$(LC_ALL=C date -j -u -f '%a, %d %b %Y %H:%M:%S' "${LASTMOD% GMT}" +%s 2>/dev/null); bin_epoch=$(stat -f %m "$DEST/opencode-zom") ;;
    Linux)  asset_epoch=$(date -u -d "$LASTMOD" +%s 2>/dev/null);                bin_epoch=$(stat -c %Y "$DEST/opencode-zom") ;;
  esac
  if [ -n "${asset_epoch:-}" ] && [ "$asset_epoch" -le "$bin_epoch" ]; then
    echo "==> opencode-zom up to date (asset $LASTMOD <= installed mtime), skip"
    exit 0
  fi
fi

mkdir -p "$DEST"
TMP=$(mktemp)
curl -fL --progress-bar "$URL" -o "$TMP"
chmod +x "$TMP"
mv "$TMP" "$DEST/opencode-zom"

echo "==> installed: $DEST/opencode-zom ($("$DEST/opencode-zom" --version 2>/dev/null | head -1))"
echo "    the plugin uses it automatically on the next shell;"
echo "    or pin it: config.jsonc shell.binary = \"$DEST/opencode-zom\""
