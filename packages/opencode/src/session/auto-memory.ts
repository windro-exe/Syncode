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
// Trigger rotation a bit under memory's 64KB MAX_CONTENT_BYTES so we always
// have room for one more append. Without rotation, the note silently fails
// every append once full and every prune burns a small-model LLM call into a
// guaranteed write failure. Threshold here is the projected size of the new
// content; if it'd exceed this, rotate by dropping the oldest blocks.
const NOTE_ROTATE_THRESHOLD = 56 * 1024
// Drop oldest "## Evicted ..." blocks until total content fits under threshold.
// Keeps the per-file header (everything before the first block) and a marker
// for how many were rotated. Hydrate will still recover ids from the blocks
// that remain — older ones are gone and their facts have been summarized into
// memory by now anyway (or the model already moved past them).
function rotateNote(existing: string, newBlock: string, threshold: number): string {
  const headIdx = existing.indexOf("## Evicted")
  const head = headIdx >= 0 ? existing.slice(0, headIdx) : existing.replace(/\n*$/, "\n\n")
  const tail = headIdx >= 0 ? existing.slice(headIdx) : ""
  const blocks = tail.split(/(?=^## Evicted )/m).filter((b) => b.trim().length > 0)
  blocks.push(newBlock.endsWith("\n") ? newBlock : newBlock + "\n")
  let dropped = 0
  const size = (parts: string[]) =>
    Buffer.byteLength(head, "utf8") +
    parts.reduce((s, b) => s + Buffer.byteLength(b, "utf8"), 0) +
    (dropped > 0 ? 200 : 0)
  while (blocks.length > 1 && size(blocks) > threshold) {
    blocks.shift()
    dropped++
  }
  const marker =
    dropped > 0
      ? `<!-- rotated: dropped ${dropped} oldest evicted block(s) to fit ${threshold}-byte cap -->\n\n`
      : ""
  return head + marker + blocks.join("")
}

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

    // Per-session in-flight guard. Prune is forked off the response path with
    // Effect.forkIn(scope), which ESCAPES the per-session run lock — so two
    // prunes within the 20s extract timeout could both fork extract for the
    // same session, both hydrate from the same note, both filter overlapping
    // ids, both LLM-extract, both append. dedupeFacts blunts content overlap
    // but ids comments duplicate and tokens are wasted. This drops a duplicate
    // fork at the door instead.
    const inFlight = new Set<SessionID>()

    // Rebuild the seen-set for a session from the ids recorded in the note, the
    // first time we touch that session. This makes dedup durable across restarts
    // instead of living only in this in-process Map.
    const hydrate = Effect.fn("AutoMemory.hydrate")(function* (sessionID: SessionID) {
      const cached = done.get(sessionID)
      if (cached) return cached
      const seen = new Set<string>()
      const viewed = yield* memory.view({ scope: "session", path: NOTE_PATH, ctx: { sessionID } }).pipe(Effect.option)
      if (viewed._tag === "Some" && viewed.value.entry) {
        // Tolerant of partial writes / manual edits / truncated `-->`: accept
        // anything from `<!-- ids: ` up to the next `>` OR the end of line.
        // Multiline-anchored. Matches both `<!-- ids: a,b -->` and the
        // half-broken `<!-- ids: a,b\n` cases hydrate would silently miss.
        for (const m of viewed.value.entry.content.matchAll(/<!--\s*ids:\s*([^>\r\n]+?)\s*(?:-->|$)/gm)) {
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
      const existing = viewed.value.entry.content
      // Rotate if the new block would push the file past memory's 64KB cap —
      // otherwise updateContent fails forever and every subsequent prune burns
      // a small-model LLM call into a guaranteed write failure. Drop oldest
      // ## Evicted blocks (in order) to fit; keeps recent blocks + their id
      // markers so hydrate can still dedup what's still in the file.
      const candidate = existing + "\n" + block
      if (Buffer.byteLength(candidate, "utf8") > NOTE_ROTATE_THRESHOLD) {
        const rotated = rotateNote(existing, block, NOTE_ROTATE_THRESHOLD)
        yield* memory.strReplace({ scope: "session", path: NOTE_PATH, oldStr: existing, newStr: rotated, ctx })
        return
      }
      const lineCount = existing.split("\n").length
      yield* memory.insert({ scope: "session", path: NOTE_PATH, line: lineCount, text: "\n" + block, ctx })
    })

    const extract = Effect.fn("AutoMemory.extract")(function* (input: ExtractInput) {
      // Per-session in-flight guard. The fork that calls us escapes the session
      // run-state lock, so two prunes within the 20s extract timeout could
      // both reach this function for the same session. Drop the second one.
      if (inFlight.has(input.sessionID)) {
        log.info("auto-memory: extract skipped (already in flight)", { sessionID: input.sessionID })
        return
      }
      inFlight.add(input.sessionID)
      try {
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
      } finally {
        inFlight.delete(input.sessionID)
      }
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
