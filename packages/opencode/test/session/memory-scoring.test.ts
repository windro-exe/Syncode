import { describe, expect, test } from "bun:test"
import { recency, salience, normalizeBm25, importanceFactor, score } from "@/memory/scoring"

describe("memory.scoring", () => {
  test("recency decays with a 30-day half-life and clamps future to 1", () => {
    const now = 1_700_000_000_000
    expect(recency(now, now)).toBeCloseTo(1, 5)
    expect(recency(now - 30 * 86_400_000, now)).toBeCloseTo(0.5, 2)
    expect(recency(now - 60 * 86_400_000, now)).toBeCloseTo(0.25, 2)
    expect(recency(now + 99_999, now)).toBeCloseTo(1, 5)
  })

  test("salience is non-negative, zero at zero, and monotonic", () => {
    expect(salience(0)).toBe(0)
    expect(salience(1)).toBeGreaterThan(0)
    expect(salience(10)).toBeGreaterThan(salience(1))
  })

  test("normalizeBm25 maps to [0,1), guards non-finite, stronger ranks higher", () => {
    expect(normalizeBm25(0)).toBeCloseTo(0, 10)
    expect(normalizeBm25(NaN)).toBe(0)
    expect(normalizeBm25(-Infinity)).toBe(0)
    const weak = normalizeBm25(-1)
    const strong = normalizeBm25(-50)
    expect(weak).toBeGreaterThan(0)
    expect(strong).toBeLessThan(1)
    expect(strong).toBeGreaterThan(weak)
  })

  test("importanceFactor clamps to [0.1, 1] and defaults blank to 0.5", () => {
    expect(importanceFactor(5)).toBeCloseTo(0.5)
    expect(importanceFactor(10)).toBeCloseTo(1)
    expect(importanceFactor(100)).toBeCloseTo(1)
    expect(importanceFactor(0)).toBeCloseTo(0.5)
  })

  test("score ranks higher reinforcement / importance / recency above equal bm25", () => {
    const now = 1_700_000_000_000
    const base = { bm25: -5, reinforcedAt: now, reinforcement: 0, importance: 5, now }
    expect(score({ ...base, reinforcement: 10 })).toBeGreaterThan(score(base))
    expect(score({ ...base, importance: 10 })).toBeGreaterThan(score(base))
    expect(score({ ...base, reinforcedAt: now - 90 * 86_400_000 })).toBeLessThan(score(base))
    // no NaN when last_reinforced falls back to an old timestamp
    expect(Number.isFinite(score({ ...base, reinforcedAt: 0 }))).toBe(true)
  })
})
