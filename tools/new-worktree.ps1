# Create a git worktree for a second feature and run the repo's worktree setup in it.
# Usage, from the main checkout:  .\tools\new-worktree.ps1 <branch-name> [-Base <ref>]
# The new checkout lands next to this one as ..\yt-music-app-<branch-name>.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Branch,
    [string]$Base = 'HEAD'
)

$ErrorActionPreference = 'Stop'

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$safe = $Branch -replace '[\\/:*?"<>| ]', '-'
$Worktree = Join-Path (Split-Path $Root -Parent) ("yt-music-app-" + $safe)

if (Test-Path -LiteralPath $Worktree) {
    Write-Error "$Worktree already exists."
}

git -C $Root worktree add -b $Branch $Worktree $Base
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# .cursor/ is gitignored, so the new checkout does not have the setup script. Copy it in.
$setupSrc = Join-Path $Root '.cursor\setup-worktree-windows.ps1'
if (-not (Test-Path -LiteralPath $setupSrc)) {
    Write-Error "Missing $setupSrc"
}
$setupDir = Join-Path $Worktree '.cursor'
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
$setup = Join-Path $setupDir 'setup-worktree-windows.ps1'
Copy-Item -LiteralPath $setupSrc -Destination $setup -Force

$env:ROOT_WORKTREE_PATH = $Root
try {
    & $setup
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Remove-Item Env:ROOT_WORKTREE_PATH -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Worktree ready: $Worktree"
Write-Host "Next: cd `"$Worktree`" and start claude there."
