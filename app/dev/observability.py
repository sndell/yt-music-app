"""Dev-only observability for the probe.

Two ring buffers: one for Python log records, one for what the renderer
reports (console output and uncaught errors). The probe's ``/logs`` reads
both, so an agent sees the same failures the terminal would show without
scraping it.

Nothing here runs outside a DEBUG process. ``main.py`` installs the Python
ring and attaches the renderer sink only when ``_DEBUG`` is set.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any

MAX_PYTHON_RECORDS = 800
MAX_RENDERER_RECORDS = 800
# Long messages are clipped so one payload cannot fill the ring.
MAX_TEXT = 4000
_LOG_FORMAT = "%(message)s"

# Log levels the renderer is allowed to send, mapped to a sort order.
_LEVEL_ORDER = {"debug": 10, "info": 20, "warning": 30, "error": 40, "unhandled": 50}


class PythonLogRing(logging.Handler):
    """Keeps the most recent Python log records in memory."""

    def __init__(self, maxlen: int = MAX_PYTHON_RECORDS) -> None:
        super().__init__(level=logging.INFO)
        self.records: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._formatter = logging.Formatter(_LOG_FORMAT)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry: dict[str, Any] = {
                "ts": record.created,
                "level": record.levelname.lower(),
                "logger": record.name,
                "message": self._formatter.format(record)[:MAX_TEXT],
            }
            if record.exc_info:
                entry["traceback"] = (
                    logging.Formatter().formatException(record.exc_info)[:MAX_TEXT]
                )
            with self._lock:
                self.records.append(entry)
        except Exception:  # a logging handler must never raise
            self.handleError(record)

    def snapshot(self, since: float | None = None, level: str | None = None) -> list[dict[str, Any]]:
        floor = _LEVEL_ORDER.get((level or "").lower())
        with self._lock:
            items = list(self.records)
        if since is not None:
            items = [item for item in items if item["ts"] > since]
        if floor is not None:
            items = [item for item in items if _LEVEL_ORDER.get(item["level"], 0) >= floor]
        return items


class RendererLog:
    """What the page reports: console lines and uncaught errors."""

    def __init__(self, maxlen: int = MAX_RENDERER_RECORDS) -> None:
        self.records: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def add(self, payload: Any) -> dict[str, int]:
        """Accepts ``{"entries": [...]}`` or a single entry. Returns a count."""
        if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
            entries = payload["entries"]
        elif isinstance(payload, dict):
            entries = [payload]
        elif isinstance(payload, list):
            entries = payload
        else:
            entries = [{"level": "info", "message": str(payload)}]

        stored = 0
        with self._lock:
            for raw in entries:
                if not isinstance(raw, dict):
                    continue
                level = str(raw.get("level", "info")).lower()
                if level not in _LEVEL_ORDER:
                    level = "info"
                entry = {
                    "ts": raw.get("ts") if isinstance(raw.get("ts"), (int, float)) else time.time(),
                    "level": level,
                    "kind": str(raw.get("kind", "console")),
                    "message": str(raw.get("message", ""))[:MAX_TEXT],
                }
                stack = raw.get("stack")
                if stack:
                    entry["stack"] = str(stack)[:MAX_TEXT]
                url = raw.get("url")
                if url:
                    entry["url"] = str(url)[:MAX_TEXT]
                self.records.append(entry)
                stored += 1
        return {"stored": stored}

    def snapshot(self, since: float | None = None, level: str | None = None) -> list[dict[str, Any]]:
        floor = _LEVEL_ORDER.get((level or "").lower())
        with self._lock:
            items = list(self.records)
        if since is not None:
            items = [item for item in items if item["ts"] > since]
        if floor is not None:
            items = [item for item in items if _LEVEL_ORDER.get(item["level"], 0) >= floor]
        return items

    def last_error(self, *, after_boot: bool = True) -> dict[str, Any] | None:
        """Most recent error. ``after_boot`` ignores anything before the page's
        last load, so a transient error that a reload already cleared does not
        keep making a healthy window look broken."""
        with self._lock:
            items = list(self.records)
        if after_boot:
            boot = 0.0
            for item in items:
                if item.get("kind") == "boot":
                    boot = max(boot, float(item.get("ts") or 0.0))
            items = [item for item in items if float(item.get("ts") or 0.0) >= boot]
        for item in reversed(items):
            if _LEVEL_ORDER.get(item["level"], 0) >= _LEVEL_ORDER["error"]:
                return item
        return None


python_ring = PythonLogRing()
renderer_log = RendererLog()
_installed = False


def install_python_ring() -> None:
    """Attach the in-memory handler to the root logger, once."""
    global _installed
    if _installed:
        return
    logging.getLogger().addHandler(python_ring)
    _installed = True


def attach_renderer_sink(api: Any) -> None:
    """Expose ``api.dev_report`` so the page can forward console output.

    Called before the window is created, so pywebview enumerates it.
    """
    api.dev_report = renderer_log.add
