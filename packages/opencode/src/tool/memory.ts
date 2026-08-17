import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "@/memory/memory"

const Scope = Schema.Literals(["global", "session"]).annotate({
  description: "Memory scope. global = persists across every session. session = only this session.",
})

export const Parameters = Schema.Struct({
  command: Schema.Literals(["view", "create", "str_replace", "insert", "delete", "rename", "search"]).annotate({
    description: "The memory operation to perform.",
  }),
  scope: Schema.optional(Scope),
  path: Schema.optional(
    Schema.String.annotate({
      description: "Path inside the memory directory, e.g. /memories/notes.md. Required for all commands except search.",
    }),
  ),
  content: Schema.optional(Schema.String.annotate({ description: "Initial file contents (used by create)." })),
  title: Schema.optional(Schema.String.annotate({ description: "Optional title shown in the memory index." })),
  tags: Schema.optional(Schema.Array(Schema.String).annotate({ description: "Optional tags for categorization." })),
  view_range: Schema.optional(
    Schema.Tuple([Schema.Number, Schema.Number]).annotate({
      description: "Optional [start_line, end_line] (1-indexed, inclusive) for partial views.",
    }),
  ),
  old_str: Schema.optional(Schema.String.annotate({ description: "Used by str_replace: text to find." })),
  new_str: Schema.optional(Schema.String.annotate({ description: "Used by str_replace: replacement text." })),
  insert_line: Schema.optional(
    Schema.Number.annotate({ description: "Used by insert: line number to insert before (0 = before line 1)." }),
  ),
  insert_text: Schema.optional(Schema.String.annotate({ description: "Used by insert: text to insert." })),
  old_path: Schema.optional(Schema.String.annotate({ description: "Used by rename: source path." })),
  new_path: Schema.optional(Schema.String.annotate({ description: "Used by rename: destination path." })),
  query: Schema.optional(Schema.String.annotate({ description: "Used by search: free-text query." })),
  limit: Schema.optional(Schema.Number.annotate({ description: "Used by search: max results (default 8)." })),
})

type Metadata = {
  command: string
  scope?: "global" | "session"
  path?: string
}

function need<T>(value: T | undefined, name: string, command: string) {
  if (value === undefined || value === null) {
    return Effect.fail(
      new Memory.MemoryError({ message: `\`${name}\` is required for command \`${command}\`.` }),
    )
  }
  return Effect.succeed(value)
}

function fmtListing(label: string, listing: Memory.ListEntry[]) {
  if (listing.length === 0) return `${label}: (empty)`
  const lines = listing.map(
    (e) =>
      `  ${e.pinned ? "★" : " "} ${e.path}${e.title ? ` — ${e.title}` : ""}  [${e.tags.join(",")}]  (${e.bytes}B, accessed ${new Date(e.timeAccessed).toISOString().slice(0, 10)} ×${e.accessCount})`,
  )
  return `${label}:\n${lines.join("\n")}`
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const command = params.command
          const ctxScope = { sessionID: ctx.sessionID }
          if (command === "search") {
            const query = yield* need(params.query, "query", command)
            const results = yield* memory.search({
              query,
              scope: params.scope,
              limit: params.limit,
              ctx: ctxScope,
            })
            const body =
              results.length === 0
                ? "(no matches)"
                : results
                    .map(
                      (r) =>
                        `[${r.entry.scope}] ${r.entry.path} — score=${r.score.toFixed(3)} bm25=${r.bm25.toFixed(3)}\n${r.entry.title ? `  title: ${r.entry.title}\n` : ""}  preview: ${r.entry.content.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 200)}`,
                    )
                    .join("\n\n")
            return {
              title: `${results.length} match${results.length === 1 ? "" : "es"}`,
              output: body,
              metadata: { command } as Metadata,
            }
          }

          const scope = yield* need(params.scope, "scope", command)

          if (command === "view") {
            const path = params.path ?? "/memories"
            const range: [number, number] | undefined = params.view_range
              ? [params.view_range[0], params.view_range[1]]
              : undefined
            const result = yield* memory.view({
              scope,
              path,
              range,
              ctx: ctxScope,
            })
            if (result.isDirectory) {
              const out = fmtListing(`Listing under ${path} (${scope})`, result.listing!)
              return {
                title: `${result.listing!.length} entries`,
                output: out,
                metadata: { command, scope, path } as Metadata,
              }
            }
            const e = result.entry!
            const lines = e.content.split(/\r?\n/)
            const start = params.view_range?.[0] ?? 1
            const numbered = lines
              .map((line, i) => `${String(start + i).padStart(6, " ")}\t${line}`)
              .join("\n")
            const header = `Here's the content of ${e.path} with line numbers:`
            return {
              title: e.path,
              output: `${header}\n${numbered}`,
              metadata: { command, scope, path: e.path } as Metadata,
            }
          }

          if (command === "create") {
            const path = yield* need(params.path, "path", command)
            const content = yield* need(params.content, "content", command)
            const entry = yield* memory.create({
              scope,
              path,
              content,
              title: params.title,
              tags: params.tags ? Array.from(params.tags) : undefined,
              ctx: ctxScope,
            })
            return {
              title: `created ${entry.path}`,
              output: `File created successfully at: ${entry.path}`,
              metadata: { command, scope, path: entry.path } as Metadata,
            }
          }

          if (command === "str_replace") {
            const path = yield* need(params.path, "path", command)
            const oldStr = yield* need(params.old_str, "old_str", command)
            const newStr = yield* need(params.new_str, "new_str", command)
            yield* memory.strReplace({ scope, path, oldStr, newStr, ctx: ctxScope })
            return {
              title: `edited ${path}`,
              output: "The memory file has been edited.",
              metadata: { command, scope, path } as Metadata,
            }
          }

          if (command === "insert") {
            const path = yield* need(params.path, "path", command)
            const line = yield* need(params.insert_line, "insert_line", command)
            const text = yield* need(params.insert_text, "insert_text", command)
            yield* memory.insert({ scope, path, line, text, ctx: ctxScope })
            return {
              title: `edited ${path}`,
              output: `The file ${path} has been edited.`,
              metadata: { command, scope, path } as Metadata,
            }
          }

          if (command === "delete") {
            const path = yield* need(params.path, "path", command)
            yield* memory.remove({ scope, path, ctx: ctxScope })
            return {
              title: `deleted ${path}`,
              output: `Successfully deleted ${path}`,
              metadata: { command, scope, path } as Metadata,
            }
          }

          if (command === "rename") {
            const oldPath = yield* need(params.old_path, "old_path", command)
            const newPath = yield* need(params.new_path, "new_path", command)
            const entry = yield* memory.rename({ scope, oldPath, newPath, ctx: ctxScope })
            return {
              title: `renamed to ${entry.path}`,
              output: `Successfully renamed ${oldPath} to ${newPath}`,
              metadata: { command, scope, path: entry.path } as Metadata,
            }
          }

          return yield* Effect.fail(
            new Memory.MemoryError({ message: `Unknown command: ${command satisfies never}` }),
          )
        }).pipe(
          Effect.catchTag("MemoryError", (err) =>
            Effect.succeed({
              title: "memory error",
              output: err.message,
              metadata: { command: params.command } as Metadata,
            }),
          ),
        ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
