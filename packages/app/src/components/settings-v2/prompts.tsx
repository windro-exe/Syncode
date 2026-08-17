import { Component, createSignal, createMemo, For, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSettings, type CustomPromptSetting, defaultPromptPresets } from "@/context/settings"
import { useProviders } from "@/hooks/use-providers"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

interface OptionItem {
  value: string
  label: string
}

export const SettingsPromptsV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const providers = useProviders(() => undefined)

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [isCreating, setIsCreating] = createSignal(false)

  // Form state
  const [formName, setFormName] = createSignal("")
  const [formProvider, setFormProvider] = createSignal("*")
  const [formModel, setFormModel] = createSignal("*")
  const [formPrompt, setFormPrompt] = createSignal("")
  const [formEnabled, setFormEnabled] = createSignal(true)

  // Connected providers from server/runtime
  const connectedProviders = createMemo(() => providers.connected())

  const providerOptions = createMemo<OptionItem[]>(() => {
    const connected = connectedProviders()
    const list = connected.map((p) => ({
      value: p.id,
      label: p.name ? `${p.name} (${p.id})` : p.id,
    }))
    return [
      { value: "*", label: "All Connected Providers (*)" },
      ...list,
    ]
  })

  const currentProviderOption = createMemo(() => {
    const val = formProvider()
    return providerOptions().find((opt) => opt.value === val) ?? { value: val, label: val }
  })

  // Dynamic models under the selected provider
  const availableModels = createMemo<OptionItem[]>(() => {
    const currentP = formProvider()
    if (currentP === "*") {
      return [{ value: "*", label: "All Models (*)" }]
    }
    const found = connectedProviders().find((p) => p.id === currentP)
    if (!found || !found.models) {
      return [{ value: "*", label: "All Models (*)" }]
    }
    const list = Object.values(found.models).map((m) => ({
      value: m.id,
      label: m.name ? `${m.name} (${m.id})` : m.id,
    }))
    return [
      { value: "*", label: `All ${found.name || currentP} Models (*)` },
      ...list,
    ]
  })

  const currentModelOption = createMemo(() => {
    const val = formModel()
    return availableModels().find((opt) => opt.value === val) ?? { value: val, label: val }
  })

  const resetForm = () => {
    setFormName("")
    setFormProvider("*")
    setFormModel("*")
    setFormPrompt("")
    setFormEnabled(true)
    setEditingId(null)
    setIsCreating(false)
  }

  const startCreate = () => {
    const firstConnected = connectedProviders()[0]?.id ?? "*"
    setFormName("New System Prompt")
    setFormProvider(firstConnected)
    setFormModel("*")
    setFormPrompt("")
    setFormEnabled(true)
    setEditingId(null)
    setIsCreating(true)
  }

  const startEdit = (item: CustomPromptSetting) => {
    setFormName(item.name)
    setFormProvider(item.providerID)
    setFormModel(item.modelID)
    setFormPrompt(item.prompt)
    setFormEnabled(item.enabled)
    setEditingId(item.id)
    setIsCreating(false)
  }

  const saveForm = () => {
    const name = formName().trim() || "Custom System Prompt"
    const providerID = formProvider().trim() || "*"
    const modelID = formModel().trim() || "*"
    const prompt = formPrompt()
    const enabled = formEnabled()

    if (editingId()) {
      settings.customPrompts.update(editingId()!, {
        name,
        providerID,
        modelID,
        prompt,
        enabled,
      })
    } else {
      settings.customPrompts.add({
        name,
        providerID,
        modelID,
        prompt,
        enabled,
      })
    }
    resetForm()
  }

  const applyPreset = (preset: CustomPromptSetting) => {
    setFormName(preset.name)
    setFormProvider(preset.providerID)
    setFormModel(preset.modelID)
    setFormPrompt(preset.prompt)
  }

  const prompts = createMemo(() => settings.customPrompts.list())
  const activeCount = createMemo(() => prompts().filter((p) => p.enabled).length)

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1 min-w-0">
            <h2 class="settings-v2-tab-title">Custom System Prompts</h2>
            <p class="text-12-regular text-text-weak">
              Override and customize the system prompt sent to AI models for your connected providers.
            </p>
          </div>
          <Show when={!isCreating() && !editingId()}>
            <div class="shrink-0 whitespace-nowrap">
              <ButtonV2 variant="neutral" size="normal" class="whitespace-nowrap shrink-0 flex items-center gap-1.5" onClick={startCreate}>
                <Icon name="plus-small" />
                <span class="whitespace-nowrap">New Prompt</span>
              </ButtonV2>
            </div>
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Editor / Form modal section */}
        <Show when={isCreating() || editingId()}>
          <div class="settings-v2-section border border-border-base rounded-lg p-5 bg-background-base flex flex-col gap-4">
            <div class="flex items-center justify-between border-b border-border-base pb-3">
              <span class="text-14-medium text-text-base font-semibold">
                {editingId() ? "Edit System Prompt" : "Create New System Prompt"}
              </span>
              <div class="flex items-center gap-2 shrink-0">
                <ButtonV2 variant="ghost" size="small" onClick={resetForm}>
                  Cancel
                </ButtonV2>
                <ButtonV2 variant="neutral" size="small" onClick={saveForm} disabled={!formPrompt().trim()}>
                  Save Changes
                </ButtonV2>
              </div>
            </div>

            {/* Quick Presets */}
            <div class="flex flex-col gap-2">
              <span class="text-11-medium text-text-weak uppercase tracking-wider">Quick Presets</span>
              <div class="flex flex-wrap gap-2">
                <For each={defaultPromptPresets}>
                  {(preset) => (
                    <button
                      type="button"
                      class="px-2.5 py-1 text-12-regular rounded bg-surface-base hover:bg-surface-hover border border-border-base text-text-base transition-colors flex items-center gap-1.5"
                      onClick={() => applyPreset(preset)}
                    >
                      <span>{preset.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* Form Fields */}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="flex flex-col gap-1.5">
                <label class="text-12-medium text-text-weak">Prompt Title</label>
                <TextInputV2
                  value={formName()}
                  onInput={(e) => setFormName(e.currentTarget.value)}
                  placeholder="e.g. Senior Architect / TDD Specialist"
                />
              </div>

              <div class="flex items-center justify-between p-3 rounded bg-surface-base border border-border-base">
                <div class="flex flex-col">
                  <span class="text-13-medium text-text-base">Enable this prompt</span>
                  <span class="text-11-regular text-text-weak">Active system prompts apply automatically</span>
                </div>
                <Switch checked={formEnabled()} onChange={(val) => setFormEnabled(val)} />
              </div>

              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <label class="text-12-medium text-text-weak">Connected Provider</label>
                  <span class="text-10-regular text-text-weak">{connectedProviders().length} connected</span>
                </div>
                <SelectV2<OptionItem>
                  options={providerOptions()}
                  current={currentProviderOption()}
                  value={(opt) => opt.value}
                  label={(opt) => opt.label}
                  onSelect={(opt) => {
                    if (!opt) return
                    setFormProvider(opt.value)
                    setFormModel("*")
                  }}
                />
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-12-medium text-text-weak">Model Selection / Pattern</label>
                <Show
                  when={availableModels().length > 1}
                  fallback={
                    <TextInputV2
                      value={formModel()}
                      onInput={(e) => setFormModel(e.currentTarget.value)}
                      placeholder="e.g. * or specific model id"
                    />
                  }
                >
                  <SelectV2<OptionItem>
                    options={availableModels()}
                    current={currentModelOption()}
                    value={(opt) => opt.value}
                    label={(opt) => opt.label}
                    onSelect={(opt) => opt && setFormModel(opt.value)}
                  />
                </Show>
              </div>
            </div>

            {/* Prompt Body */}
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between">
                <label class="text-12-medium text-text-weak">System Prompt Instructions</label>
                <span class="text-11-regular text-text-weak">
                  {formPrompt().length} characters (~{Math.round(formPrompt().length / 4)} tokens)
                </span>
              </div>
              <textarea
                class="w-full h-48 p-3 text-13-regular font-mono rounded bg-surface-base border border-border-base text-text-base resize-y focus:outline-none focus:border-border-accent"
                value={formPrompt()}
                onInput={(e) => setFormPrompt(e.currentTarget.value)}
                placeholder="Enter custom instructions, rules, tone, and operational guidelines..."
              />
            </div>
          </div>
        </Show>

        {/* Overview Stats */}
        <div class="grid grid-cols-2 gap-4">
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-1">
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Active Prompts</span>
            <span class="text-20-semibold text-text-base">{activeCount()} / {prompts().length}</span>
          </div>
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-1">
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Connected Providers</span>
            <span class="text-12-regular text-text-weak font-mono">
              {connectedProviders().map((p) => p.name || p.id).join(", ") || "None (configure in Providers tab)"}
            </span>
          </div>
        </div>

        {/* Configured Prompts List */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Configured System Prompts</div>
          <SettingsListV2>
            <For each={prompts()}>
              {(item) => (
                <div class="flex items-start justify-between p-4 border-b border-border-base last:border-b-0 hover:bg-surface-hover/30 transition-colors gap-4">
                  <div class="flex flex-col gap-2 flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-14-medium text-text-base font-semibold">{item.name}</span>
                      <span class="px-2 py-0.5 text-10-medium rounded-full bg-surface-base border border-border-base text-text-weak font-mono">
                        {item.providerID} / {item.modelID}
                      </span>
                      <Show when={item.enabled}>
                        <span class="px-2 py-0.5 text-10-medium rounded-full bg-success/10 text-success border border-success/20">
                          Active
                        </span>
                      </Show>
                    </div>
                    <p class="text-12-regular text-text-weak line-clamp-2 font-mono whitespace-pre-wrap">
                      {item.prompt}
                    </p>
                  </div>

                  <div class="flex items-center gap-3 shrink-0">
                    <Switch
                      checked={item.enabled}
                      onChange={() => settings.customPrompts.toggle(item.id)}
                    />
                    <ButtonV2 variant="outline" size="small" onClick={() => startEdit(item)}>
                      <Icon name="edit" />
                    </ButtonV2>
                    <ButtonV2 variant="outline" size="small" onClick={() => settings.customPrompts.remove(item.id)}>
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
