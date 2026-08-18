<#
.SYNOPSIS
    Verifies an installed OpenCode desktop build (prod or dev) in a visible console
    window. Writes the default-project.v1 marker, checks the exe/shortcut/bundled
    CLI, and prints a colored result. Stays open until the user presses Enter.
    Launched automatically by deploy-prod.ps1 / deploy-dev.ps1 after install.
#>

param(
    [ValidateSet("prod", "dev")]
    [string]$Channel = "prod"
)

$ErrorActionPreference = "Continue"
$title = if ($Channel -eq "dev") { "OpenCode Dev - Install Verification" } else { "OpenCode Production - Install Verification" }
$Host.UI.RawUI.WindowTitle = $title

function Pass($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "  $msg" -ForegroundColor Gray }

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   $title" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$failures = 0

$isProd = $Channel -eq "prod"
$storeName = if ($isProd) { "ai.opencode.desktop" } else { "ai.opencode.desktop.dev" }
$targetDir = Join-Path $env:LOCALAPPDATA "Programs\OpenCode"
$targetExe = Join-Path $targetDir "OpenCode.exe"
$shortcutName = "OpenCode"
if (-not $isProd) {
    $targetDir = Join-Path $env:LOCALAPPDATA "Programs\OpenCode Dev"
    $targetExe = Join-Path $targetDir "OpenCode Dev.exe"
    $shortcutName = "OpenCode Dev"
}

# 1. default-project.v1 marker in the store
$prodStore = Join-Path $env:APPDATA "$storeName\default.dat"
$marker = "default-project.v1"
$defaultProject = "C:\Users\spsid\Documents\Default Project"
try {
    if (Test-Path -LiteralPath $prodStore) {
        $json = Get-Content -LiteralPath $prodStore -Raw | ConvertFrom-Json
    } else {
        $json = @{}
    }
    $json | Add-Member -NotePropertyName $marker -NotePropertyValue $defaultProject -Force
    $json | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $prodStore -Encoding utf8
    Pass "default-project marker written to $prodStore"
    Info "  $marker = $defaultProject"
} catch {
    Fail "could not write default-project marker: $($_.Exception.Message)"
    $failures++
}

# 2. Target exe exists
if (Test-Path -LiteralPath $targetExe) {
    Pass "install exe exists: $targetExe"
    $exeVer = (Get-Item -LiteralPath $targetExe).VersionInfo.FileVersion
    Info "  file version: $exeVer"
} else {
    Fail "install exe MISSING: $targetExe"
    $failures++
}

# 3. Bundled CLI version
$cli = Join-Path (Split-Path $targetExe) "resources\opencode-cli.exe"
if (Test-Path -LiteralPath $cli) {
    $cliVer = (& $cli --version 2>$null | Select-Object -First 1)
    if ($cliVer -match "1\.19\.0-wnxd-v2") {
        Pass "bundled CLI is the local fork build: $cliVer"
    } else {
        Fail "bundled CLI version unexpected: $cliVer"
        $failures++
    }
} else {
    Fail "bundled CLI MISSING: $cli"
    $failures++
}

# 4. Start Menu shortcut target
$shell = New-Object -ComObject WScript.Shell
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$shortcutName.lnk"
if (Test-Path -LiteralPath $lnk) {
    $target = $shell.CreateShortcut($lnk).TargetPath
    if ($target -eq $targetExe) {
        Pass "Start Menu shortcut targets new exe"
    } else {
        Fail "Start Menu shortcut targets $target (expected $targetExe)"
        $failures++
    }
    Info "  $lnk"
} else {
    Fail "Start Menu shortcut MISSING: $lnk"
    $failures++
}

# 5. Running processes for this channel come from the installed dir. Do not let
# prod processes make the dev verification fail (or vice versa).
$processName = if ($isProd) { "OpenCode*" } else { "OpenCode Dev*" }
$running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $paths = $running | Select-Object -ExpandProperty Path -Unique
    $stray = $paths | Where-Object { $_ -and -not [string]::Equals($_, $targetExe, [System.StringComparison]::OrdinalIgnoreCase) }
    if ($stray) {
        Fail "some processes run from an unexpected path:"
        $stray | ForEach-Object { Info "  $_" }
        $failures++
    } else {
        Pass "running processes use the installed exe"
        $paths | ForEach-Object { Info "  $_" }
    }
} else {
    Info "no OpenCode processes running (app closed)"
}

Write-Host ""
if ($failures -eq 0) {
    Write-Host "RESULT: ALL CHECKS PASSED" -ForegroundColor Green
    Write-Host "Production OpenCode is fully migrated with all local fixes." -ForegroundColor Green
} else {
    Write-Host "RESULT: $failures CHECK(S) FAILED" -ForegroundColor Red
}
Write-Host ""
Write-Host "Press Enter to close this window..." -ForegroundColor Yellow
[void][Console]::In.ReadLine()
