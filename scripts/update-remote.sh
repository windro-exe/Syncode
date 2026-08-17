#!/usr/bin/env bash
# Syncode updater (macOS / Linux) - compares the installed CLI version against the
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
# (default dist), SYNCODE_BIN (install dir, default ~/.local/bin),
# SYNCODE_CHECK=1 (compare only, don't install). Also accepts --check as an arg.
set -euo pipefail

REPO="${SYNCODE_REPO:-windro-xdd/Syncode}"
BRANCH="${SYNCODE_DIST_BRANCH:-dist}"
DEST="${SYNCODE_BIN:-$HOME/.local/bin}"
BASE="https://raw.githubusercontent.com/$REPO/$BRANCH"
CHECK_ONLY=0
{ [ "${SYNCODE_CHECK:-}" = "1" ] || [ "${1:-}" = "--check" ]; } && CHECK_ONLY=1

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required"; exit 1; }

os="$(uname -s)"
machine="$(uname -m)"
# uname -m reports the calling process arch, which lies under Rosetta. On macOS,
# ask the kernel whether the hardware is arm64 so we don't ship an x64 binary to an
# Apple Silicon machine running an x86 shell.
if [ "$os" = "Darwin" ] && sysctl -n hw.optional.arm64 2>/dev/null | grep -q '^1$'; then
  machine="arm64"
fi
case "$os-$machine" in
  Linux-x86_64)               ASSET=opencode-linux-x64.gz ;;
  Linux-aarch64|Linux-arm64)  ASSET=opencode-linux-arm64.gz ;;
  Darwin-arm64)               ASSET=opencode-darwin-arm64.gz ;;
  Darwin-x86_64)              ASSET=opencode-darwin-x64.gz ;;
  *) echo "Unsupported platform: $os-$machine"; exit 1 ;;
esac

# Always target the canonical install location ($DEST/opencode), matching the
# installer. Updating whatever happens to be first on PATH risks clobbering a
# package-manager shim (npm/brew) with a raw binary, so we don't do that - but we
# do warn if a different opencode is shadowing this one.
TARGET="$DEST/opencode"
if other="$(command -v opencode 2>/dev/null)" && [ "$other" != "$TARGET" ]; then
  echo "note: a different 'opencode' is on your PATH at $other"
  echo "      this updater manages $TARGET (set SYNCODE_BIN to change)."
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
  echo "Update available: ${installed:-(none)} -> $latest  (run without --check / SYNCODE_CHECK to install)"
  exit 0
fi

# Stage the download IN the install dir so the final move is an atomic same-filesystem
# rename and so we never exec the candidate from a noexec /tmp during verification.
mkdir -p "$DEST"
tmp="$(mktemp "$DEST/.opencode.XXXXXX")"
tmpgz="$tmp.gz"
cleanup() { rm -f "$tmp" "$tmpgz"; }
trap cleanup EXIT

echo "Downloading $ASSET ..."
if ! curl -fL "$BASE/$ASSET" -o "$tmpgz"; then
  echo "Download failed for $BASE/$ASSET (no prebuilt binary for $os-$machine, or network error)."
  exit 1
fi
gzip -dc "$tmpgz" > "$tmp"
chmod +x "$tmp"

if [ "$os" = "Darwin" ]; then
  # Unsigned binaries: clear the quarantine bit and apply an ad-hoc signature, or
  # Apple Silicon refuses to exec the binary at all (Killed: 9) and verify fails.
  xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true
  command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$tmp" 2>/dev/null || true
fi

# Verify the downloaded binary actually runs before we install it.
newver="$("$tmp" --version 2>/dev/null | extract_ver || true)"
if [ -z "$newver" ]; then
  echo "Downloaded binary failed to run on this system; not installing."
  [ "$os" = "Darwin" ] && echo "  (macOS: ensure Xcode command line tools are present so it can be code-signed.)"
  exit 1
fi

# Atomic swap: keep the old one for rollback, then rename the new one into place.
if [ -e "$TARGET" ]; then mv -f "$TARGET" "$TARGET.old"; fi
if ! mv -f "$tmp" "$TARGET"; then
  [ -e "$TARGET.old" ] && mv -f "$TARGET.old" "$TARGET"
  echo "Install failed; restored previous binary."
  exit 1
fi
trap - EXIT; rm -f "$tmpgz"

echo "Updated ${installed:-(none)} -> $newver"
echo "Your config, sessions and settings are untouched."
[ -e "$TARGET.old" ] && echo "Previous binary saved as $TARGET.old"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "note: $DEST is not on your PATH - add it so 'opencode' resolves here." ;;
esac
