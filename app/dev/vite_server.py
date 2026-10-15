"""Stop the Vite dev server that serves one checkout's dev window.

The dev window and Vite have separate lifetimes, but closing the window ends
the session, so the Vite server started for it must not outlive it. This module
finds Vite through the checkout's UI port, which covers every way it gets
started: ``tools/dev.py up``, a plain ``pnpm dev``, or a hand-typed vite.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess

from dev.identity import ui_port

COMMAND_TIMEOUT = 10.0


def listener_pids(port: int) -> list[int]:
    """Pids listening on ``port``, lowest first. Empty when nothing listens.

    Only local listeners count: the window and Vite never leave this machine.
    """
    if os.name == "nt":
        return _windows_listener_pids(port)
    return _posix_listener_pids(port)


def stop_vite(port: int | None = None) -> int | None:
    """Kill the server listening on ``port``, default this checkout's UI port.

    Returns the pid that was asked to stop, or None when nothing listened.
    Called when the dev window closes, and again by the watcher as a backstop.
    """
    target = ui_port() if port is None else port
    pids = listener_pids(target)
    for pid in pids:
        _kill_tree(pid)
    return pids[0] if pids else None


def _windows_listener_pids(port: int) -> list[int]:
    """``netstat -ano`` line: proto, local, remote, state, pid.

    No ``-p tcp``: that lists IPv4 only, and Vite binds ``localhost``, which is
    usually the IPv6 loopback ``[::1]``.
    """
    output = _run(["netstat", "-ano"])
    if output is None:
        return []
    pids: set[int] = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP" or parts[3].upper() != "LISTENING":
            continue
        local, raw_pid = parts[1], parts[4]
        if _port_of(local) != port or not _is_loopback(local):
            continue
        if raw_pid.isdigit():
            pids.add(int(raw_pid))
    return sorted(pids)


def _posix_listener_pids(port: int) -> list[int]:
    lsof = shutil.which("lsof")
    if lsof is None:
        return []
    output = _run([lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"])
    if output is None:
        return []
    return sorted({int(token) for token in output.split() if token.isdigit()})


def _port_of(address: str) -> int | None:
    """The port from ``host:port``, including the ``[::1]:port`` form."""
    _, _, raw = address.rpartition(":")
    try:
        return int(raw)
    except ValueError:
        return None


def _is_loopback(address: str) -> bool:
    """Loopback or wildcard bind: the dev server is only ever served locally."""
    return address.startswith(("127.", "[::1]", "0.0.0.0", "[::]"))


def _run(command: list[str]) -> str | None:
    """stdout, or None when the command is missing or fails to finish."""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout


def _kill_tree(pid: int) -> None:
    """Kill one pid and its children. taskkill /T is the Windows way."""
    if pid <= 0 or pid == os.getpid():
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
