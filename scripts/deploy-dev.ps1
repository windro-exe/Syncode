<#
.SYNOPSIS
    Deploys and installs OpenCode Dev (with DEV badge and debug tools).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "     Deploying OpenCode DEV App         " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$env:OPENCODE_CHANNEL = "dev"
$env:VITE_OPENCODE_CHANNEL = "dev"

Write-Host "`n[1/2] Building and packaging OpenCode Dev app..." -ForegroundColor Yellow
Push-Location "$RepoRoot\packages\desktop"
try {
    & bun.cmd run build
    & bun.cmd run package:win
} finally {
    Pop-Location
}

Write-Host "`n[2/2] Installing OpenCode Dev to Windows..." -ForegroundColor Yellow
$Installer = "$RepoRoot\packages\desktop\dist\opencode-desktop-win-x64.exe"

Get-Process -Name "OpenCode Dev*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path $Installer) {
    Write-Host "Running OpenCode Dev installer silently..." -ForegroundColor Gray
    Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
}

$devData = "$env:APPDATA\ai.opencode.desktop.dev"
Write-Host "`n[DONE] OpenCode Dev successfully installed!" -ForegroundColor Green
Write-Host "Start Menu Entry: OpenCode Dev" -ForegroundColor Green
Write-Host "Data Directory:   $devData" -ForegroundColor Green
