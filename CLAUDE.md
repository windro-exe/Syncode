# opencode (wnxd local fork)

This is wnxd's locally modified opencode clone. We carry features that don't exist upstream and ship them as a self-built Windows binary at `~/.local/bin/opencode.exe`.

## Layout

- Default branch: whatever the upstream HEAD is when this clone was last pulled (currently `main`/`master` from `origin https://github.com/anomalyco/opencode.git`).
- Working branch: **`wnxd`**. All local features live on this branch.
- Build pipeline: standard `bun run build` from `packages/opencode`. Output is a true production single-exe (~143 MB), bundled and minified — there is no separate "prod vs dev" binary.

## Local features layered on top of upstream

- **Memory system** (`packages/opencode/src/memory/`, `src/tool/memory.ts`, `src/tool/memory.txt`, `migration/2026*_memory_system/`).
  - Two-tier persistent memory (`global` + `session`) backed by SQLite + FTS5
  - Replaces upstream's compaction loop: the prompt loop's overflow auto-trigger is neutered (`src/session/prompt.ts`), the system prompt now includes a live memory index (`src/session/system.ts`), and the `/remember` slash command pre-fills a snapshot directive for the agent (`src/cli/cmd/tui/routes/session/index.tsx`)
  - The model is responsible for persisting durable facts to memory before context overflows, instead of having the system summarize them
- Add new features here as they land.

## Upgrade workflow — DO NOT use the in-app auto-updater

The user has explicitly said: never let the auto-updater run. It will overwrite `~/.local/bin/opencode.exe` with the upstream npm release and erase every local feature.

Concretely:

- The TUI's "Update Available" prompt: always answer **Skip**, never Confirm.
- Never run `bun upgrade`, `opencode upgrade`, or any equivalent install script that pulls from GitHub releases or npm.
- The version stamp (`OPENCODE_VERSION` baked into the binary at build time) is set high on purpose so the in-app upgrader's release-type check doesn't auto-install anything. If you see it as `1.16.0-wnxd` or higher, that's intentional — don't "fix" it down.
- `opencode.jsonc` is left at the user's preferred autoupdate setting; the version stamp is the safety, not the config.

When the user wants to take an upstream update:

1. They will explicitly tell you ("update from upstream", "pull the latest opencode", etc.).
2. From `wnxd` branch: `git fetch origin && git merge origin/<upstream-default-branch>` — resolve any conflicts in the local-feature files (memory system, /remember, prompt loop neutering).
3. Run `bun run typecheck` and fix anything broken by the upstream changes before building.
4. Rebuild with the version stamp:
   ```bash
   OPENCODE_VERSION=<new-stamp> bun run build
   ```
   Pick a stamp that semver-compares ABOVE the latest upstream npm release. Currently we use `1.16.0-wnxd`; bump it past whatever upstream is.
5. Install the rebuilt binary (Windows file lock requires rename-swap):
   ```bash
   mv ~/.local/bin/opencode.exe ~/.local/bin/opencode.exe.old
   cp packages/opencode/dist/opencode-windows-x64/bin/opencode.exe ~/.local/bin/opencode.exe
   ```
   The `.old` file can be deleted once the running TUI session is closed.
6. Smoke test: `~/.local/bin/opencode.exe --version` should print the new stamp.

## Build notes

- `bun run build` requires bun 1.3.14 (per `packageManager` in root package.json) and a working node-gyp toolchain (Python 3.12 + VS Build Tools) for the tree-sitter-powershell native build.
- `OPENCODE_VERSION` env var, when set, overrides the auto-stamping in `packages/script/src/index.ts`. Without it the build script falls back to `0.0.0-<branch>-<timestamp>` because this clone has no release tag matching its current HEAD.
- The CRLF-vs-LF warnings on Windows are harmless and don't constitute real diffs.
