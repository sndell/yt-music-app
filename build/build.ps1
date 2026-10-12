# Build a windowed onefile exe under build\dist\<date>_<time>\.
# Each run gets its own folder, so older builds stay where they are.
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
