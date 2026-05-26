import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { SessionID } from "./schema"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Memory } from "@/memory/memory"
import { ensureGlobalSeeds } from "@/memory/bootstrap"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly memory: (sessionID: SessionID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const memorySvc = yield* Memory.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      memory: Effect.fn("SystemPrompt.memory")(function* (sessionID: SessionID) {
        yield* ensureGlobalSeeds(memorySvc).pipe(Effect.ignore)
        const idx = yield* memorySvc.index({ ctx: { sessionID } })
        const fmt = (label: string, list: typeof idx.global) => {
          if (list.length === 0) return `  ${label}: (empty)`
          const lines = list
            .slice(0, 32)
            .map(
              (e) =>
                `    - ${e.path}${e.title ? ` — ${e.title}` : ""}${e.tags.length ? `  [${e.tags.join(",")}]` : ""}`,
            )
          return `  ${label}:\n${lines.join("\n")}`
        }

        const inlineEntry = yield* memorySvc
          .view({ scope: "global", path: "/memories/agent.md", ctx: { sessionID } })
          .pipe(Effect.orElseSucceed(() => undefined))
        const agentBlock = (() => {
          if (!inlineEntry || !inlineEntry.entry) return null
          const content = inlineEntry.entry.content
          const unfilled = /_unset_/.test(content)
          if (unfilled) {
            return [
              "<agent-preferences status=\"unfilled\">",
              "The /memories/agent.md file is shown below. The user has NOT yet filled it in. On your VERY FIRST reply this session, before doing anything else, ask the three questions in the file (name, style, personality), wait for the user's answers, then save them by calling the memory tool with command=str_replace to overwrite the `_unset_` markers in /memories/agent.md (scope=global). Then continue with the user's actual request.",
              content,
              "</agent-preferences>",
            ].join("\n")
          }
          return [
            "<agent-preferences status=\"filled\">",
            content,
            "</agent-preferences>",
          ].join("\n")
        })()

        return [
          "<memory>",
          "You have a persistent memory tool. ALWAYS check memory before starting a task and save durable facts as you learn them.",
          "Two scopes:",
          "  - global: persists across every session (user prefs, system info, conventions, lessons)",
          "  - session: only this conversation (current plan, in-flight thoughts)",
          "Use `memory` tool with command=view to read entries, command=create/str_replace/insert to update, command=search to query.",
          "Index of what is already in memory:",
          fmt("global", idx.global),
          fmt("session", idx.session),
          ...(agentBlock ? ["", agentBlock] : []),
          "</memory>",
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer), Layer.provide(Memory.defaultLayer))

export * as SystemPrompt from "./system"
