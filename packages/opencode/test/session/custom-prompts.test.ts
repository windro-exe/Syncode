import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { _resetCache, getCustomPrompt } from "../../src/session/custom-prompts"

const ENV_KEY = "OPENCODE_CUSTOM_PROMPTS"
const FILE_KEY = "OPENCODE_CUSTOM_PROMPTS_FILE"

// This suite exercises the inline-env path. custom-prompts.ts gives the FILE
// var absolute precedence, and a real opencode launched with --custom-prompt
// exports OPENCODE_CUSTOM_PROMPTS_FILE into the test process — which would
// shadow the inline entries and make every lookup miss. Clear both around
// each test to keep it hermetic regardless of how the suite is launched.
beforeEach(() => {
  delete process.env[FILE_KEY]
  delete process.env[ENV_KEY]
  _resetCache()
})

afterEach(() => {
  delete process.env[ENV_KEY]
  delete process.env[FILE_KEY]
  _resetCache()
})

function setEntries(entries: Array<{ providerID: string; modelID: string; prompt: string }>) {
  process.env[ENV_KEY] = JSON.stringify(entries)
  _resetCache()
}

describe("custom-prompts.getCustomPrompt", () => {
  test("returns undefined when env unset", () => {
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBeUndefined()
  })

  test("exact provider+model match", () => {
    setEntries([{ providerID: "anthropic", modelID: "claude-opus-4-7", prompt: "p1" }])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("p1")
    expect(getCustomPrompt("anthropic", "claude-sonnet-4-6")).toBeUndefined()
    expect(getCustomPrompt("openai", "claude-opus-4-7")).toBeUndefined()
  })

  test("wildcard model — anthropic/* matches any anthropic model", () => {
    setEntries([{ providerID: "anthropic", modelID: "*", prompt: "all-anthropic" }])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("all-anthropic")
    expect(getCustomPrompt("anthropic", "claude-haiku-4-5")).toBe("all-anthropic")
    expect(getCustomPrompt("openai", "gpt-5")).toBeUndefined()
  })

  test("wildcard provider — */claude-opus-4-7 matches any provider with that model", () => {
    setEntries([{ providerID: "*", modelID: "claude-opus-4-7", prompt: "any-provider-opus" }])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("any-provider-opus")
    expect(getCustomPrompt("kiro", "claude-opus-4-7")).toBe("any-provider-opus")
    expect(getCustomPrompt("anthropic", "claude-sonnet-4-6")).toBeUndefined()
  })

  test("glob substring matching", () => {
    setEntries([{ providerID: "*", modelID: "*claude*", prompt: "any-claude" }])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("any-claude")
    expect(getCustomPrompt("kiro", "claude-sonnet-4-6")).toBe("any-claude")
    expect(getCustomPrompt("openai", "gpt-5")).toBeUndefined()
  })

  test("first match wins (argv order)", () => {
    setEntries([
      { providerID: "anthropic", modelID: "claude-opus-4-7", prompt: "specific" },
      { providerID: "anthropic", modelID: "*", prompt: "fallback" },
    ])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("specific")
    expect(getCustomPrompt("anthropic", "claude-sonnet-4-6")).toBe("fallback")
  })

  test("malformed env JSON is ignored, not thrown", () => {
    process.env[ENV_KEY] = "{not valid json"
    _resetCache()
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBeUndefined()
  })

  test("non-array JSON is ignored", () => {
    process.env[ENV_KEY] = JSON.stringify({ providerID: "x", modelID: "y", prompt: "z" })
    _resetCache()
    expect(getCustomPrompt("x", "y")).toBeUndefined()
  })

  test("entries with missing fields are filtered out", () => {
    process.env[ENV_KEY] = JSON.stringify([
      { providerID: "anthropic" },
      { modelID: "claude-opus-4-7", prompt: "no-provider" },
      { providerID: "anthropic", modelID: "claude-opus-4-7", prompt: "ok" },
    ])
    _resetCache()
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("ok")
  })

  test("matching is case-insensitive on the glob comparison", () => {
    setEntries([{ providerID: "*", modelID: "*CLAUDE*", prompt: "matches" }])
    expect(getCustomPrompt("anthropic", "claude-opus-4-7")).toBe("matches")
  })
})
