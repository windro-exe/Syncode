import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { BackgroundJob } from "@/background/job"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { TasksTool } from "@/tool/tasks"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(BackgroundJob.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer)
const it = testEffect(env)

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
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

function tasks(params: { action?: "list" | "stop"; id?: string }) {
  return Effect.gen(function* () {
    const info = yield* TasksTool
    const def = yield* info.init()
    const execute = def.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => ReturnType<typeof def.execute>
    return yield* execute(params, makeCtx())
  })
}

describe("tool.tasks", () => {
  it.instance("reports when no background tasks exist", () =>
    Effect.gen(function* () {
      const result = yield* tasks({})
      expect(result.title).toBe("No background tasks")
      expect(result.metadata.total).toBe(0)
    }),
  )

  it.instance("lists a running background job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* jobs.start({ type: "shell", title: "long build", run: Effect.never })

      const result = yield* tasks({ action: "list" })

      expect(result.output).toContain(started.id)
      expect(result.output).toContain("long build")
      expect(result.metadata.total).toBe(1)
      expect(result.metadata.running).toBe(1)

      yield* jobs.cancel(started.id)
    }),
  )

  it.instance("stops a running job by id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* jobs.start({ type: "shell", title: "watcher", run: Effect.never })

      const result = yield* tasks({ action: "stop", id: started.id })

      expect(result.title).toContain("Stopped")
      const after = yield* jobs.get(started.id)
      expect(after?.status).toBe("cancelled")
    }),
  )

  it.instance("reports a friendly message when stop is missing an id", () =>
    Effect.gen(function* () {
      const result = yield* tasks({ action: "stop" })
      expect(result.title).toBe("Missing id")
    }),
  )

  it.instance("reports when stopping an unknown job id", () =>
    Effect.gen(function* () {
      const result = yield* tasks({ action: "stop", id: "job_does_not_exist" })
      expect(result.title).toBe("No such job")
    }),
  )
})
