#!/usr/bin/env bash
# Syncode CLI installer — builds from source and installs to ~/.local/bin/opencode
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v bun >/dev/null 2>&1 || { echo "bun is required: https://bun.sh"; exit 1; }

STAMP="${OPENCODE_VERSION:-1.16.13-wnxd}"
echo "Building Syncode CLI ($STAMP) — this compiles all targets and may take a few minutes..."
cd "$ROOT/packages/opencode"
bun install
OPENCODE_VERSION="$STAMP" bun run build

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)   T=opencode-darwin-arm64 ;;
  Darwin-x86_64)  T=opencode-darwin-x64 ;;
  Linux-aarch64)  T=opencode-linux-arm64 ;;
  Linux-x86_64)   T=opencode-linux-x64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m). Copy the right dist/ binary manually."; exit 1 ;;
esac

mkdir -p "$HOME/.local/bin"
cp "dist/$T/bin/opencode" "$HOME/.local/bin/opencode"
chmod +x "$HOME/.local/bin/opencode"
echo "Installed $T to ~/.local/bin/opencode ($STAMP). Ensure ~/.local/bin is on your PATH."
