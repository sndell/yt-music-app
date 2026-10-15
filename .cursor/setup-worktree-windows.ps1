# Cursor runs this inside a new worktree. $env:ROOT_WORKTREE_PATH is the main checkout.
# Port bases match app/dev/identity.py. Slot 0 stays with the main checkout.

$ErrorActionPreference = 'Stop'

$Root = $env:ROOT_WORKTREE_PATH
if (-not $Root) {
    Write-Error "ROOT_WORKTREE_PATH is not set. Cursor sets it when creating a worktree."
}

function Normalize-Path([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

$Worktree = Normalize-Path (Join-Path $PSScriptRoot '..')
$Root = Normalize-Path $Root

Write-Host "Setting up worktree $Worktree"
Write-Host "Main checkout $Root"

Push-Location (Join-Path $Worktree 'ui')
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}

$authSource = Join-Path $Root 'app\browser.json'
$authDest = Join-Path $Worktree 'app\browser.json'
if ((Test-Path -LiteralPath $authSource) -and -not (Test-Path -LiteralPath $authDest)) {
    Copy-Item -LiteralPath $authSource -Destination $authDest
    Write-Host "Copied app\browser.json"
}

$python = Join-Path $Root 'app\.venv\Scripts\python.exe'
$devDir = Join-Path $Worktree 'app\dev'
if (Test-Path -LiteralPath $python) {
    New-Item -ItemType Directory -Force -Path $devDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $devDir '.dev-python'), $python)
    Write-Host "Recorded $python"
}
else {
    Write-Warning "Main venv not found at $python. Create it in the main checkout before running this worktree."
}

if (Test-Path -LiteralPath $python) {
    # One allocator: app/dev/slots.py. Run it against this worktree's app package
    # so it resolves this checkout. Release the claim again because setup exits
    # right away; the .dev-slot preference it writes is what has to persist.
    Push-Location $Worktree
    try {
        $slot = & $python -c "import sys; sys.path.insert(0, r'$Worktree\app'); from dev import slots; s = slots.ensure_checkout_slot(); slots.release_slot(s); print(s)"
    }
    finally {
        Pop-Location
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "app/dev/slots.py ensure exited $LASTEXITCODE"
    }

    $n = 0
    if (-not [int]::TryParse("$slot".Trim(), [ref]$n) -or $n -lt 0) {
        Write-Error "app/dev/slots.py returned '$slot', not a dev slot number."
    }
    $slot = $n

    New-Item -ItemType Directory -Force -Path $devDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $devDir '.dev-slot'), "$slot")
    Write-Host "Dev slot $slot"
    Write-Host "Vite http://localhost:$(5173 + $slot)"
    Write-Host "Probe http://127.0.0.1:$(8765 + $slot)/health"
}
else {
    Write-Warning "Skipped dev slot assignment: main venv not found at $python."
}
