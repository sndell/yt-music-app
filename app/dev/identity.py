"""Ports and restart identity for one dev checkout.

Slot 0 keeps the original ports. A worktree writes app/dev/.dev-slot so its
window does not take the main checkout's probe, Vite, or DevTools ports.
Older checkouts may still have dev/.dev-slot or app/.dev-slot. This module
only reads those files.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from util.app_paths import data_dir, is_frozen

DEV_DIR = Path(__file__).resolve().parent
APP_DIR = DEV_DIR.parent
REPO_DIR = APP_DIR.parent
PROBE_BASE = 8765
UI_BASE = 5173
DEBUG_BASE = 9222

_slot: int | None = None
_ui_slot: int | None = None
_title: str | None = None


def _read_slot_file() -> str:
    """Slot text from app/dev/.dev-slot, then older locations. Does not create files.

    Returns an empty string when no file exists, so a caller can tell "no slot
    named" from a file that deliberately says 0.
    """
    candidates = (
        DEV_DIR / ".dev-slot",
        REPO_DIR / "dev" / ".dev-slot",
        APP_DIR / ".dev-slot",
    )
    for path in candidates:
        try:
            return path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
    return ""


def _worktree_slot() -> int | None:
    """Allocate this worktree's own slot when no file or env names one.

    Slot 0 belongs to the main checkout. A linked worktree falling back to it
    would bind the main checkout's probe and Vite ports, which is the exact
    parallel-worktree collision this guards against. Imported lazily because
    slots imports this module.
    """
    try:
        from dev import slots
    except ImportError:
        return None
    try:
        return slots.resolve_checkout_slot()
    except (RuntimeError, OSError):
        return None


def ui_slot() -> int:
    """Checkout slot. DEV_UI_SLOT wins, then the slot file, then 0.

    A linked worktree with neither gets its own slot allocated, never 0.
    """
    global _ui_slot
    if _ui_slot is not None:
        return _ui_slot

    raw = os.environ.get("DEV_UI_SLOT")
    if raw is None or not raw.strip():
        raw = _read_slot_file()
    named = bool(raw and raw.strip())
    if not named and is_linked_worktree():
        resolved = _worktree_slot()
        if resolved is not None:
            _ui_slot = resolved
            return _ui_slot

    try:
        slot = int(raw.strip()) if named else 0
    except ValueError:
        slot = 0
    if slot < 0:
        slot = 0
    _ui_slot = slot
    return _ui_slot


def dev_slot() -> int:
    """Instance slot for this process. Env wins, then the checkout slot."""
    global _slot
    if _slot is not None:
        return _slot
    if is_frozen():
        _slot = 0
        return _slot

    raw = os.environ.get("DEV_SLOT")
    if raw is None or not raw.strip():
        _slot = ui_slot()
        return _slot
    try:
        slot = int(raw.strip())
    except ValueError:
        slot = 0
    if slot < 0:
        slot = 0
    _slot = slot
    return slot


def probe_port(slot: int | None = None) -> int:
    if slot is None:
        slot = dev_slot()
    return PROBE_BASE + slot


def ui_port(slot: int | None = None) -> int:
    if slot is None:
        slot = ui_slot()
    return UI_BASE + slot


def debug_port(slot: int | None = None) -> int:
    if slot is None:
        slot = dev_slot()
    return DEBUG_BASE + slot


def ui_origin(slot: int | None = None) -> str:
    return f"http://localhost:{ui_port(slot)}"


def checkout() -> str:
    """Repo path for this checkout, the one identity shared by its instances."""
    return REPO_DIR.as_posix()


def webview_data_dir(slot: int | None = None) -> Path:
    """WebView2 profile for this instance.

    The default session keeps webview-data/; every other slot gets its own
    folder, because WebView2 forbids two processes sharing one profile.
    """
    if slot is None:
        slot = dev_slot()
    if slot == ui_slot():
        return data_dir() / "webview-data"
    return data_dir() / f"webview-data-{slot}"


def is_linked_worktree() -> bool:
    """True when this checkout is a git worktree, not the main checkout."""
    return (REPO_DIR / ".git").is_file()


def _branch_name() -> str:
    """Current branch, or the checkout folder name when git is unavailable."""
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_DIR), "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        name = result.stdout.strip()
        if result.returncode == 0 and name:
            return name
    except (OSError, subprocess.SubprocessError):
        pass
    return REPO_DIR.name


def window_title() -> str:
    """Title for this window, so parallel agents can tell them apart.

    The main checkout stays ``YTMusic``. A worktree adds its branch name, and a
    non-default instance adds its slot. Memoized.
    """
    global _title
    if _title is not None:
        return _title
    if is_frozen():
        _title = "YTMusic"
        return _title
    title = f"YTMusic - {_branch_name()}" if is_linked_worktree() else "YTMusic"
    if dev_slot() != ui_slot():
        title = f"{title} (slot {dev_slot()})"
    _title = title
    return title


def generation() -> int:
    raw = os.environ.get("DEV_GENERATION", "0")
    try:
        value = int(raw.strip() or "0")
    except ValueError:
        return 0
    return value if value >= 0 else 0


def restarted_files() -> list[str]:
    raw = os.environ.get("DEV_RESTART_FILES", "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return [part for part in raw.split(",") if part]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if str(item)]
    return []


def health_payload() -> dict[str, object]:
    return {
        "ok": True,
        "pid": os.getpid(),
        "slot": dev_slot(),
        "checkout": checkout(),
        "generation": generation(),
        "restarted_files": restarted_files(),
    }
