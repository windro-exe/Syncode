import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@opencode-ai/schema/models-dev"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = ModelsDev.Event

// ---------------------------------------------------------------------------
// Built-in providers (Syncode)
//
// Providers shipped in-source so they appear in /connect and resolve with zero
// opencode.json config. Kiro talks directly to AWS Q via the vendored provider
// SDK (packages/opencode/src/provider/kiro, npm key "kiro"); the user only pastes
// a `ksk_` key via /connect. Built-ins are merged into every get() result and win
// over any same-id upstream entry so the vendored SDK binding stays authoritative.
// ---------------------------------------------------------------------------

function kiroModel(
  id: string,
  name: string,
  release_date: string,
  context: number,
  output: number,
  input: ("text" | "image" | "pdf")[] = ["text", "image", "pdf"],
): Model {
  return {
    id,
    name,
    release_date,
    attachment: input.length > 1,
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: { context, output },
    modalities: { input, output: ["text"] },
  }
}

function orcarouterModel(
  id: string,
  name: string,
  release_date: string,
  context: number,
  output: number,
  input: ("text" | "image" | "video")[] = ["text"],
  interleaved?: { field: "reasoning_content" | "reasoning_details" },
): Model {
  return {
    id,
    name,
    release_date,
    attachment: input.length > 1,
    reasoning: true,
    temperature: true,
    tool_call: true,
    interleaved,
    limit: { context, output },
    modalities: { input, output: ["text"] },
  }
}

export const BUILTIN_PROVIDERS: Record<string, Provider> = {
  kiro: {
    id: "kiro",
    name: "Kiro",
    npm: "kiro",
    env: ["KIRO_API_KEY"],
    models: {
      // Context limits EMPIRICALLY MEASURED against the Q backend 2026-07-14, NOT the
      // advertised catalog numbers. AWS capacity-throttles INPUT on the newest models
      // (opus-4.8/4.7 + the sonnet-5 preview) to ~640K tokens despite their "1M" label;
      // the mature opus-4.6/sonnet-4.6 genuinely deliver ~1M. Past ~2.65M chars the throttled
      // ones return ValidationException/CONTENT_LENGTH_EXCEEDS_THRESHOLD, so we declare the
      // real ceiling here to let context pruning fire before Q hard-rejects.
      "claude-sonnet-5": kiroModel("claude-sonnet-5", "Claude Sonnet 5", "2026-07-01", 640_000, 64_000),
      "claude-opus-5": kiroModel("claude-opus-5", "Claude Opus 5", "2026-08-01", 640_000, 128_000),
      "claude-opus-4.8": kiroModel("claude-opus-4.8", "Claude Opus 4.8", "2026-01-01", 640_000, 128_000),
      "claude-opus-4.7": kiroModel("claude-opus-4.7", "Claude Opus 4.7", "2025-11-01", 640_000, 128_000),
      "claude-opus-4.6": kiroModel("claude-opus-4.6", "Claude Opus 4.6", "2025-09-01", 1_000_000, 128_000),
      "claude-opus-4.5": kiroModel("claude-opus-4.5", "Claude Opus 4.5", "2025-07-01", 200_000, 64_000),
      "claude-sonnet-4.6": kiroModel("claude-sonnet-4.6", "Claude Sonnet 4.6", "2025-11-01", 1_000_000, 64_000),
      "claude-sonnet-4.5": kiroModel("claude-sonnet-4.5", "Claude Sonnet 4.5", "2025-07-01", 200_000, 64_000),
      // GPT-5.6 variants (experimental preview). Verified 2026-07-14: real ~272K window
      // (advertised 272k is accurate here, NOT throttled) and TEXT-ONLY — the Q `images`
      // field returns REQUEST_BODY_INVALID for these (Claude accepts it), so no image/pdf.
      "gpt-5.6-sol": kiroModel("gpt-5.6-sol", "GPT-5.6 Sol", "2026-07-01", 272_000, 64_000, ["text"]),
      "gpt-5.6-terra": kiroModel("gpt-5.6-terra", "GPT-5.6 Terra", "2026-07-01", 272_000, 64_000, ["text"]),
      "gpt-5.6-luna": kiroModel("gpt-5.6-luna", "GPT-5.6 Luna", "2026-07-01", 272_000, 64_000, ["text"]),
    },
  },
  orcarouter: {
    id: "orcarouter",
    name: "OrcaRouter",
    api: "https://api.orcarouter.ai/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["ORCAROUTER_API_KEY"],
    models: {
      "qwen/qwen3.8-27b-free": orcarouterModel(
        "qwen/qwen3.8-27b-free",
        "Qwen: Qwen3.8 27B (Free)",
        "2026-08-13",
        262_144,
        0,
        ["text", "image", "video"],
      ),
      "deepseek/deepseek-v4-flash-free": orcarouterModel(
        "deepseek/deepseek-v4-flash-free",
        "DeepSeek: DeepSeek V4 Flash (Free)",
        "",
        1_048_576,
        384_000,
        ["text"],
        { field: "reasoning_content" },
      ),
      "deepseek/deepseek-v4-pro-free": orcarouterModel(
        "deepseek/deepseek-v4-pro-free",
        "DeepSeek: DeepSeek V4 Pro (Free)",
        "",
        1_048_576,
        384_000,
        ["text"],
        { field: "reasoning_content" },
      ),
      "stealth/ox-alpha": orcarouterModel(
        "stealth/ox-alpha",
        "Ox Alpha (Stealth Reasoning)",
        "2026-08-20",
        1_048_576,
        131_072,
        ["text", "image", "video"],
        { field: "reasoning_content" },
      ),
    },
  },
}

declare const OPENCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.OPENCODE_MODELS_URL || "https://models.opencode.ai"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch((error) => {
        if (
          Flag.OPENCODE_MODELS_PATH === undefined &&
          error._tag === "FileSystemError" &&
          error.method === "readJson"
        ) {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent opencode CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return JSON.parse(text) as Record<string, Provider>
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> =>
      cachedGet.pipe(Effect.map((all) => ({ ...all, ...BUILTIN_PROVIDERS })))

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
        Effect.ignore,
      )
    })

    if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export * as ModelsDev from "./models-dev"
