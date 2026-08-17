import { Effect, Schema } from "effect"
import { Skill } from "@/skill"
import { SkillActive } from "@/skill/active"
import * as Tool from "./tool"
import DESCRIPTION from "./skill_section.txt"

export const Parameters = Schema.Struct({
  skill: Schema.optional(Schema.String).annotate({
    description:
      "Name of the active skill to fetch sections from. Required when multiple skills are active; optional when only one is active (defaults to the single active skill).",
  }),
  sections: Schema.Array(Schema.String).annotate({
    description: "Section ids to fetch from the chosen skill's table of contents.",
  }),
})

type Metadata = {
  active: string[]
  resolved: string | null
  requested: string[]
  found: string[]
  unknown: string[]
}
type Result = { title: string; output: string; metadata: Metadata }

function xmlAttr(value: string): string {
  return value.replace(/[<>"]/g, "")
}

// Wrap content in a fence the model won't accidentally close. We pick the
// shortest backtick run that doesn't appear in the content (>= 4) so a
// section that contains literal triple backticks stays intact.
function fenceFor(content: string): string {
  const longest = content.match(/`{3,}/g)?.reduce((acc, m) => Math.max(acc, m.length), 0) ?? 0
  return "`".repeat(Math.max(4, longest + 1))
}

function noActive(): Result {
  return {
    title: "No active skill",
    output: "No skill is active for this turn. Fall back to general reasoning.",
    metadata: { active: [], resolved: null, requested: [], found: [], unknown: [] },
  }
}

function ambiguous(active: string[]): Result {
  return {
    title: "Multiple skills active — pass `skill`",
    output: [
      `Multiple skills are active for this turn: ${active.join(", ")}.`,
      "Call `skill_section` again with the `skill` parameter set to one of the names above.",
    ].join("\n"),
    metadata: { active, resolved: null, requested: [], found: [], unknown: [] },
  }
}

function unknownSkill(requested: string, active: string[]): Result {
  return {
    title: `Skill not active: ${requested}`,
    output: [
      `"${requested}" is not active for this turn.`,
      active.length > 0
        ? `Active skills: ${active.join(", ")}. Pass one of these as \`skill\`.`
        : "No skills are active for this turn.",
    ].join("\n"),
    metadata: { active, resolved: null, requested: [], found: [], unknown: [] },
  }
}

function notFound(name: string, active: string[]): Result {
  return {
    title: `Skill not found: ${name}`,
    output: `Active skill "${name}" was not found in the registry.`,
    metadata: { active, resolved: name, requested: [], found: [], unknown: [] },
  }
}

function emptyRequest(info: Skill.Info, active: string[]): Result {
  return {
    title: `${info.name}: no sections requested`,
    output: [
      `Active skill: ${info.name}`,
      "Pass at least one section id from the table of contents.",
      "<table_of_contents>",
      ...info.sections.map((s) => `  - ${s.id}${s.title ? `: ${s.title}` : ""}`),
      "</table_of_contents>",
    ].join("\n"),
    metadata: { active, resolved: info.name, requested: [], found: [], unknown: [] },
  }
}

function buildResult(info: Skill.Info, requested: string[], active: string[]): Result {
  const found: Skill.SkillSection[] = []
  const unknown: string[] = []
  for (const id of requested) {
    const match = info.sections.find((s) => s.id.toLowerCase() === id.toLowerCase())
    if (match) found.push(match)
    else unknown.push(id)
  }

  const blocks = found.map((s) => {
    const fence = fenceFor(s.content)
    const head = `### ${s.id}${s.title ? ` — ${s.title}` : ""}`
    return [head, fence, s.content, fence].join("\n")
  })
  const unknownBlock =
    unknown.length > 0
      ? [
          `<unknown_sections>`,
          ...unknown.map((id) => `  - ${xmlAttr(id)}`),
          `</unknown_sections>`,
          "Available sections:",
          ...info.sections.map((s) => `  - ${xmlAttr(s.id)}${s.title ? `: ${s.title}` : ""}`),
        ].join("\n")
      : ""

  return {
    title: `${info.name}: ${found.map((s) => s.id).join(", ")}`,
    output: [`<active_skill name="${xmlAttr(info.name)}">`, ...blocks, unknownBlock, `</active_skill>`]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      active,
      resolved: info.name,
      requested,
      found: found.map((s) => s.id),
      unknown,
    },
  }
}

export const SkillSectionTool = Tool.define(
  "skill_section",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const active = yield* SkillActive.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const names = yield* active.get(ctx.sessionID)
          if (names.length === 0) return noActive()

          const requestedSkill = params.skill?.trim()
          let resolved: string
          if (requestedSkill) {
            const match = names.find((n) => n.toLowerCase() === requestedSkill.toLowerCase())
            if (!match) return unknownSkill(requestedSkill, names)
            resolved = match
          } else {
            if (names.length > 1) return ambiguous(names)
            resolved = names[0]
          }

          const info = yield* skill.get(resolved)
          if (!info) return notFound(resolved, names)
          const requested = Array.from(new Set(params.sections.map((s) => s.trim()).filter((s) => s.length > 0)))
          if (requested.length === 0) return emptyRequest(info, names)
          return buildResult(info, requested, names)
        }),
    }
  }),
)
