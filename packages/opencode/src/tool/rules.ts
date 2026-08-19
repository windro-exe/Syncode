import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./rules.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadProjectRules, loadGlobalRules, addRule, removeRule, defaultProjectDirectory } from "@/session/rules"

import * as os from "node:os"
import * as path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["add", "list", "remove"]).annotate({
      description:
        '"add" (default) adds a new rule, "list" displays all active rules, "remove" deletes an existing rule.',
    }),
  ),
  scope: Schema.optional(
    Schema.Literals(["auto", "project", "global"]).annotate({
      description:
        '"auto" (default; omit scope for normal requests), "project" (only when the user explicitly asks for project/workspace rules), "global" (only when the user explicitly asks for global/all-workspace rules).',
    }),
  ),
  rule: Schema.optional(
    Schema.String.annotate({
      description:
        "The concrete rule text (e.g. 'Always use early returns', 'Never commit changes without asking'). Required for 'add' and 'remove'.",
    }),
  ),
})

type Metadata = {
  action: string
  scope?: string
  rule?: string
  filePath?: string
}

export const RulesTool = Tool.define<typeof Parameters, Metadata, never>(
  "rules",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action ?? "add"
          const rawScope = params.scope ?? "auto"
          const inst = yield* InstanceState.context
          const cwd = inst.directory

          const isHome = path.resolve(cwd) === path.resolve(os.homedir())
          const isDefault = cwd === defaultProjectDirectory()
          // The home/default session and the desktop app's Default Project are
          // not project sessions: an unqualified add belongs in the global rule
          // files. Only an explicit scope=project request lands in project rules.
          const isProjectSession = !isHome && !isDefault

          const scope: "project" | "global" =
            rawScope === "project"
              ? "project"
              : rawScope === "global"
                ? "global"
                : isProjectSession
                  ? "project"
                  : "global"

          if (action === "list") {
            const projectFiles = loadProjectRules(cwd)
            const globalFiles = loadGlobalRules()

            const projectRules = projectFiles.flatMap((f) => f.rules.map((r) => `  - ${r} (${f.name})`))
            const globalRules = globalFiles.flatMap((f) => f.rules.map((r) => `  - ${r} (${f.name})`))

            const lines = [
              `=== Active Operational Rules (Current Session: ${isProjectSession ? "Project" : "Default/Global"}) ===`,
              "",
              "Project Rules:",
              projectRules.length > 0 ? projectRules.join("\n") : "  (none)",
              "",
              "Global Rules:",
              globalRules.length > 0 ? globalRules.join("\n") : "  (none)",
            ]

            return {
              title: "Active rules",
              output: lines.join("\n"),
              metadata: { action, scope } as Metadata,
            }
          }

          const ruleText = params.rule?.trim()
          if (!ruleText) {
            return {
              title: "Missing rule text",
              output: `To ${action} a rule, you must provide the 'rule' parameter with the specific instruction.`,
              metadata: { action, scope } as Metadata,
            }
          }

          if (action === "remove") {
            const res = removeRule({
              scope,
              rule: ruleText,
              cwd,
            })

            return {
              title: res.success ? `Rule removed (${scope})` : `Rule not found`,
              output: res.success
                ? `Removed rule "${ruleText}" from ${res.filePath}. (${res.remainingCount} rules remaining in file).`
                : `Could not find rule matching "${ruleText}".`,
              metadata: { action, scope, rule: ruleText, filePath: res.filePath } as Metadata,
            }
          }

          const res = addRule({
            scope,
            rule: ruleText,
            cwd,
          })

          return {
            title: `Rule added (${scope})`,
            output: [
              `Successfully added ${scope} rule (Session: ${isProjectSession ? "Project" : "Default"}):`,
              `> ${ruleText}`,
              `Saved to: ${res.filePath}`,
              `This rule is active and will be strictly enforced as an inviolable constraint on all future turns.`,
            ].join("\n"),
            metadata: { action, scope, rule: ruleText, filePath: res.filePath } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
