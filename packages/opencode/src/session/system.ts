import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_SYNCODE from "./prompt/syncode.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SkillActive } from "@/skill/active"
import { Memory } from "@/memory/memory"
import { ensureGlobalSeeds, ensureSessionSeeds } from "@/memory/bootstrap"
import { SessionID } from "@/session/schema"
import { getCustomPrompt } from "./custom-prompts"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

let sweptThisProcess = false

function xmlAttr(value: string): string {
  return value.replace(/[<>"]/g, "")
}

export function provider(model: Provider.Model) {
  const custom = getCustomPrompt(model.providerID, model.api.id)
  if (custom) return [custom]
  return [PROMPT_SYNCODE]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info, sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
  readonly memory: (sessionID: SessionID) => Effect.Effect<string>
  readonly recall: (input: { query: string; sessionID: SessionID; skipPaths?: string[] }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const skillActive = yield* SkillActive.Service
    const memorySvc = yield* Memory.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
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
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
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

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),

      memory: Effect.fn("SystemPrompt.memory")(function* (sessionID: SessionID) {
        yield* ensureGlobalSeeds(memorySvc).pipe(Effect.ignore)
        yield* ensureSessionSeeds(memorySvc, sessionID).pipe(Effect.ignore)
        // Opt-in real forgetting: once per process, evict genuinely-dead global
        // memories (old, never-retrieved, low-importance, unpinned). OFF by
        // default — auto-deleting memory is destructive — enable with
        // OPENCODE_MEMORY_FORGET=1.
        if (!sweptThisProcess && process.env["OPENCODE_MEMORY_FORGET"] === "1") {
          sweptThisProcess = true
          yield* memorySvc.forget({ scope: "global", ctx: {} }).pipe(Effect.ignore)
        }
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
          const unfilled = /_unset[_:]/.test(content)
          if (unfilled) {
            return [
              '<agent-preferences status="unfilled">',
              "The /memories/agent.md file is shown below. The user has NOT yet filled it in. On your VERY FIRST reply this session, before doing anything else, ask the three questions in the file (name, style, personality), wait for the user's answers, then save them by calling the memory tool with command=str_replace to overwrite each `_unset:..._` placeholder (e.g. `_unset:name_`) in /memories/agent.md (scope=global). Then continue with the user's actual request.",
              content,
              "</agent-preferences>",
            ].join("\n")
          }
          return [
            '<agent-preferences status="filled">',
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
          const unfilled = /_unset[_:]/.test(content)
          if (unfilled) {
            return [
              '<session-state status="unfilled">',
              "The /memories/_plan.md file (scope=session) is your scratchpad for THIS conversation only. As the task takes shape, fill the sections by calling the memory tool with command=str_replace, old_str set to the placeholder (e.g. `_unset:goal_`). You do NOT need to rewrite it every turn — update it at natural checkpoints (a decision is made, a step finishes, the plan changes) so a future turn (after context overflow) can resume from a clean snapshot. Don't put durable user-level facts here — those go to global scope.",
              content,
              "</session-state>",
            ].join("\n")
          }
          return [
            '<session-state status="filled">',
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
          'Routing test: "Would I want this in an unrelated conversation two weeks from now?" yes → global, no → session. When in doubt, prefer session — global is for facts that earn their permanence.',
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

      recall: Effect.fn("SystemPrompt.recall")(function* (input) {
        return yield* memorySvc.recall({
          query: input.query,
          ctx: { sessionID: input.sessionID },
          skipPaths: input.skipPaths,
        })
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, SkillActive.node, Memory.node, MCP.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
