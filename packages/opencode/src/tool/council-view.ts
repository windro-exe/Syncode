// `council_view` — read the council table. Open to members + chair.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council-view.txt"
import { Council } from "@/council"

export const Parameters = Schema.Struct({
  council_id: Schema.optional(
    Schema.String.annotate({ description: "Optional council id. Defaults to your council." }),
  ),
  since: Schema.optional(
    Schema.Number.annotate({ description: "Only return entries with index > this." }),
  ),
  limit: Schema.optional(Schema.Number.annotate({ description: "Max entries to return. Default 30." })),
  mine: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "If true, filter to entries broadcast to all + addressed to your role + your own posts. Default false (full table).",
    }),
  ),
})

type Metadata = { council_id: string; entries: number; rotated: number }

function fmtTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

export const CouncilViewTool = Tool.define(
  "council_view",
  Effect.gen(function* () {
    const council = yield* Council.Service

    const run = Effect.fn("CouncilViewTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = yield* resolveCouncilID(council, ctx, params.council_id)
      const result = yield* council.view({
        councilID: id,
        sinceIndex: params.since,
        limit: params.limit ?? 30,
        ...(params.mine ? { filterFor: ctx.sessionID } : {}),
      })
      const lines: string[] = []
      lines.push(`# Council ${result.state.id} — ${result.state.status}`)
      lines.push(`Brief: ${result.state.brief}`)
      lines.push("")
      lines.push("## Members")
      for (const m of result.state.members) {
        const tag = m.sessionID === ctx.sessionID ? " (you)" : ""
        lines.push(`- [${m.status}] ${m.role} (${m.agent})${tag}${m.summary ? ` — ${m.summary}` : ""}`)
      }
      lines.push("")
      if (result.rotatedCount > 0) lines.push(`(${result.rotatedCount} earlier entries archived)`)
      lines.push(`## Entries (showing ${result.entries.length})`)
      for (const e of result.entries) {
        const addr = e.to ? ` → ${e.to}` : ""
        const refs = e.refIndex !== undefined ? ` (re: #${e.refIndex})` : ""
        lines.push(`#${e.i} [${fmtTimestamp(e.ts)}] ${e.from} · ${e.kind}${addr}${refs}`)
        for (const ln of e.content.split("\n")) lines.push(`    ${ln}`)
      }
      return {
        title: `council ${id} (${result.entries.length} entries)`,
        output: lines.join("\n"),
        metadata: { council_id: id, entries: result.entries.length, rotated: result.rotatedCount } satisfies Metadata,
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

// Resolve which council the caller means: explicit id wins, else hot-membership
// (callers who are members), else the most recently-spawned active council
// for which they're the chair (callers who are parents). Errors if neither.
function resolveCouncilID(council: Council.Interface, ctx: Tool.Context, explicit?: string) {
  return Effect.gen(function* () {
    if (explicit) return explicit
    const m = yield* council.membership(ctx.sessionID)
    if (m) return m.councilID
    const own = yield* council.councilsFor(ctx.sessionID)
    if (own.length === 0) {
      return yield* Effect.fail(
        new Error(
          "No council found. Pass council_id explicitly, or call this from a council member session, or spawn a council first.",
        ),
      )
    }
    return own[own.length - 1]!.id
  })
}

export { resolveCouncilID }
