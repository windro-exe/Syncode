#!/usr/bin/env bash
# Syncode release publisher - builds the CLI for all shipped targets, gzips them,
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

# Safety: this force-pushes an orphan binary branch. Never let it target a real
# source branch, or it would destroy that branch's history.
case "$DIST_BRANCH" in
  wnxd|dev|main|master|HEAD) echo "refusing to publish binaries to source branch '$DIST_BRANCH'"; exit 1 ;;
esac

DIST="$ROOT/packages/opencode/dist"
echo "==> Building Syncode CLI $VERSION (all targets; this takes a few minutes)"
rm -rf "$DIST"   # never ship a stale binary left over from a previous build
( cd "$ROOT/packages/opencode" && bun install && OPENCODE_VERSION="$VERSION" bun run build )

# The updater compares each binary's baked --version against version.json, so the
# build MUST report exactly $VERSION or clients would re-download on every run.
case "$(uname -s)-$(uname -m)" in
  *NT*|MINGW*|MSYS*|CYGWIN*)  probe="$DIST/opencode-windows-x64/bin/opencode.exe" ;;
  Linux-x86_64)               probe="$DIST/opencode-linux-x64/bin/opencode" ;;
  Linux-aarch64|Linux-arm64)  probe="$DIST/opencode-linux-arm64/bin/opencode" ;;
  Darwin-arm64)               probe="$DIST/opencode-darwin-arm64/bin/opencode" ;;
  Darwin-x86_64)              probe="$DIST/opencode-darwin-x64/bin/opencode" ;;
  *)                          probe="" ;;
esac
if [ -n "$probe" ] && [ -x "$probe" ]; then
  built="$("$probe" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[-.A-Za-z0-9]*' | head -1 || true)"
  if [ -n "$built" ] && [ "$built" != "$VERSION" ]; then
    echo "built binary reports '$built' but expected '$VERSION'; aborting"; exit 1
  fi
fi
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# target dir name  ->  published asset name
emit() {
  local dir="$1" out="$2" bin="$DIST/$1/bin/opencode"
  [ -f "$bin" ] || bin="$DIST/$1/bin/opencode.exe"
  if [ ! -f "$bin" ]; then echo "  ! missing $1 (skipped)"; return; fi
  gzip -c "$bin" > "$STAGE/$out"
  echo "  + $out ($(( $(wc -c < "$STAGE/$out") / 1048576 ))MB)"
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
  # Disable GPG signing and any global hooks for this throwaway repo so a contributor's
  # global commit.gpgsign / core.hooksPath can't block the publish. Credentials still
  # come from global config so the push can authenticate.
  git -c commit.gpgsign=false -c user.name="syncode-publisher" \
      -c user.email="syncode@windro-xdd.users.noreply.github.com" \
      commit -q --no-verify -m "dist: $VERSION (prebuilt, gzipped, all OS)"
  git push -f --no-verify "$PUSH_URL" "$DIST_BRANCH"
)

echo "==> Done. Users update with:"
echo "     irm  https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.ps1 | iex      # Windows"
echo "     curl -fsSL https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.sh | bash # macOS/Linux"
