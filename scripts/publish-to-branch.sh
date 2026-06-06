#!/usr/bin/env bash
# Syncode release publisher — builds the CLI for all shipped targets, gzips them,
# and force-pushes them plus a version.json manifest to the `dist` branch of the
# Syncode repo. The remote updater (scripts/update-remote.{sh,ps1}) reads from there.
#
#   bash scripts/publish-to-branch.sh <version>
#   e.g.  bash scripts/publish-to-branch.sh 1.16.18-wnxd
#
# Why a separate orphan branch + force-push: the binaries are ~50MB each gzipped;
# keeping them off the source branch and replacing (not appending) each release
# stops the repo history from ballooning. GitHub rejects single files >100MB, so
# the binaries MUST be shipped gzipped (raw is ~137MB).
#
# Requires: bun, git, gzip, and push access to the repo (uses the `syncode` remote
# if present, else windro-xdd/Syncode over https).
set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: $0 <version>   e.g. $0 1.16.18-wnxd"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v bun  >/dev/null 2>&1 || { echo "bun is required: https://bun.sh"; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required"; exit 1; }

# Resolve push URL from the `syncode` remote, falling back to the canonical repo.
PUSH_URL="$(git -C "$ROOT" remote get-url syncode 2>/dev/null || echo "https://github.com/windro-xdd/Syncode.git")"
DIST_BRANCH="${SYNCODE_DIST_BRANCH:-dist}"

echo "==> Building Syncode CLI $VERSION (all targets; this takes a few minutes)"
( cd "$ROOT/packages/opencode" && bun install && OPENCODE_VERSION="$VERSION" bun run build )

DIST="$ROOT/packages/opencode/dist"
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# target dir name  ->  published asset name
emit() {
  local dir="$1" out="$2" bin="$DIST/$1/bin/opencode"
  [ -f "$bin" ] || bin="$DIST/$1/bin/opencode.exe"
  if [ ! -f "$bin" ]; then echo "  ! missing $1 (skipped)"; return; fi
  gzip -c "$bin" > "$STAGE/$out"
  echo "  + $out ($(( $(stat -c%s "$STAGE/$out") / 1048576 ))MB)"
}

echo "==> Gzipping shipped targets"
emit opencode-windows-x64   opencode-windows-x64.exe.gz
emit opencode-windows-arm64 opencode-windows-arm64.exe.gz
emit opencode-darwin-arm64  opencode-darwin-arm64.gz
emit opencode-darwin-x64    opencode-darwin-x64.gz
emit opencode-linux-x64     opencode-linux-x64.gz
emit opencode-linux-arm64   opencode-linux-arm64.gz

cat > "$STAGE/version.json" <<EOF
{
  "version": "$VERSION",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "branch": "$DIST_BRANCH"
}
EOF
echo "==> version.json -> $VERSION"

# Build a throwaway standalone repo and force-push it to the dist branch. This never
# touches the working tree, the source branch, or its history.
echo "==> Publishing to $DIST_BRANCH on $PUSH_URL"
(
  cd "$STAGE"
  git init -q
  git checkout -q -b "$DIST_BRANCH"
  git add -A
  git -c user.name="syncode-publisher" -c user.email="syncode@windro-xdd.users.noreply.github.com" \
      commit -q -m "dist: $VERSION (prebuilt, gzipped, all OS)"
  git push -f "$PUSH_URL" "$DIST_BRANCH"
)

echo "==> Done. Users update with:"
echo "     irm  https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.ps1 | iex      # Windows"
echo "     curl -fsSL https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.sh | bash # macOS/Linux"
