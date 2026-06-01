#!/usr/bin/env bash
# Syncode remote installer — downloads the latest CLI release binary for this
# OS/arch and installs it to ~/.local/bin/opencode.
#
# Private repo: set GH_TOKEN (repo scope). Once the repo is public, no token needed.
#   export GH_TOKEN=ghp_xxx
#   bash -c "$(curl -fsSL -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/windro-xdd/Syncode/contents/scripts/install-remote.sh?ref=wnxd")"
set -euo pipefail

REPO="${SYNCODE_REPO:-windro-xdd/Syncode}"
DEST="${SYNCODE_BIN:-$HOME/.local/bin}"
API="https://api.github.com/repos/$REPO"

hdr=(-H "Accept: application/vnd.github+json" -H "User-Agent: syncode-installer")
[ -n "${GH_TOKEN:-}" ] && hdr+=(-H "Authorization: token $GH_TOKEN")

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "jq is required — install it: 'sudo pacman -S jq' / 'brew install jq' / 'sudo apt install jq'"; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)             ASSET=opencode-linux-x64 ;;
  Linux-aarch64|Linux-arm64) ASSET=opencode-linux-arm64 ;;
  Darwin-arm64)             ASSET=opencode-darwin-arm64 ;;
  Darwin-x86_64)            ASSET=opencode-darwin-x64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
esac

echo "Resolving latest release asset: $ASSET ..."
ID=$(curl -fsSL "${hdr[@]}" "$API/releases/latest" | jq -r --arg n "$ASSET" '.assets[] | select(.name==$n) | .id')
[ -n "$ID" ] && [ "$ID" != "null" ] || { echo "Asset $ASSET not found in latest release of $REPO"; exit 1; }

mkdir -p "$DEST"
echo "Downloading $ASSET (id $ID) ..."
curl -fL "${hdr[@]}" -H "Accept: application/octet-stream" "$API/releases/assets/$ID" -o "$DEST/opencode"
chmod +x "$DEST/opencode"

echo "Installed -> $DEST/opencode"
"$DEST/opencode" --version || true
case ":$PATH:" in *":$DEST:"*) ;; *) echo "NOTE: add $DEST to your PATH (e.g. echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.bashrc)";; esac
