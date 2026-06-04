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

# macOS: the binary is unsigned, so clear the Gatekeeper quarantine flag or the
# first run is blocked ("cannot be opened" / "killed: 9").
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$DEST/opencode" 2>/dev/null || true
fi

# Verify it actually runs — do NOT pretend success if it doesn't.
if "$DEST/opencode" --version >/dev/null 2>&1; then
  echo "Installed -> $DEST/opencode ($("$DEST/opencode" --version 2>/dev/null | head -1))"
else
  echo "WARNING: downloaded to $DEST/opencode but it failed to run on this system."
  [ "$(uname -s)" = "Darwin" ] && echo "  macOS: try  xattr -dr com.apple.quarantine \"$DEST/opencode\""
  echo "  (Report the OS/arch so the binary can be checked.)"
  exit 1
fi

# Auto-add to PATH so `opencode` works immediately and on future shells
case ":$PATH:" in *":$DEST:"*) ;;
  *)
    export PATH="$DEST:$PATH"
    case "${SHELL##*/}" in
      zsh)  rc="$HOME/.zshrc"; echo "export PATH=\"$DEST:\$PATH\"" >> "$rc" ;;
      fish) rc="$HOME/.config/fish/config.fish"; echo "set -gx PATH $DEST \$PATH" >> "$rc" ;;
      *)    rc="$HOME/.bashrc"; echo "export PATH=\"$DEST:\$PATH\"" >> "$rc" ;;
    esac
    echo "Added $DEST to PATH in $rc — run: source $rc"
    ;;
esac
