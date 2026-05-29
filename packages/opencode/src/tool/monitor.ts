import { Effect, Schema, Stream } from "effect"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import DESCRIPTION from "./monitor.txt"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Shell } from "@/shell/shell"
import { Truncate } from "./truncate"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import { cmd } from "./shell"
import type { TaskPromptOps } from "./task"

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to run and monitor (watcher, tail, dev server, poller)." }),
  description: Schema.String.annotate({ description: "A short (3-5 words) description of what is being monitored." }),
  pattern: Schema.optional(
    Schema.String.annotate({
      description:
        "JavaScript regular expression. Only output lines matching it are pushed back to you. Strongly recommended; omit only if you want every line.",
    }),
  ),
  max_notifications: Schema.optional(
    Schema.Number.annotate({
      description: "Stop the monitor after pushing this many matching lines (default 10).",
    }),
  ),
})

type Metadata = {
  command: string
  jobId?: string
  outputPath?: string
  pattern?: string
}

function monitorMessage(input: { jobId: string; command: string; line: string }): string {
  return [
    `<monitor id="${input.jobId}" command="${input.command}">`,
    "A line from the monitored command matched your pattern:",
    "<line>",
    input.line,
    "</line>",
    "React if it requires action, otherwise acknowledge and continue. The monitor is still running.",
    "</monitor>",
  ].join("\n")
}

function finishedMessage(input: { jobId: string; command: string; count: number }): string {
  return [
    `<monitor id="${input.jobId}" command="${input.command}" state="finished">`,
    `The monitored command exited after ${input.count} matching line${input.count === 1 ? "" : "s"}.`,
    "</monitor>",
  ].join("\n")
}

const DEFAULT_MAX = 10

// Compiling a user-supplied regex is a genuine parse boundary that can throw;
// return undefined on failure so the caller can report it cleanly.
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

export const MonitorTool = Tool.define<
  typeof Parameters,
  Metadata,
  Config.Service | ChildProcessSpawner | BackgroundJob.Service | Truncate.Service
>(
  "monitor",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const background = yield* BackgroundJob.Service
    const trunc = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops)
            return {
              title: "Monitor unavailable",
              output: "The monitor tool requires an interactive session and cannot run here.",
              metadata: { command: params.command } as Metadata,
            }

          // Build the regex up front so an invalid pattern fails fast with a
          // clear message instead of silently never matching.
          let regex: RegExp | undefined
          if (params.pattern) {
            regex = compileRegex(params.pattern)
            if (!regex)
              return {
                title: "Invalid pattern",
                output: `The pattern ${JSON.stringify(params.pattern)} is not a valid regular expression.`,
                metadata: { command: params.command, pattern: params.pattern } as Metadata,
              }
          }

          const max = Math.max(1, Math.min(params.max_notifications ?? DEFAULT_MAX, 100))
          const cfg = yield* config.get()
          const shell = Shell.acceptable(cfg.shell)
          const cwd = (yield* InstanceState.context).directory
          const env = process.env
          const outputPath = yield* trunc.write("")
          const command = params.command

          const job = yield* background.start({
            type: "monitor",
            title: params.description,
            metadata: { command, outputPath, pattern: params.pattern },
            run: Effect.scoped(
              Effect.gen(function* () {
                const sink = createWriteStream(outputPath, { flags: "a" })
                yield* Effect.addFinalizer(() => Effect.sync(() => sink.end()))
                const handle = yield* spawner.spawn(cmd(shell, command, cwd, env))

                let buffer = ""
                let count = 0
                const jobId = outputPath

                const inject = (text: string) =>
                  ops
                    .prompt({
                      sessionID: ctx.sessionID,
                      agent: ctx.agent,
                      parts: [{ type: "text", synthetic: true, text }],
                    })
                    .pipe(Effect.ignore)

                yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                  Effect.gen(function* () {
                    sink.write(chunk)
                    buffer += chunk
                    const lines = buffer.split("\n")
                    buffer = lines.pop() ?? ""
                    for (const raw of lines) {
                      const line = raw.trimEnd()
                      if (!line.trim()) continue
                      if (regex && !regex.test(line)) continue
                      if (count >= max) continue
                      count++
                      yield* inject(monitorMessage({ jobId, command, line })).pipe(Effect.forkScoped)
                      if (count >= max) yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
                    }
                  }),
                )

                const code = yield* handle.exitCode
                yield* inject(finishedMessage({ jobId, command, count }))
                return `Monitor finished (exit ${code}) after ${count} matching line${count === 1 ? "" : "s"}`
              }),
            ),
          })

          return {
            title: params.description,
            metadata: { command, jobId: job.id, outputPath, pattern: params.pattern } as Metadata,
            output: [
              `Started monitoring (job ${job.id}): ${command}`,
              params.pattern ? `Watching for lines matching: ${params.pattern}` : "Pushing every output line back to you.",
              `Up to ${max} matching line${max === 1 ? "" : "s"} will be pushed to you as they appear.`,
              `Full output streams to: ${outputPath}`,
              "Continue with other work; you will be notified when a matching line appears. Stop it with the tasks tool.",
            ].join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
