# Installing Syncode

Syncode is a fork of opencode. Two ways to install:

## 1. Download a prebuilt binary (easiest)

Grab the binary for your OS from the repo's **Releases** page, then put it on your `PATH`.

| OS | Asset |
|----|-------|
| Windows x64 | `opencode-windows-x64.exe` |
| macOS (Apple Silicon) | `opencode-darwin-arm64` |
| macOS (Intel) | `opencode-darwin-x64` |
| Linux x64 | `opencode-linux-x64` |
| Linux arm64 | `opencode-linux-arm64` |

**macOS / Linux**
```bash
chmod +x opencode-*           # the file you downloaded
mkdir -p ~/.local/bin
mv opencode-* ~/.local/bin/opencode
# ensure ~/.local/bin is on your PATH
opencode --version
```

**Windows (PowerShell)**
```powershell
mkdir "$HOME\.local\bin" -Force
Move-Item .\opencode-windows-x64.exe "$HOME\.local\bin\opencode.exe" -Force
# ensure %USERPROFILE%\.local\bin is on your PATH
opencode --version
```

**Desktop (Windows only, for now):** run `OpenCode-desktop-windows-x64-installer.exe` (oneClick). macOS/Linux desktop installers ship later via CI.

## 2. Build from source

Requires [Bun](https://bun.sh).

```bash
# from the repo root
bash scripts/install.sh        # macOS / Linux
# or
pwsh scripts/install.ps1       # Windows
```

This builds the CLI and installs it to `~/.local/bin/opencode`. Set `OPENCODE_VERSION` to override the stamp.

> Note: the in-app auto-updater is intentionally disabled in this fork — updates are manual rebuilds (so upstream releases can't overwrite local features).
