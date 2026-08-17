import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useSettings, type GlobalRuleSetting } from "@/context/settings"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const RULE_PRESETS: Array<{ label: string; rule: string; category: string }> = [
  { label: "⚡ No `any` Type", rule: "Never use the `any` type in TypeScript — always use strict types or unknown with type narrowing.", category: "TypeScript" },
  { label: "🛡️ Effect / No Try-Catch", rule: "Avoid try/catch wrappers where possible; prefer Effect/Option/Result pipelines or early returns.", category: "Architecture" },
  { label: "🧪 Strict TDD", rule: "Write tests before implementation and run the test suite before claiming completion.", category: "Testing" },
  { label: "📦 Bun Execution", rule: "Use bun/bun.cmd for scripts and commands, never bare npm or npx shims.", category: "Environment" },
  { label: "📝 Conventional Commits", rule: "Format git commits as type(scope): message using conventional commits style.", category: "Git" },
  { label: "🎯 Minimal Variables", rule: "Do not extract single-use variables or helpers preemptively; inline logic cleanly.", category: "Simplicity" },
]

export const SettingsRulesV2: Component = () => {
  const settings = useSettings()
  const serverSDK = useServerSDK()

  const [draft, setDraft] = createSignal("")
  const [draftCategory, setDraftCategory] = createSignal("General")

const [serverRules, { refetch }] = createResource(
    () => serverSDK().client,
    async (client) => (await client.global.rules()).data ?? [],
  )
  const rules = createMemo(() => {
    const local = settings.globalRules.list().map((rule) => ({ ...rule, source: "settings" as const }))
    const localRules = new Set(local.map((rule) => rule.rule))
    const external = (serverRules() ?? [])
      .filter((rule) => !localRules.has(rule.rule))
      .map((rule) => ({
        id: `file:${rule.file}:${rule.rule}`,
        rule: rule.rule,
        category: rule.file,
        enabled: rule.enabled,
        filePath: rule.path,
        source: "file" as const,
      }))
    return [...local, ...external]
  })
  const activeCount = createMemo(() => rules().filter((r) => r.enabled).length)

  const removeFileRule = async (rule: string, filePath: string) => {
    try {
      await serverSDK().client.global.rules2.delete({ rule, filePath })
    } catch {
      // fall through to refetch so the list reflects what the server actually has
    }
    void refetch()
  }

  const addRule = (text?: string, category?: string) => {
    const ruleText = (text ?? draft()).trim()
    if (!ruleText) return
    settings.globalRules.add({
      rule: ruleText,
      category: (category ?? draftCategory().trim()) || "General",
      enabled: true,
    })
    setDraft("")
  }

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1 min-w-0">
            <h2 class="settings-v2-tab-title">Global Rules & Negative Constraints</h2>
            <p class="text-12-regular text-text-weak">
              Inviolable developer laws applied across all workspaces and sessions.
            </p>
          </div>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Strict Enforcement Banner */}
        <div class="p-4 rounded-lg bg-surface-base border border-border-base flex items-start gap-3">
          <div class="text-text-base mt-0.5">
            <Icon name="shield" />
          </div>
          <div class="flex flex-col gap-1 text-12-regular text-text-weak">
            <span class="text-13-medium text-text-base font-semibold">Priority & Consequence Enforcement</span>
            <span>
              Every rule is sent to the model with supreme priority. Violations are treated as instruction failures, and the model is mandated to verify all actions against these rules.
            </span>
          </div>
        </div>

        {/* Quick Presets */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Quick Starter Rule Presets</div>
          <div class="flex flex-wrap gap-2">
            <For each={RULE_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class="px-3 py-1.5 text-12-regular rounded bg-surface-base hover:bg-surface-hover border border-border-base text-text-base transition-colors flex items-center gap-1.5"
                  onClick={() => addRule(preset.rule, preset.category)}
                >
                  <span>{preset.label}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Add New Global Rule */}
        <div class="settings-v2-section border border-border-base rounded-lg p-4 bg-surface-base flex flex-col gap-3">
          <span class="text-13-medium text-text-base font-semibold">Add New Standing Rule</span>
          <div class="flex items-center gap-2">
            <TextInputV2
              class="flex-1"
              value={draft()}
              placeholder="e.g. Always write automated tests before declaring a task complete"
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
        </div>

        {/* Overview Stats */}
        <div class="grid grid-cols-2 gap-4">
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-1">
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Active Global Rules</span>
            <span class="text-20-semibold text-text-base">{activeCount()} / {rules().length}</span>
          </div>
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-1">
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Precedence Hierarchy</span>
            <span class="text-12-regular text-text-weak">Project Rules &gt; Global Rules &gt; Persona &gt; Defaults</span>
          </div>
        </div>

        {/* Active Rules List */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Active Global Rules</div>
          <SettingsListV2>
            <For each={rules()}>
              {(item) => (
                <div class="flex items-start justify-between p-4 border-b border-border-base last:border-b-0 hover:bg-surface-hover/30 transition-colors gap-4">
                  <div class="flex flex-col gap-1.5 flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="px-2 py-0.5 text-10-medium rounded-full bg-surface-base border border-border-base text-text-weak">
                        {item.category || "Rule"}
                      </span>
                      <Show when={item.enabled}>
                        <span class="px-2 py-0.5 text-10-medium rounded-full bg-success/10 text-success border border-success/20">
                          Active
                        </span>
                      </Show>
                    </div>
                    <input
                      type="text"
                      class="w-full bg-transparent text-13-regular text-text-base focus:outline-none"
                      value={item.rule}
                       readOnly={item.source === "file"}
                       onBlur={(e) => {
                         if (item.source === "settings") {
                           settings.globalRules.update(item.id, { rule: e.currentTarget.value.trim() || item.rule })
                         }
                       }}
                    />
                  </div>

                  <div class="flex items-center gap-3 shrink-0">
                    <Switch
                      checked={item.enabled}
                      disabled={item.source === "file"}
                      onChange={() => {
                        if (item.source === "settings") settings.globalRules.toggle(item.id)
                      }}
                    />
<ButtonV2
                      variant="outline"
                      size="small"
                      onClick={() => {
                        if (item.source === "settings") settings.globalRules.remove(item.id)
                        else if (item.source === "file" && item.filePath) void removeFileRule(item.rule, item.filePath)
                      }}
                    >
                      <Icon name="trash" />
                    </ButtonV2>
                  </div>
                </div>
              )}
            </For>
          </SettingsListV2>
        </div>
      </div>
    </div>
  )
}
