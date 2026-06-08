// Council — typed schemas + error class. No runtime side effects; pure types
// shared by the storage layer, the service, and every council_* tool.
import { Schema } from "effect"
import { SessionID } from "@/session/schema"

// What an entry on the council "table" can be. Typed taxonomy is the difference
// between a "team chat" and a structured collaboration log: an `ask` references
// the entry that an `answer` resolves; `done` carries the member's final
// summary; `decision` is the chair's binding ruling on a fork in the road.
export const Kind = Schema.Literals(["brief", "note", "msg", "ask", "answer", "decision", "stuck"]).annotate({
  identifier: "Council.Kind",
})
export type Kind = Schema.Schema.Type<typeof Kind>

export const Status = Schema.Literals(["thinking", "working", "done", "stuck"]).annotate({
  identifier: "Council.Status",
})
export type Status = Schema.Schema.Type<typeof Status>

export const Member = Schema.Struct({
  sessionID: SessionID,
  agent: Schema.String,
  role: Schema.String,
  status: Status,
  summary: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.String),
  spawnedAt: Schema.Number,
}).annotate({ identifier: "Council.Member" })
export type Member = Schema.Schema.Type<typeof Member>

// Single entry on the table. Append-only. `i` is monotonic across the whole
// council (rotated entries keep their original index so view-deltas survive
// rotation correctly).
export const Entry = Schema.Struct({
  i: Schema.Number,
  ts: Schema.Number,
  from: Schema.String,
  fromSessionID: SessionID,
  kind: Kind,
  to: Schema.optional(Schema.String),
  refIndex: Schema.optional(Schema.Number),
  content: Schema.String,
}).annotate({ identifier: "Council.Entry" })
export type Entry = Schema.Schema.Type<typeof Entry>

export const State = Schema.Struct({
  id: Schema.String,
  parentSessionID: SessionID,
  chairAgent: Schema.String,
  brief: Schema.String,
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  timeoutMs: Schema.Number,
  status: Schema.Literals(["active", "closing", "closed"]),
  members: Schema.Array(Member),
  nextEntryIndex: Schema.Number,
  rotatedCount: Schema.Number,
  entries: Schema.Array(Entry),
}).annotate({ identifier: "Council.State" })
export type State = Schema.Schema.Type<typeof State>

export class CouncilError extends Schema.TaggedErrorClass<CouncilError>()("CouncilError", {
  message: Schema.String,
}) {}
