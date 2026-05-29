import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  router_model: Schema.optional(Schema.String).annotate({
    description:
      "Model used by the auto-router to pick a skill each turn. Format: 'providerID/modelID'. Falls back to small_model when unset.",
  }),
  router_enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the auto-router. Defaults to true when at least one skill is available.",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigSkills from "./skills"
