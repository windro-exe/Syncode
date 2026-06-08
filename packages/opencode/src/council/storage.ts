// Council storage. Each council is one JSON file at /memories/councils/<id>.json
// in GLOBAL scope (multiple sessions — parent + every member — need to read it).
// Single-file keeps writes atomic-ish (memory.strReplace replaces the whole
// content in one DB transaction); shared scope means no per-session fragments.
//
// Storage operations take a `Memory.Interface` parameter rather than yielding
// the Service so the env requirement doesn't leak into callers' return types.
// MemoryError is mapped to CouncilError at the boundary so the public surface
// has one error type.
import { Effect } from "effect"
import { Memory } from "@/memory/memory"
import { CouncilError } from "./types"
import type { State } from "./types"

const COUNCILS_DIR = "/memories/councils/"
const pathFor = (id: string) => `${COUNCILS_DIR}${id}.json`
// Rotate when the projected file would exceed this. Memory caps at 64KB —
// staying under 56 leaves room for several more posts before next rotation.
const ROTATE_BYTES = 56 * 1024
const MIN_KEPT_ENTRIES = 8

const encode = (state: State) => JSON.stringify(state, null, 2)

// Drop oldest entries until the projected file fits under ROTATE_BYTES.
// Bumps `rotatedCount` so views can render "[N earlier entries archived]"
// without losing the index sequence — `entry.i` is global, new entries keep
// climbing past rotated ones, view-deltas survive rotation correctly.
function rotate(state: State): State {
  const entries = [...state.entries]
  let rotated = state.rotatedCount
  while (entries.length > MIN_KEPT_ENTRIES) {
    const projected = encode({ ...state, entries, rotatedCount: rotated })
    if (Buffer.byteLength(projected, "utf8") <= ROTATE_BYTES) break
    entries.shift()
    rotated++
  }
  return { ...state, entries, rotatedCount: rotated }
}

const wrap = <A>(effect: Effect.Effect<A, Memory.MemoryError>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.fail(new CouncilError({ message: `council storage error: ${String(cause).slice(0, 200)}` })),
    ),
  )

export const read = Effect.fn("Council.Storage.read")(function* (memory: Memory.Interface, id: string) {
  const viewed = yield* wrap(memory.view({ scope: "global", path: pathFor(id), ctx: {} })).pipe(
    Effect.option,
  )
  if (viewed._tag === "None" || !viewed.value.entry) return undefined
  try {
    return JSON.parse(viewed.value.entry.content) as State
  } catch (e) {
    return yield* new CouncilError({
      message: `corrupt council state at ${pathFor(id)}: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
})

// Initial create. Fails (via memory) if the file already exists.
export const init = Effect.fn("Council.Storage.init")(function* (memory: Memory.Interface, state: State) {
  yield* wrap(
    memory.create({
      scope: "global",
      path: pathFor(state.id),
      title: `Council ${state.id}`,
      tags: ["council", "auto"],
      content: encode(state),
      ctx: {},
    }),
  )
})

// Read-modify-write under a caller-provided pure transform. Concurrent writers
// for the same council are serialized by the per-council Semaphore in the
// service layer above this — this fn is the storage primitive, not the lock.
// On size-cap rejection (entry exceeds memory MAX_CONTENT_BYTES), rotate the
// transformed state and retry once.
export const update = Effect.fn("Council.Storage.update")(function* (
  memory: Memory.Interface,
  id: string,
  transform: (prev: State) => State,
) {
  const viewed = yield* wrap(memory.view({ scope: "global", path: pathFor(id), ctx: {} })).pipe(
    Effect.option,
  )
  if (viewed._tag === "None" || !viewed.value.entry) {
    return yield* new CouncilError({ message: `council ${id} does not exist` })
  }
  const prevContent = viewed.value.entry.content
  let prev: State
  try {
    prev = JSON.parse(prevContent) as State
  } catch (e) {
    return yield* new CouncilError({
      message: `corrupt council state for ${id}: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
  const next = transform(prev)
  const direct = yield* wrap(
    memory.strReplace({
      scope: "global",
      path: pathFor(id),
      oldStr: prevContent,
      newStr: encode(next),
      ctx: {},
    }),
  ).pipe(Effect.option)
  if (direct._tag === "Some") return next
  // Most likely failure: encoded next exceeds the memory size cap. Rotate and
  // retry against fresh content (in case anything shifted between reads).
  const rotated = rotate(next)
  const fresh = yield* wrap(memory.view({ scope: "global", path: pathFor(id), ctx: {} }))
  if (!fresh.entry) return yield* new CouncilError({ message: `council ${id} state vanished mid-write` })
  yield* wrap(
    memory.strReplace({
      scope: "global",
      path: pathFor(id),
      oldStr: fresh.entry.content,
      newStr: encode(rotated),
      ctx: {},
    }),
  )
  return rotated
})

// List every council we know about. Used for membership-map hydration so that
// after a process restart, an existing member session's tools still work.
export const list = Effect.fn("Council.Storage.list")(function* (memory: Memory.Interface) {
  const viewed = yield* wrap(memory.view({ scope: "global", path: COUNCILS_DIR, ctx: {} })).pipe(
    Effect.option,
  )
  if (viewed._tag === "None" || !viewed.value.listing) return [] as State[]
  const states: State[] = []
  for (const item of viewed.value.listing) {
    if (!item.path.startsWith(COUNCILS_DIR) || !item.path.endsWith(".json")) continue
    const id = item.path.slice(COUNCILS_DIR.length, -".json".length)
    const s = yield* read(memory, id).pipe(Effect.option)
    if (s._tag === "Some" && s.value) states.push(s.value)
  }
  return states
})

export * as CouncilStorage from "./storage"
