import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./rules.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadProjectRules, loadGlobalRules, addRule, removeRule } from "@/session/rules"

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["add", "list", "remove"]).annotate({
      description: '"add" (default) adds a new rule, "list" displays all active rules, "remove" deletes an existing rule.',
    }),
  ),
  scope: Schema.optional(
    Schema.Literals(["project", "global"]).annotate({
      description: '"project" (default) applies to this workspace only (.syncode/rules), "global" applies to all workspaces (~/.syncode/rules).',
    }),
  ),
  rule: Schema.optional(
    Schema.String.annotate({
      description: "The concrete rule text (e.g. 'Always use early returns', 'Never commit changes without asking'). Required for 'add' and 'remove'.",
    }),
  ),
  file: Schema.optional(
    Schema.String.annotate({
      description: "Optional rule category/filename without extension (e.g. 'style', 'security', 'git'). Defaults to 'project' or 'global'.",
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
          const scope = params.scope ?? "project"
          const inst = yield* InstanceState.context
          const cwd = inst.directory

          if (action === "list") {
            const projectFiles = loadProjectRules(cwd)
            const globalFiles = loadGlobalRules()

            const projectRules = projectFiles.flatMap((f) => f.rules.map((r) => `  - ${r} (${f.name})`))
            const globalRules = globalFiles.flatMap((f) => f.rules.map((r) => `  - ${r} (${f.name})`))

            const lines = [
              "=== Active Operational Rules ===",
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
              metadata: { action } as Metadata,
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
              file: params.file,
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
            file: params.file,
          })

          return {
            title: `Rule added (${scope})`,
            output: [
              `Successfully added ${scope} rule:`,
              `> ${ruleText}`,
              `Saved to: ${res.filePath}`,
              `This rule is now active and will be strictly enforced on all subsequent model turns.`,
            ].join("\n"),
            metadata: { action, scope, rule: ruleText, filePath: res.filePath } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
