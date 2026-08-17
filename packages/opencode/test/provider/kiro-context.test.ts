import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import { Schema } from "effect"
import { BUILTIN_PROVIDERS } from "@opencode-ai/core/models-dev"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { contextWindow, createKiro } from "@/provider/kiro"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { usable } from "@/session/overflow"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

// AWS Q reports context usage only as a PERCENTAGE (contextUsageEvent). The
// provider multiplies it by a window to get tokens, and session/overflow.ts
// compares that token count against thresholds derived from
// `model.limit.context`. If the two windows disagree, reported usage saturates
// below every trim threshold, nothing ever gets pruned or compacted, and Q
// hard-rejects with `CONTENT_LENGTH_EXCEEDS_THRESHOLD` while the UI still shows
// plenty of headroom. These tests pin both halves of that contract.

const cfg = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
const KIRO = BUILTIN_PROVIDERS["kiro"]!

const enc = new TextEncoder()
const dec = new TextDecoder()
const codec = new EventStreamCodec(
  (input) => (typeof input === "string" ? input : dec.decode(input)),
  (input) => enc.encode(input),
)

function frame(eventType: string, payload: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: eventType },
    },
    body: enc.encode(JSON.stringify(payload)),
  })
}

function eventStream(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of frames) controller.enqueue(item)
      controller.close()
    },
  })
}

function responder(response: () => Response) {
  return (async () => response()) as unknown as typeof fetch
}

async function collect(stream: ReadableStream<any>): Promise<any[]> {
  const reader = stream.getReader()
  const parts: any[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const PROMPT = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any

/** Drive a real doStream against a fake Q that only reports context usage. */
async function reportedInput(modelId: string, pct: number, context?: number): Promise<number> {
  const model = createKiro({
    apiKey: "ksk_test",
    region: "us-east-1",
    context,
    fetch: responder(() => new Response(eventStream([frame("contextUsageEvent", { contextUsagePercentage: pct })]))),
  }).languageModel(modelId)
  const parts = await collect((await model.doStream(PROMPT)).stream)
  return parts.find((p) => p.type === "finish").usage.inputTokens.total
}

/** Minimal Provider.Model view of a catalog entry — usable() only reads limit. */
function asProviderModel(id: string, limit: { context: number; output: number }): Provider.Model {
  return {
    id,
    providerID: "kiro",
    name: id,
    limit,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    api: { npm: "kiro", id },
    options: {},
  } as unknown as Provider.Model
}

describe("kiro context-usage scaling", () => {
  test("100% of context reports the model's declared window, not a fixed 200K", async () => {
    expect(await reportedInput("claude-opus-5", 100)).toBe(640_000)
  })

  test("a partial percentage scales against the same window", async () => {
    // The exact pair that fooled the TUI: Q said 31.25%, the old code called it
    // 200,000 tokens and the bar rendered 31% of 640,000 — coincidentally right,
    // while every trim threshold was being fed a number 3.2x too small.
    expect(await reportedInput("claude-opus-5", 31.25)).toBe(200_000)
  })

  test("windows differ per model within the same provider instance", async () => {
    expect(await reportedInput("claude-opus-4.6", 100)).toBe(1_000_000)
    expect(await reportedInput("claude-opus-4.5", 100)).toBe(200_000)
    expect(await reportedInput("gpt-5.6-sol", 100)).toBe(272_000)
  })

  test("an explicit options.context still overrides the catalog", async () => {
    expect(await reportedInput("claude-opus-5", 50, 100_000)).toBe(50_000)
  })

  test("a real metering/usage event still wins over the percentage estimate", async () => {
    const model = createKiro({
      apiKey: "ksk_test",
      region: "us-east-1",
      fetch: responder(
        () =>
          new Response(
            eventStream([
              frame("meteringEvent", { usage: {}, inputTokens: 12_345, outputTokens: 67 }),
              frame("contextUsageEvent", { contextUsagePercentage: 100 }),
            ]),
          ),
      ),
    }).languageModel("claude-opus-5")
    const parts = await collect((await model.doStream(PROMPT)).stream)
    const usage = parts.find((p) => p.type === "finish").usage
    expect(usage.inputTokens.total).toBe(12_345)
    expect(usage.outputTokens.total).toBe(67)
  })
})

describe("kiro context-usage invariants (regression guard)", () => {
  const models = Object.entries(KIRO.models)

  test("the catalog is the single source of the scaling window", () => {
    expect(models.length).toBeGreaterThan(0)
    for (const [id, model] of models) {
      expect(contextWindow(id), `kiro/${id} scaling window`).toBe(model.limit.context)
    }
  })

  // THE guard. Q can never report more than 100% of context, so the largest
  // token count the session layer can ever observe is the scaling window. If
  // that ceiling sits below the compaction budget, auto-compaction, turn
  // eviction and the soft checkpoint are all unreachable BY CONSTRUCTION and
  // the model runs until the provider hard-rejects. Any new Kiro model with a
  // window the provider can't resolve fails here instead of in production.
  test("a 100% context report can trip every trim threshold", async () => {
    for (const [id, catalog] of models) {
      const ceiling = await reportedInput(id, 100)
      const model = asProviderModel(id, { context: catalog.limit.context, output: catalog.limit.output })
      const budget = usable({ cfg, model })
      expect(budget, `kiro/${id} usable budget`).toBeGreaterThan(0)
      expect(ceiling, `kiro/${id} reportable ceiling vs compaction budget`).toBeGreaterThanOrEqual(budget)
    }
  })
})

describe("kiro error classification", () => {
  const OVERFLOW_BODY = JSON.stringify({
    __type: "com.amazon.kiro.runtimeservice#ValidationException",
    message: "Input content length exceeds threshold.",
    reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  })

  async function fail(status: number, body: string) {
    const model = createKiro({
      apiKey: "ksk_test",
      region: "us-east-1",
      fetch: responder(() => new Response(body, { status })),
    }).languageModel("claude-opus-5")
    return await model.doStream(PROMPT).then(
      () => undefined,
      (e) => e,
    )
  }

  test("a Q failure is an AI SDK APICallError, not an opaque Error", async () => {
    const error = await fail(400, OVERFLOW_BODY)
    // Marker-based isInstance imported from `ai` — the same call site
    // session/message-v2.ts uses. A plain Error here would fall through to
    // NamedError.Unknown and skip every classifier below.
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.statusCode).toBe(400)
    expect(error.responseBody).toBe(OVERFLOW_BODY)
  })

  test("CONTENT_LENGTH_EXCEEDS_THRESHOLD is context overflow, so the session compacts and retries", async () => {
    const error = await fail(400, OVERFLOW_BODY)
    expect(ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("kiro"), error }).type).toBe("context_overflow")
    const classified = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("kiro") })
    expect(MessageV2.ContextOverflowError.isInstance(classified)).toBe(true)
  })

  test("throttling and server errors are retryable", async () => {
    for (const status of [429, 500, 503]) {
      const error = await fail(status, JSON.stringify({ __type: "ThrottlingException", message: "slow down" }))
      const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("kiro"), error })
      expect(parsed.type, `status ${status}`).toBe("api_error")
      expect(parsed.type === "api_error" && parsed.isRetryable, `status ${status} retryable`).toBe(true)
    }
  })

  test("an unrelated 400 stays a non-retryable api error", async () => {
    const error = await fail(400, JSON.stringify({ __type: "ValidationException", message: "REQUEST_BODY_INVALID" }))
    const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("kiro"), error })
    expect(parsed.type).toBe("api_error")
    expect(parsed.type === "api_error" && parsed.isRetryable).toBe(false)
  })
})
