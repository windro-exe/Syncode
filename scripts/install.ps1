# Syncode CLI installer (Windows) — builds from source and installs to ~/.local/bin/opencode.exe
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Write-Error "bun is required: https://bun.sh"; exit 1 }

$stamp = if ($env:OPENCODE_VERSION) { $env:OPENCODE_VERSION } else { "1.16.13-wnxd" }
Write-Host "Building Syncode CLI ($stamp) — this compiles all targets and may take a few minutes..."
Push-Location (Join-Path $root "packages/opencode")
bun install
$env:OPENCODE_VERSION = $stamp
bun run build

$dest = Join-Path $HOME ".local/bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$target = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "opencode-windows-arm64" } else { "opencode-windows-x64" }
$src = Join-Path (Get-Location) "dist/$target/bin/opencode.exe"

# rename-swap because Windows locks a running exe
$installed = Join-Path $dest "opencode.exe"
if (Test-Path $installed) { Move-Item $installed "$installed.old" -Force -ErrorAction SilentlyContinue }
Copy-Item $src $installed -Force
Pop-Location
Write-Host "Installed $target to $installed ($stamp). Ensure $dest is on your PATH."
