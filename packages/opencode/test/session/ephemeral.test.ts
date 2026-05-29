import { describe, expect, test } from "bun:test"
import { isEphemeralAside, BTW_PREFIX } from "@/session/ephemeral"

describe("session.ephemeral.isEphemeralAside", () => {
  test("detects the btw marker case-insensitively and after whitespace", () => {
    expect(isEphemeralAside("btw: what's the capital of France?")).toBe(true)
    expect(isEphemeralAside("BTW: quick aside")).toBe(true)
    expect(isEphemeralAside("   btw: leading space")).toBe(true)
  })

  test("does not match normal messages", () => {
    expect(isEphemeralAside("fix the bug in auth.ts")).toBe(false)
    expect(isEphemeralAside("by the way, this is not the marker")).toBe(false)
    expect(isEphemeralAside("")).toBe(false)
  })

  test("the marker is the documented prefix", () => {
    expect(BTW_PREFIX).toBe("btw:")
  })
})
