import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "prod"
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const CHANNEL_NAMES = {
  dev: { name: "opencode-dev", productName: "OpenCode Dev" },
  beta: { name: "opencode-beta", productName: "OpenCode Beta" },
  prod: { name: "opencode", productName: "OpenCode" },
} as const

const CHANNEL_GUIDS = {
  dev: "7c3a0b4d-1e2f-4a5b-9c8d-0e1f2a3b4c5d",
  beta: "8d4b1c5e-2f30-4b6a-ad9e-1f2a3b4c5d6e",
  prod: "6b2a9e1c-0f1e-3a4b-8c7d-9e0f1a2b3c4d",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: `${CHANNEL_NAMES[channel].name}-\${os}-\${arch}.\${ext}`,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    name: CHANNEL_NAMES[channel].name,
    productName: CHANNEL_NAMES[channel].productName,
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],
  extraResources: [
    // wnxd fork: bundle the local CLI in every channel so the desktop sidecar
    // runs this fork's build, not an upstream release.
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: CHANNEL_NAMES[channel].productName,
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    executableName: CHANNEL_NAMES[channel].productName,
    // Only wire signing under CI. Locally signWindows is a no-op, but merely
    // declaring signtoolOptions makes electron-builder download+extract the
    // winCodeSign tooling, which fails on Windows without admin/Developer Mode
    // (it contains macOS symlinks). Omit it locally so unsigned local builds work.
    ...(process.env.GITHUB_ACTIONS === "true" ? { signtoolOptions: { sign: signWindows } } : {}),
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    // Assisted NSIS uses productFilename for the per-user install directory.
    oneClick: false,
    perMachine: false,
    guid: CHANNEL_GUIDS[channel],
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    include: "installer.nsh",
    shortcutName: CHANNEL_NAMES[channel].productName,
    uninstallDisplayName: CHANNEL_NAMES[channel].productName,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: CHANNEL_NAMES[channel].productName,
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: CHANNEL_NAMES[channel].productName,
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: CHANNEL_NAMES[channel].productName,
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        // wnxd fork: no `publish` feed — local fork must never auto-update from
        // upstream anomalyco releases (would wipe local features). Updater is
        // also hard-disabled in src/main/constants.ts.
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
