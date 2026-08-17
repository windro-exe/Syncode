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
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"))
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

const PROJECT_RULE_DIRS = [".syncode/rules", ".opencode/rules", ".hermes/rules"]
const GLOBAL_RULE_DIRS = [
  path.join(os.homedir(), ".config", "opencode", "rules"),
  path.join(os.homedir(), ".syncode", "rules"),
]
if (process.env.APPDATA) {
  GLOBAL_RULE_DIRS.push(path.join(process.env.APPDATA, "opencode", "rules"))
}

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
  return collectDirectoryRules(cwd)
}

function collectDirectoryRules(cwd: string): RuleFile[] {
  const results: RuleFile[] = []
  if (!cwd || !fs.existsSync(cwd)) return results

  for (const relDir of PROJECT_RULE_DIRS) {
    const dir = path.join(cwd, relDir)
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"))
        for (const file of files) {
          const filePath = path.join(dir, file)
          try {
            const raw = fs.readFileSync(filePath, "utf8")
            const { frontmatter } = splitFrontmatter(raw)
            const enabled = isAlwaysOn(frontmatter)
            const rules = parseRulesFromMarkdown(raw)
            results.push({
              name: file,
              path: filePath,
              rules,
              enabled,
            })
          } catch {
            // Ignore single unreadable file
          }
        }
      } catch {
        // Ignore directory read error
      }
    }
  }

  // Also check AGENTS.md at project root if present
  const agentsFile = path.join(cwd, "AGENTS.md")
  if (fs.existsSync(agentsFile) && fs.statSync(agentsFile).isFile()) {
    try {
      const raw = fs.readFileSync(agentsFile, "utf8")
      const rules = parseRulesFromMarkdown(raw)
      if (rules.length > 0) {
        results.push({
          name: "AGENTS.md",
          path: agentsFile,
          rules,
          enabled: true,
        })
      }
    } catch {
      // Ignore
    }
  }

// Also check desktop default.dat store files for UI project rules (project-rules:<cwd>)
  for (const datDir of desktopStoreDirs()) {
    const datPath = path.join(datDir, "default.dat")
    if (fs.existsSync(datPath)) {
      try {
        const raw = fs.readFileSync(datPath, "utf8")
        const parsed = JSON.parse(raw)
        const key1 = `project-rules:${cwd}`
        const key2 = `project-rules:${cwd.replace(/\\/g, "/")}`
        const rulesJson = parsed[key1] || parsed[key2]
        if (rulesJson) {
          const val = typeof rulesJson === "string" ? JSON.parse(rulesJson) : rulesJson
          if (val && Array.isArray(val.rules)) {
            const rules = val.rules.map((r: any) => String(r).trim()).filter(Boolean)
            if (rules.length > 0) {
              results.push({
                name: "ui.projectRules",
                path: datPath,
                rules,
                enabled: true,
              })
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  return results
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
  const results: RuleFile[] = []

  for (const dir of GLOBAL_RULE_DIRS) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"))
        for (const file of files) {
          const filePath = path.join(dir, file)
          try {
            const raw = fs.readFileSync(filePath, "utf8")
            const { frontmatter } = splitFrontmatter(raw)
            const enabled = isAlwaysOn(frontmatter)
            const rules = parseRulesFromMarkdown(raw)
            results.push({
              name: file,
              path: filePath,
              rules,
              enabled,
            })
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }
  }

// Also check desktop default.dat store files if present
  for (const datDir of desktopStoreDirs()) {
    const datPath = path.join(datDir, "default.dat")
    if (fs.existsSync(datPath)) {
      try {
        const raw = fs.readFileSync(datPath, "utf8")
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed["settings.v3"] === "string") {
          const settings = JSON.parse(parsed["settings.v3"])
          if (Array.isArray(settings.globalRules)) {
            const rules = settings.globalRules
              .filter((item: any) => item && typeof item.rule === "string" && item.enabled !== false)
              .map((item: any) => item.rule as string)
            if (rules.length > 0) {
              results.push({
                name: "settings.globalRules",
                path: datPath,
                rules,
                enabled: true,
              })
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // The default project is not a project — its rules (files and UI store) are
  // global rules. Collect them through the same directory walker used for
  // projects, then re-label them as default-project sources.
  const defaultDir = defaultProjectDirectory()
  if (defaultDir) {
    for (const file of collectDirectoryRules(defaultDir)) {
      results.push({
        name: `default:${file.name}`,
        path: file.path,
        rules: file.rules,
        enabled: file.enabled,
      })
    }
  }

  // Also check JSON configs if present
  const jsonPaths = [
    path.join(os.homedir(), ".config", "opencode", "global_rules.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "global_rules.json") : null,
  ].filter(Boolean) as string[]

  for (const jsonPath of jsonPaths) {
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, "utf8")
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const rules = parsed
            .filter((item) => item && typeof item.rule === "string" && item.enabled !== false)
            .map((item) => item.rule as string)
          if (rules.length > 0) {
            results.push({
              name: "global_rules.json",
              path: jsonPath,
              rules,
              enabled: true,
            })
          }
        }
      } catch {
        // Ignore
      }
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

export function addRule(opts: {
  scope: "project" | "global"
  rule: string
  cwd?: string
  file?: string
}): { success: boolean; filePath: string; rule: string } {
  const cleanRule = opts.rule.trim()
  if (!cleanRule) throw new Error("Rule content cannot be empty")

  let targetDir = ""
  let targetFile = ""

  if (opts.scope === "project") {
    const cwd = opts.cwd || process.cwd()
    targetDir = path.join(cwd, ".syncode", "rules")
    const fileName = opts.file ? (opts.file.endsWith(".md") ? opts.file : `${opts.file}.md`) : "project.md"
    targetFile = path.join(targetDir, fileName)
  } else {
    targetDir = path.join(os.homedir(), ".syncode", "rules")
    const fileName = opts.file ? (opts.file.endsWith(".md") ? opts.file : `${opts.file}.md`) : "global.md"
    targetFile = path.join(targetDir, fileName)
  }

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

export function removeRule(opts: {
  scope: "project" | "global"
  rule: string
  cwd?: string
  file?: string
  filePath?: string
}): { success: boolean; filePath: string; remainingCount: number } {
  const cleanRule = opts.rule.trim()
  let targetFile = opts.filePath

  if (!targetFile) {
    let targetDir = ""
    if (opts.scope === "project") {
      const cwd = opts.cwd || process.cwd()
      targetDir = path.join(cwd, ".syncode", "rules")
      const fileName = opts.file ? (opts.file.endsWith(".md") ? opts.file : `${opts.file}.md`) : "project.md"
      targetFile = path.join(targetDir, fileName)
    } else {
      targetDir = path.join(os.homedir(), ".syncode", "rules")
      const fileName = opts.file ? (opts.file.endsWith(".md") ? opts.file : `${opts.file}.md`) : "global.md"
      targetFile = path.join(targetDir, fileName)
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

