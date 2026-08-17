import { Component, createMemo } from "solid-js"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

interface OptionItem {
  value: string
  label: string
}

const ROUTER_MODELS: OptionItem[] = [
  { value: "small_model", label: "Default Small Model (Fast & Efficient)" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek-V4 / V3 Chat" },
  { value: "anthropic/claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
]

export const SettingsCustomizationsV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const currentRouterModelOption = createMemo(() =>
    ROUTER_MODELS.find((opt) => opt.value === settings.syncode.routerModel()) ?? {
      value: settings.syncode.routerModel(),
      label: settings.syncode.routerModel(),
    }
  )

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">Skills, Memory & Engine</h2>
          <p class="text-12-regular text-text-weak">
            Configure Antigravity progressive skill routing, SQLite+FTS5 persistent memory, and autonomous execution loops.
          </p>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Antigravity Skill Router */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Antigravity Skill Router & Rules</div>
          <SettingsListV2>
            <SettingsRowV2
              title="Autonomous Skill Router"
              description="Per-turn router model selects relevant skills, injecting only rules and TOC to save prompt tokens"
            >
              <Switch
                checked={settings.syncode.skillRouter()}
                onChange={(val) => settings.syncode.setSkillRouter(val)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Skill Router Model"
              description="Lightweight model used to evaluate user intent against available skill catalog"
            >
              <SelectV2<OptionItem>
                options={ROUTER_MODELS}
                current={currentRouterModelOption()}
                value={(opt) => opt.value}
                label={(opt) => opt.label}
                onSelect={(opt) => opt && settings.syncode.setRouterModel(opt.value)}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        {/* Persistent Memory System */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Two-Tier Persistent Memory</div>
          <SettingsListV2>
            <SettingsRowV2
              title="Auto-Memory Sliding Window Distillation"
              description="Automatically distills evicted context turns into persistent notes when reaching 80% window limit"
            >
              <Switch
                checked={settings.syncode.autoMemory()}
                onChange={(val) => settings.syncode.setAutoMemory(val)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title="Memory Backend"
              description="Persistent storage backend with BM25 ranking, recency decay, and salience weighting"
            >
              <div class="px-2.5 py-1 text-12-medium rounded bg-surface-base border border-border-base text-text-base font-mono">
                SQLite + FTS5 (Active)
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        {/* Autonomous Loops */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Autonomous Goal Engine (/goal)</div>
          <SettingsListV2>
            <SettingsRowV2
              title="Maximum Autonomous Iterations"
              description="Safety clamp for consecutive automated turns executed under a single goal objective"
            >
              <div class="flex items-center gap-3">
                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  value={settings.syncode.goalIterations()}
                  onInput={(e) => settings.syncode.setGoalIterations(Number(e.currentTarget.value))}
                  class="w-32 accent-accent"
                />
                <span class="text-12-medium text-text-base w-12">{settings.syncode.goalIterations()} turns</span>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        {/* Discovery Directory Reference */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Customization Discovery Locations</div>
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-2.5 text-12-regular text-text-weak">
            <div class="flex items-center justify-between border-b border-border-base pb-2">
              <span class="font-medium text-text-base">Workspace Skills:</span>
              <span class="font-mono text-11-regular">.agents/skills/, .claude/skills/, .opencode/skill/</span>
            </div>
            <div class="flex items-center justify-between border-b border-border-base pb-2">
              <span class="font-medium text-text-base">Global Skills:</span>
              <span class="font-mono text-11-regular">~/.agents/skills/, ~/.claude/skills/</span>
            </div>
            <div class="flex items-center justify-between border-b border-border-base pb-2">
              <span class="font-medium text-text-base">Rule Files:</span>
              <span class="font-mono text-11-regular">AGENTS.md, CONTEXT.md (Hierarchical)</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="font-medium text-text-base">Persistent Memories:</span>
              <span class="font-mono text-11-regular">/memories/system.md, /memories/agent.md</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
