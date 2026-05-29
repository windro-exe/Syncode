import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Goal } from "@/session/goal"

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["set", "clear", "status"]).annotate({
      description: '"set" (default) starts a goal, "clear" cancels it, "status" reports the active goal.',
    }),
  ),
  condition: Schema.optional(
    Schema.String.annotate({
      description: "The objectively checkable completion condition. Required for action 'set'.",
    }),
  ),
  max_iterations: Schema.optional(
    Schema.Number.annotate({
      description: "Safety cap on extra autonomous turns (default 25).",
    }),
  ),
})

type Metadata = {
  action: string
  condition?: string
}

export const GoalTool = Tool.define<typeof Parameters, Metadata, Goal.Service>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action ?? "set"

          if (action === "clear") {
            yield* goal.clear(ctx.sessionID)
            return {
              title: "Goal cleared",
              output: "The completion goal for this session has been cleared. You will stop after the current turn.",
              metadata: { action } as Metadata,
            }
          }

          if (action === "status") {
            const entry = yield* goal.get(ctx.sessionID)
            if (!entry)
              return {
                title: "No active goal",
                output: "No completion goal is set for this session.",
                metadata: { action } as Metadata,
              }
            return {
              title: "Active goal",
              output: [
                `Condition: ${entry.condition}`,
                `Iterations used: ${entry.iterations} / ${entry.max}`,
              ].join("\n"),
              metadata: { action, condition: entry.condition } as Metadata,
            }
          }

          const condition = params.condition?.trim()
          if (!condition)
            return {
              title: "Missing condition",
              output: 'To set a goal, provide a concrete, checkable `condition`. Use action "clear" to cancel a goal.',
              metadata: { action } as Metadata,
            }

          const entry = yield* goal.set(ctx.sessionID, condition, params.max_iterations)
          return {
            title: "Goal set",
            output: [
              `Completion goal set: ${condition}`,
              `After each turn a checker will decide if this is met; if not, you will be prompted to continue (up to ${entry.max} iterations).`,
              "Work toward the goal now. Clear it with action 'clear' if it becomes unnecessary.",
            ].join("\n"),
            metadata: { action, condition } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
