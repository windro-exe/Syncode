import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@/config/config"
import { isSoftCheckpoint, SOFT_CHECKPOINT_FRACTION } from "@/session/overflow"
import type { Provider } from "@/provider/provider"

const cfg = Schema.decodeUnknownSync(Config.Info)({}) as Config.Info

function model(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("session.overflow.isSoftCheckpoint", () => {
  // usable = context - output = 68_000; soft threshold = 0.6 * 68_000 = 40_800
  const m = model({ context: 100_000, output: 32_000 })

  test("fires once projected crosses the soft fraction", () => {
    expect(isSoftCheckpoint({ cfg, projected: 41_000, model: m })).toBe(true)
  })

  test("stays quiet below the soft fraction", () => {
    expect(isSoftCheckpoint({ cfg, projected: 40_000, model: m })).toBe(false)
  })

  test("still fires deep into the window (above the eviction trigger)", () => {
    expect(isSoftCheckpoint({ cfg, projected: 67_000, model: m })).toBe(true)
  })

  test("never fires when the model reports no context limit", () => {
    expect(isSoftCheckpoint({ cfg, projected: 1_000_000, model: model({ context: 0, output: 0 }) })).toBe(false)
  })

  test("fires earlier than overflow — leaves headroom before eviction", () => {
    // 60% of usable is well below the full usable budget, so the checkpoint
    // nudge lands before the 80% eviction trigger would.
    const projected = Math.floor(68_000 * SOFT_CHECKPOINT_FRACTION) + 1
    expect(isSoftCheckpoint({ cfg, projected, model: m })).toBe(true)
    expect(projected).toBeLessThan(68_000 * 0.8)
  })
})
