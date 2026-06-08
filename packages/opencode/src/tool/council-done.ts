// `council_done` — member declares completion of their role.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council-done.txt"
import { Council } from "@/council"

export const Parameters = Schema.Struct({
  summary: Schema.String.annotate({ description: "1-3 sentences summarizing what you contributed." }),
  evidence: Schema.optional(
    Schema.String.annotate({ description: "Optional supporting details for the chair to use." }),
  ),
})

type Metadata = { council_id: string; role: string }

export const CouncilDoneTool = Tool.define(
  "council_done",
  Effect.gen(function* () {
    const council = yield* Council.Service

    const run = Effect.fn("CouncilDoneTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const m = yield* council.membership(ctx.sessionID)
      if (!m) {
        return yield* Effect.fail(
          new Error(
            "council_done can only be called from a council member session. If you're the chair, use council_close instead.",
          ),
        )
      }
      yield* council.declareDone({
        councilID: m.councilID,
        sessionID: ctx.sessionID,
        summary: params.summary,
        ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
      })
      return {
        title: `${m.role} done`,
        output: `Marked ${m.role} as done in council ${m.councilID}. The chair will see your summary on their next turn.`,
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
