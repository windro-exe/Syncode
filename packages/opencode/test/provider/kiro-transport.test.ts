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
  test("normalizes a mediaType with parameters and whitespace (image/png; charset=utf-8)", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const bytes = new Uint8Array([1, 2, 3])
    const expected = Buffer.from(bytes).toString("base64")
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "file", data: bytes, mediaType: " IMAGE/PNG ; charset=utf-8 " },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.images).toEqual([{ format: "png", source: { bytes: expected } }])
  })

  test("dedupes document names so two unnamed/duplicate filenames don't collide", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const data1 = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const data2 = new Uint8Array([0x25, 0x50, 0x44, 0x47])
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "compare" },
            { type: "file", data: data1, mediaType: "application/pdf", filename: "spec.pdf" },
            { type: "file", data: data2, mediaType: "application/pdf", filename: "spec.pdf" },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    const names = ui.documents.map((d: any) => d.name)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain("spec")
  })

  test("caps images at 20 per message and surfaces a marker for the rest", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const bytes = new Uint8Array([0xff])
    const parts: any[] = [{ type: "text", text: "many" }]
    for (let i = 0; i < 25; i++) parts.push({ type: "file", data: bytes, mediaType: "image/png" })

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({ prompt: [{ role: "user", content: parts }] } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.images.length).toBe(20)
    expect(ui.content).toMatch(/5 additional image attachment.*dropped/i)
  })

  test("rejects garbage strings instead of forwarding them as base64", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "file", data: "not base64 because it has spaces and !@#", mediaType: "image/png" },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    expect(ui.images).toBeUndefined()
    expect(ui.content).toMatch(/unsupported attachment/i)
  })

  test("history user messages also forward image attachments (multi-turn)", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const bytes = new Uint8Array([1, 2, 3, 4])
    const expected = Buffer.from(bytes).toString("base64")
    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this?" },
            { type: "file", data: bytes, mediaType: "image/png" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "a cat" }] },
        { role: "user", content: [{ type: "text", text: "and the previous one?" }] },
      ],
    } as any)

    const history = captured.conversationState.history
    const firstUser = history.find((h: any) => h.userInputMessage)
    expect(firstUser.userInputMessage.images).toEqual([{ format: "png", source: { bytes: expected } }])
  })

  test("surfaces image/file placeholders inside tool result content blocks", async () => {
    let captured: any
    const fakeFetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(emptyEventStream(), { status: 200 })
    }) as unknown as typeof fetch

    const model = createKiro({ apiKey: "ksk_test", region: "us-east-1", fetch: fakeFetch }).languageModel(
      "claude-opus-4.8",
    )
    await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "screenshot" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "t1", toolName: "screenshot", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "screenshot",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "captured" },
                  { type: "image-data", data: "base64here", mediaType: "image/png" },
                  { type: "file-data", data: "x", mediaType: "application/pdf" },
                ],
              },
            },
          ],
        },
      ],
    } as any)

    const ui = captured.conversationState.currentMessage.userInputMessage
    const tr = ui.userInputMessageContext.toolResults[0]
    const text = tr.content.map((c: any) => c.text).join("\n")
    expect(text).toContain("captured")
    expect(text).toContain("[image]")
    expect(text).toContain("[file: application/pdf]")
  })

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
