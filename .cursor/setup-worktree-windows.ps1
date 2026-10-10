# Cursor runs this inside a new worktree. $env:ROOT_WORKTREE_PATH is the main checkout.
# Port bases match dev/identity.py. Slot 0 stays with the main checkout.

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
if (Test-Path -LiteralPath $python) {
    [System.IO.File]::WriteAllText((Join-Path $Worktree 'dev\.dev-python'), $python)
    Write-Host "Recorded $python"
}
else {
    Write-Warning "Main venv not found at $python. Create it in the main checkout before running this worktree."
}

function Test-PortFree([int]$Port) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

$used = @{}
try {
    $porcelain = & git -C $Worktree worktree list --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "git worktree list exited $LASTEXITCODE"
    }
    foreach ($line in @($porcelain)) {
        if (-not $line.StartsWith('worktree ')) {
            continue
        }
        $path = Normalize-Path $line.Substring(9)
        if ($path -eq $Worktree) {
            continue
        }
        $slotFile = Join-Path $path 'dev\.dev-slot'
        if (-not (Test-Path -LiteralPath $slotFile)) {
            $slotFile = Join-Path $path 'app\.dev-slot'
        }
        if (-not (Test-Path -LiteralPath $slotFile)) {
            continue
        }
        $text = [System.IO.File]::ReadAllText($slotFile).Trim().TrimStart([char]0xFEFF)
        $n = 0
        if ([int]::TryParse($text, [ref]$n) -and $n -ge 0) {
            $used["$n"] = $true
        }
    }
}
catch {
    Write-Warning "Could not read other worktree slots: $_"
}

$slot = $null
for ($i = 1; $i -le 50; $i++) {
    if ($used.ContainsKey("$i")) {
        continue
    }
    $probe = 8765 + $i
    $ui = 5173 + $i
    $debug = 9222 + $i
    if ((Test-PortFree $probe) -and (Test-PortFree $ui) -and (Test-PortFree $debug)) {
        $slot = $i
        break
    }
}

if ($null -eq $slot) {
    Write-Error "No free dev slot. Ports 8766-8815, 5174-5223, and 9223-9272 are in use or already claimed."
}

[System.IO.File]::WriteAllText((Join-Path $Worktree 'dev\.dev-slot'), "$slot")
Write-Host "Dev slot $slot"
Write-Host "Vite http://localhost:$(5173 + $slot)"
Write-Host "Probe http://127.0.0.1:$(8765 + $slot)/health"
