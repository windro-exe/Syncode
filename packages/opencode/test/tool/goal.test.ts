import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Goal } from "@/session/goal"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { GoalTool } from "@/tool/goal"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(Goal.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer)
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

function goalTool(params: { action?: "set" | "clear" | "status"; condition?: string }, sessionID: SessionID) {
  return Effect.gen(function* () {
    const info = yield* GoalTool
    const def = yield* info.init()
    const execute = def.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => ReturnType<typeof def.execute>
    return yield* execute(params, makeCtx(sessionID))
  })
}

describe("tool.goal", () => {
  it.instance("sets a goal and reports it via status", () =>
    Effect.gen(function* () {
      const sid = SessionID.descending()
      const set = yield* goalTool({ action: "set", condition: "all tests pass" }, sid)
      expect(set.title).toBe("Goal set")

      const goal = yield* Goal.Service
      expect((yield* goal.get(sid))?.condition).toBe("all tests pass")

      const status = yield* goalTool({ action: "status" }, sid)
      expect(status.output).toContain("all tests pass")
    }),
  )

  it.instance("requires a condition to set", () =>
    Effect.gen(function* () {
      const result = yield* goalTool({ action: "set" }, SessionID.descending())
      expect(result.title).toBe("Missing condition")
    }),
  )

  it.instance("clears a goal", () =>
    Effect.gen(function* () {
      const sid = SessionID.descending()
      yield* goalTool({ action: "set", condition: "x" }, sid)
      const cleared = yield* goalTool({ action: "clear" }, sid)
      expect(cleared.title).toBe("Goal cleared")
      const goal = yield* Goal.Service
      expect(yield* goal.get(sid)).toBeUndefined()
    }),
  )

  it.instance("reports no active goal", () =>
    Effect.gen(function* () {
      const result = yield* goalTool({ action: "status" }, SessionID.descending())
      expect(result.title).toBe("No active goal")
    }),
  )
})
