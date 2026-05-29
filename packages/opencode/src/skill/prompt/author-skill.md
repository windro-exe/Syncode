<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts. The body below becomes the
  skill's content.
-->

# Authoring an opencode skill

opencode picks one skill per turn via an auto-router (DeepSeek-V4-Flash by
default). The router sees only the skill's `name` and `description`. When a
skill is picked, opencode injects its **rules** and a **table of contents**
into the system prompt, and the model pulls section bodies on demand with
the `skill_section` tool.

A good skill has three jobs:

1. Make `description` route correctly — short, trigger-shaped, names what the
   user is trying to do.
2. List **rules** the model must follow whenever the skill is active.
3. Split the body into named **sections** so the model only loads what it
   needs.

## file-layout

| Scope    | Path                                                |
| -------- | --------------------------------------------------- |
| Project  | `.opencode/skill(s)/<name>/SKILL.md`                |
| Global   | `~/.config/opencode/skill(s)/<name>/SKILL.md`       |
| External | `~/.claude/skills/<name>/SKILL.md` (auto-loaded)    |

The folder name should match `name` in the frontmatter.

## template

A complete SKILL.md looks like this:

```markdown
---
name: review-pr
description: Use when the user asks to review a pull request, code diff, or merge request
rules:
  - Never approve a PR that touches authentication or authorization without manual verification
  - Always check for missing tests on new code paths
  - Surface security concerns before style nits
  - Quote exact lines when calling out a problem; never paraphrase
sections:
  - id: workflow
    title: Step-by-step review workflow
  - id: checklist
    title: Code-review checklist
  - id: examples
    title: Example reviews (good and bad)
---

## workflow

(Body for the workflow section — markdown allowed.)

## checklist

(Body for the checklist section.)

## examples

(Body for the examples section.)
```

Section ids in the YAML must match the `## <id>` headings in the body
exactly (case-insensitive).

## description

The description is the *only* signal the router has. Make it specific and
trigger-shaped. Lead with "Use when …".

Good:
- `Use when the user asks to review a pull request or code diff`
- `Use ONLY when the user is editing opencode's own opencode.json or .opencode/ files`
- `Use when generating SQL migrations for the project's Postgres database`

Bad:
- `Helps with code review` (no trigger)
- `Various PR utilities` (vague)
- `Code quality skill` (router can't tell when to pick it)

If a skill should *only* fire in narrow conditions, write `Use ONLY when …`
and name the conditions explicitly. If a skill is about a noun the user might
mention casually (e.g. "skill", "agent", "config"), narrow further so it
doesn't hijack debugging or general conversation.

## rules

Rules are the negative-prompt block. Short, imperative, one rule per line.
Format: "Never X", "Always Y", "Do not Z", "Only ever W". They get injected
verbatim every turn the skill is active, so:

- Keep each rule under ~120 chars.
- Aim for 3-7 rules. More than 10 is a smell — split the skill or move
  detail into a section.
- Write rules the model would otherwise get wrong. Don't restate generic
  good behavior ("write clean code") — only what's specific to this skill.
- If a rule has a *why*, append it after a dash: `Never approve auth changes
  without manual verification — past incident: 2025-Q3 token leak`.

Example block:

```yaml
rules:
  - Never run destructive SQL (DROP, TRUNCATE, DELETE without WHERE) without explicit user confirmation
  - Always EXPLAIN ANALYZE before suggesting an index — index choices depend on row counts
  - Quote table and column names with double quotes; this database is case-sensitive
```

## sections

Each entry in `sections:` declares a section by `id`. The body must contain
a matching `## <id>` heading. Section ids should be **single lowercase
words or kebab-case** — they're used as `skill_section` tool arguments, so
the model has to type them.

Good ids: `workflow`, `checklist`, `examples`, `error-handling`, `setup`.
Bad ids: `Step 1`, `My Workflow`, `errors_and_exceptions` (snake_case is
inconsistent with the rest of the system).

Section titles (`title:`) are human-readable and shown in the table of
contents. Keep them short — they help the model decide which section to
fetch.

Aim for 2-6 sections. With one section you don't need sections at all (the
body becomes one implicit `body` section automatically). With ten the TOC
gets noisy — split into multiple skills.

What goes in which section, by convention:

- **workflow / steps** — ordered procedure the model follows
- **checklist** — things to verify before declaring done
- **examples** — concrete good/bad inputs and outputs
- **reference** — schemas, command-line flags, API shapes
- **gotchas** — known pitfalls and how to avoid them

The model fetches sections on demand, so put the most-needed content in
the most obviously-named section.

Skills with no `rules:` and no `sections:` still work. They're treated as
one implicit `body` section with no rules. You don't need to migrate
existing skills unless you want the new behavior.

## checklist

Before saving, verify:

- `name:` matches the parent folder name
- `description:` starts with "Use when" and names a specific trigger
- `description:` is narrow enough that the router won't hijack unrelated requests
- `rules:` are imperative and skill-specific (not generic)
- Every `sections[].id` has a matching `## <id>` heading in the body
- Section ids are lowercase / kebab-case (no spaces, no snake_case)
- File saved as `<scope>/skill(s)/<name>/SKILL.md`
- After saving, **tell the user to quit and restart opencode** — skills are
  loaded once at startup, not hot-reloaded
