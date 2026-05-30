import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./context.txt"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Token } from "@/util/token"
import { usable as usableContext, SOFT_CHECKPOINT_FRACTION } from "@/session/overflow"
import { SessionCompaction } from "@/session/compaction"
import type { MessageV2 } from "@/session/message-v2"
import type { Provider } from "@/provider/provider"

export const Parameters = Schema.Struct({})

type Metadata = {
  used: number
  limit: number
  pruned: number
}

const n = (x: number) => Math.round(x).toLocaleString("en-US")

// Sum estimated tokens of either the text/reasoning parts or the completed
// tool outputs across a set of messages, plus a count of how many parts.
function estimate(messages: MessageV2.WithParts[], kind: "text" | "tool") {
  let tokens = 0
  let count = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (kind === "text" && (part.type === "text" || part.type === "reasoning") && part.text.trim()) {
        tokens += Token.estimate(part.text)
        count++
      } else if (kind === "tool" && part.type === "tool" && part.state.status === "completed" && part.state.output) {
        tokens += Token.estimate(part.state.output)
        count++
      }
    }
  }
  return { tokens, count }
}

function lastAssistantTokens(messages: MessageV2.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.role !== "assistant" || !info.tokens) continue
    const t = info.tokens
    if (t.total || t.input || t.cache.read || t.cache.write) return t
  }
  return undefined
}

export const ContextTool = Tool.define<typeof Parameters, Metadata, Session.Service | Config.Service>(
  "context",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const model = ctx.extra?.model as Provider.Model | undefined
          const msgs = yield* session
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))

          const pruned = msgs.filter((m) => m.info.pruned)
          const visible = msgs.filter((m) => !m.info.pruned)
          const text = estimate(visible, "text")
          const tool = estimate(visible, "tool")
          const prunedEst = estimate(pruned, "text").tokens + estimate(pruned, "tool").tokens

          const tokens = lastAssistantTokens(msgs)
          const prompt = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
          const lines: string[] = []

          if (model && model.limit.context > 0) {
            const cfg = yield* config.get()
            const budget = usableContext({ cfg, model })
            const limit = model.limit.context
            const pct = prompt > 0 ? Math.round((prompt / limit) * 100) : 0
            lines.push(`Context window: ${n(prompt)} / ${n(limit)} tokens (${pct}%)`)
            if (budget > 0) {
              const softAt = budget * SOFT_CHECKPOINT_FRACTION
              const pruneAt = budget * SessionCompaction.PRUNE_TURN_TRIGGER_FRACTION
              lines.push(`Usable budget: ${n(budget)}`)
              lines.push(
                `  60% soft checkpoint at ${n(softAt)} — ${prompt >= softAt ? "REACHED (persist state to memory)" : "ok"}`,
              )
              lines.push(`  80% eviction trigger at ${n(pruneAt)} — ${prompt >= pruneAt ? "REACHED" : "ok"}`)
            }
            lines.push("")
          }

          if (tokens) {
            const cached = tokens.input + tokens.cache.read + tokens.cache.write
            const hitRate = cached > 0 ? Math.round((tokens.cache.read / cached) * 100) : 0
            lines.push("Last request (provider's real figures):")
            lines.push(`  uncached input: ${n(tokens.input)}`)
            lines.push(`  cached read:    ${n(tokens.cache.read)} (cache hit ${hitRate}%)`)
            lines.push(`  cached write:   ${n(tokens.cache.write)}`)
            lines.push(`  output:         ${n(tokens.output)}`)
            lines.push("")
          }

          lines.push("Estimated breakdown (character heuristic):")
          lines.push(`  conversation text: ${n(text.tokens)} (${text.count} parts)`)
          lines.push(`  tool output:       ${n(tool.tokens)} (${tool.count} calls)`)
          if (prompt > 0) {
            const overhead = Math.max(0, prompt - text.tokens - tool.tokens)
            lines.push(`  system + tools overhead (est): ${n(overhead)}`)
          }
          if (pruned.length > 0) {
            lines.push(
              `  evicted: ${pruned.length} turn${pruned.length === 1 ? "" : "s"}, ~${n(prunedEst)} tokens (recoverable with session_recall)`,
            )
          }

          return {
            title: model ? `Context: ${n(prompt)} tokens used` : "Context breakdown",
            output: lines.join("\n"),
            metadata: { used: prompt, limit: model?.limit.context ?? 0, pruned: pruned.length } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
