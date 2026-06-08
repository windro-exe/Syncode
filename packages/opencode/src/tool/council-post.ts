// `council_post` — append an entry to the council table.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council-post.txt"
import { Council } from "@/council"
import { resolveCouncilID } from "./council-view"

export const Parameters = Schema.Struct({
  kind: Schema.Literals(["note", "msg", "ask", "answer", "decision"]).annotate({
    description: "Entry kind — see description for taxonomy.",
  }),
  content: Schema.String.annotate({ description: "Message body. Markdown ok." }),
  to: Schema.optional(Schema.String.annotate({ description: "Recipient role. Omit for broadcast to all." })),
  ref: Schema.optional(
    Schema.Number.annotate({ description: "Index of a prior entry this references." }),
  ),
  council_id: Schema.optional(
    Schema.String.annotate({ description: "Council id. Defaults to your council." }),
  ),
})

type Metadata = { council_id: string; entry_index: number; kind: string }

export const CouncilPostTool = Tool.define(
  "council_post",
  Effect.gen(function* () {
    const council = yield* Council.Service

    const run = Effect.fn("CouncilPostTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = yield* resolveCouncilID(council, ctx, params.council_id)
      const entry = yield* council.post({
        councilID: id,
        fromSessionID: ctx.sessionID,
        kind: params.kind,
        content: params.content,
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.ref !== undefined ? { refIndex: params.ref } : {}),
      })
      return {
        title: `posted #${entry.i}`,
        output: `Posted entry #${entry.i} to council ${id} (kind: ${entry.kind}${entry.to ? `, to: ${entry.to}` : ""}).`,
        metadata: { council_id: id, entry_index: entry.i, kind: entry.kind } satisfies Metadata,
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
