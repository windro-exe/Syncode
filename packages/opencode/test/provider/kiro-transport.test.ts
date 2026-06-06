import { describe, expect, test } from "bun:test"
import { createKiro } from "@/provider/kiro"

// Unit tests for the vendored Kiro provider's grafted behavior (effort body
// injection + AI SDK v3 stream contract). Uses a fake fetch so no live AWS Q
// call is made; the reasoning/effort WIRE acceptance still needs a live test.

function emptyEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
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

describe("kiro provider transport", () => {
  test("injects output_config.effort into the request body when effort is set", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { kiro: { effort: "high" } },
    } as any)

    expect(captured.conversationState).toBeDefined()
    expect(captured.additionalModelRequestFields.output_config.effort).toBe("high")
  })

  test("omits additionalModelRequestFields when no effort is set", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any)

    expect(captured.additionalModelRequestFields).toBeUndefined()
  })

  test("ignores an invalid effort value (no body field)", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { kiro: { effort: "bogus" } },
    } as any)

    expect(captured.additionalModelRequestFields).toBeUndefined()
  })

  test("uses the ksk_ key as a bearer token with tokentype: API_KEY", async () => {
    let headers: Headers | undefined
    const fakeFetch = (async (_url: any, init: any) => {
      headers = new Headers(init.headers)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_secret", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any)

    expect(headers!.get("authorization")).toBe("Bearer ksk_secret")
    expect(headers!.get("tokentype")).toBe("API_KEY")
  })

  test("emits a well-formed stream (stream-start … finish) even on an empty response", async () => {
    const fakeFetch = (async () =>
      new Response(emptyEventStream(), { status: 200 })) as unknown as typeof fetch
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as any)
    const parts = await collect(result.stream)
    expect(parts[0]?.type).toBe("stream-start")
    expect(parts[parts.length - 1]?.type).toBe("finish")
    expect(parts[parts.length - 1]?.finishReason?.unified).toBe("stop")
  })

  test("surfaces an API error for a non-ok response", async () => {
    const fakeFetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await expect(
      model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any),
    ).rejects.toThrow(/403/)
  })
})
