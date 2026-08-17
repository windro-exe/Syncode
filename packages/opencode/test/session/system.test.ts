import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { SkillActive } from "../../src/skill/active"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { SessionID } from "../../src/session/schema"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
    rules: ["do not run zeta in prod"],
    sections: [{ id: "usage", title: "Usage", content: "zeta usage details" }],
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
    rules: ["alpha rule 1"],
    sections: [{ id: "intro", title: "Intro", content: "alpha intro details" }],
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([SystemPrompt.node, SkillActive.node]), [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Syncode system prompt", () => {
    const prompt = SystemPrompt.provider({ providerID: "anthropic", api: { id: "claude-3-7-sonnet" } } as Provider.Model)[0]
    expect(prompt).toContain("You are Syncode, a fully capable AI assistant")
  })

  it.effect("renders active skills TOC and rules", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const skillActive = yield* SkillActive.Service
      const sid = SessionID.descending()

      yield* skillActive.set(sid, ["alpha-skill", "zeta-skill"])
      const output = (yield* prompt.skills(build, sid)) ?? ""

      expect(output).toContain('<active_skill name="alpha-skill">')
      expect(output).toContain("alpha rule 1")
      expect(output).toContain("<table_of_contents>")
      expect(output).toContain("- intro: Intro")
      expect(output).toContain('<active_skill name="zeta-skill">')
      expect(output).toContain("do not run zeta in prod")
      expect(output).toContain("- usage: Usage")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
