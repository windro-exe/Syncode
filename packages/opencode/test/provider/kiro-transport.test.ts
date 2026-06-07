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
  test("forwards image file parts to userInputMessage.images with the right format + base64 bytes", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    // 1×1 PNG
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89,
    ])
    const expectedB64 = Buffer.from(pngBytes).toString("base64")

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this screenshot?" },
            { type: "file", data: pngBytes, mediaType: "image/png", filename: "clipboard" },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.content).toContain("what is in this screenshot?")
    expect(ui.images).toEqual([{ format: "png", source: { bytes: expectedB64 } }])
  })

  test("forwards PDF file parts to userInputMessage.documents with format and base64 bytes", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]) // %PDF-1.4
    const expectedB64 = Buffer.from(pdfBytes).toString("base64")

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            { type: "file", data: pdfBytes, mediaType: "application/pdf", filename: "spec.pdf" },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.documents).toEqual([{ name: "spec", format: "pdf", source: { bytes: expectedB64 } }])
  })

  test("decodes a data: URL string image part to base64 bytes", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const b64 = Buffer.from([0xff, 0xd8, 0xff]).toString("base64")
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "ok" },
            { type: "file", data: `data:image/jpeg;base64,${b64}`, mediaType: "image/jpeg" },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.images).toEqual([{ format: "jpeg", source: { bytes: b64 } }])
  })

  test("omits images/documents when the user message has none", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.images).toBeUndefined()
    expect(ui.documents).toBeUndefined()
  })

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
