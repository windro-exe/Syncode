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
// Per-block content cap. A single tool output can be huge (a 2000-line file
// read, a directory dump). Without a cap, a 50-block recall can produce
// 100K+ tokens which itself triggers another prune and evicts the very turns
// the recall was supposed to expose. 4000 chars ≈ ~1000 tokens.
const PER_BLOCK_CHARS = 4_000
// Total output cap. Defends against pathological cases where many blocks each
// hit PER_BLOCK_CHARS. ~32K chars ≈ ~8K tokens — plenty to be useful, bounded
// enough to fit comfortably without re-triggering eviction.
const TOTAL_OUTPUT_CHARS = 32_000

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ` … [+${s.length - max} chars truncated]` : s
}

// Pull the human-readable content out of a message's parts. Evicted turns
// keep their parts on disk untouched (the prune only flips `info.pruned`),
// so text, reasoning, and completed tool output are all still here verbatim.
// Non-text parts (file/image/compaction/subtask) get a one-line placeholder
// so the model knows something existed there instead of seeing nothing —
// matters because they may have driven the conversation.
function extractText(msg: MessageV2.WithParts): string {
  const chunks: string[] = []
  for (const part of msg.parts) {
    if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim())
    else if (part.type === "reasoning" && part.text.trim()) chunks.push(`(reasoning) ${part.text.trim()}`)
    else if (part.type === "tool" && part.state.status === "completed" && part.state.output.trim())
      chunks.push(`[tool ${part.tool}] ${clip(part.state.output.trim(), PER_BLOCK_CHARS)}`)
    else if (part.type === "file") chunks.push(`[file: ${part.mime}${part.filename ? ` (${part.filename})` : ""}]`)
    else if (part.type === "compaction") chunks.push(`[compaction summary]`)
    else if (part.type === "subtask") chunks.push(`[subtask]`)
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
          // Build the output incrementally so we can stop adding blocks once
          // we hit the total cap, instead of producing a 100K-char string and
          // immediately triggering another prune.
          const blocks: string[] = []
          let charBudget = TOTAL_OUTPUT_CHARS
          let dropped = 0
          for (const item of selected) {
            const rendered = renderBlock(item.msg, item.text)
            if (rendered.length > charBudget) {
              dropped = selected.length - blocks.length
              break
            }
            blocks.push(rendered)
            charBudget -= rendered.length + 2 // for "\n\n" separator
          }
          if (dropped > 0)
            blocks.push(`[${dropped} additional evicted turn${dropped === 1 ? "" : "s"} omitted to fit recall budget — narrow with a query]`)

          return {
            title: `Recalled ${blocks.length - (dropped > 0 ? 1 : 0)} evicted turn${selected.length === 1 ? "" : "s"}`,
            output: [header, "", ...blocks].join("\n\n"),
            metadata: { evicted: evicted.length, returned: selected.length - dropped, query } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
