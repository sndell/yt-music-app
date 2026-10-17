# The one command that proves the surfaces agree. Run it before a commit; the
# same script runs in CI and before PyInstaller.
#
# Live editor windows keep the previous version of this file; restart the
# window to pick up a Python change.
$ErrorActionPreference = "Continue"

& python "$PSScriptRoot\app\dev\checks.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location "$PSScriptRoot\ui"
try {
    & pnpm exec tsc -b
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # --quiet hides the pre-existing react-hooks warnings; errors still fail.
    & pnpm exec eslint . --quiet
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Write-Host "checks: green"
