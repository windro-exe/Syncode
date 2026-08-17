import { Component } from "solid-js"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsEngineV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">Engine & Memory Architecture</h2>
          <p class="text-12-regular text-text-weak">
            Manage two-tier SQLite+FTS5 persistent memory indexing, auto-distillation, and autonomous execution loops.
          </p>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Two-Tier Persistent Memory */}
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

        {/* Autonomous Goal Loops */}
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

        {/* Memory Storage Locations */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Persistent Memory Locations</div>
          <div class="p-4 rounded-lg bg-surface-base border border-border-base flex flex-col gap-2.5 text-12-regular text-text-weak">
            <div class="flex items-center justify-between border-b border-border-base pb-2">
              <span class="font-medium text-text-base">System Profile Memory:</span>
              <span class="font-mono text-11-regular">/memories/system.md</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="font-medium text-text-base">Agent Persona Memory:</span>
              <span class="font-mono text-11-regular">/memories/agent.md</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
