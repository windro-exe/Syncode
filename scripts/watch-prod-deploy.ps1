<#
.SYNOPSIS
    Watches for the legacy production OpenCode process to fully exit, then runs
    deploy-prod.ps1 and writes the default-project.v1 marker into the production
    store. Designed to be launched detached so it survives the agent session that
    armed it. It never stops the running app itself.
#>

$ErrorActionPreference = "Stop"

$oldTarget = Join-Path $env:LOCALAPPDATA "Programs\opencode\OpenCode.exe"
$scriptDir = $PSScriptRoot
$logPath = Join-Path $env:USERPROFILE ".local\share\opencode\watch-prod-deploy.log"

function Write-Log($message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message"
    Add-Content -LiteralPath $logPath -Value $line
    Write-Output $line
}

Write-Log "Watching for $oldTarget to exit..."

while ($true) {
    $running = @(Get-Process -Name "OpenCode*" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $oldTarget })
    if ($running.Count -eq 0) {
        Write-Log "PROD_APP_CLOSED - starting deploy"
        break
    }
    Start-Sleep -Seconds 3
}

# Give the filesystem a moment to release handles, then deploy.
Start-Sleep -Seconds 2
& powershell -ExecutionPolicy Bypass -File (Join-Path $scriptDir "deploy-prod.ps1")
$deployExit = $LASTEXITCODE
Write-Log "PROD_DEPLOY_DONE exit=$deployExit"

# Write the default-project.v1 marker into the production store so the rules
# tool treats Documents\Default Project as the global/default session.
$prodStore = Join-Path $env:APPDATA "ai.opencode.desktop\default.dat"
$defaultProject = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Default Project"
if (Test-Path -LiteralPath $prodStore) {
    try {
        $raw = Get-Content -LiteralPath $prodStore -Raw
        $json = $raw | ConvertFrom-Json -AsHashtable
        $json["default-project.v1"] = $defaultProject
        $json | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $prodStore -Encoding UTF8
        Write-Log "MARKER_WRITTEN $prodStore -> $defaultProject"
    } catch {
        Write-Log "MARKER_WRITE_FAILED: $($_.Exception.Message)"
    }
}

# Verification
$newExe = Join-Path $env:LOCALAPPDATA "Programs\OpenCode\OpenCode.exe"
Write-Log "VERIFY newExeExists=$(Test-Path -LiteralPath $newExe)"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpenCode.lnk"
if (Test-Path -LiteralPath $shortcut) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
    Write-Log "VERIFY shortcutTarget=$target"
}
$cli = Join-Path (Split-Path $newExe) "resources\opencode-cli.exe"
if (Test-Path -LiteralPath $cli) {
    $v = (& $cli --version 2>$null | Select-Object -First 1)
    Write-Log "VERIFY bundledCliVersion=$v"
}
Write-Log "WATCHER_COMPLETE"