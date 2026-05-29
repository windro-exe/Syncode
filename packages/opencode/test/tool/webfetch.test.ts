import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool, extractRelevantSections } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("returns only objective-relevant sections when objective is set", () =>
    withFetch(
      () =>
        new Response(
          [
            "# Project README",
            "",
            "## Installation",
            "Run npm install. Then start the server.",
            "",
            "## Authentication",
            "We use OAuth2 with PKCE for authentication. Tokens expire in 1 hour.",
            "Refresh tokens last 30 days.",
            "",
            "## Deployment",
            "Deploy to AWS using Terraform. Run terraform apply in production.",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({
            url: new URL("/readme.md", url).toString(),
            format: "markdown",
            objective: "how does authentication and tokens work",
          })
          expect(result.output).toContain("OAuth2")
          expect(result.output).toContain("Tokens expire")
          expect(result.output).not.toContain("Terraform")
          expect(result.metadata).toMatchObject({ objective: "how does authentication and tokens work" })
        }),
    ),
  )
})

describe("extractRelevantSections", () => {
  const md = [
    "# Title",
    "",
    "## Alpha",
    "alpha is about cats and dogs",
    "",
    "## Beta",
    "beta talks about birds and birds and more birds",
    "",
    "## Gamma",
    "gamma covers reptiles and amphibians",
  ].join("\n")

  test("ranks sections by objective token frequency", () => {
    const result = extractRelevantSections(md, "tell me about birds", 10_000)
    expect(result.kept).toBe(1)
    expect(result.output).toContain("## Beta")
    expect(result.output).not.toContain("alpha is about")
  })

  test("falls back to a flat slice when no section matches", () => {
    const result = extractRelevantSections(md, "submarines and torpedoes", 10_000)
    expect(result.kept).toBe(0)
    expect(result.output).toContain("no sections matched")
  })

  test("respects maxChars budget", () => {
    const long = Array.from({ length: 50 }, (_, i) => `## section${i}\n` + "birds ".repeat(200)).join("\n\n")
    const result = extractRelevantSections(long, "birds", 5000)
    expect(result.output.length).toBeLessThanOrEqual(5_500)
  })

  test("ignores stopword-only objectives", () => {
    const result = extractRelevantSections(md, "the and is", 10_000)
    expect(result.kept).toBe(0)
    expect(result.total).toBe(0)
  })
})
