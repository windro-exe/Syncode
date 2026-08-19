- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

---

## Syncode — standalone fork

This section is specific to this standalone fork. It does not exist upstream and is
intended for any agent (opencode itself, Claude Code, etc.) working ON this codebase.

### Repository & branching model

- Origin: `git@gh-personal:windro-exe/Syncode.git`. **Syncode is fully standalone —
  there is NO upstream remote and no connection to `anomalyco/opencode`.**
- Branching model — every piece of work gets its own branch:
  1. `feature/<name>` or `fix/<name>` branched off `dev` for the work.
  2. Merge the branch into `dev` (integration branch) when done.
  3. Merge `dev` into `prod` only for a release/deploy.
- `dev` is the default branch on GitHub. `dist` holds prebuilt binaries + `version.json`; never develop on it.
- Local source tree: `C:\wnx-projects\personal\Syncode-wnxd` (Windows). Do not work out of `%TEMP%` — cleanup tools eat it.
- Build: `bun run build` from `packages/opencode`. Output is a real production single-exe (~143 MB), bundled and minified — there is no separate "prod vs dev" binary. Add `--single` to build only the current platform instead of all 12 targets.

### Build and install (Windows) — the normal loop

Agents do this unattended; it needs no env setup and no arguments:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

That builds from local source and installs to `~/.local/bin/opencode.exe`, keeping the
old binary as `opencode.exe.old`. Pass `-AllTargets` only for a release cross-compile.
Config, sessions, auth and memory are never touched. Restart the TUI to pick up a new build.

- **Version stamp lives in `SYNCODE_VERSION`** at the repo root. `install.ps1` reads it;
  `$env:OPENCODE_VERSION` or `-Version` override it. Bump that file, not the script.
  Without a stamp, `Script.version` falls back to `git branch --show-current` and produces
  a junk `0.0.0--<timestamp>` build, so the stamp is mandatory — and must stay semver-ABOVE
  the latest upstream npm release so the in-app updater never overwrites this build.
- **Never invoke bare `bun` from PowerShell.** npm installs a `bun.ps1` shim that
  PowerShell prefers and a restricted execution policy blocks. Use `bun.cmd`/`bun.exe`
  (`install.ps1` resolves this itself).
- **`tree-sitter-powershell`'s postinstall always fails** — node-gyp wants Visual Studio.
  Harmless: the package ships a `.wasm` and parsing goes through `web-tree-sitter`. The
  build and its smoke test are the real gate, not `bun install`'s exit code.
- **Moving the tree breaks `node_modules`.** Bun's isolated linker writes ~8,900 symlinks
  under `node_modules\.bun\` with absolute targets. After any move, `bun install --force`.
  Note `--force` also re-resolves `github:` deps like `ghostty-web`; check `bun.lock` isn't
  drifting before committing.

### Adding models

Built-in providers and their model lists live in `packages/core/src/models-dev.ts`
(`BUILTIN_PROVIDERS`). Add a `kiroModel(id, name, release_date, context, output, input[])`
entry. Context limits there are empirically measured against the Q backend, not the
advertised catalog numbers — don't "correct" them upward from marketing pages.

If a new model needs the full reasoning-effort tier set (`low`…`max`), also add its id to
the explicit check in `packages/opencode/src/provider/transform.ts` (`variants()`);
`anthropicAdaptiveEfforts` does not match preview ids. Then rebuild and install.

### Local features layered on top of upstream

- **Memory system** (`packages/opencode/src/memory/`, `src/tool/memory.ts`, `src/tool/memory.txt`, `migration/20260710000000_memory_system.ts`).
  - Two-tier persistent memory (`global` + `session`) backed by SQLite + FTS5
  - BM25 relevance ranking with recency decay, salience weighting, and age rail
  - Auto-memory: sliding-window background extraction of pruned turns into session notes
  - Replaces upstream compaction loop with durable memory injection and soft checkpoint reminders
  - `/remember` slash command in TUI (`packages/tui/src/routes/session/index.tsx`) pre-fills a snapshot directive
- **`CLAUDE.md` auto-loading disabled** in `packages/opencode/src/session/instruction.ts`. Syncode reads only `AGENTS.md` (this file) and `CONTEXT.md`.
- **Auto-skill router + TOC-based loading** (`packages/opencode/src/skill/router.ts`, `active.ts`, `packages/opencode/src/tool/skill_section.ts`).
  - Router model selects relevant skills per turn without injecting large prompt bodies
  - Active skills inject `<rules>` and `<table_of_contents>`; model fetches sections via `skill_section`
  - Built-in `author-skill` teaches schema, rules conventions, and TOC structure
- **Autonomous goal loop (`/goal`)** (`packages/opencode/src/session/goal.ts`, `packages/opencode/src/tool/goal.ts`).
  - Evaluates user-defined goal condition using small checker model, continuing turns autonomously until met
- **Ephemeral asides (`/btw`)** (`packages/opencode/src/session/ephemeral.ts`, `packages/tui/src/component/dialog-btw.tsx`).
  - Concurrent, tool-less side questions answered against session context without polluting conversation history
- **Context window breakdown & TUI bar** (`packages/opencode/src/tool/context.ts`, `packages/tui/src/component/dialog-context.tsx`, `packages/tui/src/component/prompt/index.tsx`).
  - Slim horizontal bar (`━`/`─`) with live token count, limit, and percentage in prompt footer
  - Instant client-side `/context` dialog with breakdown and usable budget calculations
- **Background task monitoring (`/tasks`)** (`packages/opencode/src/tool/monitor.ts`, `tasks.ts`).
- **Desktop app protection**: In-app updater hard-disabled in `packages/desktop/src/main/constants.ts` and `electron-builder.config.ts`.

### Upgrade workflow — updates come from THIS repo only (wired 2026-08-19)

The in-app updaters were re-wired to the fork, never upstream:

- **CLI/TUI updater** (`packages/opencode/src/installation/index.ts`): checks the
  fork's `dist` branch (`version.json` + gzip-compressed prebuilt binaries) and
  swaps the binary in place, keeping `opencode.exe.old` for rollback. A
  `semver.gt` guard in `src/cli/upgrade.ts` makes downgrades impossible.
- **Desktop updater** (`packages/desktop/src/main/`): prod builds check GitHub
  releases of `windro-exe/Syncode` (publish feed in `electron-builder.config.ts`,
  `UPDATER_ENABLED` in `src/main/constants.ts`). Dev/beta installs stay manual.
- **Publish side**: `syncode-release.yml` builds + uploads installers and
  `latest*.yml` on tag pushes (e.g. `v1.19.0-wnxd-v3`). It currently does NOT
  run — GitHub Actions is disabled on this repo. Enabling it requires a CI
  account; until then releases stay manual.

Still true:

- Never run `bun upgrade`, `opencode upgrade`, or any install path that pulls
  from upstream npm/GitHub releases — those would still overwrite
  `~/.local/bin/opencode.exe` with a stock build.
- `scripts/update-remote.ps1` (now defaulting to `windro-exe/Syncode`) is correct
  for machines that only consume published builds; on a dev machine after local
  source edits, use `scripts/install.ps1` instead.
- The version stamp (`OPENCODE_VERSION` baked at build time) must stay semver-ABOVE
  any upstream release and must match what the `dist` branch publishes. If you see
  `1.19.0-wnxd-v2` or higher, that's intentional — don't "fix" it down.
- The dist branch is the CLI release channel: after a release build, update
  `dist/version.json` + binaries so the in-app updater actually offers it.

Syncode is standalone — there is no upstream to merge from. Feature and fix branches
are the only update path:

1. Branch `feature/<name>` or `fix/<name>` off `dev`, do the work, merge back to `dev`.
2. Merge `dev` into `prod` only for a release/deploy.
3. Build and install: `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`
4. Confirm: `~/.local/bin/opencode.exe --version` prints the new stamp.

### Memory profiling

The first time a model boots a session, the bootstrap in `src/memory/bootstrap.ts` auto-detects username/host/OS/CPU/RAM/node/bun/shell and seeds `/memories/system.md`. It also creates a `/memories/agent.md` template that prompts the model to ask the user once for name/style/personality, then saves the answers. After that, never ask again unless the user says "forget my prefs".

Beyond the first-session ask, the agent should learn organically — when something durable surfaces, save it to memory (global scope for cross-session, session for current conversation only). Use the memory tool's `search` command before starting any task to recall relevant prior context.
