<#
.SYNOPSIS
    Syncode release script (local, Windows). Turns a prod merge into a real
    release: bumps the version stamp, tags, builds the CLI + desktop installer,
    publishes the GitHub Release (desktop updater feed) and updates the dist
    branch (CLI/TUI updater feed). After this completes, both in-app updaters
    will offer the new version.

    Run from the repo root:
      powershell -ExecutionPolicy Bypass -File .\scripts\release.ps1

    Requirements: gh CLI authed as windro, git, bun.cmd, on the prod branch
    with a clean tree (the .syncode/rules/rules.md local modification is allowed).

    -DryRun prints the plan and validates the environment without changing anything.
#>
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $RepoRoot
try {
    # ------------------------------------------------------------------ env checks
    $branch = git branch --show-current
    if (-not $DryRun -and $branch -ne "prod") { throw "release must run from the prod branch (on $branch)" }
    if (-not $DryRun) {
        $dirty = git status --porcelain | Where-Object { $_ -notmatch "\.syncode/rules/rules\.md" }
        if ($dirty) { throw "working tree is dirty:`n$dirty" }
    }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh CLI is required" }
    if (-not (Get-Command bun.cmd -ErrorAction SilentlyContinue)) { throw "bun.cmd is required" }

    # ------------------------------------------------------------------ version bump
    $stamp = (Get-Content "SYNCODE_VERSION" -Raw).Trim()
    if ($stamp -notmatch '^(?<base>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+)?)-v(?<n>[0-9]+)$') {
        throw "SYNCODE_VERSION '$stamp' does not match the <semver>-v<N> pattern"
    }
    $next = "$($Matches.base)-v$([int]$Matches.n + 1)"
    $tag = "v$next"
    # PS 5.1 turns native stderr into a terminating error under EAP=Stop;
    # a repo without tags writes to stderr, so capture defensively.
    $prevTag = ""
    try { $prevTag = git describe --tags --abbrev=0 2>$null | Select-Object -First 1 } catch { }

    Write-Host "release: $stamp -> $next (tag $tag)" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host "DRY RUN - would: bump SYNCODE_VERSION, commit 'release: $next', push prod, tag $tag," -ForegroundColor Yellow
        Write-Host "  build CLI + desktop, gh release create $tag, update dist branch (version.json + windows binary)" -ForegroundColor Yellow
        return
    }

    # ------------------------------------------------------------------ commit + tag
    Set-Content "SYNCODE_VERSION" $next -NoNewline
    git add SYNCODE_VERSION
    git commit -m "release: $next"
    git push origin prod
    git tag $tag
    git push origin $tag
    Write-Host "[1/5] version bumped, prod + tag pushed" -ForegroundColor Green

    # ------------------------------------------------------------------ build CLI
    Write-Host "[2/5] building CLI (this takes a few minutes)..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\install.ps1"
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed with exit code $LASTEXITCODE" }
    $cliBin = Join-Path $RepoRoot "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
    if (-not (Test-Path $cliBin)) { throw "built CLI not found at $cliBin" }
    $cliVer = & $cliBin --version 2>$null | Select-Object -First 1
    if ($cliVer -ne $next) { throw "built CLI reports '$cliVer', expected '$next'" }

    # ------------------------------------------------------------------ build desktop
    Write-Host "[3/5] building desktop installer..." -ForegroundColor Yellow
    Push-Location "$RepoRoot\packages\desktop"
    try {
        & bun.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "desktop build failed ($LASTEXITCODE)" }
        & bun.cmd run package:win
        if ($LASTEXITCODE -ne 0) { throw "desktop packaging failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    $installer = Get-ChildItem "$RepoRoot\packages\desktop\dist\opencode-win-*.exe" -Exclude "*uninstaller*" | Select-Object -First 1
    $latestYml = "$RepoRoot\packages\desktop\dist\latest.yml"
    if (-not $installer -or -not (Test-Path $latestYml)) { throw "installer or latest.yml missing from desktop dist" }

    # ------------------------------------------------------------------ GitHub Release (desktop feed)
    Write-Host "[4/5] publishing GitHub Release $tag..." -ForegroundColor Yellow
    $range = "$prevTag..HEAD"
    $notes = git log --oneline $range 2>$null | Select-Object -First 20 | Out-String
    if (-not $notes) { $notes = "Syncode release $next" }
    gh release create $tag $installer.FullName $latestYml --title "Syncode $next" --notes $notes --repo windro-exe/Syncode
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed ($LASTEXITCODE)" }

    # ------------------------------------------------------------------ dist branch (CLI/TUI feed)
    Write-Host "[5/5] updating dist branch..." -ForegroundColor Yellow
    $distDir = Join-Path $env:TEMP "syncode-dist-$next"
    if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
    git worktree add $distDir origin/dist
    try {
        $gzName = "opencode-windows-x64.exe.gz"
        Push-Location (Split-Path $cliBin)
        try {
            & tar -czf "$distDir\$gzName" (Split-Path $cliBin -Leaf)
            if ($LASTEXITCODE -ne 0) { throw "gzip failed ($LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
        $manifest = @{ version = $next; date = (Get-Date).ToUniversalTime().ToString("o"); branch = "dist" } | ConvertTo-Json
        Set-Content "$distDir\version.json" $manifest -NoNewline
        Push-Location $distDir
        try {
            git add version.json $gzName
            git commit -m "release: $next"
            git push origin HEAD:dist
        } finally {
            Pop-Location
        }
    } finally {
        git worktree remove $distDir -Force
    }

    Write-Host "`n[DONE] Syncode $next released." -ForegroundColor Green
    Write-Host "  Desktop updater: GitHub Release $tag (installer + latest.yml)" -ForegroundColor Green
    Write-Host "  CLI/TUI updater: dist branch (version.json + $gzName)" -ForegroundColor Green
    Write-Host "  Both in-app updaters will offer $next once their next check runs." -ForegroundColor Green
} finally {
    Pop-Location
}
