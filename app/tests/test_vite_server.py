"""Closing the dev window stops the Vite server on the checkout's UI port.

These tests use a real listener and the real lookup, but a throwaway port, so
they neither talk to the dev session nor touch the account.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

from dev import vite_server

# Binds, listens, and holds the port until it is killed.
STAND_IN_SERVER = (
    "import socket,time;"
    " s=socket.socket();"
    " s.bind(('127.0.0.1', {port}));"
    " s.listen(1);"
    " time.sleep(120)"
)

WAIT_SECONDS = 10.0


def free_port() -> int:
    """A port nothing holds right now."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def wait_for_listener(port: int) -> bool:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if vite_server.listener_pids(port):
            return True
        time.sleep(0.2)
    return False


def wait_for_exit(proc: subprocess.Popen) -> bool:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return True
        time.sleep(0.2)
    return False


def test_no_listener_has_no_pids() -> None:
    assert vite_server.listener_pids(free_port()) == []


def test_listener_pids_finds_the_owner_of_a_listening_port() -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = int(listener.getsockname()[1])
        assert vite_server.listener_pids(port) == [os.getpid()]


def test_listener_pids_finds_an_ipv6_loopback_listener() -> None:
    """Vite binds ``localhost``, which is the IPv6 loopback on this machine."""
    with socket.socket(socket.AF_INET6) as listener:
        listener.bind(("::1", 0))
        listener.listen(1)
        port = int(listener.getsockname()[1])
        assert vite_server.listener_pids(port) == [os.getpid()]


def test_stop_vite_kills_the_listener_and_reports_its_pid() -> None:
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-c", STAND_IN_SERVER.format(port=port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert wait_for_listener(port), "the stand-in server never listened"
        # list and stop agree on the pid: the process netstat names as the
        # owner, which is not Popen's pid when a shim sits in between.
        owner = vite_server.listener_pids(port)
        assert vite_server.stop_vite(port) == owner[0]
        assert wait_for_exit(server)
        assert vite_server.listener_pids(port) == []
    finally:
        if server.poll() is None:
            server.kill()
            server.wait(timeout=WAIT_SECONDS)


def test_stop_vite_reports_nothing_for_a_port_nothing_serves() -> None:
    assert vite_server.stop_vite(free_port()) is None
