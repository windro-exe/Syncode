// `council` — spawn a council. Parent-only entry point.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./council.txt"
import { Council } from "@/council"
import { CouncilError } from "@/council/types"

const MemberSpec = Schema.Struct({
  role: Schema.String.annotate({
    description: "Short slug for this member (e.g. 'researcher'). Must be unique within the council.",
  }),
  system_prompt: Schema.String.annotate({
    description:
      "The custom system prompt for this member — the agent definition you crafted by web-researching this role. Tells the model who it is, what its expertise covers, what working style to use, and what's out of scope. This is the heart of the council: the chair builds the perfect agent for each role on the fly, instead of using a preset.",
  }),
  prompt: Schema.String.annotate({
    description: "The specific task you want THIS member to focus on. Different from system_prompt — this is the work, not the identity.",
  }),
  tools_allow: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Optional explicit tool allowlist for this member (e.g. ['read', 'grep', 'glob', 'webfetch']). If omitted, member inherits the default subagent toolset plus the council collaboration tools.",
    }),
  ),
  tools_deny: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Optional explicit tool denylist for this member.",
    }),
  ),
})

export const Parameters = Schema.Struct({
  brief: Schema.String.annotate({
    description: "1-3 sentences describing the high-level task all members share.",
  }),
  members: Schema.Array(MemberSpec).annotate({
    description:
      "2-7 council members. For each, draft a custom system_prompt by researching what makes the perfect agent for that role.",
  }),
  timeout_seconds: Schema.optional(
    Schema.Number.annotate({ description: "Wallclock cap. Default 600 (10 min)." }),
  ),
})

type Metadata = {
  council_id: string
  member_count: number
  members?: Array<{ role: string; agent: string; sessionID: string }>
}

export const CouncilTool = Tool.define(
  "council",
  Effect.gen(function* () {
    const council = yield* Council.Service

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
          members: params.members.map((m) => ({
            role: m.role,
            system_prompt: m.system_prompt,
            prompt: m.prompt,
            ...(m.tools_allow !== undefined ? { tools_allow: m.tools_allow } : {}),
            ...(m.tools_deny !== undefined ? { tools_deny: m.tools_deny } : {}),
          })),
          promptOps,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new CouncilError({ message: `failed to spawn council: ${String(cause).slice(0, 300)}` })),
          ),
        )

      yield* ctx.metadata({
        title: `council ${result.councilID}`,
        metadata: {
          council_id: result.councilID,
          member_count: result.members.length,
          // The Council TUI render (session-v2.tsx) reads this list to show
          // each member as a clickable row with role + agent + session id.
          members: result.members.map((m) => ({
            role: m.role,
            agent: m.agent,
            sessionID: m.sessionID,
          })),
        } as Metadata,
      })
      const lines = [
        `Council ${result.councilID} spawned with ${result.members.length} members:`,
        ...result.members.map((m) => `  - ${m.role} (${m.agent}, ${m.sessionID})`),
        "",
        "The council is running in the background. As members post to the table, you'll see deltas",
        "auto-injected into your context at the start of each turn. Use council_view to fetch the",
        "current table on demand, council_post to inject guidance, council_close when ready.",
      ]
      return {
        title: `council ${result.councilID}`,
        output: lines.join("\n"),
        metadata: {
          council_id: result.councilID,
          member_count: result.members.length,
          members: result.members.map((m) => ({ role: m.role, agent: m.agent, sessionID: m.sessionID })),
        } as Metadata,
      }
    })
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
