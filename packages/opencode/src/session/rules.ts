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

export function loadProjectRules(cwd: string): RuleFile[] {
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

  return results
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
  const datDirs = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "ai.opencode.desktop") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "ai.opencode.desktop.dev") : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode") : null,
    path.join(os.homedir(), ".config", "opencode"),
  ].filter(Boolean) as string[]

  for (const datDir of datDirs) {
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
}): string | undefined {
  const projectList = opts.projectRules.map((r) => r.trim()).filter(Boolean)
  const globalList = opts.globalRules.map((r) => r.trim()).filter(Boolean)

  if (projectList.length === 0 && globalList.length === 0) {
    return undefined
  }

  const sections: string[] = [
    "## Operational Rules & Negative Constraints (MANDATORY)",
    "",
    "The following operational rules are strict, inviolable constraints for THIS session.",
    "Where a project rule conflicts with general defaults, persona, or phrasing, the project rule takes absolute precedence.",
    "",
  ]

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
