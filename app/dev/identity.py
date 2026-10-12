"""Ports and restart identity for one dev checkout.

Slot 0 keeps the original ports. A worktree writes app/dev/.dev-slot so its
window does not take the main checkout's probe, Vite, or DevTools ports.
Older checkouts may still have dev/.dev-slot or app/.dev-slot. This module
only reads those files.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from util.app_paths import is_frozen

DEV_DIR = Path(__file__).resolve().parent
APP_DIR = DEV_DIR.parent
REPO_DIR = APP_DIR.parent
PROBE_BASE = 8765
UI_BASE = 5173
DEBUG_BASE = 9222

_slot: int | None = None


def _read_slot_file() -> str:
    """Slot text from app/dev/.dev-slot, then older locations. Does not create files."""
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
    return "0"


def dev_slot() -> int:
    """Slot for this process. Env wins, then the slot file, then 0."""
    global _slot
    if _slot is not None:
        return _slot
    if is_frozen():
        _slot = 0
        return _slot

    raw = os.environ.get("DEV_SLOT")
    if raw is None or not raw.strip():
        raw = _read_slot_file()
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
        slot = dev_slot()
    return UI_BASE + slot


def debug_port(slot: int | None = None) -> int:
    if slot is None:
        slot = dev_slot()
    return DEBUG_BASE + slot


def ui_origin(slot: int | None = None) -> str:
    return f"http://localhost:{ui_port(slot)}"


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
        "generation": generation(),
        "restarted_files": restarted_files(),
    }
