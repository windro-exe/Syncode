import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Memory } from "@/memory/memory"
import { Provider } from "@/provider/provider"
import { Council } from "@/council"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import * as MessageV2 from "@/session/message-v2"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const env = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Memory.defaultLayer,
  Provider.defaultLayer,
  Council.defaultLayer,
)

const it = testEffect(env)

// A fake promptOps that doesn't actually run the prompt loop — it just returns
// an empty WithParts so the BackgroundJob fiber completes immediately. This
// lets us test spawn / post / view / done / close without an LLM.
const fakeOps: Council.TaskPromptOpsLike = {
  prompt: (input) =>
    Effect.succeed({
      info: {
        id: input.messageID as ReturnType<typeof MessageID.ascending>,
        sessionID: input.sessionID,
        role: "assistant" as const,
        mode: input.agent,
        agent: input.agent,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.model.modelID,
        providerID: input.model.providerID,
        time: { created: Date.now(), completed: Date.now() },
      },
      parts: [],
    } as unknown as MessageV2.WithParts),
}

const newSession = Effect.gen(function* () {
  return (yield* (yield* Session.Service).create({})).id
})

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const validMembers = [
  { role: "researcher", agent: "general", prompt: "find the answer", model: ref },
  { role: "architect", agent: "general", prompt: "design the solution", model: ref },
]

describe("council", () => {
  it.instance("spawn rejects fewer than 2 members", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const result = yield* council
        .spawn({
          parentSessionID: sid,
          chairAgent: "general",
          brief: "test",
          members: [{ role: "solo", agent: "general", prompt: "do it alone" }],
          promptOps: fakeOps,
        })
        .pipe(Effect.option)
      expect(result._tag).toBe("None")
    }),
  )

  it.instance("spawn rejects more than 7 members", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const tooMany = Array.from({ length: 8 }, (_, i) => ({
        role: `r${i}`,
        agent: "general",
        prompt: "x",
      }))
      const result = yield* council
        .spawn({
          parentSessionID: sid,
          chairAgent: "general",
          brief: "test",
          members: tooMany,
          promptOps: fakeOps,
        })
        .pipe(Effect.option)
      expect(result._tag).toBe("None")
    }),
  )

  it.instance("spawn rejects duplicate roles", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const result = yield* council
        .spawn({
          parentSessionID: sid,
          chairAgent: "general",
          brief: "test",
          members: [
            { role: "same", agent: "general", prompt: "a" },
            { role: "same", agent: "general", prompt: "b" },
          ],
          promptOps: fakeOps,
        })
        .pipe(Effect.option)
      expect(result._tag).toBe("None")
    }),
  )

  it.instance("post + view delivers entries since the brief", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "build a parser",
        members: validMembers,
        promptOps: fakeOps,
      })
      // Entry 0 is the brief written by the spawn.
      const initialView = yield* council.view({ councilID: spawn.councilID })
      expect(initialView.entries.length).toBe(1)
      expect(initialView.entries[0]!.kind).toBe("brief")
      expect(initialView.entries[0]!.from).toBe("chair")

      // A member posts a note.
      const memberSid = spawn.members[0]!.sessionID
      yield* council.post({
        councilID: spawn.councilID,
        fromSessionID: memberSid,
        kind: "note",
        content: "looking at PEG grammars",
      })

      const sinceBrief = yield* council.view({ councilID: spawn.councilID, sinceIndex: 0 })
      expect(sinceBrief.entries.length).toBe(1)
      expect(sinceBrief.entries[0]!.kind).toBe("note")
      expect(sinceBrief.entries[0]!.from).toBe("researcher")
      expect(sinceBrief.entries[0]!.fromSessionID).toBe(memberSid)
    }),
  )

  it.instance("view filterFor returns broadcasts + entries addressed to the role + own posts", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "test",
        members: validMembers,
        promptOps: fakeOps,
      })
      const m1 = spawn.members[0]! // researcher
      const m2 = spawn.members[1]! // architect

      yield* council.post({ councilID: spawn.councilID, fromSessionID: sid, kind: "note", content: "broadcast" })
      yield* council.post({
        councilID: spawn.councilID,
        fromSessionID: sid,
        kind: "msg",
        content: "for researcher only",
        to: "researcher",
      })
      yield* council.post({
        councilID: spawn.councilID,
        fromSessionID: sid,
        kind: "msg",
        content: "for architect only",
        to: "architect",
      })

      const v = yield* council.view({
        councilID: spawn.councilID,
        sinceIndex: 0,
        filterFor: m1.sessionID,
      })
      const contents = v.entries.map((e) => e.content)
      expect(contents).toContain("broadcast")
      expect(contents).toContain("for researcher only")
      expect(contents).not.toContain("for architect only")
      void m2
    }),
  )

  it.instance("declareDone marks the member done and auto-closes when all done", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "test",
        members: validMembers,
        promptOps: fakeOps,
      })

      yield* council.declareDone({
        councilID: spawn.councilID,
        sessionID: spawn.members[0]!.sessionID,
        summary: "researched PEG, recommend X",
      })
      const mid = yield* council.get(spawn.councilID)
      expect(mid?.status).toBe("active")
      expect(mid?.members.find((m) => m.role === "researcher")?.status).toBe("done")

      yield* council.declareDone({
        councilID: spawn.councilID,
        sessionID: spawn.members[1]!.sessionID,
        summary: "designed the parser",
      })
      const after = yield* council.get(spawn.councilID)
      expect(after?.status).toBe("closed")
    }),
  )

  it.instance("declareStuck marks the member stuck", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "test",
        members: validMembers,
        promptOps: fakeOps,
      })
      yield* council.declareStuck({
        councilID: spawn.councilID,
        sessionID: spawn.members[0]!.sessionID,
        why: "blocked on missing context",
      })
      const state = yield* council.get(spawn.councilID)
      expect(state?.members.find((m) => m.role === "researcher")?.status).toBe("stuck")
    }),
  )

  it.instance("close seals the council and clears membership", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "test",
        members: validMembers,
        promptOps: fakeOps,
      })
      const beforeClose = yield* council.membership(spawn.members[0]!.sessionID)
      expect(beforeClose?.councilID).toBe(spawn.councilID)
      expect(beforeClose?.role).toBe("researcher")

      yield* council.close({ councilID: spawn.councilID, reason: "done by chair" })
      const state = yield* council.get(spawn.councilID)
      expect(state?.status).toBe("closed")
      const afterClose = yield* council.membership(spawn.members[0]!.sessionID)
      expect(afterClose).toBeUndefined()
    }),
  )

  it.instance("membership() returns council + role for a spawned member", () =>
    Effect.gen(function* () {
      const council = yield* Council.Service
      const sid = yield* newSession
      const spawn = yield* council.spawn({
        parentSessionID: sid,
        chairAgent: "general",
        brief: "test",
        members: validMembers,
        promptOps: fakeOps,
      })
      const m = yield* council.membership(spawn.members[1]!.sessionID)
      expect(m?.councilID).toBe(spawn.councilID)
      expect(m?.role).toBe("architect")
    }),
  )
})

// Suppress unused-variable warnings on imports kept for type clarity.
void PartID
