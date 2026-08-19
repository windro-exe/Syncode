import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface RuleEntry {
  id?: string
  text: string
  source: "project" | "global"
  file?: string
  enabled?: boolean
}

export interface RuleFile {
  name: string
  path: string
  rules: string[]
  enabled: boolean
}

function splitFrontmatter(text: string): { body: string; frontmatter: string } {
  const clean = text.replace(/^\ufeff/, "")
  if (!clean.startsWith("---")) {
    return { body: clean, frontmatter: "" }
  }
  const end = clean.indexOf("\n---", 3)
  if (end === -1) {
    return { body: clean, frontmatter: "" }
  }
  return {
    body: clean.slice(end + 4).replace(/^\n+/, ""),
    frontmatter: clean.slice(0, end + 4),
  }
}

function isAlwaysOn(frontmatter: string): boolean {
  if (!frontmatter) return true
  const lower = frontmatter.toLowerCase()
  if (/^\s*alwaysapply\s*:\s*false\s*$/m.test(lower)) return false
  if (/^\s*(?:mode|trigger)\s*:\s*(?:manual|disabled|off)\s*$/m.test(lower)) return false
  return true
}

export function parseRulesFromMarkdown(content: string): string[] {
  const { body, frontmatter } = splitFrontmatter(content)
  if (!isAlwaysOn(frontmatter)) return []
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      // Only bullet list items count as rules. Prose, numbered lists, code blocks,
      // and tables in a .md file are documentation, not operational rules — without
      // this, document files like AGENTS.md would dump every line into the UI.
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, ""))
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  )
}

export function serializeRulesToMarkdown(rules: string[], frontmatter = ""): string {
  const body = rules
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => `- ${r}`)
    .join("\n")
  const header = frontmatter ? `${frontmatter.trim()}\n\n` : ""
  return `${header}${body}\n`
}

// Rules live in exactly one file per scope: rules.md. No other files are read
// or written — AGENTS.md/CONTEXT.md are instructions (injected by
// instruction.ts), and store/JSON sources are gone.
const PROJECT_RULE_DIR = ".syncode/rules"
const PROJECT_RULE_FILE = "rules.md"
const GLOBAL_RULE_FILE = path.join(os.homedir(), ".syncode", "rules", "rules.md")

const DEFAULT_PROJECT_MARKER_KEY = "default-project.v1"

function desktopStoreDirs(): string[] {
  return [
    process.env.APPDATA ? path.join(process.env.APPDATA, "ai.opencode.desktop") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "ai.opencode.desktop.dev") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode") : null,
    path.join(os.homedir(), ".config", "opencode"),
  ].filter(Boolean) as string[]
}

/**
 * The desktop app's "Default Project" is where non-project chats live. It is not
 * a real project: rules added there are global rules. The directory is persisted
 * by the desktop app under `default-project.v1` in its default.dat store; the
 * well-known Documents\Default Project location is the fallback for installs
 * that predate the marker.
 */
export function defaultProjectDirectory(): string | undefined {
  for (const datDir of desktopStoreDirs()) {
    const datPath = path.join(datDir, "default.dat")
    if (!fs.existsSync(datPath)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(datPath, "utf8"))
      const marker = parsed?.[DEFAULT_PROJECT_MARKER_KEY]
      if (typeof marker === "string" && marker) return marker
    } catch {
      // Ignore unreadable store
    }
  }
  const fallback = path.join(os.homedir(), "Documents", "Default Project")
  return fs.existsSync(fallback) ? fallback : undefined
}

export function loadProjectRules(cwd: string): RuleFile[] {
  if (cwd && cwd === defaultProjectDirectory()) return []
  migrateProjectLegacy(cwd)
  const filePath = path.join(cwd, PROJECT_RULE_DIR, PROJECT_RULE_FILE)
  return readRuleFile(filePath)
}

// ---------------------------------------------------------------------------
// One-time migration from the old multi-file/multi-source layout into rules.md.
// Any rules found in legacy files are merged into rules.md (deduped) and the
// legacy files are deleted — rules.md is the only source from now on.
// ---------------------------------------------------------------------------

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function mergeInto(filePath: string, rules: string[]) {
  if (rules.length === 0) return
  const existing = new Set(parseRulesFromMarkdown(readIfExists(filePath)))
  const added = rules.filter((rule) => !existing.has(rule))
  if (added.length === 0) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const merged = [...existing, ...added]
  fs.writeFileSync(filePath, serializeRulesToMarkdown(merged), "utf8")
}

const LEGACY_GLOBAL_RULE_DIRS = [
  path.join(os.homedir(), ".config", "opencode", "rules"),
  path.join(os.homedir(), ".syncode", "rules"),
]
if (process.env.APPDATA) {
  LEGACY_GLOBAL_RULE_DIRS.push(path.join(process.env.APPDATA, "opencode", "rules"))
}

let globalLegacyMigrated = false

function migrateProjectLegacy(cwd: string) {
  const targets: { dir: string; rules: string[]; filePath: string }[] = []
  for (const relDir of [PROJECT_RULE_DIR, ".opencode/rules", ".hermes/rules"]) {
    const dir = path.join(cwd, relDir)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith(".md") || file.toLowerCase() === PROJECT_RULE_FILE) continue
      const filePath = path.join(dir, file)
      targets.push({ dir, rules: parseRulesFromMarkdown(readIfExists(filePath)), filePath })
    }
  }
  if (targets.length === 0) return
  const targetFile = path.join(cwd, PROJECT_RULE_DIR, PROJECT_RULE_FILE)
  const merged = targets.flatMap((t) => t.rules)
  mergeInto(targetFile, merged)
  for (const t of targets) {
    try {
      fs.unlinkSync(t.filePath)
    } catch {
      // Ignore
    }
  }
}

function migrateGlobalLegacy() {
  if (globalLegacyMigrated) return
  globalLegacyMigrated = true

  const merged: string[] = []
  const removals: string[] = []
  for (const dir of LEGACY_GLOBAL_RULE_DIRS) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith(".md") || file.toLowerCase() === PROJECT_RULE_FILE) continue
      const filePath = path.join(dir, file)
      merged.push(...parseRulesFromMarkdown(readIfExists(filePath)))
      removals.push(filePath)
    }
  }
  for (const jsonPath of [
    path.join(os.homedir(), ".config", "opencode", "global_rules.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "global_rules.json") : null,
  ].filter(Boolean) as string[]) {
    if (!fs.existsSync(jsonPath)) continue
    try {
      const parsed = JSON.parse(readIfExists(jsonPath))
      if (Array.isArray(parsed)) {
        merged.push(...parsed.filter((item) => item && typeof item.rule === "string").map((item) => item.rule))
      }
      removals.push(jsonPath)
    } catch {
      // Ignore unreadable json
    }
  }
  mergeInto(GLOBAL_RULE_FILE, merged)
  for (const filePath of removals) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // Ignore
    }
  }

  const defaultDir = defaultProjectDirectory()
  if (defaultDir) migrateProjectLegacy(defaultDir)
}

function readRuleFile(filePath: string): RuleFile[] {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return []
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    const { frontmatter } = splitFrontmatter(raw)
    const rules = parseRulesFromMarkdown(raw)
    if (rules.length === 0) return []
    return [
      {
        name: PROJECT_RULE_FILE,
        path: filePath,
        rules,
        enabled: isAlwaysOn(frontmatter),
      },
    ]
  } catch {
    return []
  }
}

export function loadProjectIdea(cwd: string): string | undefined {
  if (!cwd) return undefined
  // Check IDEA.md in project root
  const ideaFile = path.join(cwd, "IDEA.md")
  if (fs.existsSync(ideaFile) && fs.statSync(ideaFile).isFile()) {
    try {
      const raw = fs.readFileSync(ideaFile, "utf8").trim()
      if (raw) return raw
    } catch {}
  }

  // Check desktop default.dat store for UI project idea (project-idea:<cwd>)
  for (const datDir of desktopStoreDirs()) {
    const datPath = path.join(datDir, "default.dat")
    if (fs.existsSync(datPath)) {
      try {
        const raw = fs.readFileSync(datPath, "utf8")
        const parsed = JSON.parse(raw)
        const key1 = `project-idea:${cwd}`
        const key2 = `project-idea:${cwd.replace(/\\/g, "/")}`
        const ideaJson = parsed[key1] || parsed[key2]
        if (ideaJson) {
          const val = typeof ideaJson === "string" ? JSON.parse(ideaJson) : ideaJson
          if (val && typeof val.idea === "string" && val.idea.trim()) {
            return val.idea.trim()
          }
        }
      } catch {
        // Ignore
      }
    }
  }
  return undefined
}

export function loadGlobalRules(): RuleFile[] {
  migrateGlobalLegacy()
  const results = readRuleFile(GLOBAL_RULE_FILE)

  // The default project is not a project — its rules.md is a global rules file.
  const defaultDir = defaultProjectDirectory()
  if (defaultDir) {
    const defaultFile = path.join(defaultDir, PROJECT_RULE_DIR, PROJECT_RULE_FILE)
    for (const file of readRuleFile(defaultFile)) {
      results.push({
        ...file,
        name: `default:${file.name}`,
      })
    }
  }

  return results
}

export function formatRulesSystemPrompt(opts: {
  projectRules: string[]
  globalRules: string[]
  projectPath?: string
  projectIdea?: string
}): string | undefined {
  const projectList = opts.projectRules.map((r) => r.trim()).filter(Boolean)
  const globalList = opts.globalRules.map((r) => r.trim()).filter(Boolean)
  const idea = opts.projectIdea?.trim()

  if (projectList.length === 0 && globalList.length === 0 && !idea) {
    return undefined
  }

  const sections: string[] = [
    "## Operational Rules & Negative Constraints (MANDATORY)",
    "",
    "The following operational rules are strict, inviolable constraints for THIS session.",
    "Where a project rule conflicts with general defaults, persona, or phrasing, the project rule takes absolute precedence.",
    "",
  ]

  if (idea) {
    sections.push("### Project Purpose & Intent (IDEA.md)")
    sections.push("<project_intent>")
    sections.push(idea)
    sections.push("</project_intent>")
    sections.push("")
  }

  if (projectList.length > 0) {
    sections.push("### Project-Specific Rules")
    sections.push("<project_rules>")
    for (const rule of projectList) {
      sections.push(`- ${rule}`)
    }
    sections.push("</project_rules>")
    sections.push("")
  }

  if (globalList.length > 0) {
    sections.push("### Global Developer Rules")
    sections.push("<global_rules>")
    for (const rule of globalList) {
      sections.push(`- ${rule}`)
    }
    sections.push("</global_rules>")
    sections.push("")
  }

  sections.push("### Strict Enforcement & Consequence Notice")
  sections.push("Every rule above is an immutable constraint. Violating any constraint is an instruction failure.")
  sections.push("Before executing any tool or returning your final output:")
  sections.push("1. Verify your planned actions and code against each active rule above.")
  sections.push("2. If an action would contradict any rule, abort that action immediately and adjust your approach.")
  sections.push("3. Non-compliance is treated as an operational failure requiring immediate correction.")

  return sections.join("\n")
}

export function addRule(opts: { scope: "project" | "global"; rule: string; cwd?: string }): {
  success: boolean
  filePath: string
  rule: string
} {
  const cleanRule = opts.rule.trim()
  if (!cleanRule) throw new Error("Rule content cannot be empty")

  let targetFile = ""
  if (opts.scope === "project") {
    const cwd = opts.cwd || process.cwd()
    targetFile = path.join(cwd, PROJECT_RULE_DIR, PROJECT_RULE_FILE)
  } else {
    targetFile = GLOBAL_RULE_FILE
  }

  const targetDir = path.dirname(targetFile)
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  let existingRules: string[] = []
  let frontmatter = ""

  if (fs.existsSync(targetFile)) {
    try {
      const raw = fs.readFileSync(targetFile, "utf8")
      const split = splitFrontmatter(raw)
      frontmatter = split.frontmatter
      existingRules = parseRulesFromMarkdown(raw)
    } catch {}
  }

  if (!existingRules.includes(cleanRule)) {
    existingRules.push(cleanRule)
  }

  const updatedMarkdown = serializeRulesToMarkdown(existingRules, frontmatter)
  fs.writeFileSync(targetFile, updatedMarkdown, "utf8")

  return { success: true, filePath: targetFile, rule: cleanRule }
}

export function removeRule(opts: { scope: "project" | "global"; rule: string; cwd?: string; filePath?: string }): {
  success: boolean
  filePath: string
  remainingCount: number
} {
  const cleanRule = opts.rule.trim()
  let targetFile = opts.filePath

  if (!targetFile) {
    if (opts.scope === "project") {
      const cwd = opts.cwd || process.cwd()
      targetFile = path.join(cwd, PROJECT_RULE_DIR, PROJECT_RULE_FILE)
    } else {
      targetFile = GLOBAL_RULE_FILE
    }
  }

  if (!fs.existsSync(targetFile)) {
    return { success: false, filePath: targetFile, remainingCount: 0 }
  }

  const raw = fs.readFileSync(targetFile, "utf8")
  const split = splitFrontmatter(raw)
  const existingRules = parseRulesFromMarkdown(raw)
  const filtered = existingRules.filter((r) => r.toLowerCase() !== cleanRule.toLowerCase())

  const updatedMarkdown = serializeRulesToMarkdown(filtered, split.frontmatter)
  fs.writeFileSync(targetFile, updatedMarkdown, "utf8")

  return { success: true, filePath: targetFile, remainingCount: filtered.length }
}
