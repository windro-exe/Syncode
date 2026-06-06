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

## 3. Update an existing install

Syncode ships its own remote updater. It checks your installed version against the
latest published on the `dist` branch and, if they differ, downloads the prebuilt
binary for your OS and swaps it in. No Bun, no build, no GitHub Releases needed.

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.ps1 | iex
```

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.sh | bash
```

The same command also works for a **fresh install** (when no binary is present yet).
It only replaces the `opencode` binary — your config, sessions, auth and settings
(`~/.config/opencode`, `~/.local/share/opencode`, `%APPDATA%\opencode`) are never
touched, and the previous binary is kept as `opencode(.exe).old` for rollback. Add
`--check` (sh) or `$env:SYNCODE_CHECK=1` (ps1) to only compare without installing.

> Publishing a new version (maintainer): `bash scripts/publish-to-branch.sh <version>`
> rebuilds all targets and force-pushes the gzipped binaries + `version.json` to the
> `dist` branch.

> Note: the in-app auto-updater is intentionally disabled in this fork (so upstream
> opencode releases can't overwrite local features). Use the Syncode updater above.
