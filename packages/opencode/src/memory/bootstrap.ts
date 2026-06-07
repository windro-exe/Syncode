import os from "os"
import { Effect } from "effect"
import { Memory } from "./memory"
import type { SessionID } from "@/session/schema"

const SYSTEM_PATH = "/memories/system.md"
const AGENT_PATH = "/memories/agent.md"
const SESSION_PLAN_PATH = "/memories/_plan.md"

function detect() {
  const username = os.userInfo().username
  const hostname = os.hostname()
  const platform = `${os.type()} ${os.release()} (${os.arch()})`
  const cpu = os.cpus()[0]?.model ?? "unknown"
  const cores = os.cpus().length
  const totalGb = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const node = process.versions.node
  const bun = process.versions.bun ?? "n/a"
  const shell = process.env["SHELL"] || process.env["ComSpec"] || "unknown"
  return {
    username,
    hostname,
    platform,
    cpu,
    cores,
    totalGb,
    node,
    bun,
    shell,
  }
}

function buildSystemMd() {
  const d = detect()
  return [
    "# System info (auto-detected on first run)",
    "",
    `- **User:** ${d.username}`,
    `- **Hostname:** ${d.hostname}`,
    `- **OS:** ${d.platform}`,
    `- **CPU:** ${d.cpu} (${d.cores} cores)`,
    `- **RAM:** ~${d.totalGb} GB`,
    `- **Node:** v${d.node}`,
    `- **Bun:** ${d.bun}`,
    `- **Shell:** ${d.shell}`,
    "",
    "_This file is auto-generated. Edit freely; opencode will not overwrite it._",
    "",
  ].join("\n")
}

function buildAgentMd() {
  return [
    "# Agent preferences",
    "",
    "_This file is empty until the user fills it in. On the first session, ask the user once:_",
    "",
    "1. What should I call you?",
    "2. How do you want me to behave (terse / explanatory / casual / formal)?",
    "3. Anything about your personality I should know (direct / friendly / patient / fast-paced)?",
    "",
    "Once they answer, replace this file's body with their preferences.",
    "After that, never ask again unless the user explicitly says \"forget my prefs\".",
    "",
    "## Name",
    "_unset:name_",
    "",
    "## Style",
    "_unset:style_",
    "",
    "## Personality",
    "_unset:personality_",
    "",
  ].join("\n")
}

export const ensureGlobalSeeds = Effect.fn("Memory.bootstrap")(function* (memory: Memory.Interface) {
  const idx = yield* memory.index({ ctx: {} })
  const has = (p: string) => idx.global.some((e) => e.path === p)

  if (!has(SYSTEM_PATH)) {
    yield* memory
      .create({
        scope: "global",
        path: SYSTEM_PATH,
        title: "System info",
        content: buildSystemMd(),
        tags: ["system", "auto"],
        ctx: {},
      })
      .pipe(Effect.ignore)
  }
  if (!has(AGENT_PATH)) {
    yield* memory
      .create({
        scope: "global",
        path: AGENT_PATH,
        title: "Agent preferences",
        content: buildAgentMd(),
        tags: ["preferences"],
        ctx: {},
      })
      .pipe(Effect.ignore)
  }
})

function buildSessionPlanMd() {
  return [
    "# Session plan",
    "",
    "_Working notes for this conversation only. Update as the task evolves so a future turn can resume cleanly. Fill a section by calling the memory tool with command=str_replace, old_str set to the placeholder (e.g. `_unset:goal_`). You don't need to rewrite this every turn — update it at natural checkpoints (a decision is made, a step finishes, the plan changes)._",
    "",
    "## Goal",
    "_unset:goal_",
    "",
    "## Plan",
    "_unset:plan_",
    "",
    "## Decisions made this session",
    "_unset:decisions_",
    "",
    "## In-progress / next step",
    "_unset:next_",
    "",
    "## Open questions / blockers",
    "_unset:blockers_",
    "",
    "## Tried and didn't work",
    "_unset:tried_",
    "",
  ].join("\n")
}

export const ensureSessionSeeds = Effect.fn("Memory.bootstrap.session")(function* (
  memory: Memory.Interface,
  sessionID: SessionID,
) {
  const idx = yield* memory.index({ ctx: { sessionID } })
  const has = (p: string) => idx.session.some((e) => e.path === p)

  if (!has(SESSION_PLAN_PATH)) {
    yield* memory
      .create({
        scope: "session",
        path: SESSION_PLAN_PATH,
        title: "Session plan",
        content: buildSessionPlanMd(),
        tags: ["plan", "auto"],
        ctx: { sessionID },
      })
      .pipe(Effect.ignore)
  }
})
