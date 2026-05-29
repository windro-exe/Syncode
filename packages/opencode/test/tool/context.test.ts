import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Session as SessionNs } from "@/session/session"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { ContextTool } from "@/tool/context"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const ref = { providerID: "test" as never, modelID: "test-model" as never }

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 200_000, input: undefined, output: 32_000 },
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

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  Config.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

function makeCtx(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: { model },
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function addText(sessionID: SessionID, text: string, pruned: boolean) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
    if (pruned) yield* ssn.updateMessage({ ...msg, pruned: Date.now() })
  })
}

function context(sessionID: SessionID) {
  return Effect.gen(function* () {
    const info = yield* ContextTool
    const def = yield* info.init()
    const execute = def.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => ReturnType<typeof def.execute>
    return yield* execute({}, makeCtx(sessionID))
  })
}

describe("tool.context", () => {
  it.instance("reports window, breakdown, and evicted turns", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addText(session.id, "visible conversation content here", false)
      yield* addText(session.id, "old evicted content", true)

      const result = yield* context(session.id)

      expect(result.output).toContain("Context window:")
      expect(result.output).toContain("200,000")
      expect(result.output).toContain("conversation text:")
      expect(result.output).toContain("evicted: 1 turn")
      expect(result.metadata.pruned).toBe(1)
      expect(result.metadata.limit).toBe(200_000)
    }),
  )

  it.instance("works on an empty session", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const result = yield* context(session.id)
      expect(result.output).toContain("Estimated breakdown")
      expect(result.metadata.pruned).toBe(0)
    }),
  )
})
