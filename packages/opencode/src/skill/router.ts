import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Skill } from "@/skill"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "skill.router" })

const ROUTE_TIMEOUT = "3 seconds"
const USER_TEXT_CAP = 4000
const MAX_PICKS = 3

export interface RouteInput {
  agent: Agent.Info
  user: MessageV2.User
  userText: string
  fallbackModel: Provider.Model
  sessionID: string
}

export interface Interface {
  readonly route: (input: RouteInput) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillRouter") {}

const SYSTEM_PROMPT = [
  "You are a skill router. Given the user's latest message and a list of skills, pick the skills whose descriptions match what the user is asking for.",
  "",
  "Rules:",
  `- Output a comma-separated list of skill names, ordered by relevance (most relevant first). At most ${MAX_PICKS} skills. No quotes, punctuation, explanation, thinking, or markdown.`,
  "- Be conservative. Most messages match zero skills. Only pick a skill if the user's intent clearly fits its description.",
  "- Pick more than one ONLY when separate skills cover separate, non-overlapping aspects of the request. Do not pick overlapping or near-duplicate skills.",
  "- A skill that says 'Use ONLY when ...' must match the listed conditions exactly. If unsure, leave it out.",
  "- If no skill is a clear match, output exactly: none",
].join("\n")

const promptFor = (userText: string, skills: { name: string; description?: string }[]) =>
  [
    "Available skills:",
    ...skills.map((s) => `- ${s.name}: ${s.description ?? "(no description)"}`),
    "",
    "User message:",
    userText.slice(0, USER_TEXT_CAP),
    "",
    `Pick up to ${MAX_PICKS} skill names (comma-separated, most relevant first), or 'none'. Output only the names.`,
  ].join("\n")

// Strip thinking blocks (deepseek `<think>`, anthropic `<thinking>`),
// fenced code, and markdown punctuation, then collect EVERY available
// skill name that appears, ordered by first-occurrence in the cleaned
// output, deduped, and capped at MAX_PICKS. Returns [] for "none" / no
// matches. Handles plain list, JSON, markdown, trailing punctuation, etc.
function parseRouterAnswer(raw: string, available: Set<string>): string[] {
  const cleaned = raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#]/g, " ")
  const lower = cleaned.toLowerCase()
  const matches: { name: string; index: number }[] = []
  for (const name of available) {
    const re = new RegExp(
      `(^|[^a-z0-9_-])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`,
      "i",
    )
    const m = re.exec(lower)
    if (m) matches.push({ name, index: m.index })
  }
  if (matches.length === 0) return []
  matches.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    out.push(m.name)
    if (out.length >= MAX_PICKS) break
  }
  return out
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const skill = yield* Skill.Service

    const route = Effect.fn("SkillRouter.route")(function* (input: RouteInput) {
      const cfg = yield* config.get()
      const enabled = cfg.skills?.router_enabled ?? true
      if (!enabled) return [] as string[]

      const available = yield* skill.available(input.agent)
      const described = available.filter((s) => s.description)
      if (described.length === 0) return [] as string[]

      const userText = input.userText.trim()
      if (!userText) {
        log.debug("no userText, skipping router")
        return [] as string[]
      }

      const routerModel = yield* resolveRouterModel(provider, cfg, input.fallbackModel)
      if (!routerModel) {
        log.warn("no small router model available, skipping route to avoid tapping main-model quota")
        return [] as string[]
      }

      const result = yield* llm
        .stream({
          agent: input.agent,
          user: input.user,
          system: [SYSTEM_PROMPT],
          small: true,
          tools: {},
          model: routerModel,
          sessionID: input.sessionID,
          retries: 0,
          messages: [{ role: "user", content: promptFor(userText, described) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.timeout(ROUTE_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.info("router failed", { cause: String(cause).slice(0, 200) })
              return null as string | null
            }),
          ),
        )

      if (result === null) return [] as string[]

      const picked = parseRouterAnswer(result, new Set(described.map((s) => s.name)))
      log.info("router decision", { picked, raw: result.slice(0, 240) })
      return picked
    })

    return Service.of({ route })
  }),
)

// Resolve the router model. Configured `skills.router_model` wins; otherwise
// fall back to the provider's small_model. NEVER fall back to the user's
// main model — running the router on Opus/GPT-5 every turn taps the user's
// expensive quota. When no genuinely small model is available, return
// undefined so the router skips routing entirely.
const resolveRouterModel = Effect.fn("SkillRouter.resolveRouterModel")(function* (
  provider: Provider.Interface,
  cfg: Config.Info,
  fallback: Provider.Model,
) {
  const explicit = cfg.skills?.router_model
  if (explicit) {
    const slash = explicit.indexOf("/")
    if (slash > 0) {
      const providerID = explicit.slice(0, slash)
      const modelID = explicit.slice(slash + 1)
      const got = yield* provider.getModel(providerID as never, modelID as never).pipe(Effect.option)
      if (got._tag === "Some") return got.value
      log.warn("router_model not found, falling back to small_model", { explicit })
    } else {
      log.warn("router_model is malformed (expected 'providerID/modelID'), falling back to small_model", { explicit })
    }
  }
  const small = yield* provider.getSmallModel(fallback.providerID).pipe(Effect.option)
  if (small._tag === "Some" && small.value) return small.value
  return undefined
})

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LLM.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as SkillRouter from "./router"
