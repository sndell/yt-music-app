"""Log capture for the dev control surface.

Three streams land here for an agent to read:

- Python's own log records, kept in memory by a root handler.
- Renderer console output and errors, forwarded from the page through `dev_log`.
- Vite's console output, which `dev.vite` tees to a file while still showing it.

Nothing here owns a thread or a file. The control server reads these buffers.
"""

from __future__ import annotations

import logging
import re
from collections import deque
from pathlib import Path
from typing import Any

MAX_PYTHON_LINES = 1000
MAX_RENDERER_LINES = 500
MAX_TEXT = 4000

# Vite draws colour and clears the screen; the tail should read as plain text.
_ANSI = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]"
)

_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}

_python: deque[dict[str, Any]] = deque(maxlen=MAX_PYTHON_LINES)
_renderer: deque[dict[str, Any]] = deque(maxlen=MAX_RENDERER_LINES)


class _RingHandler(logging.Handler):
    """Keep formatted records in memory. Never raises into the logging side."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            if record.exc_info:
                message = f"{message}\n{self.format(record)}"
            _python.append(
                {
                    "level": record.levelname.lower(),
                    "logger": record.name,
                    "message": message[:MAX_TEXT],
                    "ts": record.created,
                }
            )
        except Exception:
            pass


def install_python_ring() -> None:
    """Attach the in-memory handler to the root logger once."""
    root = logging.getLogger()
    if any(isinstance(handler, _RingHandler) for handler in root.handlers):
        return
    handler = _RingHandler()
    handler.setLevel(logging.DEBUG)
    root.addHandler(handler)


def add_renderer_entry(entry: dict[str, Any] | None) -> None:
    """Record one renderer console entry forwarded by the page."""
    if not entry:
        return
    level = str(entry.get("level", "log")).lower()
    if level not in _LEVELS:
        level = "log"
    _renderer.append(
        {
            "level": level,
            "message": str(entry.get("message", ""))[:MAX_TEXT],
            "source": str(entry.get("source", ""))[:512],
            "line": entry.get("line"),
        }
    )


def _at_least(level: str) -> int:
    return _LEVELS.get(level.lower(), 0)


def python_entries(level: str = "", limit: int = 200) -> list[dict[str, Any]]:
    """Recent Python log records, optionally at or above a level."""
    items = list(_python)
    floor = _at_least(level)
    if floor:
        items = [item for item in items if _LEVELS.get(item["level"], 0) >= floor]
    return items[-limit:]


def renderer_entries(level: str = "", limit: int = 200) -> list[dict[str, Any]]:
    """Recent renderer console entries, optionally at or above a level."""
    items = list(_renderer)
    floor = _at_least(level)
    if floor:
        items = [item for item in items if _LEVELS.get(item["level"], 0) >= floor]
    return items[-limit:]


def vite_tail(log_path: Path, limit: int = 200) -> list[str]:
    """Last lines of the tee'd Vite console, newest last.

    Windows PowerShell writes the tee in UTF-16, so decode by looking at the
    bytes rather than assuming UTF-8.
    """
    try:
        raw = log_path.read_bytes()
    except OSError:
        return []
    if not raw:
        return []
    if raw.count(b"\x00") > len(raw) // 4:
        text = raw.decode("utf-16-le", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
    text = _ANSI.sub("", text).replace("\x00", "")
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    return lines[-limit:]
