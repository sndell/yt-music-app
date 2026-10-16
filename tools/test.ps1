# Run the whole check suite: UI types, UI unit tests, Python tests.
# Usage, from the repo root:  .\tools\test.ps1
# Add -Lint to also run eslint (the repo's lint baseline is currently red).

param(
    [switch]$Lint
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Repo "app\.venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
    # An opencode worktree has no venv; tools/dev.py records the main one.
    $Recorded = Join-Path $Repo "app\dev\.dev-python"
    if (Test-Path -LiteralPath $Recorded) {
        $Python = (Get-Content -LiteralPath $Recorded -Raw).Trim()
    }
}
$failed = @()

function Step([string]$Name, [scriptblock]$Body) {
    Write-Host "== $Name ==" -ForegroundColor Cyan
    & $Body
    if ($LASTEXITCODE -ne 0) {
        $script:failed += $Name
        Write-Host "   FAILED: $Name" -ForegroundColor Red
    }
}

Push-Location (Join-Path $Repo "ui")
try {
    Step "tsc -b" { & pnpm exec tsc -b }
    Step "vitest" { & pnpm exec vitest run }
    if ($Lint) { Step "eslint" { & pnpm exec eslint . } }
}
finally {
    Pop-Location
}

Step "pytest" { & $Python -m pytest -q }

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host ("FAILED: " + ($failed -join ", ")) -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "All checks passed." -ForegroundColor Green
