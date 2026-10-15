#!/usr/bin/env python3
"""Agent-friendly debugging CLI for the YTMusic dev window.

Talks to the dev probe (8765 + slot) and the Vite server (5173 + slot) so a
change can be checked without hand-rolled PowerShell or DOM scripts.

    .\\app\\.venv\\Scripts\\python.exe tools\\dev.py health
    .\\app\\.venv\\Scripts\\python.exe tools\\dev.py state
    .\\app\\.venv\\Scripts\\python.exe tools\\dev.py logs --level error
    .\\app\\.venv\\Scripts\\python.exe tools\\dev.py screenshot --diff
    .\\app\\.venv\\Scripts\\python.exe tools\\dev.py watch --check "document.title"

Standard library only; any Python 3.10+ works.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_INFRA = 2

REPO = Path(__file__).resolve().parent.parent
APP_DIR = REPO / "app"
UI_DIR = REPO / "ui"
UI_SRC = UI_DIR / "src"
ARTIFACTS = APP_DIR / "dev" / ".dev-artifacts"

PROBE_BASE = 8765
UI_BASE = 5173
DEBUG_BASE = 9222

SKIP_DIRS = {"__pycache__", ".venv", "node_modules", ".cache", "webview-data", ".dev-artifacts", "dist", ".git"}
WATCH_SUFFIXES = (".py", ".ts", ".tsx", ".css", ".html")

HEALTH_TIMEOUT = 60.0
RESTART_SETTLE = 0.8
SUITE_TIMEOUT = 240.0


class ToolError(Exception):
    """Something the CLI could not do; reported as an infra failure."""


def dev_slot(explicit: int | None) -> int:
    if explicit is not None:
        return max(0, explicit)
    env = os.environ.get("DEV_SLOT", "").strip()
    if env:
        try:
            return max(0, int(env))
        except ValueError:
            pass
    for candidate in (
        APP_DIR / "dev" / ".dev-slot",
        REPO / "dev" / ".dev-slot",
        APP_DIR / ".dev-slot",
    ):
        try:
            return max(0, int(candidate.read_text(encoding="utf-8-sig").strip()))
        except (OSError, ValueError):
            continue
    return 0


def ports(slot: int) -> dict[str, int]:
    return {"probe": PROBE_BASE + slot, "ui": UI_BASE + slot, "cdp": DEBUG_BASE + slot}


def request(
    method: str,
    url: str,
    payload: Any | None = None,
    *,
    timeout: float = 60.0,
) -> tuple[dict[str, Any], Any]:
    """Return ``(meta, decoded body)``. Raises ToolError on HTTP or socket errors."""
    data = None
    headers: dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            meta = {
                "status": resp.status,
                "generation": resp.headers.get("X-Dev-Generation"),
                "files": resp.headers.get("X-Dev-Restart-Files"),
            }
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace").strip()
        raise ToolError(f"HTTP {err.code} from {url}: {detail}")
    except urllib.error.URLError as err:
        raise ToolError(f"cannot reach {url}: {err.reason}")
    text = body.decode("utf-8", "replace")
    if not text:
        return meta, None
    try:
        return meta, json.loads(text)
    except json.JSONDecodeError:
        return meta, text


def probe(method: str, path: str, payload: Any | None = None, slot: int = 0) -> tuple[dict[str, Any], Any]:
    return request(method, f"http://127.0.0.1:{ports(slot)['probe']}{path}", payload)


def run_browser_driver(node_args: list[str], slot: int, timeout: float = 180.0) -> int:
    """Run the CDP driver (ui/dev/browser.mjs) and stream its output."""
    node = shutil.which("node")
    if node is None:
        raise ToolError("node is not on PATH; the CDP driver needs it")
    driver = UI_DIR / "dev" / "browser.mjs"
    if not driver.exists():
        raise ToolError(f"missing {driver}")
    environment = {**os.environ, "DEV_SLOT": str(slot)}
    try:
        proc = subprocess.run(
            [node, str(driver), *node_args],
            cwd=UI_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=environment,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolError(f"browser driver timed out after {timeout:.0f}s") from exc
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    return proc.returncode


def run_command(command: list[str], cwd: Path, timeout: float) -> tuple[int | None, str]:
    """Run a command and return ``(returncode, output)``.

    ``returncode`` is ``None`` when it could not start or finish (missing
    binary, timeout); callers report that as UNKNOWN, never as a pass.
    """
    try:
        proc = subprocess.run(command, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return None, f"{command[0]} was not found"
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout:.0f}s"
    return proc.returncode, f"{proc.stdout or ''}{proc.stderr or ''}".strip()


def dump(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, ensure_ascii=False))
    elif isinstance(value, str):
        print(value)
    else:
        print(json.dumps(value, indent=2, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #


def cmd_health(args: argparse.Namespace) -> int:
    meta, body = probe("GET", "/health", slot=args.slot_resolved)
    dump(body, args.json)
    return EXIT_OK if isinstance(body, dict) and body.get("ok") else EXIT_FAIL


def cmd_doctor(args: argparse.Namespace) -> int:
    slot = args.slot_resolved
    p = ports(slot)
    rows: list[tuple[str, str]] = [("slot", str(slot))]
    healthy = True

    try:
        _, health = probe("GET", "/health", slot=slot)
        rows.append(("probe", f"up  {json.dumps(health)}"))
    except ToolError as exc:
        healthy = False
        rows.append(("probe", f"DOWN  {exc}"))

    try:
        request("GET", f"http://localhost:{p['ui']}/", timeout=5.0)
        rows.append(("vite", f"up  http://localhost:{p['ui']}"))
    except ToolError as exc:
        rows.append(("vite", f"down  {exc}"))

    try:
        request("GET", f"http://127.0.0.1:{p['cdp']}/json/version", timeout=3.0)
        rows.append(("cdp", f"up  http://127.0.0.1:{p['cdp']}"))
    except ToolError:
        rows.append(("cdp", "off  start with DEVTOOLS=1 (tools/dev.py up --devtools)"))

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    rows.append(("artifacts", str(ARTIFACTS)))

    if args.json:
        print(json.dumps({name: value for name, value in rows}, indent=2))
    else:
        width = max(len(name) for name, _ in rows)
        for name, value in rows:
            print(f"{name.ljust(width)}  {value}")
    return EXIT_OK if healthy else EXIT_INFRA


def cmd_call(args: argparse.Namespace) -> int:
    raw_args = args.args
    try:
        call_args = json.loads(raw_args) if raw_args else []
    except json.JSONDecodeError as exc:
        raise ToolError(f"args must be JSON: {exc}") from exc
    if not isinstance(call_args, list):
        raise ToolError("args must be a JSON list")
    _, body = probe("POST", "/call", {"method": args.method, "args": call_args}, slot=args.slot_resolved)
    dump(body, args.json)
    return EXIT_OK


def cmd_eval(args: argparse.Namespace) -> int:
    expression = args.expression
    if args.file:
        expression = Path(args.file).read_text(encoding="utf-8")
    if not expression or not expression.strip():
        raise ToolError("provide a JS expression or --file")
    _, body = probe("POST", "/eval", {"expression": expression}, slot=args.slot_resolved)
    dump(body, args.json)
    return EXIT_OK


def cmd_state(args: argparse.Namespace) -> int:
    _, body = probe("GET", "/state", slot=args.slot_resolved)
    if args.json:
        print(json.dumps(body, indent=2, ensure_ascii=False))
        return EXIT_OK
    if not isinstance(body, dict):
        print(body)
        return EXIT_OK
    dom = body.get("dom") or {}
    print(f"generation   {body.get('generation')}")
    print(f"url          {dom.get('url')}")
    print(f"bridge       {dom.get('bridge')}")
    print(f"playlists    {dom.get('playlistCount')}  first={dom.get('firstPlaylistIds')}")
    print(f"spinners     {dom.get('spinners')}")
    last = body.get("lastError")
    if last:
        age = body.get("lastErrorAgeSeconds")
        when = f" ({age}s ago)" if isinstance(age, (int, float)) else ""
        print(f"lastError    [{last.get('level')}]{when} {last.get('message')}")
        if last.get("stack"):
            print(f"             {last['stack'].splitlines()[0]}")
    else:
        print("lastError    none since this page loaded")
    return EXIT_OK


def cmd_logs(args: argparse.Namespace) -> int:
    query = []
    if args.since is not None:
        query.append(f"since={args.since}")
    if args.level:
        query.append(f"level={args.level}")
    if args.limit:
        query.append(f"limit={args.limit}")
    path = "/logs" + (f"?{'&'.join(query)}" if query else "")
    _, body = probe("GET", path, slot=args.slot_resolved)
    if args.json:
        print(json.dumps(body, indent=2, ensure_ascii=False))
        return EXIT_OK
    if not isinstance(body, dict):
        print(body)
        return EXIT_OK
    for source in ("python", "renderer"):
        entries = body.get(source) or []
        if not entries:
            continue
        print(f"--- {source} ---")
        for entry in entries:
            stamp = time.strftime("%H:%M:%S", time.localtime(entry.get("ts", 0)))
            label = entry.get("logger") or entry.get("kind") or source
            print(f"{stamp} {str(entry.get('level', '')).upper():<9} {label}: {entry.get('message', '')}")
            if entry.get("traceback"):
                print(entry["traceback"])
            if entry.get("stack") and entry.get("kind") in ("error", "rejection", "react"):
                print(entry["stack"])
    return EXIT_OK


def cmd_screenshot(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {"diff": args.diff, "accept": args.accept_baseline}
    if args.out:
        payload["out"] = str(Path(args.out).resolve())
    _, body = probe("POST", "/screenshot", payload, slot=args.slot_resolved)
    dump(body, args.json)
    return EXIT_OK


def cmd_reload(args: argparse.Namespace) -> int:
    _, body = probe("POST", "/reload", {}, slot=args.slot_resolved)
    dump(body, args.json)
    return EXIT_OK


def cmd_browse(args: argparse.Namespace) -> int:
    """Forward to the CDP driver: browse shot | text | click | run <script> ..."""
    if not args.browse_args:
        raise ToolError(
            "usage: dev.py browse <targets|shot|text|click|click-text|wait|console|run> [args]"
        )
    return run_browser_driver(args.browse_args, args.slot_resolved)


def cmd_up(args: argparse.Namespace) -> int:
    """Start the dev servers detached, logging into the artifacts dir."""
    slot = args.slot_resolved
    p = ports(slot)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["ENV"] = "dev"
    env["DEV_SLOT"] = str(slot)
    if args.devtools:
        env["DEVTOOLS"] = "1"

    interpreter = sys.executable
    recorded = APP_DIR / "dev" / ".dev-python"
    if recorded.exists():
        interpreter = recorded.read_text(encoding="utf-8").strip() or interpreter

    flags = 0
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

    ui_log = (ARTIFACTS / "vite.log").open("ab")
    py_log = (ARTIFACTS / "app.log").open("ab")

    vite = subprocess.Popen(
        ["cmd", "/c", "pnpm", "dev"],
        cwd=UI_DIR,
        env=env,
        stdout=ui_log,
        stderr=ui_log,
        creationflags=flags,
    )
    watcher = subprocess.Popen(
        [interpreter, "-u", str(APP_DIR / "dev" / "watch.py")],
        cwd=REPO,
        env=env,
        stdout=py_log,
        stderr=py_log,
        creationflags=flags,
    )

    print(f"vite     pid={vite.pid}  http://localhost:{p['ui']}   log={ARTIFACTS / 'vite.log'}")
    print(f"watcher  pid={watcher.pid}  probe http://127.0.0.1:{p['probe']}   log={ARTIFACTS / 'app.log'}")
    if args.devtools:
        print(f"devtools cdp http://127.0.0.1:{p['cdp']}")
    print("Wait for '[dev] restarted' in app.log, then run: tools/dev.py health")
    return EXIT_OK


def snapshot_mtimes() -> dict[str, int]:
    found: dict[str, int] = {}
    for root in (UI_SRC, APP_DIR):
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
            for name in filenames:
                if not name.endswith(WATCH_SUFFIXES):
                    continue
                path = Path(dirpath) / name
                try:
                    found[str(path)] = path.stat().st_mtime_ns
                except OSError:
                    continue
    return found


def changed_since(before: dict[str, int], after: dict[str, int]) -> list[str]:
    keys = set(before) | set(after)
    return sorted(key for key in keys if before.get(key) != after.get(key))


def short(path: str) -> str:
    try:
        return str(Path(path).relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return path


def wait_for_restart(slot: int, previous_generation: int | None, timeout: float) -> int | None:
    """Block until the generation advances and health is ok again."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _, health = probe("GET", "/health", slot=slot)
        except ToolError:
            time.sleep(0.3)
            continue
        generation = health.get("generation") if isinstance(health, dict) else None
        if isinstance(generation, int) and previous_generation is not None and generation > previous_generation:
            return generation
        time.sleep(0.3)
    return None


def wait_for_window_ready(slot: int, timeout: float = 20.0) -> None:
    """Block until the page has painted and the bridge is back.

    A Python save restarts the window, and ``/health`` answers as soon as the
    probe listens — before the webview has reloaded. Capturing there would be
    evidence of nothing (an empty sidebar, loaders still up), so wait for the
    page to be ready, then best-effort for the first data fetch to land.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _, state = probe("GET", "/state", slot=slot)
        except ToolError:
            time.sleep(0.3)
            continue
        dom = (state or {}).get("dom") or {}
        if dom.get("ready") == "complete" and dom.get("bridge"):
            break
        time.sleep(0.3)

    # Signed-out windows stay at 0 playlists, so this never fails the run.
    settle_deadline = time.monotonic() + min(10.0, timeout)
    while time.monotonic() < settle_deadline:
        try:
            _, state = probe("GET", "/state", slot=slot)
        except ToolError:
            return
        dom = (state or {}).get("dom") or {}
        if (dom.get("playlistCount") or 0) > 0:
            return
        time.sleep(0.4)


def run_check(slot: int, expression: str) -> tuple[bool, Any]:
    try:
        _, value = probe("POST", "/eval", {"expression": expression}, slot=slot)
    except ToolError as exc:
        return False, f"check failed to run: {exc}"
    ok = bool(value) and value != "false"
    return ok, value


def cmd_watch(args: argparse.Namespace) -> int:
    """Loop: detect a change, settle, capture evidence, assert, print a verdict."""
    slot = args.slot_resolved
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    try:
        _, health = probe("GET", "/health", slot=slot)
        generation = health.get("generation") if isinstance(health, dict) else 0
    except ToolError as exc:
        raise ToolError(f"dev window not reachable ({exc}); run tools/dev.py up or start the watcher") from exc

    baseline_ts = time.time()
    previous = snapshot_mtimes()
    print(f"watching {short(str(UI_SRC))} and {short(str(APP_DIR))} (slot {slot}, generation {generation})", flush=True)
    print("edit a file; a verdict prints here. Ctrl-C to stop.", flush=True)

    iterations = 0
    while True:
        time.sleep(0.4)
        current = snapshot_mtimes()
        changed = changed_since(previous, current)
        if not changed:
            continue

        # Debounce: a save often lands as several mtime updates.
        while True:
            time.sleep(0.35)
            latest = snapshot_mtimes()
            if changed_since(current, latest) == []:
                break
            changed += changed_since(current, latest)
            current = latest
        changed = sorted(set(changed))
        previous = current

        python_files = [p for p in changed if p.endswith(".py")]
        if python_files:
            new_generation = wait_for_restart(slot, generation, args.timeout)
            if new_generation is None:
                print(f"FAIL  restart did not come up within {args.timeout:.0f}s  files={[short(f) for f in python_files]}", flush=True)
                return _write_verdict("FAIL restart timeout", [short(f) for f in python_files], args)
            generation = new_generation
            # /health answers before the page has reloaded; wait for the paint.
            wait_for_window_ready(slot, args.timeout)
        else:
            time.sleep(RESTART_SETTLE)  # let Vite HMR apply
            wait_for_window_ready(slot, timeout=8.0)

        iterations += 1
        code = _evaluate_iteration(slot, changed, baseline_ts, args)
        if code != EXIT_OK and not args.keep_going:
            return code
        if args.once and iterations >= 1:
            return code


def _write_verdict(line: str, files: list[str], args: argparse.Namespace) -> int:
    (ARTIFACTS / "verdict.txt").write_text(f"{line}\nfiles={files}\n", encoding="utf-8")
    print(f"{line}  files={files}", flush=True)
    return EXIT_FAIL


def _under(path: str, root: Path) -> bool:
    """True when ``path`` lives under ``root`` (both absolute here)."""
    try:
        return Path(path).resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def _run_suite(name: str, command: list[str], cwd: Path) -> int:
    """Run one unit suite, print a one-line result, and return OK/FAIL/INFRA."""
    code, output = run_command(command, cwd, SUITE_TIMEOUT)
    if code is None:
        print(f"  tests  {name} UNKNOWN ({output})", flush=True)
        return EXIT_INFRA
    if code == EXIT_OK:
        print(f"  tests  {name} ok", flush=True)
        return EXIT_OK
    print(f"  tests  {name} FAILED", flush=True)
    for line in output.splitlines()[-15:]:
        print(f"         {line}", flush=True)
    return EXIT_FAIL


def _run_suites(changed: list[str], args: argparse.Namespace) -> int:
    """Run the unit suites the change touches, folded into the verdict.

    A change to ``app/`` Python (but not ``app/tests/``) runs pytest from the
    repo root; a change under ``ui/src`` runs vitest from ``ui``. A suite that
    cannot start (pytest not installed, pnpm absent) is UNKNOWN, not a pass.
    """
    if args.no_tests:
        return EXIT_OK

    codes: list[int] = []
    app_python = any(
        path.endswith(".py") and _under(path, APP_DIR) and not _under(path, APP_DIR / "tests")
        for path in changed
    )
    if app_python:
        if importlib.util.find_spec("pytest") is None:
            print("  tests  pytest UNKNOWN (pytest is not installed for this interpreter)", flush=True)
            codes.append(EXIT_INFRA)
        else:
            codes.append(_run_suite("pytest", [sys.executable, "-m", "pytest", "-q"], REPO))

    if any(_under(path, UI_SRC) for path in changed):
        if shutil.which("pnpm") is None:
            print("  tests  vitest UNKNOWN (pnpm is not on PATH)", flush=True)
            codes.append(EXIT_INFRA)
        else:
            # On Windows pnpm is a .cmd shim, which CreateProcess cannot launch
            # directly, so go through cmd.exe the way `up` starts Vite.
            vitest = ["pnpm", "exec", "vitest", "run"]
            if os.name == "nt":
                vitest = ["cmd", "/c", *vitest]
            codes.append(_run_suite("vitest", vitest, UI_DIR))

    if EXIT_FAIL in codes:
        return EXIT_FAIL
    if EXIT_INFRA in codes:
        return EXIT_INFRA
    return EXIT_OK


def _evaluate_iteration(slot: int, changed: list[str], baseline_ts: float, args: argparse.Namespace) -> int:
    files = [short(path) for path in changed]
    print(f"\n[{time.strftime('%H:%M:%S')}] changed {files}", flush=True)

    try:
        _, state = probe("GET", "/state", slot=slot)
    except ToolError as exc:
        print(f"UNKNOWN  cannot read state: {exc}", flush=True)
        return EXIT_INFRA

    dom = (state or {}).get("dom") or {}
    print(
        f"  state  url={dom.get('url')} playlists={dom.get('playlistCount')} "
        f"spinners={dom.get('spinners')} bridge={dom.get('bridge')}",
        flush=True,
    )

    try:
        _, shot = probe("POST", "/screenshot", {"diff": True}, slot=slot)
        if isinstance(shot, dict):
            changed_px = shot.get("changedPixels")
            note = "no visual change" if changed_px == 0 else f"changed pixels={changed_px}"
            print(f"  shot   {shot.get('path')}  {note}", flush=True)
    except ToolError as exc:
        print(f"  shot   unavailable: {exc}", flush=True)

    try:
        _, logs = probe("GET", f"/logs?since={baseline_ts}&level=error", slot=slot)
    except ToolError:
        logs = None
    errors = (logs or {}).get("renderer") or [] if isinstance(logs, dict) else []
    for entry in errors:
        print(f"  error  [{entry.get('kind')}] {entry.get('message')}", flush=True)
    baseline_ts = time.time()

    check_ok = True
    check_value: Any = None
    if args.check:
        check_ok, check_value = run_check(slot, args.check)
        print(f"  check  {json.dumps(check_value) if not isinstance(check_value, str) else check_value} -> {'ok' if check_ok else 'FAILED'}", flush=True)

    verify_ok = True
    if args.verify:
        print(f"  verify {args.verify}", flush=True)
        verify_ok = run_browser_driver(["run", args.verify], slot) == EXIT_OK

    tests_code = _run_suites(changed, args)

    if errors:
        return _write_verdict("FAIL renderer error", files, args)
    if not check_ok:
        return _write_verdict("FAIL check", files, args)
    if not verify_ok:
        return _write_verdict(f"FAIL verify {args.verify}", files, args)
    if tests_code == EXIT_FAIL:
        return _write_verdict("FAIL tests", files, args)
    if tests_code == EXIT_INFRA:
        print("UNKNOWN  a test suite could not run", flush=True)
        return EXIT_INFRA

    (ARTIFACTS / "verdict.txt").write_text(f"PASS\nfiles={files}\n", encoding="utf-8")
    print(f"PASS  files={files}", flush=True)
    return EXIT_OK


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dev.py", description="Debug the YTMusic dev window.")
    parser.add_argument("--slot", type=int, default=None, help="dev slot (default: auto from app/dev/.dev-slot)")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="probe /health").set_defaults(func=cmd_health)
    sub.add_parser("doctor", help="check probe, vite, cdp, artifacts").set_defaults(func=cmd_doctor)
    sub.add_parser("state", help="route, sidebar shape, loaders, last error").set_defaults(func=cmd_state)

    call = sub.add_parser("call", help="call a public Python method")
    call.add_argument("method")
    call.add_argument("args", nargs="?", default="", help="JSON list, e.g. '[\"a\"]'")
    call.set_defaults(func=cmd_call)

    evaluate = sub.add_parser("eval", help="run JS in the window")
    evaluate.add_argument("expression", nargs="?", default="")
    evaluate.add_argument("--file", help="read the expression from a file")
    evaluate.set_defaults(func=cmd_eval)

    logs = sub.add_parser("logs", help="python + renderer logs")
    logs.add_argument("--since", type=float, default=None, help="epoch seconds")
    logs.add_argument("--level", default=None, help="info|warning|error")
    logs.add_argument("--limit", type=int, default=200)
    logs.set_defaults(func=cmd_logs)

    shot = sub.add_parser("screenshot", help="capture the window (png in artifacts)")
    shot.add_argument("--out", help="also copy the png here")
    shot.add_argument("--diff", action="store_true", help="diff against the baseline")
    shot.add_argument("--accept-baseline", action="store_true", help="overwrite the baseline")
    shot.set_defaults(func=cmd_screenshot)

    sub.add_parser("reload", help="reload the webview").set_defaults(func=cmd_reload)

    browse = sub.add_parser("browse", help="drive the window over CDP (playwright-core)")
    browse.add_argument("browse_args", nargs=argparse.REMAINDER)
    browse.set_defaults(func=cmd_browse)

    up = sub.add_parser("up", help="start vite + the watcher detached")
    up.add_argument("--devtools", action="store_true", help="also enable the CDP port")
    up.set_defaults(func=cmd_up)

    watch = sub.add_parser("watch", help="live loop: change -> settle -> capture -> verdict")
    watch.add_argument("--check", default=None, help="JS expression that must be truthy")
    watch.add_argument("--verify", default=None, help="CDP verify script to run (tools/verify/*.mjs)")
    watch.add_argument("--no-tests", action="store_true", help="skip the pytest/vitest suites")
    watch.add_argument("--once", action="store_true", help="stop after the first change")
    watch.add_argument("--keep-going", action="store_true", help="do not exit on the first FAIL")
    watch.add_argument("--timeout", type=float, default=45.0, help="seconds to wait for a restart")
    watch.set_defaults(func=cmd_watch)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.slot_resolved = dev_slot(args.slot)
    try:
        return int(args.func(args) or EXIT_OK)
    except ToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INFRA
    except KeyboardInterrupt:
        print("stopped", file=sys.stderr)
        return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
