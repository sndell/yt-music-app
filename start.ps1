# Start a dev instance for this checkout.
#
# app/main.py starts the Vite dev server itself, in its own console window, so
# this is the only command to run.
#
# The unit of isolation is the instance, not the checkout: several agents may run
# at once in the same worktree, each named by YTM_INSTANCE and given its own
# WebView2 profile, discovery file and data dir. app/dev/instance.py derives all
# of that in Python, so this script only sets YTM_INSTANCE, YTM_INSTANCE_LABEL
# and ENV. Two instances may not share a data dir, because WebView2 refuses two
# processes on one profile, so the guard below scopes to a single instance id
# rather than refusing every second window in the checkout.
#
# -Instance is optional. Unset, a linked worktree takes its own directory name as
# the id, so an agent working in its own checkout runs this with no arguments. The
# main checkout stays `default`, and -Instance is only needed for a second window
# in one checkout.
#
# Always start a new one with this script. Do not look for an instance that is
# already running, and do not probe ports.
param(
    [switch]$Restart,
    [string]$Instance = $env:YTM_INSTANCE,
    [string]$Label,
    [switch]$Reseed,
    [switch]$IsolatedCache
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$MainPy = Join-Path $Root "app\main.py"
$CliPy = Join-Path $Root "app\dev\cli.py"

# instance.py slugs YTM_INSTANCE into the discovery file name, so match it here
# or the guard watches a name main.py never writes. An empty value means the
# checkout-wide `default` layout.
function ConvertTo-InstanceId {
    param([string]$Value)
    if (-not $Value -or -not $Value.Trim()) { return "default" }
    $cleaned = ($Value.Trim() -replace '[\\/:*?"<>|\s]', '-').Trim('-', '.')
    if (-not $cleaned) { return "default" }
    return $cleaned
}

# instance.py derives an unset id the same way: a linked worktree is named after
# its own directory, so an agent in a T3 checkout names nothing and still gets a
# private instance. Only the checkout that owns `.git` is `default`. Keep the two
# in step or the guard above watches a name main.py never writes.
function Get-DerivedInstanceId {
    try {
        $common = & git -C $Root rev-parse --path-format=absolute --git-common-dir 2>$null
        if ($LASTEXITCODE -eq 0 -and $common) {
            # Get-Item normalizes `/` to `\`, so the comparison is not fooled by
            # git printing the path with forward slashes.
            $mainRoot = (Get-Item -LiteralPath (Split-Path -Parent ($common.Trim()))).FullName
            $here = (Get-Item -LiteralPath $Root).FullName
            if ($mainRoot -ne $here) { return (Split-Path -Leaf $here) }
        }
    } catch {
        # Not a git checkout; fall through to the default layout.
    }
    return "default"
}

if ($Instance -and $Instance.Trim()) {
    $Id = ConvertTo-InstanceId $Instance
} else {
    $Id = ConvertTo-InstanceId (Get-DerivedInstanceId)
}

# Per instance. `default` also writes the legacy app\dev\.dev.json, so watch
# that too when this instance is the default one, or a window started before
# instances existed looks absent and a second one fights it for the profile.
$Discovery = Join-Path $Root "app\dev\.instances\$Id.json"
$LegacyDiscovery = Join-Path $Root "app\dev\.dev.json"

# This checkout's venv first. A worktree has none of its own, so fall back to
# the main checkout's venv, then to whatever python is on PATH.
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

# A live instance for this id, from its discovery file. The process must be
# running this checkout's own main.py, so a stale file or a pid the OS has
# reused is ignored.
function Get-RunningInstance {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { $info = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
    if (-not $info.pid) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($info.pid)" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.CommandLine) { return $null }
    if ($proc.CommandLine -notlike "*$MainPy*") { return $null }
    return $info
}

$Python = Resolve-Python

$running = Get-RunningInstance $Discovery
if (-not $running -and $Id -eq "default") {
    $running = Get-RunningInstance $LegacyDiscovery
}
if ($running) {
    if (-not $Restart) {
        Write-Host "Instance '$Id' is already running for this checkout (pid $($running.pid), vite port $($running.vitePort))."
        Write-Host "Stop it:    python app\dev\cli.py -i $Id stop"
        Write-Host "Restart it: .\start.ps1 -Instance $Id -Restart"
        exit 1
    }
    Write-Host "Stopping instance '$Id' (pid $($running.pid))"
    # Scoped to this id: a sibling instance keeps its own discovery file and
    # profile, so it must survive this restart.
    try { & $Python $CliPy -i $Id stop | Out-Null } catch { }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $running.pid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 300
    }
    if (Get-Process -Id $running.pid -ErrorAction SilentlyContinue) {
        Write-Host "It did not stop; killing the process tree."
        taskkill /PID $running.pid /T /F | Out-Null
        Start-Sleep -Seconds 1
    }
}

# A fresh worktree has no ui\node_modules, so `pnpm dev` fails and the window
# opens on a dead port. Install once, up front, and only when it is missing.
$UiDir = Join-Path $Root "ui"
if (-not (Test-Path -LiteralPath (Join-Path $UiDir "node_modules"))) {
    $Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $Pnpm) {
        throw "ui\node_modules is missing and pnpm is not on PATH. Install Node.js, then run: npm install -g pnpm"
    }
    Write-Host "ui\node_modules is missing; installing UI dependencies (this can take a few minutes)."
    Push-Location $UiDir
    try {
        & $Pnpm.Source install --prefer-offline
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in ui (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

# Printed before main.py blocks, so the line can be pasted into another shell.
$banner = "Instance '$Id'"
if ($Label) { $banner += "  (label: $Label)" }
Write-Host $banner
Write-Host "Drive it: python app\dev\cli.py -i $Id health"
Write-Host "Starting YTMusic with $Python"

$env:ENV = "dev"
$env:YTM_INSTANCE = $Id
if ($Label) { $env:YTM_INSTANCE_LABEL = $Label }
if ($IsolatedCache) { $env:YTM_ISOLATE_CACHE = "1" }
if ($Reseed) { $env:YTM_RESEED = "1" }
& $Python $MainPy
exit $LASTEXITCODE
