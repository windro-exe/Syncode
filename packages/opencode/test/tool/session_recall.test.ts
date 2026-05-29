import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { SessionRecallTool } from "@/tool/session_recall"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const ref = { providerID: "test" as never, modelID: "test-model" as never }

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
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
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

// Create a user message + text part, then optionally mark it evicted by
// stamping `info.pruned` (exactly what the sliding-window prune does).
function addTurn(sessionID: SessionID, text: string, pruned: boolean) {
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
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    if (pruned) yield* ssn.updateMessage({ ...msg, pruned: Date.now() })
    return msg
  })
}

function recall(sessionID: SessionID, params: { query?: string; limit?: number }) {
  return Effect.gen(function* () {
    const info = yield* SessionRecallTool
    const def = yield* info.init()
    const execute = def.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => ReturnType<typeof def.execute>
    return yield* execute(params, makeCtx(sessionID))
  })
}

describe("tool.session_recall", () => {
  it.instance("returns evicted turns and excludes still-visible ones", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addTurn(session.id, "evicted alpha", true)
      yield* addTurn(session.id, "evicted bravo", true)
      yield* addTurn(session.id, "still visible charlie", false)

      const result = yield* recall(session.id, {})

      expect(result.output).toContain("evicted alpha")
      expect(result.output).toContain("evicted bravo")
      expect(result.output).not.toContain("still visible charlie")
      expect(result.metadata.evicted).toBe(2)
      expect(result.metadata.returned).toBe(2)
    }),
  )

  it.instance("filters evicted turns by query", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addTurn(session.id, "the deploy script lives in infra/deploy.sh", true)
      yield* addTurn(session.id, "unrelated chatter about lunch", true)

      const result = yield* recall(session.id, { query: "deploy" })

      expect(result.output).toContain("infra/deploy.sh")
      expect(result.output).not.toContain("lunch")
      expect(result.metadata.evicted).toBe(2)
      expect(result.metadata.returned).toBe(1)
    }),
  )

  it.instance("reports when nothing has been evicted", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addTurn(session.id, "fully visible turn", false)

      const result = yield* recall(session.id, {})

      expect(result.title).toBe("Nothing evicted")
      expect(result.metadata.evicted).toBe(0)
      expect(result.metadata.returned).toBe(0)
    }),
  )

  it.instance("reports when a query matches no evicted turn", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addTurn(session.id, "evicted content about caching", true)

      const result = yield* recall(session.id, { query: "nonexistent-token" })

      expect(result.metadata.evicted).toBe(1)
      expect(result.metadata.returned).toBe(0)
      expect(result.output).toContain("none contain")
    }),
  )

  it.instance("caps returned turns at the requested limit, most recent first", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* addTurn(session.id, "oldest evicted", true)
      yield* addTurn(session.id, "middle evicted", true)
      yield* addTurn(session.id, "newest evicted", true)

      const result = yield* recall(session.id, { limit: 1 })

      expect(result.metadata.evicted).toBe(3)
      expect(result.metadata.returned).toBe(1)
      expect(result.output).toContain("newest evicted")
      expect(result.output).not.toContain("oldest evicted")
    }),
  )
})
