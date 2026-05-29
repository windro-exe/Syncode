// Custom system-prompt overrides loaded at startup. The CLI middleware
// writes parsed `--custom-prompt` entries to a temp JSON file and exports
// the file path in OPENCODE_CUSTOM_PROMPTS_FILE so spawned subprocesses
// (TUI, workflow, subagents) can read the same content without inheriting
// the prompt body itself in the env block. Env vars on Windows are capped
// at ~32KB per key by SetEnvironmentVariableW; a 36KB prompt silently
// truncates and breaks JSON.parse, so we never ship the body inline.
//
// Backwards-compat: still reads the legacy OPENCODE_CUSTOM_PROMPTS env var
// containing inline JSON when present, so existing tests and small inline
// configs keep working.
//
// Match precedence: exact `providerID/modelID` > model-wildcard
// `providerID/*` > provider-wildcard `*/modelID` > glob `*sub*`. First
// matching entry wins (CLI argv order).

import * as fs from "node:fs"

interface CustomPrompt {
  providerID: string
  modelID: string
  prompt: string
}

let cached: CustomPrompt[] | undefined

function readSource(): string | undefined {
  const filePath = process.env.OPENCODE_CUSTOM_PROMPTS_FILE
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8")
    } catch {
      return undefined
    }
  }
  return process.env.OPENCODE_CUSTOM_PROMPTS
}

function load(): CustomPrompt[] {
  if (cached) return cached
  const raw = readSource()
  if (!raw) {
    cached = []
    return cached
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      cached = []
      return cached
    }
    cached = parsed.filter(
      (e): e is CustomPrompt =>
        e &&
        typeof e === "object" &&
        typeof e.providerID === "string" &&
        typeof e.modelID === "string" &&
        typeof e.prompt === "string",
    )
    return cached
  } catch {
    cached = []
    return cached
  }
}

// Visible for tests — clears the lazy cache so a test can mutate the env
// var or file and re-read.
export function _resetCache() {
  cached = undefined
}

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (!pattern.includes("*")) return false
  const regex = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    "i",
  )
  return regex.test(value)
}

export function getCustomPrompt(providerID: string, modelID: string): string | undefined {
  const entries = load()
  if (entries.length === 0) return undefined
  for (const e of entries) {
    if (matches(e.providerID, providerID) && matches(e.modelID, modelID)) return e.prompt
  }
  return undefined
}

export * as CustomPrompts from "./custom-prompts"
