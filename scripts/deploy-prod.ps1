<#
.SYNOPSIS
    Deploys local dev changes to the installed Production Syncode Desktop and CLI.
.DESCRIPTION
    1. Builds and installs the production CLI binary to ~/.local/bin/opencode.exe
    2. Builds and packages the production Desktop app
    3. Safely updates the installed app at %LOCALAPPDATA%\Programs\@opencode-aidesktop\
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Deploying Syncode to Production     " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

# 1. Build and install CLI
Write-Host "`n[1/3] Building and installing production CLI..." -ForegroundColor Yellow
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\install.ps1"

# 2. Build and package desktop app
Write-Host "`n[2/3] Building and packaging production Desktop app..." -ForegroundColor Yellow
Push-Location "$RepoRoot\packages\desktop"
try {
    & bun.cmd run build
    & bun.cmd run package:win
} finally {
    Pop-Location
}

# 3. Deploy to production folder
Write-Host "`n[3/3] Deploying to %LOCALAPPDATA%\Programs\@opencode-aidesktop..." -ForegroundColor Yellow
$SourceDir = "$RepoRoot\packages\desktop\dist\win-unpacked"
$TargetDir = "$env:LOCALAPPDATA\Programs\@opencode-aidesktop"

if (Test-Path $SourceDir) {
    # Stop running production instances gracefully
    Get-Process -Name OpenCode* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    Copy-Item -Path "$SourceDir\*" -Destination $TargetDir -Recurse -Force
    Write-Host "`n✔ Production Desktop and CLI successfully updated!" -ForegroundColor Green
    Write-Host "Production Desktop: $TargetDir\OpenCode.exe" -ForegroundColor Green
    Write-Host "Production CLI:     $env:USERPROFILE\.local\bin\opencode.exe" -ForegroundColor Green
} else {
    Write-Error "Production build folder $SourceDir was not found."
}
