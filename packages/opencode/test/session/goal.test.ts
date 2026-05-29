import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Goal, parseAnswer } from "@/session/goal"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

describe("session.goal.parseAnswer", () => {
  test("YES means met", () => {
    expect(parseAnswer("YES")).toBe(true)
    expect(parseAnswer("yes, the goal is complete")).toBe(true)
  })
  test("NO means not met", () => {
    expect(parseAnswer("NO")).toBe(false)
    expect(parseAnswer("no, tests still fail")).toBe(false)
  })
  test("negation wins over affirmative tokens", () => {
    expect(parseAnswer("not yet done")).toBe(false)
    expect(parseAnswer("the goal is not complete")).toBe(false)
  })
  test("strips thinking blocks", () => {
    expect(parseAnswer("<think>hmm maybe</think> YES")).toBe(true)
  })
  test("ambiguous defaults to not met", () => {
    expect(parseAnswer("maybe")).toBe(false)
    expect(parseAnswer("")).toBe(false)
  })
})

const it = testEffect(Goal.defaultLayer)

describe("session.goal.store", () => {
  it.instance("sets, reads, increments, and clears a goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()

      expect(yield* goal.get(sid)).toBeUndefined()

      const entry = yield* goal.set(sid, "tests pass", 5)
      expect(entry.condition).toBe("tests pass")
      expect(entry.iterations).toBe(0)
      expect(entry.max).toBe(5)

      yield* goal.increment(sid)
      yield* goal.increment(sid)
      expect((yield* goal.get(sid))?.iterations).toBe(2)

      yield* goal.clear(sid)
      expect(yield* goal.get(sid)).toBeUndefined()
    }),
  )

  it.instance("clamps max_iterations into a safe range", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      expect((yield* goal.set(sid, "x", 0)).max).toBe(1)
      expect((yield* goal.set(sid, "x", 10_000)).max).toBe(100)
      expect((yield* goal.set(sid, "x")).max).toBe(25)
    }),
  )
})
