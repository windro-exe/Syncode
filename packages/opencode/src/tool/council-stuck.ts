// `council_stuck` — member flags they cannot make progress.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council-stuck.txt"
import { Council } from "@/council"

export const Parameters = Schema.Struct({
  why: Schema.String.annotate({ description: "1-3 sentences explaining the blocker." }),
  need_help_with: Schema.optional(
    Schema.String.annotate({ description: "Optional: the specific thing a peer or the chair could unblock." }),
  ),
})

type Metadata = { council_id: string; role: string }

export const CouncilStuckTool = Tool.define(
  "council_stuck",
  Effect.gen(function* () {
    const council = yield* Council.Service

    const run = Effect.fn("CouncilStuckTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const m = yield* council.membership(ctx.sessionID)
      if (!m) {
        return yield* Effect.fail(new Error("council_stuck can only be called from a council member session."))
      }
      const detail = params.need_help_with ? `${params.why}\n\nNeed help with: ${params.need_help_with}` : params.why
      yield* council.declareStuck({ councilID: m.councilID, sessionID: ctx.sessionID, why: detail })
      return {
        title: `${m.role} stuck`,
        output: `Marked ${m.role} as stuck in council ${m.councilID}. The chair will see this on their next turn and can redirect or close.`,
        metadata: { council_id: m.councilID, role: m.role } satisfies Metadata,
      }
    })
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
