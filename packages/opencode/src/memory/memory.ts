import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Database } from "@/storage/db"
import { Identifier } from "@/id/id"
import { SessionID } from "@/session/schema"
import { MemoryEntryTable, type MemoryScope } from "./memory.sql"
import { score, normalizeBm25 } from "./scoring"
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { createHash } from "node:crypto"

const MEMORY_ROOT = "/memories"
const MAX_CONTENT_BYTES = 64 * 1024
const MAX_VIEW_LINES = 4_000

// Forgetting (Phase 3): only genuinely-dead entries are ever evicted — old,
// never-retrieved, low-importance, unpinned, non-procedural, and never a
// structural seed file. Conservative on purpose; hard delete is irreversible.
const FORGET_MIN_AGE_DAYS = 30
const FORGET_IMPORTANCE_MAX = 8
const PROTECTED_PATHS = new Set([
  "/memories/agent.md",
  "/memories/system.md",
  "/memories/_plan.md",
  "/memories/evicted-context.md",
])

// Auto-recall only fires when the turn has real lexical content. These common
// words are ignored so "ok" / "yes" / "continue" / "is this right?" don't pull
// random memories into context.
const RECALL_STOPWORDS = new Set(
  (
    "the a an is are was were be been being do does did doing have has had to of in on for and or but with as at by from " +
    "this that these those it its i you we they he she me my your our their what why how when where who which can could " +
    "would should will just ok okay yes no sure please thanks thank continue go now then so if not do dont let lets"
  ).split(" "),
)

// Stable hash of an entry's content, for exact-duplicate detection (Phase 1).
export function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex")
}

export const Scope = Schema.Literals(["global", "session"]).annotate({ identifier: "MemoryScope" })

export const Entry = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  sessionID: Schema.optional(SessionID),
  path: Schema.String,
  title: Schema.optional(Schema.String),
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  accessCount: Schema.Number,
  timeAccessed: Schema.Number,
  importance: Schema.Number,
  reinforcement: Schema.Number,
  lastReinforced: Schema.Number,
  contentHash: Schema.optional(Schema.String),
  kind: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "MemoryEntry" })
export type Entry = Schema.Schema.Type<typeof Entry>

export const SearchResult = Schema.Struct({
  entry: Entry,
  score: Schema.Number,
  bm25: Schema.Number,
  snippet: Schema.optional(Schema.String),
}).annotate({ identifier: "MemorySearchResult" })
export type SearchResult = Schema.Schema.Type<typeof SearchResult>

export const Event = {
  Created: BusEvent.define("memory.created", Entry),
  Updated: BusEvent.define("memory.updated", Entry),
  Deleted: BusEvent.define(
    "memory.deleted",
    Schema.Struct({ scope: Scope, sessionID: Schema.optional(SessionID), path: Schema.String }),
  ),
}

export class MemoryError extends Schema.TaggedErrorClass<MemoryError>()("MemoryError", {
  message: Schema.String,
}) {}

export interface ResolvedPath {
  scope: MemoryScope
  path: string
}

export function normalizePath(input: string): Effect.Effect<string, MemoryError> {
  return Effect.suspend(() => {
    let p = input.trim()
    if (!p.startsWith("/")) p = `/${p}`
    if (!p.startsWith(MEMORY_ROOT)) {
      if (p === "/" || p === "") p = MEMORY_ROOT
      else p = path.posix.join(MEMORY_ROOT, p.slice(1))
    }
    const normalized = path.posix.normalize(p)
    if (!normalized.startsWith(MEMORY_ROOT)) {
      return Effect.fail(new MemoryError({ message: `Path must be inside ${MEMORY_ROOT}` }))
    }
    if (normalized.includes("..")) {
      return Effect.fail(new MemoryError({ message: "Path traversal is not allowed" }))
    }
    return Effect.succeed(normalized)
  })
}

export interface ScopeContext {
  sessionID?: SessionID
}

export interface Interface {
  readonly create: (input: {
    scope: MemoryScope
    path: string
    content: string
    title?: string
    tags?: string[]
    ctx: ScopeContext
  }) => Effect.Effect<Entry, MemoryError>
  readonly view: (input: {
    scope: MemoryScope
    path: string
    range?: [number, number]
    ctx: ScopeContext
  }) => Effect.Effect<{ entry?: Entry; listing?: ListEntry[]; isDirectory: boolean }, MemoryError>
  readonly strReplace: (input: {
    scope: MemoryScope
    path: string
    oldStr: string
    newStr: string
    ctx: ScopeContext
  }) => Effect.Effect<Entry, MemoryError>
  readonly insert: (input: {
    scope: MemoryScope
    path: string
    line: number
    text: string
    ctx: ScopeContext
  }) => Effect.Effect<Entry, MemoryError>
  readonly remove: (input: { scope: MemoryScope; path: string; ctx: ScopeContext }) => Effect.Effect<void, MemoryError>
  readonly rename: (input: {
    scope: MemoryScope
    oldPath: string
    newPath: string
    ctx: ScopeContext
  }) => Effect.Effect<Entry, MemoryError>
  readonly search: (input: {
    query: string
    scope?: MemoryScope
    limit?: number
    reinforce?: boolean
    matchMode?: "any" | "all"
    ctx: ScopeContext
  }) => Effect.Effect<SearchResult[]>
  readonly recall: (input: {
    query: string
    ctx: ScopeContext
    limit?: number
    skipPaths?: string[]
  }) => Effect.Effect<string | undefined>
  readonly index: (input: { ctx: ScopeContext }) => Effect.Effect<{ global: ListEntry[]; session: ListEntry[] }>
  readonly touch: (input: {
    scope: MemoryScope
    path: string
    ctx: ScopeContext
  }) => Effect.Effect<void, MemoryError>
  readonly forget: (input: {
    scope: MemoryScope
    ctx: ScopeContext
    minAgeDays?: number
    now?: number
  }) => Effect.Effect<number>
}

export interface ListEntry {
  scope: MemoryScope
  path: string
  title?: string
  tags: string[]
  pinned: boolean
  accessCount: number
  timeAccessed: number
  timeUpdated: number
  bytes: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function row2entry(row: typeof MemoryEntryTable.$inferSelect): Entry {
  return {
    id: row.id,
    scope: row.scope,
    sessionID: row.session_id ?? undefined,
    path: row.path,
    title: row.title ?? undefined,
    content: row.content,
    tags: parseTags(row.tags),
    pinned: !!row.pinned,
    accessCount: row.access_count,
    timeAccessed: row.time_accessed,
    importance: row.importance,
    reinforcement: row.reinforcement,
    lastReinforced: row.last_reinforced,
    contentHash: row.content_hash ?? undefined,
    kind: row.kind,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

function row2list(row: typeof MemoryEntryTable.$inferSelect): ListEntry {
  return {
    scope: row.scope,
    path: row.path,
    title: row.title ?? undefined,
    tags: parseTags(row.tags),
    pinned: !!row.pinned,
    accessCount: row.access_count,
    timeAccessed: row.time_accessed,
    timeUpdated: row.time_updated,
    bytes: Buffer.byteLength(row.content, "utf8"),
  }
}

function scopePred(scope: MemoryScope, sessionID?: SessionID) {
  return scope === "session" && sessionID
    ? and(eq(MemoryEntryTable.scope, scope), eq(MemoryEntryTable.session_id, sessionID))
    : and(eq(MemoryEntryTable.scope, scope), isNull(MemoryEntryTable.session_id))
}

function requireSession(scope: MemoryScope, ctx: ScopeContext): Effect.Effect<SessionID | undefined, MemoryError> {
  if (scope === "session") {
    if (!ctx.sessionID)
      return Effect.fail(new MemoryError({ message: "Session memory requires an active session" }))
    return Effect.succeed(ctx.sessionID)
  }
  return Effect.succeed(undefined)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    // Map any thrown SQLite/storage error into a typed MemoryError so it surfaces
    // as a normal tool failure (e.g. a UNIQUE violation, a locked db) instead of
    // escaping as an uncaught Effect defect that crashes the tool.
    const tryDb = <A>(thunk: () => A) =>
      Effect.try({
        try: thunk,
        catch: (e) =>
          new MemoryError({ message: `memory storage error: ${e instanceof Error ? e.message : String(e)}` }),
      })

    function fetchOne(scope: MemoryScope, p: string, sessionID?: SessionID) {
      return tryDb(() =>
        Database.use((db) =>
          db
            .select()
            .from(MemoryEntryTable)
            .where(and(scopePred(scope, sessionID), eq(MemoryEntryTable.path, p)))
            .get(),
        ),
      )
    }

    const create: Interface["create"] = Effect.fn("Memory.create")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const p = yield* normalizePath(input.path)
      if (Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BYTES) {
        yield* Effect.fail(new MemoryError({ message: `Content exceeds ${MAX_CONTENT_BYTES} bytes` }))
      }
      const existing = yield* fetchOne(input.scope, p, sessionID)
      if (existing) yield* Effect.fail(new MemoryError({ message: `Memory ${p} already exists` }))
      const now = Date.now()
      const id = Identifier.ascending("memory")
      yield* tryDb(() =>
        Database.transaction((db) => {
          db.insert(MemoryEntryTable)
            .values({
              id,
              scope: input.scope,
              session_id: sessionID ?? null,
              path: p,
              title: input.title ?? null,
              content: input.content,
              tags: input.tags ?? [],
              pinned: false,
              access_count: 0,
              time_accessed: now,
              content_hash: hashContent(input.content),
              last_reinforced: now,
              time_created: now,
              time_updated: now,
            })
            .run()
        }),
      )
      const row = yield* fetchOne(input.scope, p, sessionID)
      const entry = row2entry(row!)
      yield* bus.publish(Event.Created, entry)
      return entry
    })

    const view: Interface["view"] = Effect.fn("Memory.view")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const requested = input.path.trim() || MEMORY_ROOT
      const p = yield* normalizePath(requested)
      const exact = yield* fetchOne(input.scope, p, sessionID)
      if (exact) {
        // Record that the entry was looked at — but ONLY access_count, never
        // time_accessed. access_count no longer feeds ranking (that's
        // reinforcement) nor the index order (that's path), so this can't
        // recreate the old rich-get-richer loop or churn the cache; it exists
        // purely as a "has been touched" signal so forgetting spares anything
        // the user actually reads. Best-effort.
        yield* tryDb(() =>
          Database.transaction((db) => {
            db.update(MemoryEntryTable)
              .set({ access_count: sql`${MemoryEntryTable.access_count} + 1` })
              .where(eq(MemoryEntryTable.id, exact.id))
              .run()
          }),
        ).pipe(Effect.orElseSucceed(() => undefined))
        let entry = row2entry(exact)
        if (input.range) {
          const [start, end] = input.range
          const lines = entry.content.split(/\r?\n/)
          const slice = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end))
          entry = { ...entry, content: slice.join("\n") }
        } else {
          const lineCount = entry.content.split(/\r?\n/).length
          if (lineCount > MAX_VIEW_LINES) {
            yield* Effect.fail(
              new MemoryError({ message: `File ${p} has ${lineCount} lines; use a view_range parameter` }),
            )
          }
        }
        return { entry, isDirectory: false }
      }
      // Treat as directory: list anything under prefix.
      const prefix = p === MEMORY_ROOT ? MEMORY_ROOT : p.replace(/\/$/, "")
      const rows = yield* tryDb(() =>
        Database.use((db) =>
          db
            .select()
            .from(MemoryEntryTable)
            .where(scopePred(input.scope, sessionID))
            .orderBy(desc(MemoryEntryTable.pinned), asc(MemoryEntryTable.path))
            .all(),
        ),
      )
      const filtered = rows.filter((row) => row.path === prefix || row.path.startsWith(prefix + "/"))
      if (filtered.length === 0 && prefix !== MEMORY_ROOT) {
        yield* Effect.fail(new MemoryError({ message: `The path ${p} does not exist.` }))
      }
      return { listing: filtered.map(row2list), isDirectory: true }
    })

    const updateContent = Effect.fn("Memory.updateContent")(function* (
      scope: MemoryScope,
      sessionID: SessionID | undefined,
      p: string,
      mutate: (current: string) => Effect.Effect<string, MemoryError>,
    ) {
      const existing = yield* fetchOne(scope, p, sessionID)
      if (!existing) yield* Effect.fail(new MemoryError({ message: `The path ${p} does not exist.` }))
      const next = yield* mutate(existing!.content)
      if (Buffer.byteLength(next, "utf8") > MAX_CONTENT_BYTES) {
        yield* Effect.fail(new MemoryError({ message: `Content exceeds ${MAX_CONTENT_BYTES} bytes` }))
      }
      yield* tryDb(() =>
        Database.transaction((db) => {
          db.update(MemoryEntryTable)
            .set({ content: next, content_hash: hashContent(next), time_updated: Date.now(), time_accessed: Date.now() })
            .where(eq(MemoryEntryTable.id, existing!.id))
            .run()
        }),
      )
      const row = yield* fetchOne(scope, p, sessionID)
      const entry = row2entry(row!)
      yield* bus.publish(Event.Updated, entry)
      return entry
    })

    const strReplace: Interface["strReplace"] = Effect.fn("Memory.strReplace")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const p = yield* normalizePath(input.path)
      return yield* updateContent(input.scope, sessionID, p, (current) => {
        const occurrences = current.split(input.oldStr).length - 1
        if (occurrences === 0) {
          return Effect.fail(
            new MemoryError({
              message: `No replacement was performed, old_str \`${input.oldStr}\` did not appear verbatim in ${p}.`,
            }),
          )
        }
        if (occurrences > 1) {
          return Effect.fail(
            new MemoryError({
              message: `No replacement was performed. Multiple occurrences of old_str in ${p}. Please ensure it is unique.`,
            }),
          )
        }
        return Effect.succeed(current.replace(input.oldStr, input.newStr))
      })
    })

    const insertCmd: Interface["insert"] = Effect.fn("Memory.insert")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const p = yield* normalizePath(input.path)
      return yield* updateContent(input.scope, sessionID, p, (current) => {
        const lines = current.split(/\r?\n/)
        if (input.line < 0 || input.line > lines.length) {
          return Effect.fail(
            new MemoryError({
              message: `Invalid insert_line: ${input.line}. Valid range is [0, ${lines.length}].`,
            }),
          )
        }
        const insertion = input.text.endsWith("\n") ? input.text.slice(0, -1) : input.text
        lines.splice(input.line, 0, insertion)
        return Effect.succeed(lines.join("\n"))
      })
    })

    const remove: Interface["remove"] = Effect.fn("Memory.remove")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const p = yield* normalizePath(input.path)
      const exact = yield* fetchOne(input.scope, p, sessionID)
      if (exact) {
        yield* tryDb(() =>
          Database.transaction((db) => {
            db.delete(MemoryEntryTable).where(eq(MemoryEntryTable.id, exact.id)).run()
          }),
        )
        yield* bus.publish(Event.Deleted, { scope: input.scope, sessionID, path: p })
        return
      }
      // directory delete: nuke everything under prefix
      const prefix = p.replace(/\/$/, "")
      const rows = yield* tryDb(() =>
        Database.use((db) =>
          db.select().from(MemoryEntryTable).where(scopePred(input.scope, sessionID)).all(),
        ),
      )
      const matched = rows.filter((row) => row.path === prefix || row.path.startsWith(prefix + "/"))
      if (matched.length === 0) {
        yield* Effect.fail(new MemoryError({ message: `The path ${p} does not exist.` }))
      }
      yield* tryDb(() =>
        Database.transaction((db) => {
          for (const row of matched) {
            db.delete(MemoryEntryTable).where(eq(MemoryEntryTable.id, row.id)).run()
          }
        }),
      )
      for (const row of matched) {
        yield* bus.publish(Event.Deleted, { scope: input.scope, sessionID, path: row.path })
      }
    })

    const rename: Interface["rename"] = Effect.fn("Memory.rename")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const oldP = yield* normalizePath(input.oldPath)
      const newP = yield* normalizePath(input.newPath)
      const existing = yield* fetchOne(input.scope, oldP, sessionID)
      if (!existing) yield* Effect.fail(new MemoryError({ message: `The path ${oldP} does not exist.` }))
      const conflict = yield* fetchOne(input.scope, newP, sessionID)
      if (conflict) yield* Effect.fail(new MemoryError({ message: `The destination ${newP} already exists.` }))
      yield* tryDb(() =>
        Database.transaction((db) => {
          db.update(MemoryEntryTable)
            .set({ path: newP, time_updated: Date.now() })
            .where(eq(MemoryEntryTable.id, existing!.id))
            .run()
        }),
      )
      const row = yield* fetchOne(input.scope, newP, sessionID)
      const entry = row2entry(row!)
      yield* bus.publish(Event.Updated, entry)
      return entry
    })

    const search: Interface["search"] = Effect.fn("Memory.search")(function* (input) {
      const limit = Math.max(1, Math.min(input.limit ?? 8, 50))
      const tokens = input.query
        .replace(/["']/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map((t) => t.replace(/[^\w\-/.]/g, "").trim())
        .filter(Boolean)
      if (tokens.length === 0) return []
      // matchMode: "any" (default) → tokens joined by " OR " — loose lexical
      // recall, suits the explicit memory.search tool's fuzzy-find UX.
      // "all" → space-joined (FTS5 default = AND) — every meaningful token
      // must appear, used by auto-recall to avoid surfacing irrelevant
      // memories on tangentially-related multi-word queries.
      const matchMode = input.matchMode ?? "any"
      const ftsQuery = tokens.map((t) => `${t}*`).join(matchMode === "all" ? " " : " OR ")
      const sessionID = input.ctx.sessionID
      const rows = yield* tryDb(() =>
        Database.use((db) => {
          const stmt = sql`
            SELECT m.*, fts.rank as bm25
            FROM memory_entry_fts fts
            JOIN memory_entry m ON m.rowid = fts.rowid
            WHERE memory_entry_fts MATCH ${ftsQuery}
              ${input.scope ? sql`AND m.scope = ${input.scope}` : sql``}
              ${
                sessionID
                  ? sql`AND (m.session_id IS NULL OR m.session_id = ${sessionID})`
                  : sql`AND m.session_id IS NULL`
              }
            ORDER BY fts.rank
            LIMIT ${limit * 4}
          `
          return db.all<typeof MemoryEntryTable.$inferSelect & { bm25: number }>(stmt)
        }),
      ).pipe(
        // A malformed FTS query or storage hiccup must not crash search — degrade
        // to no results rather than throwing an uncaught defect.
        Effect.orElseSucceed(() => [] as Array<typeof MemoryEntryTable.$inferSelect & { bm25: number }>),
      )
      const now = Date.now()
      const ranked = rows
        .map((row) => {
          const entry = row2entry(row)
          const s = score({
            bm25: row.bm25,
            reinforcedAt: entry.lastReinforced || entry.timeCreated,
            reinforcement: entry.reinforcement,
            importance: entry.importance,
            now,
          })
          return {
            entry,
            score: entry.pinned ? s + 1 : s,
            bm25: normalizeBm25(row.bm25),
          } satisfies SearchResult
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      // Reinforcement: a genuine retrieval (an entry actually returned to the
      // caller) strengthens the memory. This is the ONLY place reinforcement
      // grows — plain views never do, which keeps the signal non-gameable.
      // Automatic recall passes reinforce:false so background surfacing doesn't
      // inflate the signal that forgetting later relies on.
      if (ranked.length > 0 && input.reinforce !== false) {
        const ids = ranked.map((r) => r.entry.id)
        yield* tryDb(() =>
          Database.transaction((db) => {
            for (const id of ids) {
              db.update(MemoryEntryTable)
                .set({ reinforcement: sql`${MemoryEntryTable.reinforcement} + 1`, last_reinforced: now })
                .where(eq(MemoryEntryTable.id, id))
                .run()
            }
          }),
        ).pipe(Effect.orElseSucceed(() => undefined))
      }
      return ranked
    })

    // Automatic, context-driven recall (push, not pull): given the working
    // context, return a ready-to-inject block of the most relevant memories'
    // CONTENT. Lexical (BM25) today; the same seam takes hybrid/semantic later.
    // Does not reinforce (it's background surfacing, not a deliberate use).
    const recall: Interface["recall"] = Effect.fn("Memory.recall")(function* (input) {
      const limit = Math.max(1, Math.min(input.limit ?? 3, 8))
      const skip = new Set(input.skipPaths ?? [])
      // Gate out trivial/stopword-only turns so recall doesn't surface random
      // memories on "ok" / "yes" / "continue". Require at least two meaningful
      // words, and search only those.
      const meaningful = input.query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/[^\w]/g, ""))
        .filter((t) => t.length > 2 && !RECALL_STOPWORDS.has(t))
      if (meaningful.length < 2) return undefined
      const hits = yield* search({
        query: meaningful.join(" "),
        ctx: input.ctx,
        limit: limit * 3,
        reinforce: false,
        // Strict AND: every meaningful word must appear in the matched entry.
        // The explicit search tool keeps the loose default ("any") so users
        // can still fuzzy-find with single keywords; auto-recall doesn't get
        // that luxury because surfacing irrelevant memories every turn is
        // worse than surfacing nothing.
        matchMode: "all",
      })
      // FTS MATCH already filters to entries sharing a query term, and search()
      // ranks them by the composite score; take the top-k. (No absolute BM25
      // floor — BM25 is corpus-scale-dependent and degenerate on tiny stores.)
      const relevant = hits.filter((h) => !skip.has(h.entry.path)).slice(0, limit)
      if (relevant.length === 0) return undefined
      const lines = [
        `<recalled-memory note="Automatically surfaced from your memory; may be relevant to this turn. Not the user's words.">`,
      ]
      for (const h of relevant) {
        const content = h.entry.content.trim()
        const snippet = content.length > 400 ? content.slice(0, 400) + " …" : content
        lines.push(`[${h.entry.scope}] ${h.entry.path}${h.entry.title ? ` — ${h.entry.title}` : ""}`)
        lines.push(`<snippet>${snippet}</snippet>`)
      }
      lines.push("</recalled-memory>")
      return lines.join("\n")
    })

    const index: Interface["index"] = Effect.fn("Memory.index")(function* (input) {
      const rows = yield* tryDb(() =>
        Database.use((db) =>
          db
            .select()
            .from(MemoryEntryTable)
            .where(
              input.ctx.sessionID
                ? sql`(${MemoryEntryTable.session_id} IS NULL OR ${MemoryEntryTable.session_id} = ${input.ctx.sessionID})`
                : isNull(MemoryEntryTable.session_id),
            )
            // Deterministic, access-independent order so the injected index is
            // byte-stable turn-to-turn (keeps the prompt cache prefix intact).
            .orderBy(desc(MemoryEntryTable.pinned), asc(MemoryEntryTable.path))
            .all(),
        ),
      ).pipe(Effect.orElseSucceed(() => [] as Array<typeof MemoryEntryTable.$inferSelect>))
      const global = rows.filter((row) => row.scope === "global").map(row2list)
      const session = rows.filter((row) => row.scope === "session").map(row2list)
      return { global, session }
    })

    const touch: Interface["touch"] = Effect.fn("Memory.touch")(function* (input) {
      const sessionID = yield* requireSession(input.scope, input.ctx)
      const p = yield* normalizePath(input.path)
      const existing = yield* fetchOne(input.scope, p, sessionID)
      if (!existing) return
      yield* tryDb(() =>
        Database.transaction((db) => {
          db.update(MemoryEntryTable)
            .set({
              access_count: sql`${MemoryEntryTable.access_count} + 1`,
              time_accessed: Date.now(),
            })
            .where(eq(MemoryEntryTable.id, existing.id))
            .run()
        }),
      )
    })

    // Real forgetting: hard-delete only genuinely-dead entries. Strong rails —
    // never pinned, never procedural, importance must be low, reinforcement must
    // be exactly zero (never genuinely retrieved), must be older than minAge, and
    // never a protected structural file. Returns how many were evicted.
    const forget: Interface["forget"] = Effect.fn("Memory.forget")(function* (input) {
      const sessionID = input.ctx.sessionID
      const now = input.now ?? Date.now()
      const minAge = (input.minAgeDays ?? FORGET_MIN_AGE_DAYS) * 86_400_000
      const rows = yield* tryDb(() =>
        Database.use((db) => db.select().from(MemoryEntryTable).where(scopePred(input.scope, sessionID)).all()),
      ).pipe(Effect.orElseSucceed(() => [] as Array<typeof MemoryEntryTable.$inferSelect>))
      const victims = rows.filter(
        (r) =>
          !r.pinned &&
          r.kind !== "procedural" &&
          r.importance < FORGET_IMPORTANCE_MAX &&
          r.reinforcement === 0 &&
          // never even looked at — guards facts the user reads via the index/view
          // but never explicitly searches (which is most of them).
          r.access_count === 0 &&
          // age off the most recent of created / edited / reinforced, so an old
          // entry that was edited recently is treated as live, not dead.
          now - Math.max(r.last_reinforced, r.time_updated, r.time_created) > minAge &&
          !PROTECTED_PATHS.has(r.path),
      )
      if (victims.length === 0) return 0
      yield* tryDb(() =>
        Database.transaction((db) => {
          for (const v of victims) db.delete(MemoryEntryTable).where(eq(MemoryEntryTable.id, v.id)).run()
        }),
      ).pipe(Effect.orElseSucceed(() => undefined))
      for (const v of victims)
        yield* bus.publish(Event.Deleted, { scope: v.scope, sessionID: v.session_id ?? undefined, path: v.path })
      return victims.length
    })

    return Service.of({
      create,
      view,
      strReplace,
      insert: insertCmd,
      remove,
      rename,
      search,
      recall,
      index,
      touch,
      forget,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Memory from "./memory"
