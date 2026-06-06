// Built-in Kiro provider for opencode.
//
// Vendored and adapted from `kiro-ai-provider` (MIT, Nacho F. Lizaur, v0.4.5) with
// three additions opencode needs that the upstream package lacks:
//   1. `settings.apiKey` so a key entered via `/connect` (stored in auth.json) is used
//      directly as the bearer token — no env var or kiro-cli login required.
//   2. Real reasoning: the AWS Q `reasoningContentEvent` is decoded and emitted as
//      AI SDK `reasoning-start`/`reasoning-delta`/`reasoning-end` stream parts (the
//      upstream package only exposed a fake "thinking" tool). Assistant reasoning is
//      round-tripped back to Q as `reasoningContent.reasoningText`.
//   3. Reasoning effort: `providerOptions.kiro.effort` is injected into the request as
//      `additionalModelRequestFields.output_config.effort`, wired into opencode's
//      existing variant/effort (ctrl+T) pipeline.
//
// Talks directly to the AWS Q / CodeWhisperer streaming endpoint
// (`q.{region}.amazonaws.com`, AWS event-stream binary protocol). No proxy.
import path from "path"
import os from "os"
import { readFile, writeFile, access } from "fs/promises"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3GenerateResult,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

const VALID_REGION = /^[a-z]{2}-[a-z]+-\d+$/
function validateRegion(region: string) {
  if (!VALID_REGION.test(region)) throw new Error(`Invalid AWS region: ${region}`)
  return region
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-amz-json-1.0",
    // `ksk_` keys are app.kiro.dev programmatic API keys and must be flagged as such.
    ...(token.startsWith("ksk_") ? { tokentype: "API_KEY" } : {}),
    "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/${process.platform} lang/js api/codewhispererstreaming#1.0.27 m/E opencode-kiro`,
    "x-amz-user-agent": "aws-sdk-js/1.0.27 opencode-kiro",
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
  }
}

// ---------------------------------------------------------------------------
// auth (env KIRO_API_KEY / OIDC token file + refresh)
// ---------------------------------------------------------------------------

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: string
  region: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  authMethod?: string
  provider?: string
}

const TOKEN_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
const BUFFER_MS = 3e5
const VALID_HASH = /^[a-zA-Z0-9_-]+$/

function resolveClient(token: StoredToken): Promise<{ clientId: string; clientSecret: string } | undefined> {
  if (token.clientId) return Promise.resolve({ clientId: token.clientId, clientSecret: token.clientSecret ?? "" })
  if (!token.clientIdHash) return Promise.resolve(undefined)
  if (!VALID_HASH.test(token.clientIdHash)) return Promise.resolve(undefined)
  const ref = path.join(os.homedir(), ".aws", "sso", "cache", `${token.clientIdHash}.json`)
  return readFile(ref, "utf-8")
    .then((text) => JSON.parse(text))
    .then((data) => ({ clientId: data.clientId, clientSecret: data.clientSecret }))
    .catch((e) => {
      console.warn("[kiro]", e instanceof Error ? e.message : e)
      return undefined
    })
}

const cache: { current: StoredToken | undefined; expires: number } = { current: undefined, expires: 0 }
const pending: { token: Promise<string | undefined> | undefined; region: Promise<string> | undefined } = {
  token: undefined,
  region: undefined,
}

function readTokenFile(): Promise<StoredToken | undefined> {
  return access(TOKEN_PATH)
    .then(() => readFile(TOKEN_PATH, "utf-8"))
    .then((text) => JSON.parse(text) as StoredToken)
    .catch(() => undefined)
}

function writeTokenFile(token: StoredToken): Promise<void> {
  return writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 }).catch((e) => {
    console.warn("[kiro]", e instanceof Error ? e.message : e)
  })
}

function refresh(token: StoredToken): Promise<string | undefined> {
  const url = `https://oidc.${validateRegion(token.region)}.amazonaws.com/token`
  return resolveClient(token).then((client) => {
    if (!client) return undefined
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: token.refreshToken,
      }),
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => {
        if (!body) return undefined
        const next: StoredToken = {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken ?? token.refreshToken,
          expiresAt: new Date(Date.now() + body.expiresIn * 1e3).toISOString(),
          region: token.region,
          clientId: token.clientId,
          clientSecret: token.clientSecret,
          clientIdHash: token.clientIdHash,
          authMethod: token.authMethod,
          provider: token.provider,
        }
        cache.current = next
        cache.expires = new Date(next.expiresAt).getTime() - BUFFER_MS
        writeTokenFile(next)
        return next.accessToken
      })
      .catch((e) => {
        console.warn("[kiro]", e instanceof Error ? e.message : e)
        return undefined
      })
  })
}

// Resolve a bearer token: explicit override (from /connect or env) wins, then the
// in-memory cache, then the on-disk kiro-cli/Kiro IDE token (refreshing if near expiry).
export function getToken(override?: string): Promise<string | undefined> {
  if (override) return Promise.resolve(override)
  if (process.env["KIRO_API_KEY"]) return Promise.resolve(process.env["KIRO_API_KEY"])
  if (cache.current && Date.now() < cache.expires) return Promise.resolve(cache.current.accessToken)
  return readTokenFile().then((token) => {
    if (!token) return undefined
    const expiry = new Date(token.expiresAt).getTime()
    if (Date.now() < expiry - BUFFER_MS) {
      cache.current = token
      cache.expires = expiry - BUFFER_MS
      return token.accessToken
    }
    if (!pending.token) pending.token = refresh(token).finally(() => (pending.token = undefined))
    return pending.token
  })
}

const regionCache = { api: "", token: "" }

function probeRegion(apiRegion: string, token: string): Promise<boolean> {
  return fetch(`https://q.${validateRegion(apiRegion)}.amazonaws.com/`, {
    method: "POST",
    headers: { ...authHeaders(token), "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels" },
    body: JSON.stringify({ origin: "AI_EDITOR" }),
  })
    .then((r) => r.ok)
    .catch(() => false)
}

// Auto-detect the Kiro API region (us-east-1 or eu-central-1) by probing, cached per token.
export function getApiRegion(token?: string): Promise<string> {
  if (regionCache.api && regionCache.token === (token ?? "")) return Promise.resolve(regionCache.api)
  if (pending.region) return pending.region
  pending.region = (token ? Promise.resolve(token) : getToken())
    .catch(() => undefined)
    .then((t) => {
      if (!t) return "us-east-1"
      return probeRegion("us-east-1", t).then((ok) => {
        if (ok) {
          regionCache.api = "us-east-1"
          regionCache.token = t ?? ""
          return "us-east-1"
        }
        return probeRegion("eu-central-1", t).then((ok2) => {
          if (ok2) {
            regionCache.api = "eu-central-1"
            regionCache.token = t ?? ""
            return "eu-central-1"
          }
          return "us-east-1"
        })
      })
    })
    .catch(() => "us-east-1")
    .finally(() => (pending.region = undefined))
  return pending.region
}

// ---------------------------------------------------------------------------
// prompt → conversationState translation
// ---------------------------------------------------------------------------

type AnyPart = { type: string; [k: string]: any }
type AnyMessage = { role: string; content: any }

const safeParseInput = (s: string): Record<string, any> => {
  try {
    const result = JSON.parse(s)
    if (typeof result === "object" && result !== null) return result
    return {}
  } catch {
    return {}
  }
}

function toolSpecs(input: { name: string; description?: string; inputSchema: any }[]) {
  return input.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: { json: tool.inputSchema },
    },
  }))
}

function textOf(parts: AnyPart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

// Extract assistant reasoning parts → AWS Q reasoningContent shape so thinking
// round-trips across turns (mirrors kiro-proxy q-client.js extractReasoning).
function reasoningOf(parts: AnyPart[]): { reasoningText: { text: string; signature?: string } } | undefined {
  const blocks = parts.filter((p) => p.type === "reasoning" && typeof p.text === "string" && p.text.length > 0)
  if (blocks.length === 0) return undefined
  const text = blocks.map((p) => p.text).join("")
  // The AI SDK delivers reasoning parts to providers with metadata under
  // `providerOptions` (convertToLanguageModelPrompt); fall back to providerMetadata defensively.
  const sig = blocks
    .map((p) => p.providerOptions?.kiro?.signature ?? p.providerMetadata?.kiro?.signature)
    .find((s) => typeof s === "string" && s.length > 0)
  return { reasoningText: { text, ...(sig ? { signature: sig } : {}) } }
}

function toolResultOutput(result: any): string {
  if (!result) return "(no output)"
  switch (result.type) {
    case "text":
    case "error-text":
      return result.value
    case "json":
    case "error-json":
      return JSON.stringify(result.value)
    case "execution-denied":
      return result.reason ?? "(execution denied)"
    case "content":
      return result.value
        .filter((v: AnyPart) => v.type === "text")
        .map((v: AnyPart) => v.text)
        .join("\n")
    default:
      return String(result.value ?? "")
  }
}

function buildHistory(prompt: AnyMessage[], model: string): any[] {
  const prefix = prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n")
  return prompt
    .filter((m) => m.role !== "system")
    .flatMap((msg): any[] => {
      switch (msg.role) {
        case "user":
          return [{ userInputMessage: { content: textOf(msg.content), modelId: model, origin: "AI_EDITOR" } }]
        case "assistant": {
          const content = textOf(msg.content.filter((p: AnyPart) => p.type === "text"))
          const calls = msg.content.filter((p: AnyPart) => p.type === "tool-call")
          const reasoning = reasoningOf(msg.content)
          const message: any = calls.length
            ? {
                content: content || "(empty)",
                toolUses: calls.map((c: AnyPart) => ({
                  name: c.toolName,
                  input: typeof c.input === "string" ? safeParseInput(c.input) : (c.input ?? {}),
                  toolUseId: c.toolCallId,
                })),
              }
            : { content: content || "(empty)" }
          if (reasoning) message.reasoningContent = reasoning
          return [{ assistantResponseMessage: message }]
        }
        case "tool":
          return [
            {
              userInputMessage: {
                content: " ",
                modelId: model,
                origin: "AI_EDITOR",
                userInputMessageContext: {
                  toolResults: msg.content
                    .filter((r: AnyPart) => r.type === "tool-result")
                    .map((r: AnyPart) => ({
                      toolUseId: r.toolCallId,
                      content: [{ text: toolResultOutput(r.output) }],
                      status:
                        r.output?.type === "error-text" || r.output?.type === "error-json" ? "error" : "success",
                    })),
                },
              },
            },
          ]
        default:
          return []
      }
    })
    .map((msg: any, idx: number) => {
      if (idx !== 0 || !prefix || !("userInputMessage" in msg)) return msg
      return {
        userInputMessage: { ...msg.userInputMessage, content: prefix + "\n" + msg.userInputMessage.content },
      }
    })
}

function countTrailing<T>(arr: T[], predicate: (item: T) => boolean): number {
  const result = arr.reduceRight<{ n: number; done: boolean }>(
    (acc, item) => (acc.done ? acc : predicate(item) ? { ...acc, n: acc.n + 1 } : { ...acc, done: true }),
    { n: 0, done: false },
  )
  return result.n
}

function translate(input: {
  prompt: AnyMessage[]
  modelId: string
  conversationId?: string
  tools?: { name: string; description?: string; inputSchema: any }[]
}) {
  const system = input.prompt.filter((m) => m.role === "system")
  const rest = input.prompt.filter((m) => m.role !== "system")
  const trailing = countTrailing(rest, (m) => m.role === "tool")
  const has = trailing > 0
  const toolResults = has
    ? rest
        .slice(rest.length - trailing)
        .filter((m) => m.role === "tool")
        .flatMap((m) =>
          m.content
            .filter((r: AnyPart) => r.type === "tool-result")
            .map((r: AnyPart) => ({
              toolUseId: r.toolCallId,
              content: [{ text: toolResultOutput(r.output) }],
              status: r.output?.type === "error-text" || r.output?.type === "error-json" ? "error" : "success",
            })),
        )
    : []
  const hist = has ? rest.slice(0, rest.length - trailing) : rest.slice(0, -1)
  const last = has ? undefined : rest.findLast((m) => m.role === "user")
  const content = last ? textOf(last.content) : " "
  const prefix = system.map((m) => m.content).join("\n")
  const current = hist.length === 0 && prefix ? prefix + "\n" + content : content
  const ctx: any = {}
  if (input.tools?.length) ctx.tools = toolSpecs(input.tools)
  if (toolResults.length) ctx.toolResults = toolResults
  const userInputMessageContext = Object.keys(ctx).length ? ctx : undefined
  return {
    conversationId: input.conversationId ?? crypto.randomUUID(),
    currentMessage: {
      userInputMessage: { content: current, modelId: input.modelId, origin: "AI_EDITOR", userInputMessageContext },
    },
    history: buildHistory([...system, ...hist], input.modelId),
    chatTriggerType: "MANUAL",
  }
}

// ---------------------------------------------------------------------------
// AWS event-stream decode
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const codec = new EventStreamCodec(
  (input) => (typeof input === "string" ? input : decoder.decode(input)),
  (input) => encoder.encode(input),
)

function mergeBuffers(buffers: Uint8Array[], total: number): Uint8Array {
  if (buffers.length === 1) return buffers[0]
  const merged = new Uint8Array(total)
  buffers.reduce((offset, buf) => {
    merged.set(buf, offset)
    return offset + buf.length
  }, 0)
  return merged
}

const MAX_FRAME = 16 * 1024 * 1024

async function* chunked(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buffer: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    buffer.push(chunk)
    total += chunk.length
    while (total >= 4) {
      const merged = mergeBuffers(buffer, total)
      const view = new DataView(merged.buffer, merged.byteOffset)
      const length = view.getUint32(0, false)
      // AWS event-stream minimum frame = 12-byte prelude + 4-byte message CRC.
      // Guard both ends: a zero/garbage length would otherwise spin on the same bytes.
      if (length < 16 || length > MAX_FRAME) throw new Error(`Event stream frame size invalid: ${length}`)
      if (total < length) break
      yield merged.slice(0, length)
      const remainder = merged.slice(length)
      buffer = remainder.length > 0 ? [remainder] : []
      total = remainder.length
    }
  }
}

function headerValue(headers: Record<string, any>, name: string): string | undefined {
  const entry = headers[name]
  if (!entry) return undefined
  if (entry.type === "string") return entry.value
  if (entry.type === "binary") return decoder.decode(entry.value)
  return String(entry.value)
}

const safeParse = (s: string): Record<string, any> | undefined => {
  try {
    const result = JSON.parse(s)
    if (typeof result === "object" && result !== null) return result
    return undefined
  } catch {
    return undefined
  }
}

type KiroEvent =
  | { type: "content"; payload: { content: string; modelId?: string } }
  | { type: "reasoning"; payload: { text?: string; signature?: string } }
  | { type: "tool_start"; payload: { toolUseId: string; name: string; input?: string } }
  | { type: "tool_input"; payload: { input: string } }
  | { type: "tool_stop"; payload: Record<string, any> }
  | { type: "usage"; payload: { inputTokens?: number; outputTokens?: number } }
  | { type: "context_usage"; payload: { contextUsagePercentage?: number; contextTokens?: number } }
  | { type: "error"; payload: { message: string } }

function interpret(message: { headers: Record<string, any>; body: Uint8Array }): KiroEvent | undefined {
  const kind = headerValue(message.headers, ":message-type")
  const event = headerValue(message.headers, ":event-type")
  if (kind === "error" || kind === "exception") {
    return { type: "error", payload: { message: decoder.decode(message.body) } }
  }
  if (kind !== "event") return undefined
  if (message.body.length === 0) return undefined
  const payload = safeParse(decoder.decode(message.body))
  if (!payload) return undefined
  switch (event) {
    case "assistantResponseEvent": {
      if ("content" in payload) return { type: "content", payload: payload as any }
      if ("name" in payload) return { type: "tool_start", payload: payload as any }
      if ("stop" in payload) return { type: "tool_stop", payload }
      if ("usage" in payload) return { type: "usage", payload: payload as any }
      if ("input" in payload) return { type: "tool_input", payload: payload as any }
      return undefined
    }
    // Real thinking: AWS Q streams reasoning here (kiro-proxy q-client.js:376-383).
    case "reasoningContentEvent":
      return { type: "reasoning", payload: payload as any }
    case "toolUseEvent": {
      if ("stop" in payload) return { type: "tool_stop", payload }
      if ("input" in payload) return { type: "tool_input", payload: payload as any }
      return { type: "tool_start", payload: payload as any }
    }
    case "contextUsageEvent":
      return { type: "context_usage", payload: payload as any }
    case "meteringEvent":
      return { type: "usage", payload: payload as any }
    default:
      return undefined
  }
}

function toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in stream) return stream as unknown as AsyncIterable<Uint8Array>
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader()
      return {
        async next() {
          const result = await reader.read()
          if (result.done) return { done: true, value: undefined }
          return { done: false, value: result.value }
        },
        async return() {
          await reader.cancel()
          reader.releaseLock()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

async function* decodeEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<KiroEvent> {
  for await (const frame of chunked(toAsyncIterable(stream))) {
    const event = interpret(codec.decode(frame))
    if (event) yield event
  }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class KiroAuthError extends Error {
  data: { message: string }
  override name = "KiroAuthError"
  constructor(data: { message: string }) {
    super(data.message)
    this.data = data
  }
}

export class KiroApiError extends Error {
  data: { status: number; body: string }
  override name = "KiroApiError"
  constructor(data: { status: number; body: string }) {
    super(`Kiro API error ${data.status}: ${data.body}`)
    this.data = data
  }
}

export class KiroStreamError extends Error {
  data: { message: string }
  override name = "KiroStreamError"
  constructor(data: { message: string }) {
    super(data.message)
    this.data = data
  }
}

// ---------------------------------------------------------------------------
// stream transform: KiroEvent → LanguageModelV3StreamPart
// ---------------------------------------------------------------------------

function makeTransform(context: number): TransformStream<KiroEvent, LanguageModelV3StreamPart> {
  const toolInputs = new Map<string, { name: string; input: string }>()
  const usage: LanguageModelV3Usage = {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
  }
  // Block ids increment so interleaved reasoning/text render as distinct parts.
  const state = {
    seq: 0,
    text: "",
    reasoning: "",
    started: false,
    errored: false,
    tool: "",
    toolOpen: "",
    signature: undefined as string | undefined,
  }

  const ensureStarted = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
    if (!state.started) {
      state.started = true
      controller.enqueue({ type: "stream-start", warnings: [] })
    }
  }
  const closeText = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
    if (state.text) {
      controller.enqueue({ type: "text-end", id: state.text })
      state.text = ""
    }
  }
  const closeReasoning = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
    if (state.reasoning) {
      controller.enqueue({
        type: "reasoning-end",
        id: state.reasoning,
        ...(state.signature ? { providerMetadata: { kiro: { signature: state.signature } } } : {}),
      })
      state.reasoning = ""
      state.signature = undefined
    }
  }
  // Close an open tool-input block, emitting a best-effort tool-call so the SDK
  // never sees a "tool-calls" finish with no matching call (truncated stream).
  const closeTool = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) => {
    if (!state.toolOpen) return
    const entry = toolInputs.get(state.toolOpen)
    controller.enqueue({ type: "tool-input-end", id: state.toolOpen })
    if (entry) controller.enqueue({ type: "tool-call", toolCallId: state.toolOpen, toolName: entry.name, input: entry.input })
    state.toolOpen = ""
  }

  return new TransformStream<KiroEvent, LanguageModelV3StreamPart>({
    transform(event, controller) {
      ensureStarted(controller)
      switch (event.type) {
        case "reasoning": {
          closeText(controller)
          closeTool(controller)
          if (!state.reasoning) {
            state.reasoning = `reasoning-${state.seq++}`
            controller.enqueue({ type: "reasoning-start", id: state.reasoning })
          }
          if (event.payload.signature) state.signature = event.payload.signature
          if (event.payload.text) controller.enqueue({ type: "reasoning-delta", id: state.reasoning, delta: event.payload.text })
          return
        }
        case "content": {
          closeReasoning(controller)
          closeTool(controller)
          if (!state.text) {
            state.text = `txt-${state.seq++}`
            controller.enqueue({ type: "text-start", id: state.text })
          }
          controller.enqueue({ type: "text-delta", id: state.text, delta: event.payload.content })
          return
        }
        case "tool_start": {
          closeReasoning(controller)
          closeText(controller)
          closeTool(controller)
          state.tool = event.payload.toolUseId
          state.toolOpen = event.payload.toolUseId
          toolInputs.set(event.payload.toolUseId, { name: event.payload.name, input: event.payload.input ?? "" })
          controller.enqueue({ type: "tool-input-start", id: event.payload.toolUseId, toolName: event.payload.name })
          if (event.payload.input)
            controller.enqueue({ type: "tool-input-delta", id: event.payload.toolUseId, delta: event.payload.input })
          return
        }
        case "tool_input": {
          const entry = toolInputs.get(state.tool)
          if (!entry) return
          entry.input += event.payload.input
          controller.enqueue({ type: "tool-input-delta", id: state.tool, delta: event.payload.input })
          return
        }
        case "tool_stop": {
          const entry = toolInputs.get(state.tool)
          if (!entry) return
          controller.enqueue({ type: "tool-input-end", id: state.tool })
          controller.enqueue({ type: "tool-call", toolCallId: state.tool, toolName: entry.name, input: entry.input })
          state.toolOpen = ""
          return
        }
        case "usage": {
          if (event.payload.inputTokens !== undefined) usage.inputTokens.total = event.payload.inputTokens
          if (event.payload.outputTokens !== undefined) usage.outputTokens.total = event.payload.outputTokens
          return
        }
        case "context_usage": {
          const pct = event.payload.contextUsagePercentage ?? event.payload.contextTokens ?? 0
          if (!usage.inputTokens.total) usage.inputTokens.total = Math.round((pct / 100) * context)
          usage.outputTokens.total = usage.outputTokens.total || 1
          return
        }
        case "error": {
          state.errored = true
          controller.enqueue({ type: "error", error: event.payload.message })
          return
        }
      }
    },
    flush(controller) {
      ensureStarted(controller)
      closeReasoning(controller)
      closeText(controller)
      closeTool(controller)
      const finishReason: LanguageModelV3FinishReason = {
        unified: state.errored ? "error" : toolInputs.size > 0 ? "tool-calls" : "stop",
        raw: undefined,
      }
      controller.enqueue({ type: "finish", finishReason, usage })
    },
  })
}

// ---------------------------------------------------------------------------
// language model
// ---------------------------------------------------------------------------

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

interface KiroModelConfig {
  provider: string
  apiKey?: string
  region?: string
  context?: number
  fetch?: typeof globalThis.fetch
}

export class KiroLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: KiroModelConfig
  private readonly conversationId = crypto.randomUUID()

  constructor(modelId: string, config: KiroModelConfig) {
    this.modelId = modelId
    this.config = config
    this.provider = config.provider
  }

  private effortFrom(options: LanguageModelV3CallOptions): string | undefined {
    const raw = options.providerOptions?.["kiro"]?.["effort"]
    if (typeof raw === "string" && VALID_EFFORTS.has(raw)) return raw
    return undefined
  }

  private buildBody(state: unknown, effort: string | undefined): string {
    const body: Record<string, unknown> = { conversationState: state }
    // Reasoning effort — same wire shape Kiro CLI uses (output_config.effort).
    if (effort) body["additionalModelRequestFields"] = { output_config: { effort } }
    return JSON.stringify(body)
  }

  private async callApi(token: string, body: string): Promise<Response> {
    const region = this.config.region ?? (await getApiRegion(token))
    const endpoint = `https://q.${validateRegion(region)}.amazonaws.com/`
    return (this.config.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
      },
      body,
    })
  }

  private buildState(options: LanguageModelV3CallOptions) {
    const tools = options.tools
      ?.filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function")
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    return translate({
      prompt: options.prompt as unknown as AnyMessage[],
      modelId: this.modelId,
      conversationId: this.conversationId,
      tools,
    })
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const token = await getToken(this.config.apiKey)
    if (!token) throw new KiroAuthError({ message: "No Kiro auth token available" })
    const effort = this.effortFrom(options)
    const state = this.buildState(options)
    const body = this.buildBody(state, effort)
    const response = await this.callApi(token, body)
    if (!response.ok) throw new KiroApiError({ status: response.status, body: await response.text() })
    if (!response.body) throw new KiroStreamError({ message: "Response body is null" })
    const source = new ReadableStream<KiroEvent>({
      async start(controller) {
        try {
          for await (const event of decodeEventStream(response.body!)) controller.enqueue(event)
          controller.close()
        } catch (e) {
          controller.error(e)
        }
      },
    })
    return {
      stream: source.pipeThrough(makeTransform(this.config.context ?? 2e5)),
      request: { body },
      response: { headers: Object.fromEntries(response.headers.entries()) },
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options)
    const content: LanguageModelV3Content[] = []
    const textParts: string[] = []
    const reasoningParts: string[] = []
    let reasoningMeta: SharedV3ProviderMetadata | undefined
    const toolInputs = new Map<string, { name: string; input: string }>()
    let usage: LanguageModelV3Usage = {
      inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: undefined, reasoning: undefined },
    }
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined }
    const flushReasoning = () => {
      if (reasoningParts.length) {
        content.push({ type: "reasoning", text: reasoningParts.join(""), ...(reasoningMeta ? { providerMetadata: reasoningMeta } : {}) })
        reasoningParts.length = 0
      }
      // Reset so a later signed reasoning block can't inherit a prior block's metadata.
      reasoningMeta = undefined
    }
    const flushText = () => {
      if (textParts.length) {
        content.push({ type: "text", text: textParts.join("") })
        textParts.length = 0
      }
    }
    const reader = result.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      switch (value.type) {
        case "reasoning-delta":
          reasoningParts.push(value.delta)
          break
        case "reasoning-end":
          reasoningMeta = value.providerMetadata
          flushReasoning()
          break
        case "text-delta":
          flushReasoning()
          textParts.push(value.delta)
          break
        case "tool-input-start":
          flushReasoning()
          flushText()
          toolInputs.set(value.id, { name: value.toolName, input: "" })
          break
        case "tool-input-delta": {
          const tool = toolInputs.get(value.id)
          if (tool) tool.input += value.delta
          break
        }
        case "tool-call": {
          const tool = toolInputs.get(value.toolCallId)
          if (tool) content.push({ type: "tool-call", toolCallId: value.toolCallId, toolName: tool.name, input: tool.input })
          break
        }
        case "finish":
          usage = value.usage
          finishReason = value.finishReason
          break
      }
    }
    flushReasoning()
    flushText()
    return {
      content,
      finishReason,
      usage,
      warnings: [],
      request: result.request,
      response: { headers: result.response?.headers },
    }
  }
}

// ---------------------------------------------------------------------------
// provider factory
// ---------------------------------------------------------------------------

export interface KiroProviderSettings {
  /** API key (e.g. a `ksk_` key) used directly as the bearer token. */
  apiKey?: string
  /** Force a region instead of auto-detecting. */
  region?: string
  /** Token-window size used for context-usage estimation. */
  context?: number
  /** Custom fetch (used by opencode's request wrapper for timeouts/telemetry). */
  fetch?: typeof globalThis.fetch
}

export interface KiroProvider {
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createKiro(settings: KiroProviderSettings = {}): KiroProvider {
  const provider: any = (modelId: string) =>
    new KiroLanguageModel(modelId, {
      provider: "kiro",
      apiKey: settings.apiKey,
      region: settings.region,
      context: settings.context,
      fetch: settings.fetch,
    })
  provider.languageModel = provider
  return provider as KiroProvider
}
