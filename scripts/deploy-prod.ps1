<#
.SYNOPSIS
    Deploys and installs Production OpenCode (clean UI, no dev badge).
#>

[CmdletBinding()]
param(
    [switch]$RebuildCLI
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Deploying OpenCode to PRODUCTION    " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TargetDir = Join-Path $env:LOCALAPPDATA "Programs\OpenCode"
$TargetExe = Join-Path $TargetDir "OpenCode.exe"
$StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpenCode.lnk"
$RunningTarget = @(Get-Process -Name "OpenCode*" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $TargetExe })
if ($RunningTarget.Count -gt 0) { throw "Production is running at $TargetExe. Close it before deploying; the script will not stop running agents." }

$env:OPENCODE_CHANNEL = "prod"
$env:VITE_OPENCODE_CHANNEL = "prod"

if ($RebuildCLI) {
    Write-Host "`n[1/3] Building and installing production CLI..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\install.ps1"
} else {
    Write-Host "`n[1/3] Skipping CLI rebuild (pass -RebuildCLI to rebuild CLI binary)" -ForegroundColor Gray
}

Write-Host "`n[2/3] Building and packaging production Desktop app..." -ForegroundColor Yellow
Push-Location "$RepoRoot\packages\desktop"
try {
    & bun.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE" }
    & bun.cmd run package:win
    if ($LASTEXITCODE -ne 0) { throw "Desktop packaging failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "`n[3/3] Installing OpenCode Production to Windows..." -ForegroundColor Yellow
$Installer = (Get-ChildItem "$RepoRoot\packages\desktop\dist\opencode-win-*.exe" -Exclude "*uninstaller*" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$SourceDir = "$RepoRoot\packages\desktop\dist\win-unpacked"

if ($Installer -and (Test-Path $Installer)) {
    Write-Host "Running production installer silently: $Installer" -ForegroundColor Gray
    $InstallProcess = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
    if ($InstallProcess.ExitCode -ne 0) { throw "Production installer failed with exit code $($InstallProcess.ExitCode)" }
} elseif (Test-Path $SourceDir) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Copy-Item -Path "$SourceDir\*" -Destination $TargetDir -Recurse -Force
    New-Item -ItemType Directory -Path (Split-Path $StartMenuShortcut) -Force | Out-Null
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuShortcut)
    $Shortcut.TargetPath = $TargetExe
    $Shortcut.WorkingDirectory = $TargetDir
    $Shortcut.Save()
} else {
    throw "Production installer and unpacked app were not found under $RepoRoot\packages\desktop\dist"
}

if (-not (Test-Path -LiteralPath $TargetExe)) { throw "Production executable was not installed at $TargetExe" }
if (-not (Test-Path -LiteralPath $StartMenuShortcut)) { throw "Production Start Menu shortcut was not installed at $StartMenuShortcut" }

$cliPath = "$env:USERPROFILE\.local\bin\opencode.exe"
Write-Host "`n[DONE] OpenCode Production successfully installed!" -ForegroundColor Green
Write-Host "Start Menu Entry: OpenCode" -ForegroundColor Green
Write-Host "Desktop Binary:   $TargetExe" -ForegroundColor Green
Write-Host "CLI Binary:       $cliPath" -ForegroundColor Green
