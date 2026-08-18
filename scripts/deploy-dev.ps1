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
$TargetDir = Join-Path $env:LOCALAPPDATA "Programs\OpenCode Dev"
$TargetExe = Join-Path $TargetDir "OpenCode Dev.exe"
$StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpenCode Dev.lnk"
$RunningTarget = @(Get-Process -Name "OpenCode*" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $TargetExe })
if ($RunningTarget.Count -gt 0) { throw "OpenCode Dev is running at $TargetExe. Close it before deploying; the script will not stop running agents." }

$env:OPENCODE_CHANNEL = "dev"
$env:VITE_OPENCODE_CHANNEL = "dev"

Write-Host "`n[1/2] Building and packaging OpenCode Dev app..." -ForegroundColor Yellow
Push-Location "$RepoRoot\packages\desktop"
try {
    & bun.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE" }
    & bun.cmd run package:win
    if ($LASTEXITCODE -ne 0) { throw "Desktop packaging failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "`n[2/2] Installing OpenCode Dev to Windows..." -ForegroundColor Yellow
$Installer = (Get-ChildItem "$RepoRoot\packages\desktop\dist\opencode-dev-*.exe" -Exclude "*uninstaller*" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$SourceDir = "$RepoRoot\packages\desktop\dist\win-unpacked"

if ($Installer -and (Test-Path $Installer)) {
    Write-Host "Running OpenCode Dev installer silently: $Installer" -ForegroundColor Gray
    $InstallProcess = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
    if ($InstallProcess.ExitCode -ne 0) { throw "Development installer failed with exit code $($InstallProcess.ExitCode)" }
} elseif (Test-Path $SourceDir) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Copy-Item -Path "$SourceDir\*" -Destination $TargetDir -Recurse -Force
    New-Item -ItemType Directory -Path (Split-Path $StartMenuShortcut) -Force | Out-Null
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuShortcut)
    $Shortcut.TargetPath = $TargetExe
    $Shortcut.WorkingDirectory = $TargetDir
    $Shortcut.Save()
} else {
    throw "Development installer and unpacked app were not found under $RepoRoot\packages\desktop\dist"
}

if (-not (Test-Path -LiteralPath $TargetExe)) { throw "Development executable was not installed at $TargetExe" }
if (-not (Test-Path -LiteralPath $StartMenuShortcut)) { throw "Development Start Menu shortcut was not installed at $StartMenuShortcut" }

$devData = "$env:APPDATA\ai.opencode.desktop.dev"
Write-Host "`n[DONE] OpenCode Dev successfully installed!" -ForegroundColor Green
Write-Host "Start Menu Entry: OpenCode Dev" -ForegroundColor Green
Write-Host "Desktop Binary:   $TargetExe" -ForegroundColor Green
Write-Host "Data Directory:   $devData" -ForegroundColor Green

# Visible verification window so the result is readable without asking the agent.
Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","$PSScriptRoot\verify-prod-install.ps1","-Channel","dev") -WorkingDirectory "$env:USERPROFILE"
