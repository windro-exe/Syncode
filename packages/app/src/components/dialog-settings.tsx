import { Component, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsServers } from "./settings-servers"
import { SettingsPromptsV2 } from "./settings-v2/prompts"
import { SettingsAppearanceV2 } from "./settings-v2/appearance"
import { SettingsRulesV2 } from "./settings-v2/rules"
import { SettingsSkillsV2 } from "./settings-v2/skills"
import { SettingsEngineV2 } from "./settings-v2/engine"
import { SettingsAboutV2 } from "./settings-v2/about"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")

  const showProviders = () => {
    void dialog.show(() => <DialogSettings defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full gap-4">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="appearance">
                      <Icon name="photo" />
                      Appearance
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>Customizations</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="prompts">
                      <Icon name="prompt" />
                      Custom Prompts
                    </Tabs.Trigger>
                    <Tabs.Trigger value="rules">
                      <Icon name="shield" />
                      Global Rules
                    </Tabs.Trigger>
                    <Tabs.Trigger value="skills">
                      <Icon name="brain" />
                      Skills
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>Engine</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="engine">
                      <Icon name="server" />
                      Engine & Memory
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>System</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="about">
                      <Icon name="shield" />
                      About Syncode
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">1.19.0-wnxd-v2</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="appearance" class="no-scrollbar">
          <SettingsAppearanceV2 />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="prompts" class="no-scrollbar">
          <SettingsPromptsV2 />
        </Tabs.Content>
        <Tabs.Content value="rules" class="no-scrollbar">
          <SettingsRulesV2 />
        </Tabs.Content>
        <Tabs.Content value="skills" class="no-scrollbar">
          <SettingsSkillsV2 />
        </Tabs.Content>
        <Tabs.Content value="engine" class="no-scrollbar">
          <SettingsEngineV2 />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsServers />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders onBack={showProviders} />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="about" class="no-scrollbar">
          <SettingsAboutV2 />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
