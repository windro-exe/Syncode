import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { MonitorTool } from "@/tool/monitor"
import type { TaskPromptOps } from "@/tool/task"
import { pollWithTimeout } from "../lib/effect"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  BackgroundJob.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)
const it = testEffect(env)

function makeCtx(promptOps: TaskPromptOps): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function fakeOps(injected: string[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: (input) =>
      Effect.sync(() => {
        for (const part of input.parts) if (part.type === "text") injected.push(part.text)
        return {} as never
      }),
  }
}

function monitor(params: { command: string; description: string; pattern?: string }, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const info = yield* MonitorTool
    const def = yield* info.init()
    const execute = def.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => ReturnType<typeof def.execute>
    return yield* execute(params, ctx)
  })
}

describe("tool.monitor", () => {
  it.instance("pushes matching output lines back via promptOps", () =>
    Effect.gen(function* () {
      const injected: string[] = []
      const ctx = makeCtx(fakeOps(injected))

      const result = yield* monitor({ command: "echo MATCH_ME", description: "Echo monitor", pattern: "MATCH" }, ctx)
      expect(typeof result.metadata.jobId).toBe("string")

      const jobs = yield* BackgroundJob.Service
      yield* jobs.wait({ id: result.metadata.jobId as string, timeout: 15_000 })

      yield* pollWithTimeout(
        Effect.sync(() => (injected.some((t) => t.includes("MATCH_ME")) ? (true as const) : undefined)),
        "monitor never pushed the matching line",
      )
      expect(injected.some((t) => t.includes("MATCH_ME"))).toBe(true)
      expect(injected.some((t) => t.includes('state="finished"'))).toBe(true)
    }),
  )

  it.instance("pushes a final line with no trailing newline back", () =>
    Effect.gen(function* () {
      const injected: string[] = []
      const ctx = makeCtx(fakeOps(injected))

      // printf emits no trailing newline — the matching line lives only in the
      // residual buffer after the stream ends, exercising the flush fix.
      const result = yield* monitor({ command: "printf MATCH_NONL", description: "no-nl", pattern: "MATCH" }, ctx)
      const jobs = yield* BackgroundJob.Service
      yield* jobs.wait({ id: result.metadata.jobId as string, timeout: 15_000 })

      yield* pollWithTimeout(
        Effect.sync(() => (injected.some((t) => t.includes("MATCH_NONL")) ? (true as const) : undefined)),
        "monitor never pushed the no-newline final line",
      )
      expect(injected.some((t) => t.includes("MATCH_NONL"))).toBe(true)
    }),
  )

  it.instance("rejects an invalid regex pattern", () =>
    Effect.gen(function* () {
      const ctx = makeCtx(fakeOps([]))
      const result = yield* monitor({ command: "echo hi", description: "bad pattern", pattern: "(" }, ctx)
      expect(result.title).toBe("Invalid pattern")
      expect(result.metadata.jobId).toBeUndefined()
    }),
  )

  it.instance("reports when promptOps is unavailable", () =>
    Effect.gen(function* () {
      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* monitor({ command: "echo hi", description: "no ops" }, ctx)
      expect(result.title).toBe("Monitor unavailable")
    }),
  )
})
