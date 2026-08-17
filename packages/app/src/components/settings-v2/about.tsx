import { Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsAboutV2: Component = () => {
  const platform = usePlatform()
  const settings = useSettings()

  return (
    <div class="settings-v2-tab">
      <div class="settings-v2-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">About Syncode v2</h2>
          <p class="text-12-regular text-text-weak">
            System runtime information, memory persistence, and anti-overwrite security shield status.
          </p>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        {/* Version Badge Card */}
        <div class="p-5 rounded-lg bg-surface-base border border-border-base flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-lg bg-border-accent/10 border border-border-accent/30 flex items-center justify-center text-border-accent font-bold text-18">
              SY
            </div>
            <div class="flex flex-col">
              <span class="text-16-semibold text-text-base">Syncode v2</span>
              <span class="text-12-regular text-text-weak">Autonomous AI Pair Programming Environment</span>
            </div>
          </div>
          <div class="px-3 py-1 text-12-medium rounded-full bg-border-accent/10 text-border-accent border border-border-accent/30 font-mono">
            1.19.0-wnxd-v2
          </div>
        </div>

        {/* Protection Shield */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Security & Feature Protection</div>
          <div class="p-4 rounded-lg bg-success/5 border border-success/20 flex items-start gap-3">
            <div class="text-success mt-0.5">
              <Icon name="shield" />
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-13-medium text-text-base font-semibold">Anti-Overwrite Shield Active</span>
              <span class="text-12-regular text-text-weak">
                In-app auto-updaters and remote update polling are hard-disabled to ensure your local memory system, custom prompts, and fork features are never overwritten by upstream releases.
              </span>
            </div>
          </div>
        </div>

        {/* System & Architecture Details */}
        <div class="settings-v2-section">
          <div class="settings-v2-section-title">Environment & Runtime</div>
          <SettingsListV2>
            <SettingsRowV2
              title="Installed Syncode Version"
              description="Local executable version stamp"
            >
              <span class="text-12-regular font-mono text-text-base">1.19.0-wnxd-v2</span>
            </SettingsRowV2>

            <SettingsRowV2
              title="Upstream Codebase Base"
              description="Synced upstream OpenCode release"
            >
              <span class="text-12-regular font-mono text-text-base">v1.18.18 (dev)</span>
            </SettingsRowV2>

            <SettingsRowV2
              title="Desktop App Version"
              description="Electron host package version"
            >
              <span class="text-12-regular font-mono text-text-base">v{platform.version}</span>
            </SettingsRowV2>

            <SettingsRowV2
              title="Memory Database Backend"
              description="High-performance full-text search indexing"
            >
              <span class="text-12-regular font-mono text-text-base">SQLite 3 + FTS5</span>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </div>
  )
}
