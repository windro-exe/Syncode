# Syncode remote installer (Windows) — downloads the latest CLI release binary
# and installs it to ~/.local/bin/opencode.exe. Only needs PowerShell.
#
#   irm https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/install-remote.ps1 | iex
#
# (If the repo is private, set $env:GH_TOKEN with repo scope first.)
$ErrorActionPreference = "Stop"

$repo = if ($env:SYNCODE_REPO) { $env:SYNCODE_REPO } else { "windro-xdd/Syncode" }
$dest = if ($env:SYNCODE_BIN)  { $env:SYNCODE_BIN }  else { Join-Path $HOME ".local/bin" }
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$asset = "opencode-windows-$arch.exe"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest "opencode.exe"

$headers = @{ "User-Agent" = "syncode-installer" }
if ($env:GH_TOKEN) { $headers["Authorization"] = "token $($env:GH_TOKEN)" }

# rename-swap: Windows locks a running exe
if (Test-Path $out) { Move-Item $out "$out.old" -Force -ErrorAction SilentlyContinue }
Write-Host "Downloading $asset (latest release) ..."
Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/releases/latest/download/$asset" -OutFile $out

Write-Host "Installed -> $out"
& $out --version

# Auto-add to user PATH so `opencode` works from any terminal
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -split ';' -notcontains $dest) {
  $newPath = if ($userPath) { "$dest;$userPath" } else { $dest }
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  $env:PATH = "$dest;$env:PATH"
  Write-Host "Added $dest to user PATH — restart your terminal or run:  refreshenv"
}
