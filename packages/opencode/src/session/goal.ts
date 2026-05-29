import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { SessionID } from "@/session/schema"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session.goal" })

const CHECK_TIMEOUT = "15 seconds"
const DEFAULT_MAX_ITERATIONS = 25
const RECENT_CAP = 4000

// A session's active completion goal. The prompt loop, instead of handing
// control back when the agent finishes a turn, asks a small checker model
// whether `condition` is met; if not, it injects a continuation and keeps
// going, up to `max` iterations.
export interface Entry {
  condition: string
  iterations: number
  max: number
}

export interface CheckInput {
  condition: string
  recent: string
  agent: Agent.Info
  user: MessageV2.User
  fallbackModel: Provider.Model
  sessionID: string
}

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string, max?: number) => Effect.Effect<Entry>
  readonly get: (sessionID: SessionID) => Effect.Effect<Entry | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly increment: (sessionID: SessionID) => Effect.Effect<void>
  readonly check: (input: CheckInput) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

const SYSTEM_PROMPT = [
  "You are a goal-completion checker for an autonomous coding agent.",
  "Given a goal condition and the agent's most recent work, decide whether the goal has been fully met.",
  "Answer with exactly one word: YES if the goal is fully and verifiably met, or NO if any part remains.",
  "Be strict: only answer YES when the condition is clearly and completely satisfied. When unsure, answer NO.",
].join("\n")

const promptFor = (condition: string, recent: string) =>
  [
    "Goal condition:",
    condition,
    "",
    "Agent's most recent work:",
    recent.slice(-RECENT_CAP) || "(no output)",
    "",
    "Has the goal been fully met? Answer YES or NO.",
  ].join("\n")

// Met only on a clear affirmative with no negation. Defaults to "not met"
// (keep working) for ambiguous answers — the iteration cap bounds the loop.
export function parseAnswer(raw: string): boolean {
  const cleaned = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "").toLowerCase()
  if (/\bno\b|\bnot\b/.test(cleaned)) return false
  return /\byes\b|\bcomplete\b|\bdone\b|\bmet\b/.test(cleaned)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const map = new Map<SessionID, Entry>()

    const check = Effect.fn("Goal.check")(function* (input: CheckInput) {
      const cfg = yield* config.get()
      const model = yield* resolveCheckerModel(provider, cfg, input.fallbackModel)
      // Fail-safe: no small checker model → treat as met so we stop rather than
      // loop forever or burn the main model's quota on checks.
      if (!model) {
        log.warn("no small checker model available; stopping goal loop")
        return true
      }
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
          messages: [{ role: "user", content: promptFor(input.condition, input.recent) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.timeout(CHECK_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.info("goal check failed", { cause: String(cause).slice(0, 200) })
              return null as string | null
            }),
          ),
        )
      if (result === null) return true
      const met = parseAnswer(result)
      log.info("goal check", { met, raw: result.slice(0, 120) })
      return met
    })

    return Service.of({
      set: (sessionID, condition, max) =>
        Effect.sync(() => {
          const entry: Entry = { condition, iterations: 0, max: Math.max(1, Math.min(max ?? DEFAULT_MAX_ITERATIONS, 100)) }
          map.set(sessionID, entry)
          return entry
        }),
      get: (sessionID) => Effect.sync(() => map.get(sessionID)),
      clear: (sessionID) => Effect.sync(() => void map.delete(sessionID)),
      increment: (sessionID) =>
        Effect.sync(() => {
          const entry = map.get(sessionID)
          if (entry) entry.iterations++
        }),
      check,
    })
  }),
)

// Resolve the checker model the same way the skill router does: configured
// `skills.router_model` wins, else the provider's small_model. NEVER the main
// model — checking after every turn on Opus/GPT-5 would burn the user's quota.
const resolveCheckerModel = Effect.fn("Goal.resolveCheckerModel")(function* (
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
)

export * as Goal from "./goal"
