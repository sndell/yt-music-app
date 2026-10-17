# Build a windowed onefile exe under build\dist\<date>_<time>\.
# Each run gets its own folder, so older builds stay where they are.
# Native commands (pnpm, PyInstaller) write progress and warnings to stderr.
# Treat those as output, not fatal errors; failures are checked with
# $LASTEXITCODE below.
$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot

# This checkout's venv first. A worktree has none of its own, so fall back to
# the main checkout's venv, the same way start.ps1 resolves its Python.
function Resolve-Python {
    $candidates = @(Join-Path $Root "app\.venv\Scripts\python.exe")
    try {
        $common = & git -C $Root rev-parse --path-format=absolute --git-common-dir 2>$null
        if ($LASTEXITCODE -eq 0 -and $common) {
            $mainRoot = Split-Path -Parent ($common.Trim())
            $candidates += Join-Path $mainRoot "app\.venv\Scripts\python.exe"
        }
    } catch {
        # Not a git checkout; skip the main-checkout fallback.
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "No Python found. Create the venv at app\.venv (see the README)."
}

$Python = Resolve-Python

# The seams first: they are seconds and they explain a type error before tsc
# has to. The frozen page ships the same contract the checks prove.
& (Join-Path $Root "check.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location (Join-Path $Root "ui")
try {
    pnpm exec tsc -b
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    pnpm exec vite build --base ./
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}

& $Python -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
    & $Python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$DistRoot = Join-Path $Root "build\dist"
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$Dist = Join-Path $DistRoot $stamp
if (Test-Path -LiteralPath $Dist) {
    $stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    $Dist = Join-Path $DistRoot $stamp
    $n = 2
    while (Test-Path -LiteralPath $Dist) {
        $Dist = Join-Path $DistRoot ($stamp + "_" + $n)
        $n++
    }
}

Set-Location $Root
& $Python -m PyInstaller --noconfirm --distpath $Dist --workpath (Join-Path $Root "build\work") (Join-Path $Root "build\YTMusic.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Built $(Join-Path $Dist 'YTMusic.exe')"
