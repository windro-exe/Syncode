import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"
import { persisted } from "@/utils/persist"

const STARTER_RULES = [
  { label: "⚡ Strict Types", rule: "Never use the `any` type in TypeScript — use explicit types or unknown with type narrowing." },
  { label: "🧪 TDD Discipline", rule: "Write and execute unit tests before claiming a task or refactor is complete." },
  { label: "📦 Bun Runtime", rule: "Use bun/bun.cmd for scripts and running commands, never bare npm or npx." },
  { label: "🎯 Early Returns", rule: "Avoid nested if/else statements — prefer guard clauses and early returns." },
  { label: "📝 Conventional Commits", rule: "Format git commits as type(scope): message using standard conventional commit style." },
]

export function DialogProjectRules(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const projectName = createMemo(() => displayName(props.project))
  const storageKey = createMemo(() => `project-rules:${props.project.worktree}`)
  const ideaStorageKey = createMemo(() => `project-idea:${props.project.worktree}`)

  const [rulesStore, setRulesStore] = persisted(
    storageKey(),
    createStore<{ rules: string[] }>({ rules: [] })
  )

  const [ideaStore, setIdeaStore] = persisted(
    ideaStorageKey(),
    createStore<{ idea: string }>({ idea: "" })
  )

  // File-backed rules come from the server (e.g. .syncode/rules/*.md, AGENTS.md).
  // The server response already includes the UI store rules (ui.projectRules), so
  // this list is the single source of truth for display.
  const [serverRules, { refetch }] = createResource(
    () => [serverSDK().client, props.project.worktree] as const,
    async ([client, directory]) => {
      try {
        return (await client.rules.list({ directory })).data ?? []
      } catch {
        return []
      }
    },
  )

  const rules = createMemo(() => {
    const seen = new Set<string>()
    return (serverRules() ?? []).filter((item) => {
      if (seen.has(item.rule)) return false
      seen.add(item.rule)
      return true
    })
  })
  const isStoreRule = (item: { rule: string; file: string }) => item.file === "ui.projectRules"

  const removeFileRule = async (rule: string, filePath: string) => {
    try {
      await serverSDK().client.rules.delete({ rule, filePath, directory: props.project.worktree })
    } catch {
      // fall through to refetch so the list reflects what the server actually has
    }
    void refetch()
  }

  const [draft, setDraft] = createSignal("")
  const [editingIndex, setEditingIndex] = createSignal<number | null>(null)

const addRule = (text?: string) => {
    const value = (text ?? draft()).trim()
    if (!value) return
    const current = rulesStore.rules ?? []
    if (!current.includes(value)) {
      setRulesStore("rules", [...current, value])
    }
    setDraft("")
    void refetch()
  }

  const editRule = (index: number, value: string) => {
    const trimmed = value.trim()
    const current = [...rulesStore.rules]
    if (trimmed) {
      current[index] = trimmed
      setRulesStore("rules", current)
    } else {
      removeRule(index)
    }
    void refetch()
  }

  const removeRule = (index: number) => {
    const current = rulesStore.rules.filter((_, i) => i !== index)
    setRulesStore("rules", current)
    void refetch()
  }

  return (
    <Dialog size="large">
      <div class="flex flex-col h-full max-h-[85vh]">
        <DialogHeader>
          <div class="flex flex-col gap-1">
            <DialogTitle>Project Rules — {projectName()}</DialogTitle>
            <span class="text-12-regular text-text-weak font-mono truncate max-w-md">
              {props.project.worktree}
            </span>
          </div>
        </DialogHeader>
        <DividerV2 />

        <DialogBody class="flex flex-col gap-5 overflow-y-auto p-5">
          {/* Consequence / Operational Notice */}
          <div class="p-3 rounded-lg bg-surface-base border border-border-base flex items-start gap-2.5">
            <Icon name="shield" />
            <div class="flex flex-col gap-0.5 text-12-regular text-text-weak">
              <span class="font-semibold text-text-base">Supreme Priority & Hard Constraints</span>
              <span>
                Project rules are injected into every turn with top precedence over general defaults. Violations are treated as instruction failures.
              </span>
            </div>
          </div>

          {/* Quick Starter Pills */}
          <div class="flex flex-col gap-2">
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Quick Starter Rules</span>
            <div class="flex flex-wrap gap-2">
              <For each={STARTER_RULES}>
                {(item) => (
                  <button
                    type="button"
                    class="px-2.5 py-1 text-12-regular rounded bg-surface-base hover:bg-surface-hover border border-border-base text-text-base transition-colors"
                    onClick={() => addRule(item.rule)}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Active Rules List */}
          <div class="flex flex-col gap-2.5">
<div class="flex items-center justify-between">
              <span class="text-13-medium text-text-base font-semibold">Active Standing Rules</span>
              <span class="text-11-regular text-text-weak">{rules().length} rules</span>
            </div>

            <Show
              when={rules().length > 0}
              fallback={
                <div class="p-4 rounded border border-dashed border-border-base text-center text-12-regular text-text-weak">
                  No project rules configured yet. Add standing rules below or click a starter rule above.
                </div>
              }
            >
              <div class="flex flex-col gap-2 max-h-56 overflow-y-auto">
                <For each={rules()}>
                  {(item, index) => (
                    <div class="flex items-center gap-2 p-2 rounded bg-surface-base border border-border-base hover:border-border-hover group">
                      <span class="text-text-weak font-bold text-14 shrink-0">•</span>
                      <Show when={!isStoreRule(item)}>
                        <span class="px-1.5 py-0.5 text-10-medium rounded bg-surface-base border border-border-base text-text-weak shrink-0">
                          {item.file}
                        </span>
                      </Show>
                      <input
                        type="text"
                        class="flex-1 bg-transparent text-12-regular text-text-base focus:outline-none"
                        value={item.rule}
                        readOnly={!isStoreRule(item)}
                        onBlur={(e) => {
                          if (isStoreRule(item)) editRule(index(), e.currentTarget.value)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur()
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="text-text-weak hover:text-danger p-1 transition-colors shrink-0"
                        title="Remove rule"
                        onClick={() => {
                          if (isStoreRule(item)) removeRule(index())
                          else if (item.path) void removeFileRule(item.rule, item.path)
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Add New Rule Input */}
          <div class="flex items-center gap-2 pt-1">
            <TextInputV2
              class="flex-1"
              value={draft()}
              placeholder="e.g. use pnpm, never npm; or keep functions pure"
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addRule()
                }
              }}
            />
            <ButtonV2 variant="neutral" size="normal" disabled={!draft().trim()} onClick={() => addRule()}>
              Add Rule
            </ButtonV2>
          </div>

          {/* Project Intent / Purpose (IDEA.md) */}
          <div class="flex flex-col gap-1.5 border-t border-border-base pt-4">
            <span class="text-12-medium text-text-base font-semibold">
              Project Purpose & Intent (IDEA.md)
            </span>
            <span class="text-11-regular text-text-weak">
              High-level vision or context that the AI cannot discover by reading code files alone.
            </span>
            <TextareaV2
              rows={3}
              class="w-full text-12-regular font-mono"
              placeholder="What this project is built for, architectural goals, target audience..."
              value={ideaStore.idea}
              onInput={(e) => setIdeaStore("idea", e.currentTarget.value)}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <ButtonV2 variant="neutral" size="normal" onClick={() => dialog.close()}>
            Done
          </ButtonV2>
        </DialogFooter>
      </div>
    </Dialog>
  )
}
