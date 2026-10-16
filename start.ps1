# Start a fresh dev instance for this checkout.
#
# app/main.py starts the Vite dev server itself, in its own console window, so
# this is the only command to run. One instance runs per checkout: a second
# process would fight the first for the WebView2 profile.
#
# Always start a new one with this script. Do not look for an instance that is
# already running, and do not probe ports.
param([switch]$Restart)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$MainPy = Join-Path $Root "app\main.py"
$Discovery = Join-Path $Root "app\dev\.dev.json"

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

# A live instance for this checkout, from its discovery file. The process must
# be running this checkout's own main.py, so a stale file or a pid the OS has
# reused is ignored.
function Get-RunningInstance {
    if (-not (Test-Path -LiteralPath $Discovery)) { return $null }
    try { $info = Get-Content -LiteralPath $Discovery -Raw | ConvertFrom-Json } catch { return $null }
    if (-not $info.pid) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($info.pid)" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.CommandLine) { return $null }
    if ($proc.CommandLine -notlike "*$MainPy*") { return $null }
    return $info
}

$Python = Resolve-Python

$running = Get-RunningInstance
if ($running) {
    if (-not $Restart) {
        Write-Host "A dev instance is already running for this checkout (pid $($running.pid), vite port $($running.vitePort))."
        Write-Host "Stop it:    python app\dev\cli.py stop"
        Write-Host "Restart it: .\start.ps1 -Restart"
        exit 1
    }
    Write-Host "Stopping pid $($running.pid)"
    try { & $Python (Join-Path $Root "app\dev\cli.py") stop | Out-Null } catch { }
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

Write-Host "Starting YTMusic with $Python"

$env:ENV = "dev"
& $Python $MainPy
exit $LASTEXITCODE
