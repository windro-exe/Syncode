import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./session_recall.txt"
import { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"

export const Parameters = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description: "Case-insensitive substring filter. Only evicted turns whose text contains it are returned.",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: "Maximum number of evicted turns to return, most recent first (default 10).",
    }),
  ),
})

type Metadata = {
  evicted: number
  returned: number
  query?: string
}

const DEFAULT_LIMIT = 10

// Pull the human-readable content out of a message's parts. Evicted turns
// keep their parts on disk untouched (the prune only flips `info.pruned`),
// so text, reasoning, and completed tool output are all still here verbatim.
function extractText(msg: MessageV2.WithParts): string {
  const chunks: string[] = []
  for (const part of msg.parts) {
    if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim())
    else if (part.type === "reasoning" && part.text.trim()) chunks.push(`(reasoning) ${part.text.trim()}`)
    else if (part.type === "tool" && part.state.status === "completed" && part.state.output.trim())
      chunks.push(`[tool ${part.tool}] ${part.state.output.trim()}`)
  }
  return chunks.join("\n")
}

function renderBlock(msg: MessageV2.WithParts, text: string): string {
  const when = new Date(msg.info.time.created).toISOString().slice(0, 16).replace("T", " ")
  return [`## ${msg.info.role} · ${when} · ${msg.info.id}`, text].join("\n")
}

export const SessionRecallTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "session_recall",
  Effect.gen(function* () {
    const session = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const query = params.query?.trim()
          const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 50))

          // Read fresh from storage rather than ctx.messages: ctx.messages is
          // the post-filter view where evicted turns are already placeholders.
          // Storage still has the full parts. A missing session just means no
          // history yet.
          const msgs = yield* session
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))

          const evicted = msgs
            .filter((msg) => msg.info.pruned)
            .map((msg) => ({ msg, text: extractText(msg) }))
            .filter((item) => item.text.length > 0)

          if (evicted.length === 0) {
            return {
              title: "Nothing evicted",
              output:
                "No conversation turns have been evicted from the context window yet. Everything from this session is still visible to you.",
              metadata: { evicted: 0, returned: 0, query } as Metadata,
            }
          }

          const matched = query
            ? evicted.filter((item) => item.text.toLowerCase().includes(query.toLowerCase()))
            : evicted

          if (matched.length === 0) {
            return {
              title: `No evicted turn matched "${query}"`,
              output: [
                `${evicted.length} turn${evicted.length === 1 ? "" : "s"} were evicted, but none contain "${query}".`,
                "Try a different query, or omit it to list everything that was evicted.",
              ].join("\n"),
              metadata: { evicted: evicted.length, returned: 0, query } as Metadata,
            }
          }

          // Most recent first, capped at limit.
          const selected = matched.slice(-limit).reverse()
          const header = `Recalled ${selected.length} of ${matched.length} evicted turn${matched.length === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""} (${evicted.length} evicted total). This is read-only — write anything you need to keep to memory.`

          return {
            title: `Recalled ${selected.length} evicted turn${selected.length === 1 ? "" : "s"}`,
            output: [header, "", ...selected.map((item) => renderBlock(item.msg, item.text))].join("\n\n"),
            metadata: { evicted: evicted.length, returned: selected.length, query } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
