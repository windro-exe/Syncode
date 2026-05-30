import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Memory } from "@/memory/memory"
import { SessionID } from "@/session/schema"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session.auto-memory" })

const EXTRACT_TIMEOUT = "20 seconds"
const SOURCE_CAP = 12000
const NOTE_PATH = "/memories/evicted-context.md"

// Auto-memory: when the sliding-window prune evicts whole turns, a small model
// distills the durable facts out of them and appends them to a session memory
// note BEFORE they're gone. This makes "memory replaces compaction" automatic
// instead of relying on the model remembering to write. Runs fire-and-forget
// off the response path; the full turns stay recoverable via session_recall.
export interface ExtractInput {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  user: MessageV2.User
  fallbackModel: Provider.Model
}

export interface Interface {
  readonly extract: (input: ExtractInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AutoMemory") {}

const SYSTEM_PROMPT = [
  "You are a memory extractor for an autonomous coding agent.",
  "The conversation excerpt you are given is about to be dropped from the context window to save space.",
  "Extract ONLY durable, reusable facts worth remembering for the rest of the session:",
  "decisions made and why, file paths and key symbols, constraints and requirements, gotchas and non-obvious behavior, unresolved questions, and current task state.",
  "Ignore pleasantries, transient reasoning, tool noise, and anything low-value or already obvious.",
  "Output a concise markdown bullet list, one atomic fact per line, no preamble.",
  "If there is nothing worth keeping, output exactly: NONE",
].join("\n")

function renderForExtraction(messages: MessageV2.WithParts[]): string {
  const chunks: string[] = []
  for (const msg of messages) {
    const parts: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text" && part.text.trim()) parts.push(part.text.trim())
      else if (part.type === "tool" && part.state.status === "completed" && part.state.output.trim())
        parts.push(`[tool ${part.tool}] ${part.state.output.trim().slice(0, 1000)}`)
    }
    if (parts.length > 0) chunks.push(`### ${msg.info.role}\n${parts.join("\n")}`)
  }
  return chunks.join("\n\n")
}

const promptFor = (source: string) =>
  ["Conversation excerpt being evicted:", "", source.slice(-SOURCE_CAP), "", "Extract the durable facts now."].join("\n")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    // Per-session set of message ids already distilled, so the same evicted
    // turns are not re-extracted on every subsequent prune.
    const done = new Map<SessionID, Set<string>>()

    const appendNote = Effect.fn("AutoMemory.appendNote")(function* (sessionID: SessionID, facts: string) {
      const ctx = { sessionID }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
      const block = [`## Evicted ${stamp}`, facts, ""].join("\n")
      const viewed = yield* memory.view({ scope: "session", path: NOTE_PATH, ctx }).pipe(Effect.option)
      if (viewed._tag === "None" || !viewed.value.entry) {
        yield* memory
          .create({
            scope: "session",
            path: NOTE_PATH,
            title: "Auto-extracted facts from evicted turns",
            tags: ["auto", "evicted"],
            content: [
              "Durable facts auto-distilled from conversation turns evicted to save context.",
              "Full turns remain recoverable with the session_recall tool.",
              "",
              block,
            ].join("\n"),
            ctx,
          })
          .pipe(Effect.ignore)
        return
      }
      const lineCount = viewed.value.entry.content.split("\n").length
      yield* memory.insert({ scope: "session", path: NOTE_PATH, line: lineCount, text: "\n" + block, ctx }).pipe(Effect.ignore)
    })

    const extract = Effect.fn("AutoMemory.extract")(function* (input: ExtractInput) {
      const seen = done.get(input.sessionID) ?? new Set<string>()
      const targets = input.messages.filter(
        (m) => m.info.pruned && !seen.has(m.info.id) && (m.info.role === "user" || m.info.role === "assistant"),
      )
      if (targets.length === 0) return
      // Mark targets handled up front so a failed/slow extraction does not get
      // retried against the same turns on the next prune.
      for (const m of targets) seen.add(m.info.id)
      done.set(input.sessionID, seen)

      const source = renderForExtraction(targets)
      if (!source.trim()) return

      const cfg = yield* config.get()
      const model = yield* resolveExtractorModel(provider, cfg, input.fallbackModel)
      if (!model) return

      const result = yield* llm
        .stream({
          agent: input.agent,
          user: input.user,
          system: [SYSTEM_PROMPT],
          small: true,
          tools: {},
          model,
          sessionID: input.sessionID,
          retries: 0,
          messages: [{ role: "user", content: promptFor(source) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.timeout(EXTRACT_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.info("auto-memory extraction failed", { cause: String(cause).slice(0, 200) })
              return null as string | null
            }),
          ),
        )
      if (!result) return
      const facts = result.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "").trim()
      if (!facts || /^none\.?$/i.test(facts)) {
        log.info("auto-memory: nothing worth keeping", { messages: targets.length })
        return
      }
      yield* appendNote(input.sessionID, facts).pipe(Effect.ignore)
      log.info("auto-memory: appended", { messages: targets.length, chars: facts.length })
    })

    return Service.of({ extract })
  }),
)

// Same resolution as the skill router / goal checker: configured
// skills.router_model, else the provider small_model. Never the main model.
const resolveExtractorModel = Effect.fn("AutoMemory.resolveExtractorModel")(function* (
  provider: Provider.Interface,
  cfg: Config.Info,
  fallback: Provider.Model,
) {
  const explicit = cfg.skills?.router_model
  if (explicit) {
    const slash = explicit.indexOf("/")
    if (slash > 0) {
      const got = yield* provider
        .getModel(explicit.slice(0, slash) as never, explicit.slice(slash + 1) as never)
        .pipe(Effect.option)
      if (got._tag === "Some") return got.value
    }
  }
  const small = yield* provider.getSmallModel(fallback.providerID).pipe(Effect.option)
  if (small._tag === "Some" && small.value) return small.value
  return undefined
})

export const defaultLayer = layer.pipe(
  Layer.provide(LLM.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Memory.defaultLayer),
)

export * as AutoMemory from "./auto-memory"
