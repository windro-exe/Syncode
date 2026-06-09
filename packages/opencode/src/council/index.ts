// Council — a small team of agent members that work on one complex task with
// SHARED VISIBILITY. Spawned by the parent (chair) via the `council` tool.
// Members run in parallel as background jobs, can read each other's table
// entries, post their own, and declare done. The chair sees deltas auto-
// injected at step start (see prompt.ts step-start hook).
//
// This is an additive, opt-in feature. The existing `task` subagent flow is
// untouched — councils are spawned via their own tool and never share Tool
// or Service surface with TaskTool.
import { Clock, Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory/memory"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import type { ModelID, ProviderID } from "@/provider/schema"
import * as MessageV2 from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import * as Agent from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { Permission } from "@/permission"
import * as Storage from "./storage"
import { CouncilError, type Entry, type Member, type State } from "./types"

const log = Log.create({ service: "council" })

const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_MEMBERS = 7
const MIN_MEMBERS = 2

export { Entry, Member, State, CouncilError } from "./types"

// Hot lookup record for members. The tools call membership() at the top of
// every council_* execute() to know which council the calling session belongs
// to (and what role) — so this has to be O(1).
export interface Membership {
  councilID: string
  role: string
}

// ---- bus events ----------------------------------------------------------

export const Event = {
  Created: BusEvent.define(
    "council.created",
    Schema.Struct({ councilID: Schema.String, parentSessionID: SessionID, brief: Schema.String }),
  ),
  Posted: BusEvent.define(
    "council.posted",
    Schema.Struct({ councilID: Schema.String, entryIndex: Schema.Number, fromSessionID: SessionID }),
  ),
  MemberDone: BusEvent.define(
    "council.member.done",
    Schema.Struct({ councilID: Schema.String, sessionID: SessionID, role: Schema.String }),
  ),
  Closed: BusEvent.define(
    "council.closed",
    Schema.Struct({ councilID: Schema.String, reason: Schema.String }),
  ),
}

// ---- service interface ---------------------------------------------------

export interface SpawnInput {
  parentSessionID: SessionID
  chairAgent: string
  brief: string
  timeoutMs?: number
  members: ReadonlyArray<{
    role: string
    // Chair-crafted custom system prompt for this member. The chair
    // typically web-researches the role first to draft this. Required —
    // the whole point of council is custom-built agents per task.
    system_prompt: string
    // Per-member task — what THIS member should focus on.
    prompt: string
    // Tool allowlist for this member (passed through to the child session's
    // permission ruleset as allow rules). Optional — if omitted, member
    // inherits the deriveSubagentSessionPermission default + council allows.
    tools_allow?: ReadonlyArray<string>
    // Tool denylist — explicit deny on top of the default.
    tools_deny?: ReadonlyArray<string>
    // Optional per-member model override. Falls back to chair's model.
    model?: { providerID: ProviderID; modelID: ModelID }
    // Optional explicit identifier ("explore", "general") if the chair just
    // wants to use an existing preset for this member instead of crafting.
    // Kept for the simple-case escape hatch; ignored when system_prompt set.
    preset_agent?: string
  }>
  // Provided by the calling tool from ctx.extra.promptOps. Required to start
  // the member loops. Not stored on the service — spawning is bound to a
  // single tool call's lifecycle.
  promptOps: TaskPromptOpsLike
}

// Subset of TaskPromptOps we actually use. Decoupled from `@/tool/task` so
// council never imports task code (additive-not-coupled is a goal).
export interface TaskPromptOpsLike {
  prompt: (input: {
    messageID: string
    sessionID: SessionID
    model: { providerID: string; modelID: string }
    agent: string
    tools?: Record<string, boolean>
    parts: Array<{ type: "text"; text: string } | Record<string, unknown>>
  }) => Effect.Effect<MessageV2.WithParts>
}

export interface SpawnResult {
  councilID: string
  members: ReadonlyArray<{ sessionID: SessionID; role: string; agent: string }>
}

export interface PostInput {
  councilID: string
  fromSessionID: SessionID
  kind: Entry["kind"]
  content: string
  to?: string
  refIndex?: number
}

export interface ViewInput {
  councilID: string
  sinceIndex?: number
  // If provided, also keep entries broadcast to all + addressed to this
  // session's role. Used by step-start injection to give a member their
  // "inbox + table" view in one call.
  filterFor?: SessionID
  limit?: number
}

export interface ViewResult {
  state: State
  entries: ReadonlyArray<Entry>
  rotatedCount: number
}

export interface CloseInput {
  councilID: string
  reason?: string
  // When close is triggered from inside a member's own loop (e.g. via
  // declareDone's auto-close), pass that member's sessionID here so we DON'T
  // interrupt the caller mid-execute. Without this, the member's tool result
  // never reaches the model.
  skipSession?: SessionID
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult, CouncilError>
  readonly post: (input: PostInput) => Effect.Effect<Entry, CouncilError>
  readonly declareDone: (input: {
    councilID: string
    sessionID: SessionID
    summary: string
    evidence?: string
  }) => Effect.Effect<void, CouncilError>
  readonly declareStuck: (input: {
    councilID: string
    sessionID: SessionID
    why: string
  }) => Effect.Effect<void, CouncilError>
  readonly close: (input: CloseInput) => Effect.Effect<State, CouncilError>
  readonly view: (input: ViewInput) => Effect.Effect<ViewResult, CouncilError>
  readonly get: (id: string) => Effect.Effect<State | undefined, CouncilError>
  readonly membership: (sessionID: SessionID) => Effect.Effect<Membership | undefined>
  readonly councilsFor: (parentSessionID: SessionID) => Effect.Effect<ReadonlyArray<State>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Council") {}

// ---- internal state ------------------------------------------------------

interface Runtime {
  semaphore: Semaphore.Semaphore
  memberJobs: Set<SessionID>
  // Ephemeral agent names registered for this council's members so close()
  // can unregister them and avoid leaking entries in the agent registry.
  ephemeralAgents: Set<string>
}

interface InternalState {
  runtimes: Map<string, Runtime>
  members: Map<SessionID, Membership>
  scope: Scope.Scope
}

// ---- layer ---------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service

    const stateRef = yield* InstanceState.make<InternalState>(
      Effect.fn("Council.state")(function* () {
        return {
          runtimes: new Map<string, Runtime>(),
          members: new Map<SessionID, Membership>(),
          scope: yield* Scope.Scope,
        } satisfies InternalState
      }),
    )

    // After a process restart, any council still in "active" status on disk is
    // a GHOST — its member background-job fibers and timeout fork died with
    // the previous process and there's no safe way to revive them. Mark each
    // one closed with reason: "process_restarted" so the chair (if they reopen
    // the session) sees an honest closed state instead of a council that looks
    // alive but isn't. Run ONCE eagerly, BEFORE the first spawn — otherwise a
    // fresh-process spawn would hit hydration on its first InstanceState.get
    // and immediately close the council it just wrote.
    yield* Effect.gen(function* () {
      const all = yield* Storage.list(memory).pipe(Effect.orElseSucceed(() => [] as State[]))
      for (const c of all) {
        if (c.status !== "closed") {
          yield* Storage.update(memory, c.id, (prev) => ({
            ...prev,
            status: "closed" as const,
            closedAt: Date.now(),
          })).pipe(Effect.ignore)
        }
      }
    })

    // Wrap any storage write under the per-council semaphore so two members
    // posting at once don't race (strReplace's oldStr check would catch the
    // race anyway, but a single mutex avoids retry loops).
    const withLock = Effect.fnUntraced(function* <A, E>(id: string, body: Effect.Effect<A, E>) {
      const s = yield* InstanceState.get(stateRef)
      const r = s.runtimes.get(id)
      if (!r) return yield* new CouncilError({ message: `unknown council ${id}` })
      return yield* r.semaphore.withPermits(1)(body)
    })

    const get: Interface["get"] = Effect.fn("Council.get")(function* (id) {
      return yield* Storage.read(memory, id)
    })

    const membership: Interface["membership"] = Effect.fn("Council.membership")(function* (sessionID) {
      const s = yield* InstanceState.get(stateRef)
      return s.members.get(sessionID)
    })

    const councilsFor: Interface["councilsFor"] = Effect.fn("Council.councilsFor")(function* (parentSessionID) {
      const all = yield* Storage.list(memory).pipe(Effect.orElseSucceed(() => [] as State[]))
      return all.filter((c) => c.parentSessionID === parentSessionID && c.status !== "closed")
    })

    const post: Interface["post"] = Effect.fn("Council.post")(function* (input) {
      const next = yield* withLock(
        input.councilID,
        Effect.gen(function* () {
          // Status check inside the lock so post() is atomic relative to close().
          // A racing close() either ran first (we see closed and refuse) or runs
          // after we release (it'll observe our entry, which is fine — entries
          // are append-only and a closed council just stops accepting new ones).
          const cur = yield* Storage.read(memory, input.councilID)
          if (!cur) return yield* new CouncilError({ message: `unknown council ${input.councilID}` })
          if (cur.status !== "active") {
            return yield* new CouncilError({
              message: `council ${input.councilID} is ${cur.status}; cannot post`,
            })
          }
          return yield* Storage.update(memory, input.councilID, (prev) => {
            const memberRole = prev.members.find((m) => m.sessionID === input.fromSessionID)?.role
            const isChair = input.fromSessionID === prev.parentSessionID
            const fromName = isChair ? "chair" : (memberRole ?? "unknown")
            const entry: Entry = {
              i: prev.nextEntryIndex,
              ts: Date.now(),
              from: fromName,
              fromSessionID: input.fromSessionID,
              kind: input.kind,
              content: input.content,
              ...(input.to !== undefined ? { to: input.to } : {}),
              ...(input.refIndex !== undefined ? { refIndex: input.refIndex } : {}),
            }
            return { ...prev, entries: [...prev.entries, entry], nextEntryIndex: prev.nextEntryIndex + 1 }
          })
        }),
      )
      const lastEntry = next.entries[next.entries.length - 1]!
      yield* bus.publish(Event.Posted, {
        councilID: input.councilID,
        entryIndex: lastEntry.i,
        fromSessionID: input.fromSessionID,
      })
      return lastEntry
    })

    const declareDone: Interface["declareDone"] = Effect.fn("Council.declareDone")(function* (input) {
      const next = yield* withLock(
        input.councilID,
        Effect.gen(function* () {
          const cur = yield* Storage.read(memory, input.councilID)
          if (!cur) return yield* new CouncilError({ message: `unknown council ${input.councilID}` })
          if (cur.status !== "active") {
            return yield* new CouncilError({
              message: `council ${input.councilID} is ${cur.status}; cannot declare done`,
            })
          }
          return yield* Storage.update(memory, input.councilID, (prev) => ({
            ...prev,
            members: prev.members.map((m) =>
              m.sessionID === input.sessionID
                ? {
                    ...m,
                    status: "done" as const,
                    ...(input.summary !== undefined ? { summary: input.summary } : {}),
                    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
                  }
                : m,
            ),
          }))
        }),
      )
      const member = next.members.find((m) => m.sessionID === input.sessionID)
      if (member) {
        yield* post({
          councilID: input.councilID,
          fromSessionID: input.sessionID,
          kind: "decision",
          content: `[done] ${input.summary}${input.evidence ? `\n\nEvidence:\n${input.evidence}` : ""}`,
        }).pipe(Effect.ignore)
        yield* bus.publish(Event.MemberDone, {
          councilID: input.councilID,
          sessionID: input.sessionID,
          role: member.role,
        })
      }
      const allDone = next.members.every((m) => m.status === "done" || m.status === "stuck")
      if (allDone && next.status === "active") {
        // Skip cancelling the caller's own member fiber so the tool can return
        // its success result to the model. The other members' loops still get
        // interrupted as part of the close.
        yield* close({ councilID: input.councilID, reason: "all_done", skipSession: input.sessionID })
      }
    })

    const declareStuck: Interface["declareStuck"] = Effect.fn("Council.declareStuck")(function* (input) {
      yield* withLock(
        input.councilID,
        Effect.gen(function* () {
          const cur = yield* Storage.read(memory, input.councilID)
          if (!cur) return yield* new CouncilError({ message: `unknown council ${input.councilID}` })
          if (cur.status !== "active") {
            return yield* new CouncilError({
              message: `council ${input.councilID} is ${cur.status}; cannot declare stuck`,
            })
          }
          return yield* Storage.update(memory, input.councilID, (prev) => ({
            ...prev,
            members: prev.members.map((m) =>
              m.sessionID === input.sessionID ? { ...m, status: "stuck" as const } : m,
            ),
          }))
        }),
      )
      yield* post({
        councilID: input.councilID,
        fromSessionID: input.sessionID,
        kind: "stuck",
        content: input.why,
      }).pipe(Effect.ignore)
    })

    const close: Interface["close"] = Effect.fn("Council.close")(function* (input) {
      const result = yield* withLock(
        input.councilID,
        Storage.update(memory, input.councilID, (prev) => ({
          ...prev,
          status: "closed" as const,
          closedAt: Date.now(),
        })),
      )
      const s = yield* InstanceState.get(stateRef)
      const r = s.runtimes.get(input.councilID)
      if (r) {
        // Cancel any still-running member jobs. runState.cancel is no-op on
        // already-finished sessions. Skip the caller's own session when set
        // so a member's auto-close-on-done can return its tool result before
        // its fiber gets interrupted.
        for (const sid of r.memberJobs) {
          if (input.skipSession && sid === input.skipSession) continue
          yield* runState.cancel(sid).pipe(Effect.ignore)
        }
        // Drop the ephemeral chair-crafted agents so they don't leak in the
        // registry. Agent.unregister is a no-op if the agent isn't registered.
        for (const name of r.ephemeralAgents) {
          yield* agents.unregister(name).pipe(Effect.ignore)
        }
      }
      // Drop hot membership entries for this council so post-close tool calls
      // from the (now-cancelled) member sessions return cleanly.
      for (const [sid, m] of s.members) if (m.councilID === input.councilID) s.members.delete(sid)
      s.runtimes.delete(input.councilID)
      yield* bus.publish(Event.Closed, { councilID: input.councilID, reason: input.reason ?? "closed" })
      return result
    })

    const view: Interface["view"] = Effect.fn("Council.view")(function* (input) {
      const state = yield* Storage.read(memory, input.councilID)
      if (!state) return yield* new CouncilError({ message: `unknown council ${input.councilID}` })
      let entries: ReadonlyArray<Entry> = state.entries
      if (input.sinceIndex !== undefined) entries = entries.filter((e) => e.i > input.sinceIndex!)
      if (input.filterFor) {
        const role = state.members.find((m) => m.sessionID === input.filterFor)?.role
        if (role) {
          entries = entries.filter(
            (e) => !e.to || e.to === "all" || e.to === role || e.fromSessionID === input.filterFor,
          )
        }
      }
      if (input.limit !== undefined) entries = entries.slice(-input.limit)
      return { state, entries, rotatedCount: state.rotatedCount }
    })

    const spawn: Interface["spawn"] = Effect.fn("Council.spawn")(function* (input) {
      if (input.members.length < MIN_MEMBERS) {
        return yield* new CouncilError({
          message: `council needs at least ${MIN_MEMBERS} members (got ${input.members.length})`,
        })
      }
      if (input.members.length > MAX_MEMBERS) {
        return yield* new CouncilError({
          message: `council cannot exceed ${MAX_MEMBERS} members (got ${input.members.length})`,
        })
      }
      const roles = new Set<string>()
      for (const m of input.members) {
        if (roles.has(m.role)) return yield* new CouncilError({ message: `duplicate role: ${m.role}` })
        roles.add(m.role)
      }
      // Validate preset agent references up front. Custom (system_prompt) members
      // need no preset.
      for (const m of input.members) {
        if (m.preset_agent) {
          const ok = yield* agents.get(m.preset_agent).pipe(Effect.option)
          if (ok._tag === "None") {
            return yield* new CouncilError({ message: `unknown preset agent: ${m.preset_agent}` })
          }
        }
        if (!m.system_prompt && !m.preset_agent) {
          return yield* new CouncilError({
            message: `member ${m.role} needs either system_prompt (chair-crafted) or preset_agent`,
          })
        }
      }

      const id = Identifier.ascending("council")
      const parent = yield* sessions
        .get(input.parentSessionID)
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(new CouncilError({ message: `parent session ${input.parentSessionID} not found` })),
          ),
        )
      const parentModel = yield* getParentModel(input.parentSessionID).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const parentAgent = parent.agent
        ? yield* agents.get(parent.agent).pipe(Effect.orElseSucceed(() => undefined))
        : undefined

      // Council members get the same isolation guards subagents get (Plan-Mode
      // edit-deny propagation, default-deny on todowrite/task) PLUS explicit
      // allows for the council collaboration tools so a restrictive subagent
      // (e.g. `explore`, which is `*: deny` with a tiny allowlist) can still
      // call council_view/post/done/stuck. council and council_close stay
      // denied for members — only the chair spawns or closes councils.
      const councilMemberAllows: Permission.Ruleset = [
        { permission: "council_view" as const, pattern: "*" as const, action: "allow" as const },
        { permission: "council_post" as const, pattern: "*" as const, action: "allow" as const },
        { permission: "council_done" as const, pattern: "*" as const, action: "allow" as const },
        { permission: "council_stuck" as const, pattern: "*" as const, action: "allow" as const },
        { permission: "council" as const, pattern: "*" as const, action: "deny" as const },
        { permission: "council_close" as const, pattern: "*" as const, action: "deny" as const },
      ]

      // Create child sessions for each member up front so the initial state
      // file has the full member roster. Each member with a chair-crafted
      // system_prompt gets an ephemeral agent registered for it; preset
      // members keep their existing agent reference. Loops are kicked off
      // afterwards.
      const memberSpec: Member[] = []
      const memberKickoffs: Array<{
        sessionID: SessionID
        role: string
        agent: string
        prompt: string
        model: { providerID: ProviderID; modelID: ModelID }
      }> = []
      const ephemeralAgentNames: string[] = []
      for (const m of input.members) {
        const model = m.model ?? parentModel
        if (!model) {
          return yield* new CouncilError({ message: `cannot resolve model for member ${m.role}` })
        }
        // Build the per-member agent. If the chair drafted a system_prompt,
        // register a fresh ephemeral agent named __council_<id>_<role> with
        // that prompt + chair-crafted tool allow/deny rules + per-member
        // model. Otherwise fall back to the named preset.
        let agentName: string
        let subagentInfo: Agent.Info
        if (m.system_prompt) {
          agentName = `__council_${id}_${m.role}`
          const customPermission = [
            ...(m.tools_allow ?? []).map((t) => ({ permission: t, pattern: "*", action: "allow" as const })),
            ...(m.tools_deny ?? []).map((t) => ({ permission: t, pattern: "*", action: "deny" as const })),
          ]
          const ephemeral: Agent.Info = {
            name: agentName,
            description: `Council member [${m.role}] · chair-crafted at runtime`,
            mode: "subagent",
            hidden: true,
            prompt: m.system_prompt,
            permission: customPermission,
            model,
            options: {},
          }
          yield* agents.register(ephemeral).pipe(Effect.orDie)
          ephemeralAgentNames.push(agentName)
          subagentInfo = ephemeral
        } else {
          agentName = m.preset_agent!
          subagentInfo = yield* agents.get(agentName)
        }
        const childPermission: Permission.Ruleset = [
          ...deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            parentAgent,
            subagent: subagentInfo,
          }),
          ...councilMemberAllows,
        ]
        const child = yield* sessions
          .create({
            parentID: input.parentSessionID,
            title: `[${m.role}] ${input.brief.slice(0, 64)} (council ${id})`,
            permission: childPermission,
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.fail(new CouncilError({ message: `failed to create session for member ${m.role}` })),
            ),
          )
        memberSpec.push({
          sessionID: child.id,
          agent: agentName,
          role: m.role,
          status: "thinking",
          spawnedAt: Date.now(),
        })
        memberKickoffs.push({ sessionID: child.id, role: m.role, agent: agentName, prompt: m.prompt, model })
      }

      const now = Date.now()
      const init: State = {
        id,
        parentSessionID: input.parentSessionID,
        chairAgent: input.chairAgent,
        brief: input.brief,
        createdAt: now,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        status: "active",
        members: memberSpec,
        nextEntryIndex: 1,
        rotatedCount: 0,
        entries: [
          {
            i: 0,
            ts: now,
            from: "chair",
            fromSessionID: input.parentSessionID,
            kind: "brief",
            content: input.brief,
          },
        ],
      }
      yield* Storage.init(memory, init)

      // Register hot membership AFTER the file is committed so a tool that
      // races in here can't see a half-state.
      const s = yield* InstanceState.get(stateRef)
      const runtime: Runtime = {
        semaphore: Semaphore.makeUnsafe(1),
        memberJobs: new Set(memberSpec.map((m) => m.sessionID)),
        ephemeralAgents: new Set(ephemeralAgentNames),
      }
      s.runtimes.set(id, runtime)
      for (const m of memberSpec) s.members.set(m.sessionID, { councilID: id, role: m.role })

      yield* bus.publish(Event.Created, {
        councilID: id,
        parentSessionID: input.parentSessionID,
        brief: input.brief,
      })

      // Kick off members. Each runs as a BackgroundJob so the parent's
      // `council` tool returns immediately. BackgroundJob is the right
      // primitive here because it tracks running work across cancellation
      // cascades and doesn't depend on TaskTool's experimental gate.
      for (const k of memberKickoffs) {
        const seed = formatMemberSeed({
          role: k.role,
          brief: input.brief,
          taskPrompt: k.prompt,
          councilID: id,
          allRoles: input.members.map((m) => ({ role: m.role })),
        })
        yield* background
          .start({
            id: k.sessionID,
            type: "council_member",
            title: `[${k.role}] ${input.brief.slice(0, 64)}`,
            metadata: {
              parentSessionId: input.parentSessionID,
              sessionId: k.sessionID,
              council: id,
              role: k.role,
            },
            run: input.promptOps
              .prompt({
                messageID: MessageID.ascending(),
                sessionID: k.sessionID,
                model: { providerID: k.model.providerID, modelID: k.model.modelID },
                agent: k.agent,
                parts: [{ type: "text", text: seed }],
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => log.info("council member loop completed", { council: id, role: k.role })),
                ),
                Effect.map((result) => result.parts.findLast((p) => p.type === "text")?.text ?? ""),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    log.error("council member loop failed", {
                      cause: String(cause).slice(0, 200),
                      council: id,
                      role: k.role,
                    })
                    // Flip the member's status to "stuck" so the council can
                    // still auto-close when the rest are done. Without this,
                    // a crashed member sits at "thinking" forever and blocks
                    // the all-done check until the wallclock timeout fires.
                    yield* declareStuck({
                      councilID: id,
                      sessionID: k.sessionID,
                      why: `member loop failed: ${String(cause).slice(0, 200)}`,
                    }).pipe(Effect.ignore)
                    return ""
                  }),
                ),
              ),
          })
          .pipe(Effect.ignore)
      }

      // Wallclock timeout: auto-close after timeoutMs unless already closed.
      // Forked into the InstanceState scope so it survives the spawn fn
      // returning, and dies when the instance is disposed.
      yield* Effect.gen(function* () {
        yield* Effect.sleep(`${init.timeoutMs} millis`)
        const cur = yield* Storage.read(memory, id).pipe(Effect.orElseSucceed(() => undefined))
        if (cur && cur.status === "active") {
          yield* close({ councilID: id, reason: "timeout" }).pipe(Effect.ignore)
        }
      }).pipe(Effect.forkIn(s.scope))

      return {
        councilID: id,
        members: memberSpec.map((m) => ({ sessionID: m.sessionID, role: m.role, agent: m.agent })),
      }
    })

    function getParentModel(parentSessionID: SessionID) {
      // Fetch the parent's most recent assistant message and reuse its model.
      // Same heuristic TaskTool uses to inherit model from the chair's turn.
      return Effect.gen(function* () {
        const msgs = yield* sessions
          .messages({ sessionID: parentSessionID })
          .pipe(Effect.orElseSucceed(() => [] as MessageV2.WithParts[]))
        const lastAssistant = msgs.findLast((m) => m.info.role === "assistant")
        if (!lastAssistant || lastAssistant.info.role !== "assistant") return undefined
        const model = yield* provider
          .getModel(lastAssistant.info.providerID, lastAssistant.info.modelID)
          .pipe(Effect.option)
        if (model._tag === "None") return undefined
        return { providerID: lastAssistant.info.providerID, modelID: lastAssistant.info.modelID }
      })
    }

    return Service.of({
      spawn,
      post,
      declareDone,
      declareStuck,
      close,
      view,
      get,
      membership,
      councilsFor,
    })
  }),
)

// Self-contained default: wraps every Service the layer needs. This means
// adding Council to a runtime doesn't widen the runtime's required-env, which
// keeps test layers and other consumers from breaking when they don't know to
// provide Council's deps. Layer dedup (memoMap) handles double-provisioning
// when these are also in the upstream chain.
export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Memory.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Agent.defaultLayer),
)

// ---- helpers -------------------------------------------------------------

function formatMemberSeed(input: {
  role: string
  brief: string
  taskPrompt: string
  councilID: string
  allRoles: ReadonlyArray<{ role: string }>
}): string {
  const peers = input.allRoles
    .filter((r) => r.role !== input.role)
    .map((r) => `- ${r.role}`)
    .join("\n")
  return [
    `You are part of a council collaborating on a complex task. Council ID: ${input.councilID}.`,
    `Your role: ${input.role}.`,
    "",
    "## Brief (shared across the council)",
    input.brief,
    "",
    "## Your task",
    input.taskPrompt,
    "",
    "## Your fellow council members",
    peers || "- (you are working solo)",
    "",
    "## How the council works",
    "- The chair (parent agent) sees everything. They will inject guidance via the table.",
    "- Use `council_view` to see what others are doing. Use `council_post` to share findings.",
    "- Address a question to a peer with `council_post(kind: 'ask', to: '<role>', content: '...')`.",
    "- When YOU are finished with your role, call `council_done({ summary, evidence? })` so the chair can synthesize.",
    "- If you are blocked, call `council_stuck({ why })` instead of spinning.",
    "- Don't duplicate work — view the table at the start of each step.",
    "",
    "Begin.",
  ].join("\n")
}

export * as Council from "."
