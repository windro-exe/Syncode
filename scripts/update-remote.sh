#!/usr/bin/env bash
# Syncode updater (macOS / Linux) — compares the installed CLI version against the
# latest published on the Syncode dist branch and, if they differ, downloads the
# prebuilt binary for this OS/arch and swaps it in. Only needs `curl` + `gzip`.
#
#   curl -fsSL https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.sh | bash
#
# It ONLY replaces the opencode binary. It never touches your config, sessions,
# auth, memory, or any local settings (~/.config/opencode, ~/.local/share/opencode).
# The previous binary is kept as <binary>.old for rollback.
#
# Env knobs: SYNCODE_REPO (default windro-xdd/Syncode), SYNCODE_DIST_BRANCH
# (default dist), SYNCODE_BIN (default ~/.local/bin). Pass --check to only compare.
set -euo pipefail

REPO="${SYNCODE_REPO:-windro-xdd/Syncode}"
BRANCH="${SYNCODE_DIST_BRANCH:-dist}"
DEST="${SYNCODE_BIN:-$HOME/.local/bin}"
BASE="https://raw.githubusercontent.com/$REPO/$BRANCH"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required"; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)              ASSET=opencode-linux-x64.gz ;;
  Linux-aarch64|Linux-arm64) ASSET=opencode-linux-arm64.gz ;;
  Darwin-arm64)              ASSET=opencode-darwin-arm64.gz ;;
  Darwin-x86_64)             ASSET=opencode-darwin-x64.gz ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
esac

# Resolve which binary we're updating: prefer one already on PATH, else ~/.local/bin.
if command -v opencode >/dev/null 2>&1; then
  TARGET="$(command -v opencode)"
else
  TARGET="$DEST/opencode"
fi

extract_ver() { grep -oE '[0-9]+\.[0-9]+\.[0-9]+[-.A-Za-z0-9]*' | head -1; }

installed=""
[ -x "$TARGET" ] && installed="$("$TARGET" --version 2>/dev/null | extract_ver || true)"
latest="$(curl -fsSL "$BASE/version.json" | tr ',{}' '\n\n\n' | grep '"version"' | extract_ver || true)"
[ -n "$latest" ] || { echo "Could not read latest version from $BASE/version.json"; exit 1; }

echo "installed: ${installed:-(none)}    latest: $latest"
if [ "$installed" = "$latest" ]; then
  echo "Already up to date."
  exit 0
fi
if [ "$CHECK_ONLY" = "1" ]; then
  echo "Update available: ${installed:-(none)} -> $latest  (run without --check to install)"
  exit 0
fi

tmp="$(mktemp)"; tmpgz="$tmp.gz"
cleanup() { rm -f "$tmp" "$tmpgz"; }
trap cleanup EXIT

echo "Downloading $ASSET ..."
curl -fL "$BASE/$ASSET" -o "$tmpgz"
gzip -dc "$tmpgz" > "$tmp"
chmod +x "$tmp"

# macOS: strip Gatekeeper quarantine or the unsigned binary won't run.
[ "$(uname -s)" = "Darwin" ] && xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true

# Verify the downloaded binary actually runs before we install it.
newver="$("$tmp" --version 2>/dev/null | extract_ver || true)"
[ -n "$newver" ] || { echo "Downloaded binary failed to run; not installing."; exit 1; }

mkdir -p "$(dirname "$TARGET")"
[ -f "$TARGET" ] && mv -f "$TARGET" "$TARGET.old"
mv -f "$tmp" "$TARGET"
trap - EXIT; rm -f "$tmpgz"

echo "Updated ${installed:-(none)} -> $newver"
echo "Your config, sessions and settings are untouched. Previous binary saved as $TARGET.old"
