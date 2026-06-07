import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_SYNCODE from "./prompt/syncode.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { SessionID } from "./schema"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SkillActive } from "@/skill/active"
import { Memory } from "@/memory/memory"
import { ensureGlobalSeeds, ensureSessionSeeds } from "@/memory/bootstrap"

export function provider(model: Provider.Model) {
  // Syncode ships ONE assistant persona for every model (prompt/syncode.txt): a
  // fully-capable general assistant, not a per-model coding-agent prompt. We append
  // only minimal, additive per-model quirks for correctness/capability — never a
  // whole replacement persona. The old per-model prompt files remain in this
  // directory, unused, for reference.
  const id = model.api.id.toLowerCase()
  const quirks: string[] = []
  // Older/reasoning models prone to ending their turn early need explicit tenacity.
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3"))
    quirks.push(
      "Keep going until the task is fully resolved and verified. Do not end your turn early, and when you say you will call a tool, actually call it.",
    )
  // Trinity-class models misbehave on multi-tool turns (correctness, not style).
  if (id.includes("trinity"))
    quirks.push("Emit exactly one tool call per message, and wait for its result before the next.")
  return [PROMPT_SYNCODE, ...quirks]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info, sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly memory: (sessionID: SessionID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

// Escape values interpolated into XML-ish attributes the model parses.
// Strips the structural characters rather than HTML-encoding them — the
// model doesn't unescape entities, and we only ever interpolate short
// identifiers (skill names, section ids).
function xmlAttr(value: string): string {
  return value.replace(/[<>"]/g, "")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const skillActive = yield* SkillActive.Service
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

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info, sessionID: SessionID) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const names = yield* skillActive.get(sessionID)
        if (names.length === 0) return

        const blocks: string[] = []
        for (const name of names) {
          const info = yield* skill.get(name)
          if (!info) continue

          const rulesBlock =
            info.rules.length > 0
              ? ["<rules>", ...info.rules.map((r) => `  - ${r}`), "</rules>"].join("\n")
              : null
          const tocBlock = [
            "<table_of_contents>",
            ...info.sections.map((s) => `  - ${s.id}${s.title ? `: ${s.title}` : ""}`),
            "</table_of_contents>",
          ].join("\n")

          blocks.push(
            [
              `<active_skill name="${xmlAttr(info.name)}">`,
              info.description ? info.description : null,
              rulesBlock,
              tocBlock,
              `Use the \`skill_section\` tool with section ids from this skill's table of contents to fetch the bodies you actually need. Pass \`skill: "${xmlAttr(info.name)}"\` to disambiguate when multiple skills are active.`,
              "</active_skill>",
            ]
              .filter(Boolean)
              .join("\n"),
          )
        }
        if (blocks.length === 0) return
        return blocks.join("\n\n")
      }),

      memory: Effect.fn("SystemPrompt.memory")(function* (sessionID: SessionID) {
        yield* ensureGlobalSeeds(memorySvc).pipe(Effect.ignore)
        yield* ensureSessionSeeds(memorySvc, sessionID).pipe(Effect.ignore)
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

        const sessionPlanEntry = yield* memorySvc
          .view({ scope: "session", path: "/memories/_plan.md", ctx: { sessionID } })
          .pipe(Effect.orElseSucceed(() => undefined))
        const sessionBlock = (() => {
          if (!sessionPlanEntry || !sessionPlanEntry.entry) return null
          const content = sessionPlanEntry.entry.content
          const unfilled = /_unset_/.test(content)
          if (unfilled) {
            return [
              "<session-state status=\"unfilled\">",
              "The /memories/_plan.md file (scope=session) is your scratchpad for THIS conversation only. As the task takes shape, fill the sections below using `memory` tool with command=str_replace to overwrite each `_unset_` marker, and keep them current with command=str_replace as decisions evolve. This lets a future turn (after context overflow or compaction) resume from a clean snapshot. Don't put durable user-level facts here — those go to global scope.",
              content,
              "</session-state>",
            ].join("\n")
          }
          return [
            "<session-state status=\"filled\">",
            content,
            "</session-state>",
          ].join("\n")
        })()

        return [
          "<memory>",
          "You have a persistent memory tool. Check it at the start of a task and write to it as you learn things.",
          "",
          "Two scopes — pick by the lifetime of the fact:",
          "  - global: persists across every future conversation. Use for the user's name and prefs, system info, durable conventions, learned lessons about the codebase, decisions about how the user works.",
          "  - session: only this conversation. Use for the current task's goal, the plan, decisions made this turn, files in flight, in-progress steps, open questions, things tried that didn't work.",
          "",
          "Routing test: \"Would I want this in an unrelated conversation two weeks from now?\" yes → global, no → session. When in doubt, prefer session — global is for facts that earn their permanence.",
          "",
          "Use `memory` tool: command=view (read), command=search (full-text query), command=create / str_replace / insert (write), command=delete / rename (manage). Memory persists across context resets — treat your active conversation as ephemeral, treat memory as durable.",
          "",
          "Index of what is already in memory:",
          fmt("global", idx.global),
          fmt("session", idx.session),
          ...(agentBlock ? ["", agentBlock] : []),
          ...(sessionBlock ? ["", sessionBlock] : []),
          "</memory>",
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(SkillActive.defaultLayer),
  Layer.provide(Memory.defaultLayer),
)

export * as SystemPrompt from "./system"
