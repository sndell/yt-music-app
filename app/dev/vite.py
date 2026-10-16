"""Start and stop the Vite dev server from the window process.

In dev the window loads Vite. Starting the server here ties its lifetime to the
window: it opens in its own console as the app starts and closes with the app,
so there is no second command to run and no server left behind.

Each run takes its own free port, so several checkouts can run at the same time
without fighting over 5173. The port is picked and checked here, then handed to
Vite with ``--port``.
"""

from __future__ import annotations

import atexit
import logging
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

REPO_DIR = Path(__file__).resolve().parents[2]
UI_DIR = REPO_DIR / "ui"
ARTIFACTS_DIR = Path(__file__).resolve().parent / ".dev-artifacts"
LOG_PATH = ARTIFACTS_DIR / "vite.log"
DEFAULT_PORT = 5173

_process: subprocess.Popen | None = None
_port: int | None = None


def log_path() -> Path:
    """File the Vite console is tee'd to, for the dev control server."""
    return LOG_PATH


def vite_port() -> int | None:
    """Port Vite was given, or None when the app did not start it."""
    return _port


def ui_origin() -> str:
    """URL the window loads in dev, on the port Vite was given."""
    if _port is None:
        raise RuntimeError("Vite has not been started")
    return f"http://localhost:{_port}"


def _free_port() -> int:
    """A free port on the loopback.

    Binding to port 0 makes the OS pick one that is free right now. Vite takes
    it a moment later, so another process could still steal it. The strict port
    then makes Vite fail loudly instead of quietly moving.
    """
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _port_from_env() -> int:
    """Port to expect when the app does not start Vite itself."""
    raw = os.environ.get("VITE_PORT", "").strip()
    try:
        return int(raw) if raw else DEFAULT_PORT
    except ValueError:
        return DEFAULT_PORT


def _serving(port: int, timeout: float = 0.3) -> bool:
    """True when something accepts a connection on localhost:port.

    Vite binds the IPv6 loopback, so connect through the name rather than
    127.0.0.1.
    """
    try:
        with socket.create_connection(("localhost", port), timeout=timeout):
            return True
    except OSError:
        return False


def start_vite(timeout: float = 60.0) -> None:
    """Run ``pnpm dev`` on a free port, in its own console.

    Returns once Vite serves or the timeout passes, so the window opens on a
    ready server. Set ``AUTO_VITE=0`` to skip the start; the window then loads
    ``VITE_PORT``, or 5173.
    """
    global _process, _port
    if os.environ.get("AUTO_VITE") == "0":
        _port = _port_from_env()
        logger.info("AUTO_VITE=0, expecting Vite on port %s", _port)
        return
    if not UI_DIR.is_dir():
        logger.warning("No ui directory at %s, cannot start Vite", UI_DIR)
        return

    port = _free_port()
    _port = port
    flags = subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
    logger.info("Starting Vite on port %s in a new console (pnpm dev in %s)", port, UI_DIR)
    try:
        log = log_path()
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("", encoding="utf-8")
        if sys.platform == "win32":
            # Tee keeps the console visible for a person and leaves a tail an
            # agent can read through the dev control server. Windows PowerShell
            # has no -Encoding on Tee-Object, so leave it off.
            command = (
                f"pnpm dev --port {port} --strictPort 2>&1 | "
                f"Tee-Object -FilePath '{log}'"
            )
            args: list[str] = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        else:
            args = ["pnpm", "dev", "--port", str(port), "--strictPort"]
        _process = subprocess.Popen(args, cwd=str(UI_DIR), creationflags=flags)
    except OSError:
        logger.exception("Could not start Vite")
        return
    atexit.register(stop_vite)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _process.poll() is not None:
            logger.error("Vite exited with code %s before serving", _process.returncode)
            return
        if _serving(port):
            logger.info("Vite is serving at %s", ui_origin())
            return
        time.sleep(0.25)
    logger.warning("Vite did not answer on port %s within %.0fs", port, timeout)


def stop_vite() -> None:
    """Stop the Vite server this process started, and its children.

    A server the app did not start is left alone. Safe to call more than once.
    """
    global _process
    process = _process
    _process = None
    if process is None or process.poll() is not None:
        return
    logger.info("Stopping Vite (pid=%s)", process.pid)
    try:
        if sys.platform == "win32":
            # pnpm runs node as a child, so the whole tree has to go.
            # /T also closes the console window Vite was given.
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
        else:
            process.terminate()
            process.wait(timeout=10)
    except (OSError, subprocess.SubprocessError):
        logger.exception("Could not stop Vite")
