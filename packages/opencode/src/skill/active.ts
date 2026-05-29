import { Context, Effect, Layer } from "effect"
import { SessionID } from "@/session/schema"

// Per-session active skills picked by the auto-router for the current turn.
// Stored in process memory: rebuilt each turn, cleared when the turn ends.
// Multi-skill: the router can pick more than one skill per turn, so this
// holds an ordered list (router order is preserved). When set with an empty
// array or null, all picks for that session are cleared.
export interface Interface {
  readonly set: (sessionID: SessionID, names: string[] | null) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<string[]>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillActive") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const map = new Map<SessionID, string[]>()
    return Service.of({
      set: (sessionID, names) =>
        Effect.sync(() => {
          if (names && names.length > 0) map.set(sessionID, names)
          else map.delete(sessionID)
        }),
      get: (sessionID) => Effect.sync(() => map.get(sessionID) ?? []),
      clear: (sessionID) => Effect.sync(() => void map.delete(sessionID)),
    })
  }),
)

export const defaultLayer = layer

export * as SkillActive from "./active"
