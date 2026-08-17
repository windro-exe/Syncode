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
    & bun.cmd run package:win
} finally {
    Pop-Location
}

Write-Host "`n[3/3] Installing OpenCode Production to Windows..." -ForegroundColor Yellow
$Installer = (Get-ChildItem "$RepoRoot\packages\desktop\dist\*.exe" -Exclude "*dev*", "*uninstaller*" | Select-Object -First 1).FullName
$SourceDir = "$RepoRoot\packages\desktop\dist\win-unpacked"

Get-Process -Name OpenCode* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if ($Installer -and (Test-Path $Installer)) {
    Write-Host "Running production installer silently: $Installer" -ForegroundColor Gray
    Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
} elseif (Test-Path $SourceDir) {
    Copy-Item -Path "$SourceDir\*" -Destination "$env:LOCALAPPDATA\Programs\OpenCode" -Recurse -Force
}

$cliPath = "$env:USERPROFILE\.local\bin\opencode.exe"
Write-Host "`n[DONE] OpenCode Production successfully installed!" -ForegroundColor Green
Write-Host "Start Menu Entry: OpenCode" -ForegroundColor Green
Write-Host "Desktop Binary:   $TargetDir\OpenCode.exe" -ForegroundColor Green
Write-Host "CLI Binary:       $cliPath" -ForegroundColor Green
