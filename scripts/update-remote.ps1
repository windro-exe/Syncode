# Syncode updater (Windows) — compares the installed CLI version against the latest
# published on the Syncode dist branch and, if they differ, downloads the prebuilt
# Windows binary and swaps it in. Only needs PowerShell.
#
#   irm https://raw.githubusercontent.com/windro-xdd/Syncode/wnxd/scripts/update-remote.ps1 | iex
#
# It ONLY replaces the opencode.exe binary. It never touches your config, sessions,
# auth, memory or local settings (%APPDATA%\opencode, ~/.local/share/opencode,
# ~/.config/opencode). The previous binary is kept as opencode.exe.old for rollback.
#
# Env knobs: SYNCODE_REPO (default windro-xdd/Syncode), SYNCODE_DIST_BRANCH
# (default dist), SYNCODE_BIN (default ~/.local/bin). Set $env:SYNCODE_CHECK=1 to
# only compare without installing.
$ErrorActionPreference = "Stop"

$repo   = if ($env:SYNCODE_REPO) { $env:SYNCODE_REPO } else { "windro-xdd/Syncode" }
$branch = if ($env:SYNCODE_DIST_BRANCH) { $env:SYNCODE_DIST_BRANCH } else { "dist" }
$dest   = if ($env:SYNCODE_BIN)  { $env:SYNCODE_BIN }  else { Join-Path $HOME ".local/bin" }
$base   = "https://raw.githubusercontent.com/$repo/$branch"
$arch   = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$asset  = "opencode-windows-$arch.exe.gz"

function Get-Ver([string]$s) {
  if ($s -and ($s -match '[0-9]+\.[0-9]+\.[0-9]+[-.A-Za-z0-9]*')) { return $Matches[0] }
  return ""
}

# Resolve which binary we're updating: prefer one already on PATH, else ~/.local/bin.
$cmd = Get-Command opencode -ErrorAction SilentlyContinue
$target = if ($cmd) { $cmd.Source } else { Join-Path $dest "opencode.exe" }

$installed = ""
if (Test-Path $target) {
  $installed = Get-Ver ((& $target --version 2>$null | Select-Object -First 1))
}
$latest = Get-Ver ((Invoke-RestMethod -Headers @{ "User-Agent" = "syncode-updater" } -Uri "$base/version.json").version)
if (-not $latest) { Write-Error "Could not read latest version from $base/version.json"; exit 1 }

Write-Host "installed: $(if ($installed) { $installed } else { '(none)' })    latest: $latest"
if ($installed -eq $latest) { Write-Host "Already up to date."; exit 0 }
if ($env:SYNCODE_CHECK -eq "1") {
  Write-Host "Update available: $(if ($installed) { $installed } else { '(none)' }) -> $latest  (run without SYNCODE_CHECK to install)"
  exit 0
}

$tmp   = [System.IO.Path]::GetTempFileName()
$tmpgz = "$tmp.gz"
$tmpex = "$tmp.exe"
try {
  Write-Host "Downloading $asset ..."
  Invoke-WebRequest -Headers @{ "User-Agent" = "syncode-updater" } -Uri "$base/$asset" -OutFile $tmpgz

  # Decompress gzip via .NET (no external tools needed).
  $in  = [System.IO.File]::OpenRead($tmpgz)
  $out = [System.IO.File]::Create($tmpex)
  $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
  try { $gz.CopyTo($out) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }

  # Verify the downloaded binary actually runs before installing.
  $newver = Get-Ver ((& $tmpex --version 2>$null | Select-Object -First 1))
  if (-not $newver) { Write-Error "Downloaded binary failed to run; not installing."; exit 1 }

  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  # rename-swap: Windows locks a running exe, so move the old one aside first.
  if (Test-Path $target) { Move-Item $target "$target.old" -Force -ErrorAction SilentlyContinue }
  Move-Item $tmpex $target -Force

  Write-Host "Updated $(if ($installed) { $installed } else { '(none)' }) -> $newver"
  Write-Host "Your config, sessions and settings are untouched. Previous binary saved as $target.old"
}
finally {
  Remove-Item $tmp, $tmpgz -Force -ErrorAction SilentlyContinue
}
