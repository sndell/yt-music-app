"""Dev slot registry and allocator for parallel worktrees.

A checkout keeps its preferred number in ``app/dev/.dev-slot`` and owns the
Vite port. A session claims that slot in a registry shared by every worktree
of one repository, under ``<git-common-dir>/ytmusic-dev``. The ports are the
hard truth: a slot is busy while a live claim names it or any of its three
ports is bound.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

# identity imports util from app/.
_APP_DIR = Path(__file__).resolve().parent.parent
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from dev import identity

MAX_SLOT = 50
LOCK_TIMEOUT = 5.0
LOCK_STALE = 10.0

# This checkout's preference. The older paths are still read.
SLOT_FILE = identity.DEV_DIR / ".dev-slot"
LEGACY_SLOT_FILES = (
    identity.REPO_DIR / "dev" / ".dev-slot",
    identity.APP_DIR / ".dev-slot",
)

_registry: Path | None = None


def is_linked_worktree() -> bool:
    """True when this checkout is a git worktree, not the main checkout."""
    return identity.is_linked_worktree()


def registry_dir() -> Path:
    """Shared registry for every worktree, from the git common directory.

    Falls back to a path under app/dev when git is unavailable, which covers
    the frozen exe. Memoized.
    """
    global _registry
    if _registry is not None:
        return _registry

    root: Path | None = None
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(identity.REPO_DIR),
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        text = result.stdout.strip()
        if result.returncode == 0 and text:
            root = Path(text) / "ytmusic-dev"
    except (OSError, subprocess.SubprocessError):
        root = None

    if root is None:
        root = identity.APP_DIR / "dev" / ".dev-registry"
    root.mkdir(parents=True, exist_ok=True)
    _registry = root
    return root


def ports_for(slot: int) -> tuple[int, int, int]:
    """The probe, Vite, and CDP ports for one slot."""
    return (identity.probe_port(slot), identity.ui_port(slot), identity.debug_port(slot))


def port_in_use(port: int) -> bool:
    """True when a listener holds the port on IPv4 or IPv6 loopback.

    Uses bind, not connect: a security product on this machine drops the SYN
    to an unbound loopback port, so a connect probe times out and would call
    every free port busy. Binding fails only when something already holds it.
    """
    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            probe = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue
        try:
            probe.bind((address, port))
        except OSError:
            return True
        finally:
            probe.close()
    return False


def _parse_slot(raw: object) -> int:
    try:
        slot = int(str(raw).strip())
    except (TypeError, ValueError):
        return 0
    return slot if slot >= 0 else 0


def _slot_text() -> str:
    for path in (SLOT_FILE, *LEGACY_SLOT_FILES):
        try:
            return path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
    return "0"


def _slot_text_at(root: Path) -> str:
    for path in (
        root / "app" / "dev" / ".dev-slot",
        root / "dev" / ".dev-slot",
        root / ".dev-slot",
    ):
        try:
            return path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
    return "0"


def checkout_slot() -> int:
    """This checkout's preferred slot. DEV_UI_SLOT, then the file, then 0."""
    raw = os.environ.get("DEV_UI_SLOT")
    if raw is None or not raw.strip():
        raw = _slot_text()
    return _parse_slot(raw)


def _write_slot_file(slot: int) -> None:
    SLOT_FILE.parent.mkdir(parents=True, exist_ok=True)
    SLOT_FILE.write_text(str(slot), encoding="utf-8")


def _claim_path(slot: int) -> Path:
    return registry_dir() / "slots" / f"{slot}.json"


def _read_claim(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _claim_slot_number(claim: dict, path: Path) -> int | None:
    value = claim.get("slot")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    try:
        return int(path.stem)
    except ValueError:
        return None


def _pid_alive(pid: int) -> bool:
    """True when a process with this pid is running."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _claim_pids(claim: dict) -> list[int]:
    pids: list[int] = []
    for key, value in claim.items():
        if key == "pid" or key.endswith("_pid"):
            if isinstance(value, int) and not isinstance(value, bool):
                pids.append(value)
        elif key == "pids" and isinstance(value, list):
            pids.extend(pid for pid in value if isinstance(pid, int) and not isinstance(pid, bool))
    return pids


def _claim_alive(claim: dict) -> bool:
    """A claim is live while any recorded pid is alive."""
    return any(_pid_alive(pid) for pid in _claim_pids(claim))


def live_claims() -> dict[int, dict]:
    """Live claims by slot. A claim with only dead pids is stale and removed."""
    claims: dict[int, dict] = {}
    directory = registry_dir() / "slots"
    if not directory.is_dir():
        return claims

    for path in sorted(directory.glob("*.json")):
        claim = _read_claim(path)
        if claim is None:
            continue
        slot = _claim_slot_number(claim, path)
        if slot is None:
            continue
        if _claim_alive(claim):
            claims[slot] = claim
            continue
        try:
            path.unlink()
        except OSError:
            pass
    return claims


def slot_free(slot: int) -> bool:
    """True when nothing claims the slot and none of its ports is in use."""
    if slot in live_claims():
        return False
    return not any(port_in_use(port) for port in ports_for(slot))


def _probe_checkout(slot: int, timeout: float = 0.8) -> str | None:
    """The checkout path the probe on this slot reports, or None.

    Used to tell this checkout's own leftover session from a stranger holding
    the same ports, so a running session is never renumbered.
    """
    url = f"http://127.0.0.1:{identity.probe_port(slot)}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    if isinstance(data, dict) and isinstance(data.get("checkout"), str):
        return data["checkout"]
    return None


def _worktree_entries() -> list[Path]:
    """Every worktree path for this repository, main checkout first.

    Empty when git is unavailable, so the frozen exe and tests stay quiet.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(identity.REPO_DIR), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []

    roots: list[Path] = []
    for line in result.stdout.splitlines():
        if not line.startswith("worktree "):
            continue
        raw = line[len("worktree ") :].strip()
        if not raw:
            continue
        try:
            roots.append(Path(raw).resolve())
        except OSError:
            continue
    return roots


def main_checkout() -> Path | None:
    """The main checkout of this repository, or None when git is unavailable."""
    roots = _worktree_entries()
    return roots[0] if roots else None


def main_venv_python() -> Path | None:
    """The main checkout's venv interpreter, when it exists.

    A linked worktree has no venv of its own; tooling shares the main
    checkout's so a new worktree needs no separate Python environment.
    """
    main = main_checkout()
    if main is None:
        return None
    for candidate in (
        main / "app" / ".venv" / "Scripts" / "python.exe",
        main / "app" / ".venv" / "bin" / "python",
    ):
        if candidate.exists():
            return candidate
    return None


def preferred_slots() -> dict[int, str]:
    """Slot to path for the other worktrees, from their .dev-slot files."""
    mapping: dict[int, str] = {}
    mine = os.path.normcase(str(identity.REPO_DIR.resolve()))
    for root in _worktree_entries():
        if os.path.normcase(str(root)) == mine:
            continue
        slot = _parse_slot(_slot_text_at(root))
        if slot > 0:
            mapping[slot] = root.as_posix()
    return mapping


@contextlib.contextmanager
def _lock(timeout: float = LOCK_TIMEOUT, stale: float = LOCK_STALE) -> Iterator[None]:
    """Serialise the read-then-claim step so two checkouts cannot race."""
    directory = registry_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "lock"
    deadline = time.monotonic() + timeout
    handle: int | None = None

    while handle is None:
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _lock_is_stale(path, stale):
                try:
                    path.unlink()
                except OSError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"dev slot lock is held: {path}")
            time.sleep(0.05)

    try:
        yield
    finally:
        os.close(handle)
        try:
            path.unlink()
        except OSError:
            pass


def _lock_is_stale(path: Path, stale: float) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) > stale
    except OSError:
        return False


def claim_slot(slot: int, role: str, extra: dict | None = None) -> dict:
    """Write the live claim for a slot. Call it once the slot is free."""
    record: dict[str, object] = {
        "slot": slot,
        "checkout": identity.checkout(),
        "pid": os.getpid(),
        "role": role,
        "started": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        record.update(extra)

    with _lock():
        path = _claim_path(slot)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            existing = _read_claim(path)
            if (
                existing is not None
                and _claim_alive(existing)
                and existing.get("checkout") != record["checkout"]
            ):
                raise RuntimeError(
                    f"slot {slot} is claimed by {existing.get('checkout')}"
                )
            try:
                path.unlink()
            except OSError:
                pass
        handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(record, stream)
        except OSError:
            try:
                path.unlink()
            except OSError:
                pass
            raise
    return record


def release_slot(slot: int) -> None:
    """Remove a claim on clean exit."""
    try:
        _claim_path(slot).unlink()
    except OSError:
        pass


def existing_session_slot() -> int | None:
    """The slot this checkout already serves on, from a claim or its probe.

    A live checkout claim names it directly. Without one, the ports may still
    be held by this checkout's own app or Vite, so the probe on the preferred
    slot decides: the same checkout means attach, anything else means the slot
    belongs to another checkout.
    """
    mine = identity.checkout()
    for slot, claim in sorted(live_claims().items()):
        if claim.get("role") == "checkout" and claim.get("checkout") == mine:
            return slot
    preferred = checkout_slot()
    if preferred <= 0 and is_linked_worktree():
        return None
    if slot_free(preferred):
        return None
    if _probe_checkout(preferred) == mine:
        return preferred
    return None


def ensure_checkout_slot(claim: bool = True) -> int:
    """Resolve, reserve, and claim this checkout's slot.

    A session already serving this checkout returns its slot untouched. A free
    preferred slot is kept and the file is not rewritten. When the preferred
    slot belongs to another checkout, take a free slot and rewrite only this
    checkout's file.

    Pass ``claim=False`` to persist the ``.dev-slot`` preference without
    writing a live claim. Tooling that only needs the number, and the app
    process itself, use that so a short-lived command or a bare window does
    not look like a running session.
    """
    running = existing_session_slot()
    if running is not None:
        return running

    preferred = checkout_slot()
    allow_preferred = preferred > 0 or not is_linked_worktree()
    chosen: int | None = None

    if allow_preferred:
        if slot_free(preferred):
            chosen = preferred
        else:
            owner = _probe_checkout(preferred)
            if owner == identity.checkout():
                return preferred
            if owner is None and any(port_in_use(port) for port in ports_for(preferred)):
                raise RuntimeError(
                    f"port {identity.ui_port(preferred)} is in use and no dev probe answers. "
                    "Stop the process holding it, then start again."
                )

    if chosen is None:
        reserved = set(preferred_slots())
        for slot in range(1, MAX_SLOT + 1):
            if slot in reserved:
                continue
            if slot_free(slot):
                chosen = slot
                break

    if chosen is None:
        for slot in range(1, MAX_SLOT + 1):
            if slot_free(slot):
                chosen = slot
                break

    if chosen is None:
        raise RuntimeError(f"no free dev slot in 1..{MAX_SLOT}")

    if chosen != _parse_slot(_slot_text()):
        _write_slot_file(chosen)
    if claim:
        claim_slot(chosen, "checkout")
    return chosen


def resolve_checkout_slot() -> int:
    """This checkout's slot, allocating and persisting one in a worktree.

    Never falls back to slot 0 in a linked worktree. Slot 0 is the main
    checkout's probe and Vite ports, so a worktree that used it would read
    another checkout's window. Leaves no claim behind.
    """
    return ensure_checkout_slot(claim=False)


def allocate_instance_slot(extra: dict | None = None) -> int:
    """First free slot from 1 up, claimed with role instance."""
    for slot in range(1, MAX_SLOT + 1):
        if slot_free(slot):
            claim_slot(slot, "instance", extra)
            return slot
    raise RuntimeError(f"no free instance slot in 1..{MAX_SLOT}")


def list_claims() -> list[dict]:
    claims = live_claims()
    return [claims[slot] for slot in sorted(claims)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dev.slots", description="Dev slot registry and allocator.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("ensure", help="resolve and claim this checkout's slot, then print it")
    release = commands.add_parser("release", help="release a slot claim")
    release.add_argument("--slot", type=int, required=True)
    commands.add_parser("list", help="print the live claims as JSON")
    args = parser.parse_args(argv)

    if args.command == "ensure":
        print(ensure_checkout_slot())
    elif args.command == "release":
        release_slot(args.slot)
    elif args.command == "list":
        print(json.dumps(list_claims(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
