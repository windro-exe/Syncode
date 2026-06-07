import { Effect } from "effect"

const CHARS_PER_TOKEN = 4

// Cheap character heuristic. Good enough for display and very rough sizing.
export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

// Lazily-loaded BPE encoder. Importing gpt-tokenizer eagerly costs ~240ms of
// module init (it builds the o200k merge tables), which we must NOT add to every
// CLI start — token.ts is imported widely. So we defer the import to the first
// accurate count and memoize the result. `null` = load failed (use heuristic).
let encoder: ((s: string) => unknown[]) | null | undefined

// Accurate token count via a real BPE tokenizer (o200k_base). A model-agnostic
// proxy: close for English/code and far better than the char heuristic at
// code/CJK where len/4 badly under-counts. Use only where an eviction / overflow
// decision depends on the number; falls back to the heuristic on any failure.
export const count = (input: string) =>
  Effect.gen(function* () {
    if (!input) return 0
    if (encoder === undefined) {
      encoder = yield* Effect.promise(() => import("gpt-tokenizer")).pipe(
        Effect.map((m) => m.encode as (s: string) => unknown[]),
        Effect.orElseSucceed(() => null),
      )
    }
    if (!encoder) return estimate(input)
    try {
      return encoder(input).length
    } catch {
      return estimate(input)
    }
  })

export * as Token from "./token"
