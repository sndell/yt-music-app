"""Small UI preferences that should survive a restart, such as the volume.

The packaged window serves the UI on a random localhost port, so the page's
localStorage origin changes on every launch. These values live in a JSON file
under data_dir() instead.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from util.app_paths import data_dir

logger = logging.getLogger(__name__)

_CONFIG_PATH = data_dir() / "preferences.json"
_DEFAULT_VOLUME = 50


def _volume(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(min(100, max(0, round(value))))


class Preferences:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: dict[str, Any] = {}
        self._load()

    def volume(self) -> int:
        with self._lock:
            stored = _volume(self._values.get("volume"))
            return _DEFAULT_VOLUME if stored is None else stored

    def set_volume(self, value: object) -> int:
        level = _volume(value)
        if level is None:
            return self.volume()
        with self._lock:
            if self._values.get("volume") == level:
                return level
            self._values["volume"] = level
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return level

    def _load(self) -> None:
        try:
            raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError, UnicodeError):
            logger.warning("Could not read preferences")
            return
        if isinstance(raw, dict):
            self._values = raw

    def _save(self) -> None:
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = _CONFIG_PATH.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self._values, indent=2) + "\n", encoding="utf-8")
        temporary.replace(_CONFIG_PATH)


preferences = Preferences()
