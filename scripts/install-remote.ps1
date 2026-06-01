# Syncode remote installer (Windows) — downloads the latest CLI release binary
# and installs it to ~/.local/bin/opencode.exe.
#
# Public repo: no token needed:
#   irm https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/install-remote.ps1 | iex
# Private repo: set $env:GH_TOKEN first (repo scope).
$ErrorActionPreference = "Stop"

$repo = if ($env:SYNCODE_REPO) { $env:SYNCODE_REPO } else { "windro-xdd/Syncode" }
$dest = if ($env:SYNCODE_BIN)  { $env:SYNCODE_BIN }  else { Join-Path $HOME ".local/bin" }

$headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "syncode-installer" }
if ($env:GH_TOKEN) { $headers["Authorization"] = "token $($env:GH_TOKEN)" }

$arch  = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$asset = "opencode-windows-$arch.exe"

Write-Host "Resolving latest release asset: $asset ..."
$rel = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/latest"
$a = $rel.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
if (-not $a) { throw "Asset $asset not found in latest release of $repo" }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest "opencode.exe"

$dl = @{ "Accept" = "application/octet-stream"; "User-Agent" = "syncode-installer" }
if ($env:GH_TOKEN) { $dl["Authorization"] = "token $($env:GH_TOKEN)" }

# rename-swap: Windows locks a running exe
if (Test-Path $out) { Move-Item $out "$out.old" -Force -ErrorAction SilentlyContinue }
Write-Host "Downloading $asset ..."
Invoke-WebRequest -Headers $dl -Uri $a.url -OutFile $out

Write-Host "Installed -> $out"
& $out --version
if (($env:PATH -split ';') -notcontains $dest) { Write-Host "NOTE: add $dest to your PATH" }
