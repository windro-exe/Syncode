# Syncode updater (Windows) - compares the installed CLI version against the latest
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
# (default dist), SYNCODE_BIN (install dir, default ~/.local/bin), SYNCODE_CHECK=1
# (compare only, don't install).
#
# Wrapped in a function so it works under `irm | iex`: `return` won't close the
# caller's window (a bare `exit` would) and $ErrorActionPreference stays local.

function Invoke-SyncodeUpdate {
  [CmdletBinding()] param()
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # IWR is glacially slow on PS 5.1 otherwise

  $repo   = if ($env:SYNCODE_REPO) { $env:SYNCODE_REPO } else { "windro-xdd/Syncode" }
  $branch = if ($env:SYNCODE_DIST_BRANCH) { $env:SYNCODE_DIST_BRANCH } else { "dist" }
  $dest   = if ($env:SYNCODE_BIN)  { $env:SYNCODE_BIN }  else { Join-Path $HOME ".local/bin" }
  $base   = "https://raw.githubusercontent.com/$repo/$branch"
  $arch   = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
  $asset  = "opencode-windows-$arch.exe.gz"
  $hdr    = @{ "User-Agent" = "syncode-updater" }

  function Get-Ver([string]$s) {
    if ($s -and ($s -match '[0-9]+\.[0-9]+\.[0-9]+[-.A-Za-z0-9]*')) { return $Matches[0] }
    return ""
  }

  # Canonical install location, matching the installer. Warn (don't hijack) if a
  # different opencode shadows it on PATH.
  $target = Join-Path $dest "opencode.exe"
  $cmd = Get-Command opencode -ErrorAction SilentlyContinue
  if ($cmd -and ($cmd.Source -ne $target)) {
    Write-Host "note: a different 'opencode' is on your PATH at $($cmd.Source)"
    Write-Host "      this updater manages $target (set SYNCODE_BIN to change)."
  }

  $installed = ""
  if (Test-Path $target) { $installed = Get-Ver ((& $target --version 2>$null | Select-Object -First 1)) }

  # Fetch version.json as text and regex it - Invoke-RestMethod's JSON parsing
  # depends on the response Content-Type, and raw.githubusercontent serves text/plain.
  $manifest = (Invoke-WebRequest -UseBasicParsing -Headers $hdr -Uri "$base/version.json").Content
  $latest = Get-Ver $manifest
  if (-not $latest) { Write-Warning "Could not read latest version from $base/version.json"; return }

  $shown = if ($installed) { $installed } else { "(none)" }
  Write-Host "installed: $shown    latest: $latest"
  if ($installed -eq $latest) { Write-Host "Already up to date."; return }
  if ($env:SYNCODE_CHECK -eq "1") {
    Write-Host "Update available: $shown -> $latest  (run without SYNCODE_CHECK to install)"
    return
  }

  # Stage in the install dir so the final move is a same-volume rename.
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $stem  = Join-Path $dest (".opencode." + [guid]::NewGuid().ToString("N"))
  $tmpgz = "$stem.gz"
  $tmpex = "$stem.exe"
  try {
    Write-Host "Downloading $asset ..."
    Invoke-WebRequest -UseBasicParsing -Headers $hdr -Uri "$base/$asset" -OutFile $tmpgz

    # Decompress gzip via .NET (no external tools needed).
    $in  = [System.IO.File]::OpenRead($tmpgz)
    $out = [System.IO.File]::Create($tmpex)
    $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    try { $gz.CopyTo($out) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }

    # Verify the downloaded binary actually runs before installing.
    $newver = Get-Ver ((& $tmpex --version 2>$null | Select-Object -First 1))
    if (-not $newver) { Write-Warning "Downloaded binary failed to run; not installing."; return }

    # Atomic-ish swap: move the (possibly running) old exe aside, then move new in.
    # Do NOT silence a failed aside-move - if it fails we must not clobber a locked exe.
    if (Test-Path $target) { Move-Item $target "$target.old" -Force }
    try {
      Move-Item $tmpex $target -Force
    } catch {
      if (Test-Path "$target.old") { Move-Item "$target.old" $target -Force }
      throw
    }
    $tmpex = $null   # consumed by the move; nothing to clean

    Write-Host "Updated $shown -> $newver"
    Write-Host "Your config, sessions and settings are untouched."
    if (Test-Path "$target.old") { Write-Host "Previous binary saved as $target.old" }
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if (($userPath -split ';') -notcontains $dest) {
      Write-Host "note: $dest is not on your PATH - add it so 'opencode' resolves here."
    }
  }
  finally {
    foreach ($p in @($tmpgz, $tmpex)) { if ($p -and (Test-Path $p)) { Remove-Item $p -Force -ErrorAction SilentlyContinue } }
  }
}

Invoke-SyncodeUpdate
