import { describe, expect, test } from "bun:test"
import {
  hasExistingWebState,
  initialAgentVisibility,
  isAppUpgrade,
  layoutTransitionState,
  maximumSunsetTimeout,
  newLayoutDesignsDefault,
  nextSunsetCheckDelay,
  resolveNewLayoutDesigns,
  shouldDisplayTabsToast,
  shouldEnableNewLayout,
} from "./settings"

describe("agent visibility", () => {
  test("shows the picker for existing profiles and hides it for first-time installs", () => {
    expect(initialAgentVisibility(undefined, true)).toBe(true)
    expect(initialAgentVisibility(undefined, false)).toBe(false)
  })

  test("shows the picker when updating from a recent release", () => {
    expect(initialAgentVisibility(undefined, false, "1.18.8")).toBe(true)
  })

  test("preserves the preference after initialization", () => {
    expect(initialAgentVisibility(true, true, "1.18.8")).toBeUndefined()
    expect(initialAgentVisibility(true, false)).toBeUndefined()
  })
})

describe("layout transition", () => {
  test("blank profiles default to the new layout", () => {
    expect(newLayoutDesignsDefault).toBe(true)
  })

  test("hides the transition until a sunset is scheduled", () => {
    expect(layoutTransitionState(false, true, false, false)).toEqual({ available: false, notice: false })
  })

  test("existing profiles can switch before sunset", () => {
    expect(layoutTransitionState(true, true, false, false)).toEqual({ available: true, notice: false })
  })

  test("classifies web profiles from existing settings or a recorded version", () => {
    expect(hasExistingWebState("{}", undefined)).toBe(true)
    expect(hasExistingWebState(null, "1.17.19")).toBe(true)
    expect(hasExistingWebState(null, undefined)).toBe(false)
  })

  test("preserves explicit and default layout preferences", () => {
    expect(resolveNewLayoutDesigns(false, false, true)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, false)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, true)).toBe(true)
  })

  test("sunset replaces the toggle with a dismissible notice", () => {
    expect(layoutTransitionState(true, true, true, false)).toEqual({ available: false, notice: true })
    expect(layoutTransitionState(true, true, true, true)).toEqual({ available: false, notice: false })
    expect(resolveNewLayoutDesigns(true, false)).toBe(true)
  })

  test("caps checks for sunsets beyond the browser timeout limit", () => {
    expect(nextSunsetCheckDelay(maximumSunsetTimeout + 1_000, 0)).toBe(maximumSunsetTimeout)
    expect(nextSunsetCheckDelay(10_000, 9_000)).toBe(1_000)
    expect(nextSunsetCheckDelay(9_000, 10_000)).toBe(0)
  })

  test("enables the new layout when upgrading from 1.17.19 or earlier", () => {
    expect(shouldEnableNewLayout("v1.17.19", "1.17.20")).toBe(true)
    expect(shouldEnableNewLayout("1.16.9", "2.0.0")).toBe(true)
  })

  test("enables the new layout when no previous version was recorded", () => {
    expect(shouldEnableNewLayout(undefined, "1.17.20")).toBe(true)
  })

  test("detects upgrades only when a previous version is older", () => {
    expect(isAppUpgrade("1.17.19", "1.17.20")).toBe(true)
    expect(isAppUpgrade(undefined, "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.20", "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.21", "1.17.20")).toBe(false)
  })

  test("shows the tabs toast for upgrades and existing installs without a recorded version", () => {
    expect(shouldDisplayTabsToast("1.17.19", "1.17.20", false)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", true)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", false)).toBe(false)
  })

  test("does not enable the new layout without a qualifying upgrade", () => {
    expect(shouldEnableNewLayout("1.17.19", "1.17.19")).toBe(false)
    expect(shouldEnableNewLayout("1.17.20", "1.17.21")).toBe(false)
    expect(shouldEnableNewLayout(undefined, "1.17.19")).toBe(false)
    expect(shouldEnableNewLayout("dev", "1.17.20")).toBe(false)
  })
})

describe("settings persistence & custom prompts migration", () => {
  test("migrates custom prompts by preserving all items and setting enabled to false on restart", () => {
    const raw = {
      general: {
        shellToolPartsExpanded: true,
        editToolPartsExpanded: true,
      },
      customPrompts: [
        {
          id: "prompt-1",
          name: "My Custom Prompt",
          providerID: "openrouter",
          modelID: "stealth/ox-alpha",
          prompt: "Custom system prompt body",
          enabled: true,
        },
        {
          id: "preset-antigravity",
          name: "Antigravity",
          providerID: "*",
          modelID: "*",
          prompt: "Preset prompt body",
          enabled: true,
        },
      ],
    }

    const migrate = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value
      const data = value as Record<string, unknown>
      if (Array.isArray(data.customPrompts)) {
        data.customPrompts = data.customPrompts.map((p) => {
          if (!p || typeof p !== "object") return p
          return { ...p, enabled: false }
        })
      }
      return data
    }

    const migrated = migrate(raw) as typeof raw
    expect(migrated.general.shellToolPartsExpanded).toBe(true)
    expect(migrated.general.editToolPartsExpanded).toBe(true)
    expect(migrated.customPrompts).toHaveLength(2)
    expect(migrated.customPrompts[0].name).toBe("My Custom Prompt")
    expect(migrated.customPrompts[0].enabled).toBe(false)
    expect(migrated.customPrompts[1].enabled).toBe(false)
  })
})
