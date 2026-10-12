"""Discord rich presence for the song that is playing.

Discord's desktop app exposes a local pipe. This module talks to that pipe with
an application ID that ships with the app. A bot token is not used, and nothing
is sent if Discord is closed or the setting is off.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any

from pypresence import Presence
from pypresence.exceptions import (
    ConnectionTimeout,
    DiscordNotFound,
    InvalidID,
    InvalidPipe,
    PipeClosed,
    ResponseTimeout,
    ServerError,
)
from pypresence.types import ActivityType, StatusDisplayType

from util.app_paths import data_dir

logger = logging.getLogger(__name__)

_CONFIG_PATH = data_dir() / "discord.json"
# Application id from the Discord developer portal. It is not a bot token and it
# is not a secret: Discord's local pipe has no authentication, so the id only
# decides which application name and art the presence shows under. It ships with
# the app, which is why Settings is a plain on/off switch and cannot change it.
_DEFAULT_CLIENT_ID = "1558993268094668981"
_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_MAX_IMAGE_LEN = 256
_MIN_INTERVAL = 1.0
_IDLE = object()

# Pipe errors mean Discord is not running, or it restarted. They are not fatal.
_UNAVAILABLE = (
    DiscordNotFound,
    InvalidPipe,
    PipeClosed,
    ConnectionTimeout,
    ResponseTimeout,
    BrokenPipeError,
    ConnectionError,
    TimeoutError,
    OSError,
)


class _Retry(Exception):
    def __init__(self, delay: float) -> None:
        self.delay = delay


def _clip(value: str, limit: int) -> str:
    value = " ".join(value.split())
    if len(value) <= limit:
        return value
    if limit <= 1:
        return value[:limit]
    return value[: limit - 1].rstrip() + "…"


def _flag(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return False


def _seconds(value: object) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if number != number or number < 0 or number == float("inf"):
        return 0.0
    return number


def cover_url(artwork: str, video_id: str) -> str | None:
    """Pick an https cover Discord can fetch. Google thumbs are asked for at 512px."""
    candidates: list[str] = []
    artwork = (artwork or "").strip()
    if artwork.startswith("https://"):
        if "googleusercontent.com" in artwork or "ggpht.com" in artwork:
            base = artwork.split("=", 1)[0]
            candidates.append(f"{base}=w512-h512-l90-rj")
        else:
            candidates.append(artwork)
    if _VIDEO_ID.fullmatch(video_id or ""):
        candidates.append(f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")
    for url in candidates:
        if len(url) <= _MAX_IMAGE_LEN:
            return url
    return None


def listening_state(artist: str, album: str) -> str:
    artist = _clip(artist, 128)
    album = _clip(album, 128)
    if artist and album and album.casefold() not in artist.casefold():
        line = f"{artist} — {album}"
    else:
        line = artist or album or "YouTube Music"
    return _clip(line, 128)


def _listen_url(video_id: str) -> str | None:
    if _VIDEO_ID.fullmatch(video_id or ""):
        return f"https://music.youtube.com/watch?v={video_id}"
    return None


def _image_key(track: dict[str, Any], mode: int) -> str | None:
    """mode 0 is the cover URL, mode 1 is Discord's external-image proxy form."""
    if mode >= 2:
        return None
    url = cover_url(str(track.get("artwork") or ""), str(track.get("video_id") or ""))
    if not url:
        return None
    if mode == 0:
        return url
    protocol, _, rest = url.partition("://")
    proxied = f"mp:external/ytmusic/{protocol}/{rest}"
    if len(proxied) > _MAX_IMAGE_LEN:
        return None
    return proxied


def _payload(track: dict[str, Any], *, buttons: bool, image_mode: int) -> dict[str, Any]:
    url = _listen_url(str(track["video_id"]))
    image = _image_key(track, image_mode)
    details = _clip(str(track["title"]), 128) or "YouTube Music"
    payload: dict[str, Any] = {
        "activity_type": ActivityType.LISTENING,
        "status_display_type": StatusDisplayType.DETAILS,
        "details": details,
        "state": listening_state(str(track["artist"]), str(track["album"])),
    }
    if url:
        payload["details_url"] = url
        payload["large_url"] = url
    if image:
        payload["large_image"] = image
        # Discord prints large_text as its own line. The album is already in the
        # artist line, so a caption would show it a second time.
    # pypresence 4 documents these as unix milliseconds.
    if track["playing"]:
        now_ms = int(time.time() * 1000)
        elapsed_ms = int(float(track["elapsed"]) * 1000)
        start = now_ms - elapsed_ms
        payload["start"] = start
        duration_ms = int(float(track["duration"]) * 1000)
        if duration_ms > elapsed_ms + 500:
            payload["end"] = start + duration_ms
    if buttons and url:
        payload["buttons"] = [{"label": "Listen", "url": url}]
    return payload


def _track_key(track: dict[str, Any]) -> tuple[Any, ...]:
    return (
        track["title"],
        track["artist"],
        track["album"],
        bool(track["playing"]),
        round(float(track["elapsed"]), 1),
        round(float(track["duration"]), 1),
        track["artwork"],
        track["video_id"],
    )


class DiscordPresence:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._enabled = True
        self._client_id = _DEFAULT_CLIENT_ID
        self._connected = False
        self._state = "off"
        self._message = ""
        self._desired: dict[str, Any] | None | object = _IDLE
        self._epoch = 0
        self._rejected = ""
        self._load()
        self._thread = threading.Thread(target=self._loop, name="discord-presence", daemon=True)
        self._thread.start()
        if self._enabled:
            self._state = "connecting"
            self._message = "Connecting to Discord..."
            self._wake.set()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot()

    def configure(self, enabled: object) -> dict[str, Any]:
        turned_on = _flag(enabled)
        with self._lock:
            self._enabled = turned_on
            self._rejected = ""
            self._epoch += 1
            self._connected = False
            if self._enabled:
                self._state = "connecting"
                self._message = "Connecting to Discord..."
            else:
                self._state = "off"
                self._message = ""
            try:
                self._save()
            except OSError:
                logger.exception("Could not save Discord settings")
                snapshot = self._snapshot()
                snapshot["message"] = "Couldn't save the Discord setting."
                return snapshot
            snapshot = self._snapshot()
        self._wake.set()
        return snapshot

    def update(
        self,
        title: object,
        artist: object,
        album: object,
        playing: object,
        elapsed: object,
        duration: object,
        artwork: object,
        video_id: object,
    ) -> None:
        try:
            name = str(title or "").strip()
            if not name:
                desired: dict[str, Any] | None = None
            else:
                length = _seconds(duration)
                position = _seconds(elapsed)
                if length > 0:
                    position = min(position, length)
                desired = {
                    "title": name,
                    "artist": str(artist or "").strip(),
                    "album": str(album or "").strip(),
                    "playing": _flag(playing),
                    "elapsed": min(position, 24 * 60 * 60),
                    "duration": length,
                    "artwork": str(artwork or "").strip(),
                    "video_id": str(video_id or "").strip(),
                }
                # A paused song is not shown at all. Discord would otherwise keep
                # a frozen progress bar and the old track on screen after a pause.
                if not desired["playing"]:
                    desired = None
        except Exception:
            logger.exception("Ignored a bad Discord presence update")
            return
        with self._lock:
            self._desired = desired
        self._wake.set()

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=2)

    def _snapshot(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "connected": self._connected,
            "state": self._state,
            "message": self._message,
        }

    def _set(self, state: str, message: str) -> None:
        with self._lock:
            self._state = state
            self._message = message
            self._connected = state == "connected"

    def _load(self) -> None:
        try:
            raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError, UnicodeError):
            logger.warning("Could not read Discord settings")
            return
        if not isinstance(raw, dict):
            return
        self._enabled = bool(raw.get("enabled"))

    def _save(self) -> None:
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {"enabled": self._enabled}
        temporary = _CONFIG_PATH.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        temporary.replace(_CONFIG_PATH)

    def _loop(self) -> None:
        self._rpc: Presence | None = None
        self._rpc_id = ""
        self._shown = False
        self._sent_key: tuple[Any, ...] | None = None
        self._sent_epoch = -1
        self._last_ipc = 0.0
        self._backoff = 2.0
        self._reported_wait = False
        self._allow_buttons = True
        delay: float | None = None
        while not self._stop.is_set():
            self._wake.wait(delay)
            delay = None
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                self._tick()
            except _Retry as exc:
                delay = exc.delay
            except Exception:
                logger.exception("Discord rich presence failed")
                self._drop(clear=False)
                self._set("error", "Couldn't update Discord presence.")
                delay = 15
        self._drop(clear=True)

    def _tick(self) -> None:
        with self._lock:
            enabled = self._enabled
            client_id = self._client_id
            desired = self._desired
            epoch = self._epoch
            rejected = self._rejected
        if not enabled or not client_id:
            self._sent_key = None
            self._sent_epoch = -1
            self._drop(clear=True)
            return
        if rejected == client_id:
            return
        try:
            if not self._ensure(client_id):
                return
            self._publish_desired(desired, epoch, client_id)
        except InvalidID:
            with self._lock:
                self._rejected = client_id
            self._drop(clear=False)
            self._set("invalid", "Discord rejected this app's application ID.")
            logger.warning("Discord rejected the application ID")
        except _UNAVAILABLE:
            self._drop(clear=False)
            if not self._reported_wait:
                logger.info("Discord rich presence is waiting for the desktop app")
                self._reported_wait = True
            self._set(
                "waiting",
                "Discord isn't open. Start the desktop app and this will connect on its own.",
            )
            delay = self._backoff
            self._backoff = min(30.0, self._backoff * 2)
            raise _Retry(delay)

    def _ensure(self, client_id: str) -> bool:
        if self._rpc is not None and self._rpc_id == client_id:
            return True
        self._drop(clear=True)
        self._set("connecting", "Connecting to Discord...")
        rpc = Presence(str(client_id), connection_timeout=8, response_timeout=8)
        try:
            rpc.connect()
        except Exception:
            self._close_rpc(rpc)
            raise
        with self._lock:
            keep = not self._stop.is_set() and self._enabled and self._client_id == client_id
        if not keep:
            self._close_rpc(rpc)
            return False
        self._rpc = rpc
        self._rpc_id = client_id
        self._allow_buttons = True
        self._reported_wait = False
        self._backoff = 2.0
        self._sent_key = None
        logger.info("Discord rich presence connected")
        return True

    def _publish_desired(self, desired: dict[str, Any] | None | object, epoch: int, client_id: str) -> None:
        if desired is _IDLE:
            self._mark_connected(client_id)
            return
        key = ("clear",) if desired is None else _track_key(desired)
        if key == self._sent_key and epoch == self._sent_epoch:
            return
        since = time.monotonic() - self._last_ipc
        if self._last_ipc and since < _MIN_INTERVAL:
            raise _Retry(_MIN_INTERVAL - since)
        try:
            if desired is None:
                if self._shown and self._rpc is not None:
                    self._rpc.clear()
                    logger.info("Discord presence cleared")
                self._shown = False
            else:
                self._publish(desired)
                self._shown = True
        except ServerError as exc:
            logger.warning("Discord rejected presence: %s", exc)
            self._sent_key = key
            self._sent_epoch = epoch
            self._last_ipc = time.monotonic()
            self._set("error", "Couldn't update Discord presence.")
            return
        self._sent_key = key
        self._sent_epoch = epoch
        self._last_ipc = time.monotonic()
        self._mark_connected(client_id)

    def _mark_connected(self, client_id: str) -> None:
        with self._lock:
            still = self._enabled and self._client_id == client_id and not self._stop.is_set()
        if not still:
            self._drop(clear=True)
            return
        self._set("connected", "Connected to Discord.")

    def _publish(self, track: dict[str, Any]) -> None:
        rpc = self._rpc
        if rpc is None:
            raise PipeClosed
        buttons = self._allow_buttons
        image_mode = 0
        stripped = False
        while True:
            kwargs = _payload(track, buttons=buttons, image_mode=image_mode)
            try:
                rpc.update(**kwargs)
            except ServerError as exc:
                text = str(exc).lower()
                if buttons and "button" in text:
                    buttons = False
                    logger.info("Discord presence buttons are not available for this application")
                    continue
                if image_mode < 2 and kwargs.get("large_image") and any(
                    token in text for token in ("image", "asset", "url", "icon")
                ):
                    image_mode += 1
                    logger.info("Discord cover was rejected (%s); trying another image form", exc)
                    continue
                if not stripped and (buttons or image_mode < 2):
                    buttons = False
                    image_mode = 2
                    stripped = True
                    logger.info("Discord rejected the presence payload (%s); retrying with text only", exc)
                    continue
                raise
            else:
                self._allow_buttons = buttons
                logger.info(
                    "Discord presence: %s (%s)",
                    track["title"],
                    "playing" if track["playing"] else "paused",
                )
                return

    def _drop(self, clear: bool) -> None:
        rpc = self._rpc
        self._rpc = None
        self._rpc_id = ""
        shown = self._shown
        self._shown = False
        if rpc is None:
            return
        try:
            if clear and shown:
                rpc.clear()
        except Exception:
            logger.debug("Discord presence clear failed", exc_info=True)
        self._close_rpc(rpc)

    def _close_rpc(self, rpc: Presence) -> None:
        try:
            rpc.close()
        except Exception:
            loop = getattr(rpc, "loop", None)
            if loop is not None and not loop.is_closed():
                loop.close()


discord_presence = DiscordPresence()
