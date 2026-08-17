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

## wnxd local fork (NOT upstream)

The section below is specific to wnxd's local clone. It does not exist upstream and is intended for any agent (opencode itself, Claude Code, etc.) working ON this codebase.

### Layout

- Origin: `https://github.com/windro-xdd/Syncode.git` (upstream is `anomalyco/opencode`)
- Working branch: **`wnxd`** — every local feature commits here. `dist` holds prebuilt binaries + `version.json`; never develop on it.
- Local source tree: `C:\wnx-projects\Syncode-wnxd` (Windows). Do not work out of `%TEMP%` — cleanup tools eat it.
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

- **Memory system** (`packages/opencode/src/memory/`, `src/tool/memory.ts`, `src/tool/memory.txt`, `migration/2026*_memory_system/`).
  - Two-tier persistent memory (`global` + `session`) backed by SQLite + FTS5
  - Replaces upstream's compaction loop: the prompt loop's overflow auto-trigger is neutered in `src/session/prompt.ts`, the system prompt now includes a live memory index in `src/session/system.ts`, and the `/remember` slash in `src/cli/cmd/tui/routes/session/index.tsx` pre-fills a snapshot directive
  - The model is responsible for persisting durable facts to memory before context overflows, instead of relying on summarization
- **`CLAUDE.md` auto-loading disabled** in `src/session/instruction.ts`. opencode reads only `AGENTS.md` (this file) and the deprecated `CONTEXT.md`. The user does not want Claude Code's user-level rules bleeding into opencode sessions.
- **Auto-skill router + TOC-based loading** (`src/skill/router.ts`, `src/skill/active.ts`, `src/tool/skill_section.ts`).
  - Each turn, a small router model (DeepSeek-V4-Flash by default; configurable via `skills.router_model` in opencode.json) is given the user's message and the names+descriptions of every available skill, and picks ONE skill or `none`.
  - When picked, the system prompt gets an `<active_skill>` block containing the skill's `rules` (negative prompts) and a `<table_of_contents>`. The full body is NOT injected.
  - The model uses the new `skill_section` tool to fetch one or more sections by id when it needs detail. The old `skill` tool that loaded the whole body is removed.
  - Skill schema extended: `rules: string[]` (always-on rules for that skill) and `sections: [{id, title}]` (declares the TOC; the body has matching `## <id>` headings). Skills with no `rules`/`sections` still work — they get one implicit `body` section.
  - Active skill name is persisted on the assistant message (`MessageV2.Assistant.skill`) and shown as `→ <name>` in the TUI status row next to the context bar.
- **Built-in `author-skill` skill** (`src/skill/prompt/author-skill.md`). Routes when the user asks to create or update a skill; teaches the schema, rule-writing conventions, and TOC structure so new skills are well-formed.

Add new features here as they land.

### Upgrade workflow — DO NOT use the in-app auto-updater

The user has explicitly said: never let the auto-updater run. It will overwrite `~/.local/bin/opencode.exe` with the upstream npm release and erase every local feature.

Concretely:

- The TUI's "Update Available" prompt: always answer **Skip**, never Confirm.
- Never run `bun upgrade`, `opencode upgrade`, or any equivalent install script that pulls from GitHub releases or npm.
- The version stamp (`OPENCODE_VERSION` baked at build time) is set high on purpose so the in-app upgrader's release-type check doesn't auto-install anything. If you see `1.16.0-wnxd` or higher, that's intentional — don't "fix" it down.

`scripts/update-remote.ps1` is the same hazard in local clothing: it downloads the
prebuilt binary from the `dist` branch and swaps it in. That is correct for a machine
that only consumes published builds, but running it after local source edits silently
reverts the installed binary to whatever `dist` holds. On a dev machine, use
`scripts/install.ps1` instead.

When the user wants to take an upstream update:

1. They will explicitly tell you ("update from upstream", "pull the latest opencode", etc.).
2. From `wnxd` branch: `git fetch upstream && git merge upstream/dev` — resolve conflicts in the local-feature files (memory system, /remember, prompt loop neutering, instruction.ts).
3. Run `bun typecheck` from `packages/opencode` and `packages/core`; fix anything broken before building.
4. Bump `SYNCODE_VERSION` to a stamp that semver-compares ABOVE the latest upstream npm release.
5. Build and install in one step: `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`
6. Confirm: `~/.local/bin/opencode.exe --version` prints the new stamp.

### Memory profiling

The first time a model boots a session, the bootstrap in `src/memory/bootstrap.ts` auto-detects username/host/OS/CPU/RAM/node/bun/shell and seeds `/memories/system.md`. It also creates a `/memories/agent.md` template that prompts the model to ask the user once for name/style/personality, then saves the answers. After that, never ask again unless the user says "forget my prefs".

Beyond the first-session ask, the agent should learn organically — when something durable surfaces, save it to memory (global scope for cross-session, session for current conversation only). Use the memory tool's `search` command before starting any task to recall relevant prior context.
