"""Small UI preferences that should survive a restart, such as the volume.

The packaged window serves the UI on a random localhost port, so the page's
localStorage origin changes on every launch. These values live in a JSON file
under data_dir() instead.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from typing import Any

from util.app_paths import data_dir

logger = logging.getLogger(__name__)

_CONFIG_PATH = data_dir() / "preferences.json"
_DEFAULT_VOLUME = 50
# One entry per slider in the UI. The count is part of the stored shape, so a
# payload that does not carry exactly this many bands is ignored rather than
# stretched.
_EQUALIZER_BANDS = 10
# The UI's slider range, in dB. Clamping here too keeps a hand-edited or older
# preferences.json from driving Chromium's filters past what the sliders show.
_GAIN_LIMIT = 12.0
_DEFAULT_EQUALIZER: dict[str, Any] = {
    "enabled": False,
    "preamp": 0.0,
    "bass": 0.0,
    "treble": 0.0,
    "bands": [0.0] * _EQUALIZER_BANDS,
}

# Long enough to be heard as a blend, short enough that most songs keep their
# own ending. The player clamps it again to what a song has left.
_DEFAULT_CROSSFADE = 6
_MAX_CROSSFADE = 12

# The popout's size is a product decision, not a user one: the surface is laid
# out for 380px and the frameless window cannot be resized by its edges anyway.
POPOUT_WIDTH = 380
POPOUT_HEIGHT = 560
POPOUT_COLLAPSED_HEIGHT = 120


def _volume(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(min(100, max(0, round(value))))


def _seconds(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(min(_MAX_CROSSFADE, max(0, round(value))))


def _boolean(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _gain(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        return None
    return round(min(_GAIN_LIMIT, max(-_GAIN_LIMIT, number)), 1)


def _equalizer(value: object) -> dict[str, Any] | None:
    """The stored equalizer, or None when the payload is not one we wrote."""
    if not isinstance(value, dict):
        return None
    bands = value.get("bands")
    if not isinstance(bands, list) or len(bands) != _EQUALIZER_BANDS:
        return None
    gains = [_gain(band) for band in bands]
    if any(gain is None for gain in gains):
        return None
    preamp = _gain(value.get("preamp"))
    bass = _gain(value.get("bass"))
    treble = _gain(value.get("treble"))
    enabled = _boolean(value.get("enabled"))
    if preamp is None or bass is None or treble is None or enabled is None:
        return None
    return {
        "enabled": enabled,
        "preamp": preamp,
        "bass": bass,
        "treble": treble,
        "bands": gains,
    }


def _integer(value: object, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(min(high, max(low, round(value))))


def _bounds(value: object) -> dict[str, int]:
    """A saved window rectangle, keeping only the numbers that make sense."""
    if not isinstance(value, dict):
        return {}
    limits = {
        "x": (-20000, 20000),
        "y": (-20000, 20000),
        "width": (POPOUT_WIDTH, 1600),
        "height": (POPOUT_COLLAPSED_HEIGHT, 1600),
    }
    stored: dict[str, int] = {}
    for key, (low, high) in limits.items():
        number = _integer(value.get(key), low, high)
        if number is not None:
            stored[key] = number
    return stored


def _popout(value: object) -> dict[str, Any]:
    """The popout settings with every default filled in.

    `enabled` defaults off and has no Settings row: the player bar's popout
    button is the switch, and open/close store it, so a launch reopens the
    window only when it was open. That keeps the shutdown order from deciding
    the next start. `pinned` defaults on, so a missing value means "above
    other windows".
    """
    stored = value if isinstance(value, dict) else {}
    return {
        # Off by default: the player bar's button is the only switch, and it
        # writes this when it opens and closes the window.
        "enabled": _boolean(stored.get("enabled")) is True,
        "pinned": _boolean(stored.get("pinned")) is not False,
        "collapsed": _boolean(stored.get("collapsed")) is True,
        "bounds": _bounds(stored.get("bounds")),
    }


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

    def horizontal_nav(self) -> bool:
        with self._lock:
            return _boolean(self._values.get("horizontal_nav")) is True

    def set_horizontal_nav(self, value: object) -> bool:
        enabled = _boolean(value)
        if enabled is None:
            return self.horizontal_nav()
        with self._lock:
            if self._values.get("horizontal_nav") == enabled:
                return enabled
            self._values["horizontal_nav"] = enabled
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return enabled

    def equalizer(self) -> dict[str, Any]:
        with self._lock:
            stored = _equalizer(self._values.get("equalizer"))
            # A fresh list per call: callers write into the payload they get back.
            return {**_DEFAULT_EQUALIZER, "bands": list(_DEFAULT_EQUALIZER["bands"])} if stored is None else stored

    def set_equalizer(self, value: object) -> dict[str, Any]:
        current = self.equalizer()
        if not isinstance(value, dict):
            return current
        next_value = dict(current)
        enabled = _boolean(value.get("enabled"))
        if enabled is not None:
            next_value["enabled"] = enabled
        for key in ("preamp", "bass", "treble"):
            gain = _gain(value.get(key))
            if gain is not None:
                next_value[key] = gain
        bands = value.get("bands")
        if isinstance(bands, list) and len(bands) == _EQUALIZER_BANDS:
            gains = [_gain(band) for band in bands]
            if all(gain is not None for gain in gains):
                next_value["bands"] = gains
        with self._lock:
            if self._values.get("equalizer") == next_value:
                return next_value
            self._values["equalizer"] = next_value
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return next_value

    def popout(self) -> dict[str, Any]:
        with self._lock:
            return _popout(self._values.get("popout"))

    def set_popout(self, **changes: object) -> dict[str, Any]:
        """Merge the given popout settings, save them, and return them all."""
        with self._lock:
            current = _popout(self._values.get("popout"))
            updated = dict(current)
            for key in ("enabled", "pinned", "collapsed"):
                if key in changes:
                    flag = _boolean(changes[key])
                    if flag is not None:
                        updated[key] = flag
            if "bounds" in changes:
                updated["bounds"] = _bounds(changes["bounds"])
            if updated == current:
                return updated
            self._values["popout"] = updated
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return updated

    def crossfade_seconds(self) -> int:
        with self._lock:
            stored = _seconds(self._values.get("crossfade_seconds"))
            return _DEFAULT_CROSSFADE if stored is None else stored

    def set_crossfade_seconds(self, value: object) -> int:
        seconds = _seconds(value)
        if seconds is None:
            return self.crossfade_seconds()
        with self._lock:
            if self._values.get("crossfade_seconds") == seconds:
                return seconds
            self._values["crossfade_seconds"] = seconds
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return seconds

    def automix(self) -> bool:
        with self._lock:
            return _boolean(self._values.get("automix")) is True

    def set_automix(self, value: object) -> bool:
        enabled = _boolean(value)
        if enabled is None:
            return self.automix()
        with self._lock:
            if self._values.get("automix") == enabled:
                return enabled
            self._values["automix"] = enabled
            try:
                self._save()
            except OSError:
                logger.exception("Could not save preferences")
        return enabled

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
