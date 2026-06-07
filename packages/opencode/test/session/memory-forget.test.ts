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

const newSession = Effect.gen(function* () {
  return (yield* (yield* SessionNs.Service).create({})).id
})

// 40 days in the future makes a just-created entry "old" for the age rail.
const FUTURE = Date.now() + 40 * 86_400_000

describe("memory.forget", () => {
  it.instance("evicts an old, never-retrieved, low-importance entry", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/stale.md",
        content: "old trivia nobody ever used",
        ctx: { sessionID: sid },
      })
      const n = yield* memory.forget({ scope: "session", ctx: { sessionID: sid }, now: FUTURE })
      expect(n).toBeGreaterThanOrEqual(1)
      const found = yield* memory.search({ query: "old trivia", ctx: { sessionID: sid }, reinforce: false })
      expect(found.length).toBe(0)
    }),
  )

  it.instance("never evicts a protected structural file", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/_plan.md",
        content: "important plan that must survive",
        ctx: { sessionID: sid },
      })
      yield* memory.forget({ scope: "session", ctx: { sessionID: sid }, now: FUTURE })
      const found = yield* memory.search({ query: "important plan survive", ctx: { sessionID: sid }, reinforce: false })
      expect(found.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("never evicts an entry that has been genuinely retrieved", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/used.md",
        content: "fact about caching that was actually retrieved",
        ctx: { sessionID: sid },
      })
      // A real search reinforces it, so forgetting must spare it.
      yield* memory.search({ query: "caching retrieved fact", ctx: { sessionID: sid } })
      yield* memory.forget({ scope: "session", ctx: { sessionID: sid }, now: FUTURE })
      const found = yield* memory.search({ query: "caching retrieved fact", ctx: { sessionID: sid }, reinforce: false })
      expect(found.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("never evicts an entry that has been viewed (touched) even if never searched", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/read.md",
        content: "a fact the user reads via the index but never explicitly searches",
        ctx: { sessionID: sid },
      })
      // Reading bumps access_count (a "touched" signal), so forget must spare it.
      yield* memory.view({ scope: "session", path: "/memories/topics/read.md", ctx: { sessionID: sid } })
      const n = yield* memory.forget({ scope: "session", ctx: { sessionID: sid }, now: FUTURE })
      expect(n).toBe(0)
      const found = yield* memory.search({ query: "fact reads index", ctx: { sessionID: sid }, reinforce: false })
      expect(found.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("does not evict recent entries (age rail)", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/fresh.md",
        content: "brand new note still in its grace period",
        ctx: { sessionID: sid },
      })
      // now == creation time, so it is well within the min-age window.
      const n = yield* memory.forget({ scope: "session", ctx: { sessionID: sid } })
      expect(n).toBe(0)
      const found = yield* memory.search({ query: "brand new grace period", ctx: { sessionID: sid }, reinforce: false })
      expect(found.length).toBeGreaterThanOrEqual(1)
    }),
  )
})
