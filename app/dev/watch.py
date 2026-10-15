"""Restart the pywebview app when Python files under app/ change."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DEV_DIR = Path(__file__).resolve().parent
APP_DIR = DEV_DIR.parent
REPO_DIR = APP_DIR.parent

# identity imports util from app/.
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from dev import slots
from dev.identity import dev_slot, probe_port, ui_slot
from dev.vite_server import stop_vite

RESTART_LOG = DEV_DIR / ".dev-restarts.jsonl"
# Test files and the artifacts dir do not change the running app.
SKIP_DIRS = {"__pycache__", ".cache", ".venv", "webview-data", ".dev-artifacts", "tests"}
POLL_SECONDS = 0.3
DEBOUNCE_SECONDS = 0.4


def snapshot() -> dict[Path, int]:
    found: dict[Path, int] = {}
    for dirpath, dirnames, filenames in os.walk(APP_DIR):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = Path(dirpath) / name
            try:
                found[path] = path.stat().st_mtime_ns
            except OSError:
                continue
    return found


def changed_files(before: dict[Path, int], after: dict[Path, int]) -> list[Path]:
    paths = set(before) | set(after)
    return sorted(path for path in paths if before.get(path) != after.get(path))


def display_path(path: Path) -> str:
    return path.resolve().relative_to(REPO_DIR).as_posix()


def file_list(paths: list[Path]) -> list[str]:
    return [display_path(path) for path in paths]


def child_flags() -> int:
    """Creation flags for the app process.

    ``tools/dev.py up`` runs this watcher with its output on a log file, so the
    app would otherwise get a console window of its own. A watcher started in a
    terminal keeps inheriting that terminal, so its tracebacks stay in view.
    """
    if os.name != "nt":
        return 0
    if sys.stdout.isatty():
        return 0
    return subprocess.CREATE_NO_WINDOW


def start(generation: int, files: list[str]) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["ENV"] = "dev"
    env["PYTHONUNBUFFERED"] = "1"
    # The default session runs on its checkout slot, so both the probe and Vite
    # read the same number.
    slot = ui_slot()
    env["DEV_SLOT"] = str(slot)
    env["DEV_UI_SLOT"] = str(slot)
    env["DEV_GENERATION"] = str(generation)
    env["DEV_RESTART_FILES"] = json.dumps(files)
    return subprocess.Popen(
        [sys.executable, "-u", str(APP_DIR / "main.py")],
        cwd=APP_DIR,
        env=env,
        creationflags=child_flags(),
    )


def append_restart_log(
    event: str,
    generation: int,
    files: list[str],
    pid: int | None,
    code: int | None = None,
) -> None:
    record: dict[str, object] = {
        "event": event,
        "generation": generation,
        "slot": dev_slot(),
        "pid": pid,
        "files": files,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if code is not None:
        record["code"] = code
    try:
        with RESTART_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
    except OSError as exc:
        print(f"[dev] could not write {RESTART_LOG.name}: {exc}", flush=True)


def stop(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def wait_for_changes(baseline: dict[Path, int]) -> tuple[dict[Path, int], list[Path]]:
    current = snapshot()
    changed = changed_files(baseline, current)
    deadline = time.monotonic() + DEBOUNCE_SECONDS
    while time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        latest = snapshot()
        latest_changed = changed_files(baseline, latest)
        current = latest
        if latest_changed != changed:
            changed = latest_changed
            deadline = time.monotonic() + DEBOUNCE_SECONDS
    return current, changed


def main() -> None:
    # Heal a checkout with no slot file, then hold the checkout slot for the
    # life of the session so a closed session frees it.
    if slots.SLOT_FILE.exists():
        slot = ui_slot()
        slots.claim_slot(slot, "checkout")
    else:
        slot = slots.ensure_checkout_slot()
    baseline = snapshot()
    generation = 1
    files: list[str] = []
    proc: subprocess.Popen[bytes] | None = start(generation, files)
    append_restart_log("start", generation, files, proc.pid)
    print(
        f"[dev] started slot={slot} probe={probe_port(slot)} generation={generation} pid={proc.pid}",
        flush=True,
    )

    try:
        while True:
            time.sleep(POLL_SECONDS)
            current = snapshot()
            changed = changed_files(baseline, current)
            if changed:
                current, changed = wait_for_changes(baseline)
                if not changed:
                    baseline = current
                    continue
                if proc is not None and proc.poll() is not None:
                    names = ", ".join(files)
                    print(
                        f"[dev] exited code={proc.returncode} generation={generation} files={names}",
                        flush=True,
                    )
                    append_restart_log("exit", generation, files, proc.pid, proc.returncode)
                elif proc is not None:
                    stop(proc)
                generation += 1
                files = file_list(changed)
                proc = start(generation, files)
                baseline = current
                names = ", ".join(files)
                append_restart_log("restart", generation, files, proc.pid)
                print(f"[dev] restarted {names} generation={generation} pid={proc.pid}", flush=True)
                continue

            if proc is not None and proc.poll() is not None:
                names = ", ".join(files)
                print(
                    f"[dev] exited code={proc.returncode} generation={generation} files={names}",
                    flush=True,
                )
                append_restart_log("exit", generation, files, proc.pid, proc.returncode)
                if proc.returncode == 0:
                    # The window was closed, which ends the session. The app
                    # stops Vite on its way out; do it here too so the server
                    # cannot be left behind, then let the slot go.
                    stopped = stop_vite()
                    if stopped:
                        print(f"[dev] stopped vite pid={stopped}", flush=True)
                    print("[dev] session ended", flush=True)
                    return
                proc = None
    except KeyboardInterrupt:
        if proc is not None:
            stop(proc)
        print("[dev] stopped", flush=True)
    finally:
        slots.release_slot(slot)


if __name__ == "__main__":
    main()
