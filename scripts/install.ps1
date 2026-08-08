# Syncode CLI installer (Windows) - builds from local source and installs to ~/.local/bin/opencode.exe
#
# Designed to be run unattended by an agent:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# No env setup required. Pass -AllTargets to cross-compile every platform (release
# builds only); the default builds just this machine's target, which is ~10x faster.
#
# This NEVER touches config, sessions, auth or memory - only the binary.
# The previous binary is kept as opencode.exe.old for rollback.

[CmdletBinding()]
param(
  [switch]$AllTargets,
  [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

# Resolve bun to a real executable. Do NOT use `bun` off PATH: npm installs a bun.ps1
# shim that PowerShell prefers, and it dies under a restricted execution policy.
$bun = @(
  $env:BUN_EXE
  (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
  (Get-Command bun.cmd -ErrorAction SilentlyContinue).Source
  (Join-Path $HOME ".bun\bin\bun.exe")
  (Join-Path $env:APPDATA "npm\bun.cmd")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $bun) { Write-Error "bun is required and was not found: https://bun.sh"; exit 1 }

# Version stamp. Script.version otherwise falls back to `git branch --show-current`,
# which yields a garbage `0.0.0--<timestamp>` stamp on a machine with no git (or a
# tree with no .git). The stamp must also stay semver-ABOVE the latest upstream npm
# release so the in-app auto-updater never decides to overwrite this build.
$stamp = @($Version, $env:OPENCODE_VERSION) | Where-Object { $_ } | Select-Object -First 1
if (-not $stamp) {
  $file = Join-Path $root "SYNCODE_VERSION"
  if (-not (Test-Path -LiteralPath $file)) { Write-Error "No version stamp: pass -Version or create $file"; exit 1 }
  $stamp = (Get-Content -LiteralPath $file -Raw).Trim()
}
if ($stamp -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') { Write-Error "Version stamp '$stamp' must start with N.N.N"; exit 1 }

$pkg = Join-Path $root "packages\opencode"
$target = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "opencode-windows-arm64" } else { "opencode-windows-x64" }
Write-Host "Building Syncode $stamp ($target) with $bun"

Push-Location $pkg
try {
  $env:OPENCODE_VERSION = $stamp

  # Not fatal: `tree-sitter-powershell` compiles a native binding via node-gyp and
  # fails without Visual Studio. The package ships a .wasm and the repo parses via
  # web-tree-sitter, so the build below succeeds anyway. The build + smoke test are
  # the real gate, not this exit code.
  & $bun install
  if ($LASTEXITCODE -ne 0) { Write-Warning "bun install exited $LASTEXITCODE (native postinstall likely failed) - continuing" }

  $buildArgs = @("run", "script/build.ts")
  if (-not $AllTargets) { $buildArgs += "--single" }
  & $bun @buildArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "build failed with exit code $LASTEXITCODE"; exit 1 }
}
finally { Pop-Location }

$src = Join-Path $pkg "dist\$target\bin\opencode.exe"
if (-not (Test-Path -LiteralPath $src)) { Write-Error "build produced no binary at $src"; exit 1 }

# Verify the fresh binary runs before letting it near the install path.
$built = (& $src --version 2>$null | Select-Object -First 1)
if ($built -notmatch [regex]::Escape($stamp)) { Write-Error "built binary reports '$built', expected '$stamp' - not installing"; exit 1 }

$dest = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$installed = Join-Path $dest "opencode.exe"

# Windows locks a running exe, so move it aside rather than overwriting. Don't silence
# this: if the aside-move fails we must not clobber a locked binary.
if (Test-Path -LiteralPath $installed) { Move-Item -LiteralPath $installed "$installed.old" -Force }
try { Copy-Item -LiteralPath $src -Destination $installed -Force }
catch {
  if (Test-Path -LiteralPath "$installed.old") { Move-Item -LiteralPath "$installed.old" $installed -Force }
  throw
}

Write-Host "Installed $target -> $installed ($stamp)"
Write-Host "Config, sessions, auth and memory are untouched. Restart any running session to pick this up."
if (([Environment]::GetEnvironmentVariable("PATH", "User") -split ';') -notcontains $dest) {
  Write-Host "note: $dest is not on your user PATH - add it so 'opencode' resolves here."
}
