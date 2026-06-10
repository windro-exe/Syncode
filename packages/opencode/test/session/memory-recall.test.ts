import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Memory, splitSections } from "@/memory/memory"
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

describe("memory.search (FTS5 robustness)", () => {
  it.instance("matches hyphenated/punctuated identifiers instead of returning zero (regression)", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/virt.md",
        title: "Virtualization",
        content: "GameLoop's QMEmulatorService owns AMD-V at boot; SQLITE_ERROR codes and src/file.path refs.",
        ctx: { sessionID: sid },
      })
      // A query containing punctuation (the hyphen in AMD-V) used to build a raw
      // FTS5 MATCH that threw a syntax error, swallowed into zero results. It
      // must now match via safely-quoted tokens.
      const hits = yield* memory.search({ query: "QMEmulatorService AMD-V hypervisor", ctx: { sessionID: sid } })
      expect(hits.some((h) => h.entry.path === "/memories/topics/virt.md")).toBe(true)
    }),
  )

  it.instance("a punctuation-only query degrades to empty, not a crash", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/x.md",
        content: "some content",
        ctx: { sessionID: sid },
      })
      const hits = yield* memory.search({ query: "  -  .  /  ", ctx: { sessionID: sid } })
      expect(hits).toEqual([])
    }),
  )
})

describe("memory.recall hygiene", () => {
  it.instance("dedups identical content so the same fact is not injected twice", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      const dup = "Vulkan renders BGMI smoother than DirectX on this AMD iGPU stack."
      yield* memory.create({ scope: "session", path: "/memories/topics/a.md", content: dup, ctx: { sessionID: sid } })
      yield* memory.create({ scope: "session", path: "/memories/topics/b.md", content: dup, ctx: { sessionID: sid } })
      const block = yield* memory.recall({ query: "Vulkan DirectX BGMI smoother", ctx: { sessionID: sid } })
      expect(block).toBeDefined()
      // two entries match, but identical content collapses to a single snippet
      expect(block!.split("<snippet>").length - 1).toBe(1)
    }),
  )
})

describe("memory section-aware retrieval", () => {
  it.instance("injects the matching section + breadcrumb, not the file head", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const sid = yield* newSession
      yield* memory.create({
        scope: "session",
        path: "/memories/topics/rig.md",
        title: "Rig",
        content: [
          "# Rig",
          "",
          "## Display",
          "1440p 165Hz panel, G-Sync off for latency.",
          "",
          "## Storage",
          "The NVMe boot drive is a Samsung 990 Pro 2TB with heatsink.",
        ].join("\n"),
        ctx: { sessionID: sid },
      })
      const block = yield* memory.recall({ query: "which NVMe boot drive Samsung", ctx: { sessionID: sid } })
      expect(block).toBeDefined()
      expect(block).toContain("990 Pro") // the Storage section was surfaced
      expect(block).toContain("Storage") // its breadcrumb is included
      expect(block).not.toContain("G-Sync") // the unrelated Display/head section was NOT injected
    }),
  )
})

describe("splitSections", () => {
  test("does not treat # lines inside fenced code blocks as headings", () => {
    const content = [
      "# Setup",
      "intro",
      "## Commands",
      "```sh",
      "# install deps (shell comment, NOT a heading)",
      "npm i",
      "```",
      "trailing note",
    ].join("\n")
    const secs = splitSections("Guide", content)
    // the "# install deps" line is inside a fence -> must not spawn its own section
    expect(secs.some((s) => s.breadcrumb.includes("install deps"))).toBe(false)
    // and the fenced block stays intact within the Commands section
    const cmd = secs.find((s) => s.breadcrumb.includes("Commands"))
    expect(cmd?.body).toContain("# install deps")
    expect(cmd?.body).toContain("npm i")
  })

  test("falls back to a single section for heading-less content", () => {
    const secs = splitSections("Note", "just a flat note with no headings at all")
    expect(secs.length).toBe(1)
    expect(secs[0]!.breadcrumb).toBe("Note")
  })
})
