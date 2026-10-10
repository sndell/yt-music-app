"""Restart the pywebview app when Python files under app/ change."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent
SKIP_DIRS = {"__pycache__", ".cache", ".venv", "webview-data"}
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


def start() -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["ENV"] = "dev"
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.Popen(
        [sys.executable, "-u", str(APP_DIR / "main.py")],
        cwd=APP_DIR,
        env=env,
    )


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
    baseline = snapshot()
    proc: subprocess.Popen[bytes] | None = start()
    print(f"[dev] started pid={proc.pid}", flush=True)

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
                if proc is not None and proc.poll() is None:
                    stop(proc)
                proc = start()
                baseline = current
                names = ", ".join(display_path(path) for path in changed)
                print(f"[dev] restarted {names} pid={proc.pid}", flush=True)
                continue

            if proc is not None and proc.poll() is not None:
                print(f"[dev] exited code={proc.returncode}", flush=True)
                proc = None
    except KeyboardInterrupt:
        if proc is not None:
            stop(proc)
        print("[dev] stopped", flush=True)


if __name__ == "__main__":
    main()
