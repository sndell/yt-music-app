from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from util.app_paths import data_dir, is_frozen

# Frozen builds have no console. Log before importing the app so startup
# failures land in the data folder.
ENV = "prod" if is_frozen() else os.getenv("ENV", "dev")
# Opt-in inspector. Stays off for a normal dev window and for the release exe.
# Does not change which UI is loaded: dev still uses Vite, a frozen exe still
# serves the packaged page.
DEVTOOLS = os.getenv("DEVTOOLS") == "1"
_DEBUG = ENV == "dev" or DEVTOOLS
_LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
if is_frozen():
    logging.basicConfig(
        level=logging.INFO,
        format=_LOG_FORMAT,
        handlers=[logging.FileHandler(data_dir() / "ytmusic.log", encoding="utf-8")],
    )
else:
    logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT)

import webview

from features.music_api import MusicApi
from util.discord_presence import discord_presence
from util.media_controls import media_controls, prepare_webview
from util.ui_server import serve_ui
from util.webview_controller import WebViewController


class Api(MusicApi):
    """Main API class exposed to the webview frontend."""

    def update_media_controls(
        self, title: str, artist: str, playing: bool, has_next: bool, artwork: str = ""
    ) -> None:
        """Publish the current song, including its cover, to Windows media keys."""
        media_controls.update(title or "", artist or "", bool(playing), bool(has_next), artwork or "")

    def get_discord_presence(self) -> dict:
        """Whether Discord rich presence is on, and if the desktop app is connected."""
        return discord_presence.status()

    def set_discord_presence(self, enabled: bool) -> dict:
        """Turn Discord rich presence on or off."""
        return discord_presence.configure(enabled)

    def update_discord_presence(
        self,
        title: str,
        artist: str,
        album: str,
        playing: bool,
        elapsed: float,
        duration: float,
        artwork: str,
        video_id: str,
    ) -> None:
        """Show the current song on Discord, or clear it when nothing is playing."""
        discord_presence.update(title, artist, album, playing, elapsed, duration, artwork, video_id)


def resource_path(*relative_parts: str) -> Path:
    """Get absolute path to resource, works for dev and PyInstaller builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base.joinpath(*relative_parts)


def _disable_browser_context_menu(window: webview.Window) -> None:
    """Hide the WebView2 menu. Track and playlist menus stay in the page."""
    native = window.native
    control = getattr(native, "webview", None)
    if control is None:
        return

    def apply() -> None:
        try:
            core = control.CoreWebView2
            if core is not None:
                core.Settings.AreDefaultContextMenusEnabled = False
        except Exception:
            logging.getLogger(__name__).exception("Could not disable the browser context menu")

    from System import Action

    # BeginInvoke posts to the window thread and returns. Invoke would wait on
    # that thread and can stall the dev probe.
    control.BeginInvoke(Action(apply))


if __name__ == "__main__":
    prepare_webview()
    api = Api()
    # Slot 0 stays on port 5173. A worktree's slot moves the Vite URL with it.
    if ENV == "dev":
        from dev.identity import debug_port, ui_origin

        url = ui_origin()
    else:
        url = serve_ui(resource_path("ui"))
    window = webview.create_window(
        "YTMusic",
        url,
        js_api=api,
        resizable=True,
        width=1280,
        height=720
    )
    WebViewController.set_window(window)
    window.events.before_show += lambda: media_controls.attach(window)
    window.events.loaded += lambda: _disable_browser_context_menu(window)
    if _DEBUG:
        from dev.probe import start_dev_probe

        # A normal dev window can still open DevTools from the page menu.
        # DEVTOOLS=1 opens them and exposes a remote debugging port.
        webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = DEVTOOLS
        if DEVTOOLS:
            # A frozen exe stays on 9222. A dev worktree uses 9222 plus its slot.
            remote_port = debug_port() if ENV == "dev" else 9222
            webview.settings["REMOTE_DEBUGGING_PORT"] = remote_port
        start_dev_probe(api, window)
    storage_path = data_dir() / "webview-data"
    storage_path.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(debug=_DEBUG, private_mode=False, storage_path=str(storage_path))
    finally:
        discord_presence.shutdown()

