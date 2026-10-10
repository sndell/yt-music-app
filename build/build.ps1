# Build a windowed onefile exe at dist\YTMusic.exe.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root "app\.venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Python venv not found at $Python"
}

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

Set-Location $Root
& $Python -m PyInstaller --noconfirm --distpath (Join-Path $Root "dist") --workpath (Join-Path $Root "build\work") (Join-Path $Root "build\YTMusic.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Built $(Join-Path $Root 'dist\YTMusic.exe')"
