"""The always-on-top player window.

A second pywebview window in this process, not a second app: it shares the
WebView2 profile and the `Api` object, so `window.pywebview.api` works there
with no extra wiring. It is frameless because the surface draws its own chrome,
and `on_top` is what makes it a widget over other applications.

It never plays audio. The main window owns the only `<audio>` element and
mirrors its state to this page over a BroadcastChannel (see
`ui/src/features/popout`), so an open popout cannot double-play a song or write
the account's history twice.

The frameless style also drops the native resize grip, so the two sizes are set
from here: the full surface and the collapsed strip.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

from util.preferences import (
    POPOUT_COLLAPSED_HEIGHT,
    POPOUT_HEIGHT,
    POPOUT_WIDTH,
    preferences,
)

if TYPE_CHECKING:
    import webview

logger = logging.getLogger(__name__)

# A move fires once per pixel while dragging; one write per pause is enough.
SAVE_DELAY_SECONDS = 0.6
SCREEN_MARGIN = 24
BACKGROUND = "#0b0b0d"


def _screens() -> list[Any]:
    try:
        import webview

        return list(webview.screens)
    except Exception:  # noqa: BLE001 - a missing screen list is not worth failing over
        return []


def _primary(screens: list[Any]) -> Any:
    """The monitor whose bounds contain the origin; Windows calls that primary."""
    for screen in screens:
        if screen.x <= 0 < screen.x + screen.width and screen.y <= 0 < screen.y + screen.height:
            return screen
    return screens[0] if screens else None


def _corner(width: int, height: int) -> tuple[int, int]:
    """Top right of the primary screen, where a widget does not cover the work."""
    screen = _primary(_screens())
    if screen is None:
        return 0, 0
    return screen.x + screen.width - width - SCREEN_MARGIN, screen.y + SCREEN_MARGIN


def _reachable(x: int, y: int, width: int, height: int) -> bool:
    """A saved rectangle the user can still see: a monitor may have been unplugged."""
    screens = _screens()
    return any(
        screen.x < x + width
        and x < screen.x + screen.width
        and screen.y < y + height
        and y < screen.y + screen.height
        for screen in screens
    )


class PopoutWindow:
    """Opens, closes, pins and sizes the second window. One per app process."""

    def __init__(self) -> None:
        self._api: Any = None
        self._url = ""
        self._on_ready: Any = None
        self._window: Any = None
        self._lock = threading.Lock()
        self._width = POPOUT_WIDTH
        self._height = POPOUT_HEIGHT
        self._x: int | None = None
        self._y: int | None = None
        self._save_timer: threading.Timer | None = None

    def configure(self, api: Any, url: str, on_ready: Any = None) -> None:
        """Hand over the shared Api object, the page URL, and a window setup hook.

        `on_ready` runs once the page has loaded, which is where the main
        window's WebView2 menu patch belongs for this window too.
        """
        self._api = api
        self._url = url
        self._on_ready = on_ready

    @property
    def is_open(self) -> bool:
        return self._window is not None

    def restore(self) -> None:
        """Open the window at startup when the feature is enabled."""
        if preferences.popout()["enabled"]:
            self.open()

    def open(self) -> None:
        with self._lock:
            if self._window is not None:
                return
            window = self._create()
            if window is None:
                return
            self._window = window

    def close(self) -> None:
        """Clear the handle first, so a second close is a no-op, not a second destroy."""
        with self._lock:
            window = self._window
            self._window = None
        if window is not None:
            window.destroy()

    def set_pinned(self, pinned: bool) -> None:
        """Preferences validates the value; the stored one is the truth."""
        pinned = bool(preferences.set_popout(pinned=pinned)["pinned"])
        window = self._window
        if window is not None:
            window.on_top = pinned

    def set_collapsed(self, collapsed: bool) -> None:
        collapsed = bool(preferences.set_popout(collapsed=collapsed)["collapsed"])
        window = self._window
        if window is None:
            return
        window.resize(self._width, POPOUT_COLLAPSED_HEIGHT if collapsed else self._height)

    def _create(self) -> webview.Window | None:
        import webview

        settings = preferences.popout()
        bounds = settings["bounds"]
        self._width = bounds.get("width", POPOUT_WIDTH)
        self._height = bounds.get("height", POPOUT_HEIGHT)
        self._x = bounds.get("x")
        self._y = bounds.get("y")
        height = POPOUT_COLLAPSED_HEIGHT if settings["collapsed"] else self._height
        if self._x is None or self._y is None or not _reachable(self._x, self._y, self._width, height):
            self._x, self._y = _corner(self._width, height)
        try:
            window = webview.create_window(
                "YTMusic Player",
                f"{self._url}?popout=1",
                js_api=self._api,
                width=self._width,
                height=height,
                x=self._x,
                y=self._y,
                frameless=True,
                easy_drag=False,
                shadow=True,
                resizable=False,
                focus=False,
                on_top=settings["pinned"],
                background_color=BACKGROUND,
            )
        except Exception:  # noqa: BLE001 - a failed window must not kill the app
            logger.exception("Could not open the popout window")
            return None
        window.events.closed += self._handle_closed
        window.events.moved += self._handle_moved
        window.events.loaded += lambda: self._handle_ready(window)
        # The form is sized while it still has a border, so the page comes up
        # 16x39 short of the requested viewport. A resize after the frameless
        # style is applied makes Size and ClientSize the same number.
        window.resize(self._width, height)
        logger.info("Popout open at %sx%s", self._width, height)
        return window

    def _handle_closed(self) -> None:
        with self._lock:
            self._window = None
        self._save_bounds()
        logger.info("Popout closed")

    def _handle_ready(self, window: Any) -> None:
        if self._on_ready is None:
            return
        try:
            self._on_ready(window)
        except Exception:  # noqa: BLE001 - a failed patch must not close the window
            logger.exception("Popout ready hook failed")

    def _handle_moved(self, x: int, y: int) -> None:
        self._x, self._y = int(x), int(y)
        self._schedule_save()

    def _schedule_save(self) -> None:
        with self._lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
            timer = threading.Timer(SAVE_DELAY_SECONDS, self._save_bounds)
            timer.daemon = True
            timer.start()
            self._save_timer = timer

    def _save_bounds(self) -> None:
        """Store the full size even while collapsed, so expanding comes back."""
        bounds = {"width": self._width, "height": self._height}
        if self._x is not None and self._y is not None:
            bounds["x"] = self._x
            bounds["y"] = self._y
        preferences.set_popout(bounds=bounds)


popout = PopoutWindow()
