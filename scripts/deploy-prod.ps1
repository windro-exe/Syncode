<#
.SYNOPSIS
    Deploys and installs Production OpenCode (clean UI, no dev badge).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Deploying OpenCode to PRODUCTION    " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$env:OPENCODE_CHANNEL = "prod"
$env:VITE_OPENCODE_CHANNEL = "prod"

Write-Host "`n[1/3] Building and installing production CLI..." -ForegroundColor Yellow
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\install.ps1"

Write-Host "`n[2/3] Building and packaging production Desktop app..." -ForegroundColor Yellow
Push-Location "$RepoRoot\packages\desktop"
try {
    & bun.cmd run build
    & bun.cmd run package:win
} finally {
    Pop-Location
}

Write-Host "`n[3/3] Installing OpenCode Production to Windows..." -ForegroundColor Yellow
$Installer = "$RepoRoot\packages\desktop\dist\opencode-desktop-win-x64.exe"
$SourceDir = "$RepoRoot\packages\desktop\dist\win-unpacked"
$TargetDir = "$env:LOCALAPPDATA\Programs\@opencode-aidesktop"

Get-Process -Name OpenCode* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path $Installer) {
    Write-Host "Running production installer silently..." -ForegroundColor Gray
    Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
} elseif (Test-Path $SourceDir) {
    Copy-Item -Path "$SourceDir\*" -Destination $TargetDir -Recurse -Force
}

$cliPath = "$env:USERPROFILE\.local\bin\opencode.exe"
Write-Host "`n[DONE] OpenCode Production successfully installed!" -ForegroundColor Green
Write-Host "Start Menu Entry: OpenCode" -ForegroundColor Green
Write-Host "Desktop Binary:   $TargetDir\OpenCode.exe" -ForegroundColor Green
Write-Host "CLI Binary:       $cliPath" -ForegroundColor Green
