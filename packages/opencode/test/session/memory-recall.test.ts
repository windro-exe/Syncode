import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Memory } from "@/memory/memory"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Memory.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer)),
)
const it = testEffect(env)

// Each test uses a fresh session and session-scoped entries so they are isolated
// (the global memory store is shared across it.instance cases in one file).
const newSession = Effect.gen(function* () {
  return (yield* (yield* SessionNs.Service).create({})).id
})

describe("memory.recall", () => {
  it.instance("surfaces relevant memory content as an injectable block", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/auth.md",
        title: "Auth",
        content: "JWT tokens are signed with RS256 and rotated weekly.",
        ctx: { sessionID: sid },
      })
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/ui.md",
        title: "UI",
        content: "The dashboard uses a dark theme by default.",
        ctx: { sessionID: sid },
      })
      const block = yield* memory.recall({ query: "how are JWT tokens signed", ctx: { sessionID: sid } })
      expect(block).toBeDefined()
      expect(block).toContain("<recalled-memory")
      expect(block).toContain("RS256")
    }),
  )

  it.instance("returns undefined when nothing is relevant", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/ui.md",
        content: "dark theme",
        ctx: { sessionID: sid },
      })
      const block = yield* memory.recall({ query: "xyzzy nonexistent quantum flux", ctx: { sessionID: sid } })
      expect(block).toBeUndefined()
    }),
  )

  it.instance("respects skipPaths (does not recall already-injected files)", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/agent.md",
        content: "the user prefers terse JWT auth answers",
        ctx: { sessionID: sid },
      })
      const block = yield* memory.recall({
        query: "JWT auth",
        ctx: { sessionID: sid },
        skipPaths: ["/memories/agent.md"],
      })
      expect(block).toBeUndefined()
    }),
  )

  it.instance("treats skipPaths ending with / as prefix matches", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      // Two files under a "councils" directory.
      yield* memory.create({
        scope: "session",
        path: "/memories/councils/cou_aaa.json",
        content: "JWT council brief",
        ctx: { sessionID: sid },
      })
      yield* memory.create({
        scope: "session",
        path: "/memories/councils/cou_bbb.json",
        content: "more JWT discussion",
        ctx: { sessionID: sid },
      })
      // A real memory file the user wants surfaced.
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/auth.md",
        content: "JWT tokens are signed with RS256",
        ctx: { sessionID: sid },
      })
      const block = yield* memory.recall({
        query: "JWT signed tokens",
        ctx: { sessionID: sid },
        skipPaths: ["/memories/councils/"],
      })
      expect(block).toBeDefined()
      expect(block).toContain("RS256")
      expect(block).not.toContain("council")
    }),
  )

  it.instance("ignores trivial / stopword-only turns", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/auth.md",
        content: "JWT tokens are signed with RS256",
        ctx: { sessionID: sid },
      })
      // "ok yes continue" is all stopwords -> no recall, even though a memory exists.
      expect(yield* memory.recall({ query: "ok yes continue", ctx: { sessionID: sid } })).toBeUndefined()
      // a single meaningful word is still below the 2-word threshold
      expect(yield* memory.recall({ query: "please continue now", ctx: { sessionID: sid } })).toBeUndefined()
    }),
  )

  it.instance("recall does not reinforce, but explicit search does", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/auth.md",
        content: "JWT tokens are signed with RS256",
        ctx: { sessionID: sid },
      })
      yield* memory.recall({ query: "JWT RS256 signed tokens", ctx: { sessionID: sid } })
      const afterRecall = yield* memory.search({ query: "JWT RS256 signed tokens", ctx: { sessionID: sid }, reinforce: false })
      expect(afterRecall[0]!.entry.reinforcement).toBe(0)
      yield* memory.search({ query: "JWT RS256 signed tokens", ctx: { sessionID: sid } })
      const afterSearch = yield* memory.search({ query: "JWT RS256 signed tokens", ctx: { sessionID: sid }, reinforce: false })
      expect(afterSearch[0]!.entry.reinforcement).toBeGreaterThan(0)
    }),
  )
})
