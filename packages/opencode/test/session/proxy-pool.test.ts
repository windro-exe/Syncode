import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { ProxyPool } from "@/util/proxy-pool"
import { isFreeModel } from "@/session/llm/request"
import { registerKeyPool, getActiveProviderKey, rotateProviderKey } from "@/provider/provider"

describe("ProxyPool", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("returns rotating proxy when configured", () => {
    process.env.SYNCODE_ROTATING_PROXY = "http://rotating.proxy:8080"
    expect(ProxyPool.getProxyForSession("session-1")).toBe("http://rotating.proxy:8080")
    expect(ProxyPool.getProxyForSession("session-2")).toBe("http://rotating.proxy:8080")
  })

  test("allocates sticky proxy from pool per session and rotates on demand", () => {
    delete process.env.SYNCODE_ROTATING_PROXY
    process.env.SYNCODE_PROXY_POOL = "http://proxy1:8080,http://proxy2:8080,http://proxy3:8080"
    
    const p1 = ProxyPool.getProxyForSession("sess-a")
    const p2 = ProxyPool.getProxyForSession("sess-a")
    expect(p1).toBeDefined()
    expect(p2).toBe(p1) // sticky

    const rotated = ProxyPool.rotateProxy("sess-a")
    expect(rotated).toBe(true)
    const p3 = ProxyPool.getProxyForSession("sess-a")
    expect(p3).toBeDefined()
    expect(p3).not.toBe(p1) // rotated to next proxy in pool
  })
})

describe("isFreeModel", () => {
  test("identifies free models across formats and providers", () => {
    expect(isFreeModel({ id: "deepseek-v4-flash-free", providerID: "opencode" })).toBe(true)
    expect(isFreeModel({ id: "qwen/qwen3.8-27b-free", providerID: "orcarouter" })).toBe(true)
    expect(isFreeModel({ id: "meta-llama/llama-3.3-70b-instruct:free", providerID: "openrouter" })).toBe(true)
    expect(isFreeModel({ id: "claude-3-7-sonnet", providerID: "anthropic", cost: { input: 3, output: 15 } })).toBe(false)
  })
})

describe("Multi-Key Rotation", () => {
  test("registers and rotates through multiple API keys for a provider", () => {
    registerKeyPool("test-free-provider", "key_alpha, key_beta, key_gamma")
    expect(getActiveProviderKey("test-free-provider")).toBe("key_alpha")
    
    expect(rotateProviderKey("test-free-provider")).toBe(true)
    expect(getActiveProviderKey("test-free-provider")).toBe("key_beta")

    expect(rotateProviderKey("test-free-provider")).toBe(true)
    expect(getActiveProviderKey("test-free-provider")).toBe("key_gamma")

    expect(rotateProviderKey("test-free-provider")).toBe(true)
    expect(getActiveProviderKey("test-free-provider")).toBe("key_alpha") // wraps around
  })
})
