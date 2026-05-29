import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import { fetchPage, extractRelevantSections } from "./webfetch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"

const DEFAULT_DEEP_MAX_FETCH = 5
const HARD_DEEP_MAX_FETCH = 10
const DEFAULT_DEEP_CHARS_PER_RESULT = 3_000
const HARD_DEEP_CHARS_PER_RESULT = 8_000
const DEEP_FETCH_TIMEOUT_MS = 15_000

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
  deep: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, parallel-fetch the top results' full pages and inline their relevant sections (objective-scored against the query). Costs more time and bandwidth — use for research tasks where snippets aren't enough.",
  }),
  maxFetch: Schema.optional(Schema.Number).annotate({
    description: "Max pages to deep-fetch when deep=true (default 5, hard max 10).",
  }),
  fetchCharsPerResult: Schema.optional(Schema.Number).annotate({
    description: "Per-page character budget when deep=true (default 3000, hard max 8000).",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

interface Metadata {
  provider: WebSearchProvider
  deep?: boolean
  fetched?: number
  errored?: number
  urls?: string[]
  truncated?: boolean
  outputPath?: string
}

export function selectWebSearchProvider(sessionID: string, flags = { exa: false, parallel: false }): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

// Both providers stream results back as a single text blob inside the MCP
// `content[].text` field with no stable structured schema. Pull URLs out
// preserving order of first appearance, dropping common junk hosts.
const URL_RE = /https?:\/\/[^\s<>"'`)\]\}]+/g
const BLOCKED_HOSTS = new Set([
  "schema.org",
  "www.w3.org",
  "ogp.me",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.google-analytics.com",
])

export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0]
    // Strip trailing punctuation that's almost never part of the URL.
    url = url.replace(/[.,;:!?]+$/, "")
    if (seen.has(url)) continue
    seen.add(url)
    try {
      const u = new URL(url)
      if (BLOCKED_HOSTS.has(u.host)) continue
      // Skip image / asset URLs — they're not useful page content.
      if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf)(\?|$)/i.test(u.pathname)) continue
    } catch {
      continue
    }
    out.push(url)
  }
  return out
}

export const WebSearchTool = Tool.define<typeof Parameters, Metadata, HttpClient.HttpClient | RuntimeFlags.Service>(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
              deep: params.deep,
              maxFetch: params.maxFetch,
              fetchCharsPerResult: params.fetchCharsPerResult,
            },
          })

          const result = yield* callProvider(http, provider, params, ctx)
          const searchText = result ?? "No search results found. Please try a different query."

          if (!params.deep || !result) {
            return {
              output: searchText,
              title: `${title}: ${params.query}`,
              metadata: { provider },
            }
          }

          const maxFetch = Math.min(Math.max(params.maxFetch ?? DEFAULT_DEEP_MAX_FETCH, 1), HARD_DEEP_MAX_FETCH)
          const charsPerResult = Math.min(
            Math.max(params.fetchCharsPerResult ?? DEFAULT_DEEP_CHARS_PER_RESULT, 500),
            HARD_DEEP_CHARS_PER_RESULT,
          )
          const urls = extractUrls(searchText).slice(0, maxFetch)

          if (urls.length === 0) {
            return {
              output:
                searchText +
                "\n\n[deep-fetch: no URLs extractable from search response — returning snippet output only]",
              title: `${title}: ${params.query}`,
              metadata: { provider, deep: true, fetched: 0 },
            }
          }

          const fetched = yield* Effect.all(
            urls.map((url) =>
              fetchPage(http, url, "markdown", DEEP_FETCH_TIMEOUT_MS).pipe(
                Effect.map((page) => ({ url, page })),
              ),
            ),
            { concurrency: "unbounded" },
          )

          const sections: string[] = []
          let okCount = 0
          let errCount = 0
          for (const { url, page } of fetched) {
            if (page.kind === "text") {
              const focused = extractRelevantSections(page.content, params.query, charsPerResult)
              sections.push(`### [${++okCount}] ${url}\n\n${focused.output}`)
            } else if (page.kind === "image") {
              errCount++
              sections.push(`### [skip] ${url}\n\n[image: ${page.mime}]`)
            } else {
              errCount++
              sections.push(`### [error] ${url}\n\n${page.error}`)
            }
          }

          const header =
            `[deep-fetch: ${okCount} fetched, ${errCount} skipped/errored, charsPerResult=${charsPerResult}]\n\n` +
            `## Search snippets\n\n${searchText}\n\n## Page extracts\n\n`

          return {
            output: header + sections.join("\n\n---\n\n"),
            title: `${title}: ${params.query}`,
            metadata: { provider, deep: true, fetched: okCount, errored: errCount, urls },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
