import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tasks.txt"
import { BackgroundJob } from "@/background/job"

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["list", "stop"]).annotate({
      description: 'What to do: "list" (default) shows all background jobs; "stop" cancels one.',
    }),
  ),
  id: Schema.optional(
    Schema.String.annotate({
      description: 'Job id to cancel. Required when action is "stop".',
    }),
  ),
})

type Metadata = {
  total: number
  running: number
}

function duration(job: BackgroundJob.Info): string {
  const end = job.completed_at ?? Date.now()
  const secs = Math.max(0, Math.round((end - job.started_at) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m${secs % 60}s`
}

function renderJob(job: BackgroundJob.Info): string {
  const parts = [`- [${job.status}] ${job.id} (${job.type}, ${duration(job)})`]
  if (job.title) parts.push(`  ${job.title}`)
  if (job.status === "error" && job.error) parts.push(`  error: ${job.error}`)
  const outputPath = job.metadata && typeof job.metadata.outputPath === "string" ? job.metadata.outputPath : undefined
  if (outputPath) parts.push(`  output: ${outputPath}`)
  return parts.join("\n")
}

export const TasksTool = Tool.define<typeof Parameters, Metadata, BackgroundJob.Service>(
  "tasks",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action ?? "list"

          if (action === "stop") {
            if (!params.id)
              return {
                title: "Missing id",
                output: 'To stop a job, pass its id. Run tasks with action "list" to see job ids.',
                metadata: { total: 0, running: 0 } as Metadata,
              }
            const stopped = yield* jobs.cancel(params.id)
            if (!stopped)
              return {
                title: "No such job",
                output: `No background job with id ${params.id}. It may have already finished.`,
                metadata: { total: 0, running: 0 } as Metadata,
              }
            return {
              title: stopped.status === "cancelled" ? `Stopped ${params.id}` : `Job ${params.id} already ${stopped.status}`,
              output:
                stopped.status === "cancelled"
                  ? `Background job ${params.id} was cancelled.`
                  : `Background job ${params.id} had already finished (${stopped.status}); nothing to stop.`,
              metadata: { total: 1, running: 0 } as Metadata,
            }
          }

          const all = yield* jobs.list()
          const running = all.filter((job) => job.status === "running").length
          if (all.length === 0)
            return {
              title: "No background tasks",
              output: "No background tasks have been started in this session.",
              metadata: { total: 0, running: 0 } as Metadata,
            }

          return {
            title: `${all.length} background task${all.length === 1 ? "" : "s"} (${running} running)`,
            output: all.map(renderJob).join("\n"),
            metadata: { total: all.length, running } as Metadata,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
