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

// Drop facts already recorded in the note (and duplicates within the new batch),
// compared on normalized bullet text. Prevents the same fact restated across
// successive evictions from accreting as N near-identical bullets.
function dedupeFacts(existing: string, facts: string): string {
  const norm = (s: string) => s.replace(/^[-*\d.)\s]+/, "").trim().toLowerCase()
  const have = new Set(existing.split(/\r?\n/).map(norm).filter(Boolean))
  const kept: string[] = []
  for (const line of facts.split(/\r?\n/)) {
    const n = norm(line)
    if (!n || have.has(n)) continue
    have.add(n)
    kept.push(line)
  }
  return kept.join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    // Per-session set of message ids already distilled, so the same evicted
    // turns are not re-extracted on every subsequent prune. Hydrated from the
    // persisted note (below) so the dedup survives a restart.
    const done = new Map<SessionID, Set<string>>()

    // Rebuild the seen-set for a session from the ids recorded in the note, the
    // first time we touch that session. This makes dedup durable across restarts
    // instead of living only in this in-process Map.
    const hydrate = Effect.fn("AutoMemory.hydrate")(function* (sessionID: SessionID) {
      const cached = done.get(sessionID)
      if (cached) return cached
      const seen = new Set<string>()
      const viewed = yield* memory.view({ scope: "session", path: NOTE_PATH, ctx: { sessionID } }).pipe(Effect.option)
      if (viewed._tag === "Some" && viewed.value.entry) {
        for (const m of viewed.value.entry.content.matchAll(/<!--\s*ids:\s*([^>]*?)\s*-->/g)) {
          for (const id of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) seen.add(id)
        }
      }
      done.set(sessionID, seen)
      return seen
    })

    const appendNote = Effect.fn("AutoMemory.appendNote")(function* (
      sessionID: SessionID,
      facts: string,
      ids: string[],
    ) {
      const ctx = { sessionID }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
      // Record which message ids this block was distilled from so hydrate() can
      // rebuild the dedup set after a restart.
      const block = [`## Evicted ${stamp}`, `<!-- ids: ${ids.join(",")} -->`, facts, ""].join("\n")
      const viewed = yield* memory.view({ scope: "session", path: NOTE_PATH, ctx }).pipe(Effect.option)
      if (viewed._tag === "None" || !viewed.value.entry) {
        yield* memory.create({
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
        return
      }
      const lineCount = viewed.value.entry.content.split("\n").length
      yield* memory.insert({ scope: "session", path: NOTE_PATH, line: lineCount, text: "\n" + block, ctx })
    })

    const extract = Effect.fn("AutoMemory.extract")(function* (input: ExtractInput) {
      const seen = yield* hydrate(input.sessionID)
      const targets = input.messages.filter(
        (m) => m.info.pruned && !seen.has(m.info.id) && (m.info.role === "user" || m.info.role === "assistant"),
      )
      if (targets.length === 0) return
      const ids = targets.map((m) => m.info.id)

      const source = renderForExtraction(targets)
      if (!source.trim()) {
        // Nothing renderable in these turns; mark handled so we don't reprocess them.
        for (const id of ids) seen.add(id)
        return
      }

      const cfg = yield* config.get()
      const model = yield* resolveExtractorModel(provider, cfg, input.fallbackModel)
      if (!model) return // no extractor model available; leave unseen to retry later

      const result = yield* llm
        .stream({
          agent: input.agent,
          user: input.user,
          system: [SYSTEM_PROMPT],
          small: true,
          tools: {},
          model,
          sessionID: input.sessionID,
          retries: 2,
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
      // Extraction failed/timed out — do NOT mark seen, so the next prune retries.
      if (!result) return
      const facts = result.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "").trim()
      if (!facts || /^none\.?$/i.test(facts)) {
        // Successful extraction, nothing worth keeping — mark handled.
        for (const id of ids) seen.add(id)
        log.info("auto-memory: nothing worth keeping", { messages: targets.length })
        return
      }
      // Drop facts already recorded in the note so the same fact restated across
      // evictions doesn't accrete as duplicates.
      const existingNote = yield* memory
        .view({ scope: "session", path: NOTE_PATH, ctx: { sessionID: input.sessionID } })
        .pipe(Effect.option)
      const existingText =
        existingNote._tag === "Some" && existingNote.value.entry ? existingNote.value.entry.content : ""
      const newFacts = dedupeFacts(existingText, facts)
      if (!newFacts.trim()) {
        for (const id of ids) seen.add(id)
        log.info("auto-memory: all facts already known", { messages: targets.length })
        return
      }
      // Persist first; mark the turns handled only once the write actually
      // succeeds, so a failed append is retried rather than silently dropped.
      const appended = yield* appendNote(input.sessionID, newFacts, ids).pipe(
        Effect.map(() => true),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.info("auto-memory append failed", { cause: String(cause).slice(0, 200) })
            return false
          }),
        ),
      )
      if (!appended) return
      for (const id of ids) seen.add(id)
      log.info("auto-memory: appended", { messages: targets.length, chars: newFacts.length })
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
