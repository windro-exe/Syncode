// `council` — spawn a council. Parent-only entry point.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council.txt"
import { Council } from "@/council"
import { CouncilError } from "@/council/types"
import { Session } from "@/session/session"
import { PartID } from "@/session/schema"
import * as MessageV2 from "@/session/message-v2"

const MemberSpec = Schema.Struct({
  role: Schema.String.annotate({
    description: "Short slug for this member (e.g. 'researcher'). Must be unique within the council.",
  }),
  agent_type: Schema.String.annotate({ description: "The subagent type (e.g. 'general', 'explore')." }),
  prompt: Schema.String.annotate({ description: "This member's specific task — what they should focus on." }),
})

export const Parameters = Schema.Struct({
  brief: Schema.String.annotate({ description: "1-3 sentences describing the high-level task." }),
  members: Schema.Array(MemberSpec).annotate({ description: "2-7 council members." }),
  timeout_seconds: Schema.optional(
    Schema.Number.annotate({ description: "Wallclock cap. Default 600 (10 min)." }),
  ),
})

type Metadata = {
  council_id: string
  member_count: number
}

export const CouncilTool = Tool.define(
  "council",
  Effect.gen(function* () {
    const council = yield* Council.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("CouncilTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const promptOps = ctx.extra?.promptOps as Council.TaskPromptOpsLike | undefined
      if (!promptOps) {
        return yield* Effect.fail(new Error("council tool requires promptOps in ctx.extra"))
      }
      const result = yield* council
        .spawn({
          parentSessionID: ctx.sessionID,
          chairAgent: ctx.agent,
          brief: params.brief,
          timeoutMs: params.timeout_seconds !== undefined ? params.timeout_seconds * 1000 : undefined,
          members: params.members.map((m) => ({ role: m.role, agent: m.agent_type, prompt: m.prompt })),
          promptOps,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new CouncilError({ message: `failed to spawn council: ${String(cause).slice(0, 300)}` })),
          ),
        )

      // Emit one `subtask` part per member, attached to the chair's current
      // assistant message. This is what makes the member sessions render in
      // the TUI like task-spawned subagents (clickable, expandable, with the
      // member's session id resolvable). Without this, the TUI only shows the
      // single ⚙ council tool-call icon and the running members are invisible.
      for (const member of result.members) {
        const promptForMember = params.members.find((p) => p.role === member.role)?.prompt ?? ""
        yield* sessions
          .updatePart({
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "subtask",
            agent: member.agent,
            description: `[${member.role}] ${params.brief.slice(0, 80)}`,
            prompt: promptForMember,
          } as MessageV2.SubtaskPart)
          .pipe(Effect.ignore)
      }

      yield* ctx.metadata({
        title: `council ${result.councilID}`,
        metadata: { council_id: result.councilID, member_count: result.members.length },
      })
      const lines = [
        `Council ${result.councilID} spawned with ${result.members.length} members:`,
        ...result.members.map((m) => `  - ${m.role} (${m.agent}, ${m.sessionID})`),
        "",
        "The council is running in the background. As members post to the table, you'll see deltas",
        "auto-injected into your context at the start of each turn. Use council_view to fetch the",
        "current table on demand, council_post to inject guidance, council_close when ready.",
      ]
      return { title: `council ${result.councilID}`, output: lines.join("\n"), metadata: { council_id: result.councilID, member_count: result.members.length } }
    })
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
