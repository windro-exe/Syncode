#!/usr/bin/env bash
# Syncode remote installer — downloads the latest CLI release binary for this
# OS/arch and installs it to ~/.local/bin/opencode. Only needs `curl`.
#
#   curl -fsSL https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/install-remote.sh | bash
#
# (If the repo is private, set GH_TOKEN with repo scope first.)
set -euo pipefail

REPO="${SYNCODE_REPO:-windro-xdd/Syncode}"
DEST="${SYNCODE_BIN:-$HOME/.local/bin}"

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)              ASSET=opencode-linux-x64 ;;
  Linux-aarch64|Linux-arm64) ASSET=opencode-linux-arm64 ;;
  Darwin-arm64)              ASSET=opencode-darwin-arm64 ;;
  Darwin-x86_64)             ASSET=opencode-darwin-x64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
esac

auth=()
[ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: token $GH_TOKEN")

mkdir -p "$DEST"
echo "Downloading $ASSET (latest release) ..."
curl -fL "${auth[@]}" "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$DEST/opencode"
chmod +x "$DEST/opencode"

echo "Installed -> $DEST/opencode"
"$DEST/opencode" --version || true
case ":$PATH:" in *":$DEST:"*) ;; *) echo "NOTE: add $DEST to your PATH (e.g. echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.bashrc)";; esac
