import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const DEFAULT_MAX_CHARS = 50_000
const HARD_MAX_CHARS = 100_000

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
  objective: Schema.optional(Schema.String).annotate({
    description:
      "Optional natural-language goal. When set, only sections most relevant to the objective are returned (lexical scoring across markdown headings/paragraphs). Use this to dig into a long page without dumping irrelevant content into context.",
  }),
  maxChars: Schema.optional(Schema.Number).annotate({
    description:
      "Optional cap on returned characters after extraction (default 50000, hard max 100000). Lower values force tighter focus when an objective is set.",
  }),
})

export type FetchedPage =
  | { kind: "text"; content: string; title: string; mime: string }
  | { kind: "image"; mime: string; base64: string; title: string }
  | { kind: "error"; error: string; title: string }

interface Metadata {
  objective?: string
  sections_kept?: number
  sections_total?: number
  truncated?: boolean
  outputPath?: string
}

const browserHeaders = (acceptHeader: string) => ({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  Accept: acceptHeader,
  "Accept-Language": "en-US,en;q=0.9",
})

function acceptFor(format: "text" | "markdown" | "html") {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

export const fetchPage = (
  http: HttpClient.HttpClient,
  url: string,
  format: "text" | "markdown" | "html",
  timeoutMs: number,
): Effect.Effect<FetchedPage> =>
  Effect.gen(function* () {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { kind: "error" as const, error: "URL must start with http:// or https://", title: url }
    }

    const httpOk = HttpClient.filterStatusOk(http)
    const headers = browserHeaders(acceptFor(format))
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))

    const response = yield* httpOk.execute(request).pipe(
      Effect.catchIf(
        (err) =>
          err.reason._tag === "StatusCodeError" &&
          err.reason.response.status === 403 &&
          err.reason.response.headers["cf-mitigated"] === "challenge",
        () =>
          httpOk.execute(
            HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" })),
          ),
      ),
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.die(new Error("Request timed out")) }),
    )

    const contentLength = response.headers["content-length"]
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return { kind: "error" as const, error: "Response too large (exceeds 5MB limit)", title: url }
    }

    const arrayBuffer = yield* response.arrayBuffer
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      return { kind: "error" as const, error: "Response too large (exceeds 5MB limit)", title: url }
    }

    const contentType = response.headers["content-type"] || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
    const title = `${url} (${contentType})`

    if (isImageAttachment(mime)) {
      return {
        kind: "image" as const,
        mime,
        base64: Buffer.from(arrayBuffer).toString("base64"),
        title,
      }
    }

    const raw = new TextDecoder().decode(arrayBuffer)
    const isHtml = contentType.includes("text/html")

    let content = raw
    if (format === "markdown" && isHtml) content = convertHTMLToMarkdown(raw)
    else if (format === "text" && isHtml) content = extractTextFromHTML(raw)

    return { kind: "text" as const, content, title, mime }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed<FetchedPage>({ kind: "error", error: String(cause).slice(0, 500), title: url }),
    ),
  )

export const WebFetchTool = Tool.define<typeof Parameters, Metadata, HttpClient.HttpClient>(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
              objective: params.objective,
              maxChars: params.maxChars,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)
          const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS)
          const format = params.format ?? "markdown"
          const fetched = yield* fetchPage(http, params.url, format, timeout)

          if (fetched.kind === "error") {
            throw new Error(fetched.error)
          }

          if (fetched.kind === "image") {
            return {
              title: fetched.title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime: fetched.mime,
                  url: `data:${fetched.mime};base64,${fetched.base64}`,
                },
              ],
            }
          }

          const objective = params.objective?.trim()
          if (!objective || format === "html") {
            const sliced = fetched.content.length > maxChars ? fetched.content.slice(0, maxChars) : fetched.content
            return { output: sliced, title: fetched.title, metadata: {} }
          }

          const focused = extractRelevantSections(fetched.content, objective, maxChars)
          return {
            output: focused.output,
            title: fetched.title,
            metadata: { objective, sections_kept: focused.kept, sections_total: focused.total },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

// Common English stopwords stripped before scoring so "what is the architecture
// of X" doesn't reward sections heavy on "the" and "is".
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "had", "has", "have", "he",
  "her", "his", "how", "i", "if", "in", "is", "it", "its", "of", "on", "or", "she", "so", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "you", "your", "about", "into",
])

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

interface Section {
  heading: string
  body: string
  score: number
}

// Split markdown by ATX headings (# / ## / ### / ...). Pre-heading content
// becomes an implicit "(intro)" section. Each section's score is the count of
// objective tokens appearing in heading+body (multiplicity counts — long
// matching sections rank higher than short ones with the same vocabulary).
function splitMarkdownSections(md: string): { heading: string; body: string }[] {
  const lines = md.split("\n")
  const sections: { heading: string; body: string }[] = []
  let currentHeading = "(intro)"
  let buffer: string[] = []

  const flush = () => {
    const body = buffer.join("\n").trim()
    if (body.length > 0 || sections.length === 0) sections.push({ heading: currentHeading, body })
    buffer = []
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (headingMatch) {
      flush()
      currentHeading = headingMatch[2]!.trim()
    } else {
      buffer.push(line)
    }
  }
  flush()

  return sections.filter((s) => s.body.length > 0 || s.heading !== "(intro)")
}

export function extractRelevantSections(
  content: string,
  objective: string,
  maxChars: number,
): { output: string; kept: number; total: number } {
  const objectiveTokens = new Set(tokenize(objective))
  if (objectiveTokens.size === 0) {
    return {
      output: content.length > maxChars ? content.slice(0, maxChars) : content,
      kept: 0,
      total: 0,
    }
  }

  const rawSections = splitMarkdownSections(content)

  // Fallback: page has no headings at all. Score paragraphs instead so we
  // don't degrade to a flat slice.
  const sections: Section[] =
    rawSections.length > 1
      ? rawSections.map((s) => ({
          ...s,
          score: scoreText(s.heading + "\n" + s.body, objectiveTokens),
        }))
      : content
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter((p) => p.length > 40)
          .map((body, i) => ({
            heading: `paragraph ${i + 1}`,
            body,
            score: scoreText(body, objectiveTokens),
          }))

  const total = sections.length
  if (total === 0) {
    return { output: content.length > maxChars ? content.slice(0, maxChars) : content, kept: 0, total: 0 }
  }

  const matching = sections.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
  if (matching.length === 0) {
    const sliced = content.length > maxChars ? content.slice(0, maxChars) : content
    return {
      output: `[no sections matched objective; returning first ${sliced.length} chars]\n\n${sliced}`,
      kept: 0,
      total,
    }
  }

  const header = `[objective-extracted: ${matching.length}/${total} sections matched, sorted by relevance]\n\n`
  const reserve = header.length
  let used = reserve
  const kept: typeof matching = []
  for (const s of matching) {
    const piece = `## ${s.heading}\n\n${s.body}\n\n`
    if (used + piece.length > maxChars) {
      // Try a truncated version if there's meaningful budget left.
      const remaining = maxChars - used
      if (remaining > 500) {
        kept.push({ ...s, body: s.body.slice(0, remaining - s.heading.length - 80) + "\n…[truncated]" })
      }
      break
    }
    kept.push(s)
    used += piece.length
  }

  const body = kept.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n")
  return { output: header + body, kept: kept.length, total }
}

function scoreText(text: string, objectiveTokens: Set<string>): number {
  let score = 0
  for (const tok of tokenize(text)) {
    if (objectiveTokens.has(tok)) score++
  }
  return score
}
