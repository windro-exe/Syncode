import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Memory } from "@/memory/memory"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AutoMemory } from "@/session/auto-memory"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { Agent } from "@/agent/agent"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const fakeModel = {
  id: "small",
  providerID: "test",
  name: "Small",
  limit: { context: 100_000, input: undefined, output: 8_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/anthropic" },
  options: {},
} as Provider.Model

// Mutable so each test can choose what the (mocked) extractor model returns.
let llmOutput = ""

const mockLLM = Layer.mock(LLM.Service, {
  stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "t", text: llmOutput })]) as never,
})
const mockProvider = Layer.mock(Provider.Service, {
  getSmallModel: () => Effect.succeed(fakeModel),
} as never)

const env = AutoMemory.layer.pipe(
  Layer.provide(mockLLM),
  Layer.provide(mockProvider),
  Layer.provide(Config.defaultLayer),
  Layer.provideMerge(Layer.mergeAll(Memory.defaultLayer, SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer)),
)
const it = testEffect(env)

function prunedMsg(sessionID: SessionID, role: "user" | "assistant", text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, role, sessionID, pruned: Date.now(), time: { created: Date.now() } },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  } as unknown as MessageV2.WithParts
}

const fakeAgent = { name: "build" } as Agent.Info
const fakeUser = { id: MessageID.ascending(), role: "user" } as unknown as MessageV2.User

function readNote(sessionID: SessionID) {
  return Effect.gen(function* () {
    const memory = yield* Memory.Service
    const viewed = yield* memory
      .view({ scope: "session", path: "/memories/evicted-context.md", ctx: { sessionID } })
      .pipe(Effect.option)
    if (viewed._tag === "None") return undefined
    return viewed.value.entry?.content
  })
}

describe("session.auto-memory", () => {
  it.instance("distills evicted turns into a session memory note", () =>
    Effect.gen(function* () {
      llmOutput = "- use bun for tests\n- auth lives in src/auth.ts"
      const auto = yield* AutoMemory.Service
      const sid = (yield* (yield* SessionNs.Service).create({})).id
      yield* auto.extract({
        sessionID: sid,
        messages: [prunedMsg(sid, "user", "where does auth live?"), prunedMsg(sid, "assistant", "in src/auth.ts")],
        agent: fakeAgent,
        user: fakeUser,
        fallbackModel: fakeModel,
      })

      const note = yield* readNote(sid)
      expect(note).toBeDefined()
      expect(note).toContain("src/auth.ts")
      expect(note).toContain("use bun for tests")
      // The block records which message ids it was distilled from, so dedup can
      // be rebuilt after a restart.
      expect(note).toContain("<!-- ids:")
    }),
  )

  it.instance("hydrates dedup from the note so a restart does not re-extract", () =>
    Effect.gen(function* () {
      // Simulate a prior process: the note already exists and records the id of
      // a turn it distilled. A fresh AutoMemory has an empty in-process set, so
      // it must rebuild dedup from the note and skip that turn.
      const memory = yield* Memory.Service
      const auto = yield* AutoMemory.Service
      const sid = (yield* (yield* SessionNs.Service).create({})).id
      const msg = prunedMsg(sid, "assistant", "already distilled work")
      yield* memory.create({
        scope: "session",
        path: "/memories/evicted-context.md",
        content: ["prior facts", `<!-- ids: ${msg.info.id} -->`, "- prior fact"].join("\n"),
        ctx: { sessionID: sid },
      })

      llmOutput = "- NEW fact SHOULD NOT APPEAR"
      yield* auto.extract({ sessionID: sid, messages: [msg], agent: fakeAgent, user: fakeUser, fallbackModel: fakeModel })

      const note = yield* readNote(sid)
      expect(note).toContain("prior fact")
      expect(note).not.toContain("SHOULD NOT APPEAR")
    }),
  )

  it.instance("does not re-extract the same pruned turns (dedup)", () =>
    Effect.gen(function* () {
      llmOutput = "- fact one"
      const auto = yield* AutoMemory.Service
      const sid = (yield* (yield* SessionNs.Service).create({})).id
      const messages = [prunedMsg(sid, "assistant", "some work")]

      yield* auto.extract({ sessionID: sid, messages, agent: fakeAgent, user: fakeUser, fallbackModel: fakeModel })
      // Second call with the same already-seen messages should be a no-op.
      llmOutput = "- fact two SHOULD NOT APPEAR"
      yield* auto.extract({ sessionID: sid, messages, agent: fakeAgent, user: fakeUser, fallbackModel: fakeModel })

      const note = yield* readNote(sid)
      expect(note).toContain("fact one")
      expect(note).not.toContain("SHOULD NOT APPEAR")
    }),
  )

  it.instance("does not re-append a fact already recorded in the note", () =>
    Effect.gen(function* () {
      const auto = yield* AutoMemory.Service
      const sid = (yield* (yield* SessionNs.Service).create({})).id
      llmOutput = "- shared fact about auth\n- first unique detail"
      yield* auto.extract({
        sessionID: sid,
        messages: [prunedMsg(sid, "assistant", "work A")],
        agent: fakeAgent,
        user: fakeUser,
        fallbackModel: fakeModel,
      })
      // A later, different turn restates the same fact plus a new one.
      llmOutput = "- shared fact about auth\n- second unique detail"
      yield* auto.extract({
        sessionID: sid,
        messages: [prunedMsg(sid, "assistant", "work B")],
        agent: fakeAgent,
        user: fakeUser,
        fallbackModel: fakeModel,
      })
      const note = yield* readNote(sid)
      expect(note).toContain("first unique detail")
      expect(note).toContain("second unique detail")
      // The shared fact must appear exactly once, not duplicated per eviction.
      expect((note!.match(/shared fact about auth/g) || []).length).toBe(1)
    }),
  )

  it.instance("writes nothing when the extractor returns NONE", () =>
    Effect.gen(function* () {
      llmOutput = "NONE"
      const auto = yield* AutoMemory.Service
      const sid = (yield* (yield* SessionNs.Service).create({})).id
      yield* auto.extract({
        sessionID: sid,
        messages: [prunedMsg(sid, "assistant", "just pleasantries")],
        agent: fakeAgent,
        user: fakeUser,
        fallbackModel: fakeModel,
      })
      expect(yield* readNote(sid)).toBeUndefined()
    }),
  )
})
