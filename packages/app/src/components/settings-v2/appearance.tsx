import { Component, For, Show, createMemo } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSettings, type SyncodeSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

interface OptionItem {
  value: string
  label: string
}

const THEME_PRESETS: Array<{ id: SyncodeSettings["themePreset"]; name: string; desc: string; bg: string; border: string }> = [
  { id: "system", name: "System Adaptive", desc: "Follow OS preference automatically", bg: "bg-surface-base", border: "border-border-base" },
  { id: "dark", name: "Deep Dark", desc: "Default dark aesthetic with high contrast", bg: "bg-[#18181b]", border: "border-[#27272a]" },
  { id: "light", name: "Clean Light", desc: "Crisp daytime workspace palette", bg: "bg-[#f4f4f5]", border: "border-[#e4e4e7]" },
  { id: "midnight", name: "Midnight Void", desc: "OLED true-black with subtle indigo tones", bg: "bg-[#09090b]", border: "border-[#1e1b4b]" },
  { id: "slate", name: "Antigravity Slate", desc: "Modern developer studio slate and charcoal", bg: "bg-[#0f172a]", border: "border-[#334155]" },
  { id: "cyberpunk", name: "Cyberpunk Glow", desc: "Neon cyan and violet hacker theme", bg: "bg-[#0a0a14]", border: "border-[#8b5cf6]" },
  { id: "obsidian", name: "Solarized Obsidian", desc: "Warm tinted dark theme easy on the eyes", bg: "bg-[#1c1917]", border: "border-[#44403c]" },
]

const ACCENT_COLORS = [
  { id: "#3b82f6", name: "Syncode Blue", color: "#3b82f6" },
  { id: "#8b5cf6", name: "Neon Violet", color: "#8b5cf6" },
  { id: "#10b981", name: "Emerald", color: "#10b981" },
  { id: "#f59e0b", name: "Amber Gold", color: "#f59e0b" },
  { id: "#ec4899", name: "Rose Glow", color: "#ec4899" },
  { id: "#06b6d4", name: "Cyber Cyan", color: "#06b6d4" },
]

const DENSITY_OPTIONS: OptionItem[] = [
  { value: "compact", label: "Compact (High information density)" },
  { value: "normal", label: "Normal (Balanced spacing)" },
  { value: "relaxed", label: "Relaxed (Spacious layout)" },
]

const CONTEXT_BAR_OPTIONS: OptionItem[] = [
  { value: "bar", label: "Visual Progress Bar (━/─ with ratio and %)" },
  { value: "percentage", label: "Percentage Only" },
  { value: "minimal", label: "Minimalist / Hidden" },
]

export const SettingsAppearanceV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const currentTheme = createMemo(() => settings.syncode.themePreset())
  const currentAccent = createMemo(() => settings.syncode.accentColor())

  const currentDensityOption = createMemo(() =>
    DENSITY_OPTIONS.find((opt) => opt.value === settings.syncode.density()) ?? DENSITY_OPTIONS[1]
  )

  const currentContextBarOption = createMemo(() =>
    CONTEXT_BAR_OPTIONS.find((opt) => opt.value === settings.syncode.contextBarStyle()) ?? CONTEXT_BAR_OPTIONS[0]
  )

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">Appearance & Customization</h2>
          <p class="text-12-regular text-text-weak">
            Personalize themes, accent tones, typography, and visual density across the Syncode workspace.
          </p>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Theme Presets */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Theme Presets</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <For each={THEME_PRESETS}>
              {(theme) => {
                const isSelected = () => currentTheme() === theme.id
                return (
                  <button
                    type="button"
                    class={`p-3.5 rounded-lg border text-left transition-all flex flex-col gap-2 relative ${
                      theme.bg
                    } ${
                      isSelected()
                        ? "border-border-accent ring-2 ring-border-accent/40 shadow-sm"
                        : "border-border-base hover:border-border-hover"
                    }`}
                    onClick={() => settings.syncode.setThemePreset(theme.id)}
                  >
                    <div class="flex items-center justify-between">
                      <span class="text-13-medium text-text-base font-semibold">{theme.name}</span>
                      <Show when={isSelected()}>
                        <div class="w-2 h-2 rounded-full bg-border-accent" />
                      </Show>
                    </div>
                    <span class="text-11-regular text-text-weak">{theme.desc}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>

        {/* Accent Colors */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Accent Color</div>
          <div class="flex items-center gap-3 flex-wrap">
            <For each={ACCENT_COLORS}>
              {(accent) => {
                const isSelected = () => currentAccent() === accent.id
                return (
                  <button
                    type="button"
                    class={`w-8 h-8 rounded-full transition-transform flex items-center justify-center ${
                      isSelected() ? "scale-125 ring-2 ring-offset-2 ring-offset-background-base ring-border-accent" : "hover:scale-110"
                    }`}
                    style={{ "background-color": accent.color }}
                    title={accent.name}
                    onClick={() => settings.syncode.setAccentColor(accent.id)}
                  >
                    <Show when={isSelected()}>
                      <Icon name="check-small" />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </div>

        {/* Interface Layout & Typography */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Layout & Context Bar</div>
          <SettingsListV2>
            <SettingsRowV2
              title="Interface Density"
              description="Adjust padding and information density in lists and prompts"
            >
              <SelectV2<OptionItem>
                options={DENSITY_OPTIONS}
                current={currentDensityOption()}
                value={(opt) => opt.value}
                label={(opt) => opt.label}
                onSelect={(opt) => opt && settings.syncode.setDensity(opt.value as any)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Context Bar Format"
              description="Style of token capacity bar rendered in prompt status footer"
            >
              <SelectV2<OptionItem>
                options={CONTEXT_BAR_OPTIONS}
                current={currentContextBarOption()}
                value={(opt) => opt.value}
                label={(opt) => opt.label}
                onSelect={(opt) => opt && settings.syncode.setContextBarStyle(opt.value as any)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Base Font Size"
              description="Adjust the primary font size of the application"
            >
              <div class="flex items-center gap-3">
                <input
                  type="range"
                  min="11"
                  max="18"
                  step="1"
                  value={settings.appearance.fontSize()}
                  onInput={(e) => settings.appearance.setFontSize(Number(e.currentTarget.value))}
                  class="w-32 accent-accent"
                />
                <span class="text-12-medium text-text-base w-8">{settings.appearance.fontSize()}px</span>
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title="UI Font Family"
              description="Custom font family used for interface elements"
            >
              <TextInputV2
                value={settings.appearance.uiFont()}
                onInput={(e) => settings.appearance.setUIFont(e.currentTarget.value)}
                placeholder="System Default"
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Code Font Family"
              description="Monospace font for diffs and code snippets"
            >
              <TextInputV2
                value={settings.appearance.font()}
                onInput={(e) => settings.appearance.setFont(e.currentTarget.value)}
                placeholder="System Mono"
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Terminal Font Family"
              description="Font used for embedded interactive terminals"
            >
              <TextInputV2
                value={settings.appearance.terminalFont()}
                onInput={(e) => settings.appearance.setTerminalFont(e.currentTarget.value)}
                placeholder="JetBrainsMono Nerd Font Mono"
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </div>
  )
}
