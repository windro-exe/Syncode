// `council_close` — chair (parent) seals the council.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council-close.txt"
import { Council } from "@/council"

export const Parameters = Schema.Struct({
  council_id: Schema.optional(
    Schema.String.annotate({ description: "Council to close. Defaults to your most recent active council." }),
  ),
  reason: Schema.optional(Schema.String.annotate({ description: "Short reason recorded in the bus event." })),
})

type Metadata = { council_id: string; closed_at: number }

export const CouncilCloseTool = Tool.define(
  "council_close",
  Effect.gen(function* () {
    const council = yield* Council.Service

    const run = Effect.fn("CouncilCloseTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      // Resolve: explicit id wins; else look up the chair's most recent active.
      let id = params.council_id
      if (!id) {
        const own = yield* council.councilsFor(ctx.sessionID)
        if (own.length === 0) {
          return yield* Effect.fail(
            new Error("No active council found. Pass council_id explicitly or spawn a council first."),
          )
        }
        id = own[own.length - 1]!.id
      }
      const state = yield* council.get(id)
      if (!state) return yield* Effect.fail(new Error(`Unknown council: ${id}`))
      if (state.parentSessionID !== ctx.sessionID) {
        return yield* Effect.fail(
          new Error(`Only the chair (parent that spawned the council) can close it. Council ${id} belongs to ${state.parentSessionID}.`),
        )
      }
      const result = yield* council.close({ councilID: id, ...(params.reason !== undefined ? { reason: params.reason } : {}) })
      const memberSummaries = result.members
        .filter((m) => m.summary)
        .map((m) => `- ${m.role} [${m.status}]: ${m.summary}`)
        .join("\n")
      return {
        title: `council ${id} closed`,
        output: [
          `Council ${id} closed (${params.reason ?? "by chair"}).`,
          memberSummaries ? "\nMember summaries:\n" + memberSummaries : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: { council_id: id, closed_at: result.closedAt ?? Date.now() } satisfies Metadata,
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
