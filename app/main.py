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

if ENV == "dev":
    # `YTM_INSTANCE` has to reach the environment before any app module is
    # imported: `util.preferences`, `util/discord_presence`, `features.music_api`
    # and `util.audio_stream` resolve `data_dir()`/`cache_dir()` at import time.
    # `prepare()` also refuses here when another live instance owns this data dir.
    from dev import instance

    instance.apply_env()
    instance.prepare()

import webview

from features.music_api import MusicApi
from util.discord_presence import discord_presence
from util.media_controls import media_controls, prepare_webview
from util.preferences import preferences
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

    def get_volume(self) -> int:
        """Saved player volume, 0-100 on the slider scale."""
        return preferences.volume()

    def set_volume(self, volume: int) -> int:
        """Save the player volume and return the stored value."""
        return preferences.set_volume(volume)

    def dev_log(self, entry: dict | None = None) -> None:
        """Dev only: the page forwards renderer console output here.

        The dev control server reads it, so an agent can see page errors without
        watching the screen. Does nothing outside dev.
        """
        if ENV == "dev":
            from dev import logs

            logs.add_renderer_entry(entry)


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
    # that thread and can stall startup.
    control.BeginInvoke(Action(apply))


if __name__ == "__main__":
    prepare_webview()
    api = Api()
    title = "YTMusic"
    # Dev loads Vite. This process starts it in its own console and stops it
    # when the window closes, so the server never outlives the window. It also
    # keeps Python logs in memory and opens the dev control server, so an agent
    # can drive the app without seeing the screen.
    if ENV == "dev":
        from dev import control, logs, vite

        # `instance.prepare()` already refused when another instance owns this
        # data dir. What is left is this instance id already being up, which
        # would put two windows on one profile and one discovery file.
        running = control.existing_instance()
        if running:
            ident = instance.instance_id()
            logging.getLogger(__name__).error(
                "Instance %r is already running (pid %s, vite %s, control %s). "
                "Stop it with `python app\\dev\\cli.py -i %s stop`, or restart with "
                "`.\\start.ps1 -Instance %s -Restart`.",
                ident,
                running.get("pid"),
                running.get("vitePort"),
                running.get("controlPort"),
                ident,
                ident,
            )
            raise SystemExit(1)
        if not instance.is_default():
            title = f"YTMusic · {instance.label() or instance.instance_id()}"
        logs.install_python_ring()
        vite.start_vite()
        url = vite.ui_origin()
    else:
        url = serve_ui(resource_path("ui"))
    window = webview.create_window(
        title,
        url,
        js_api=api,
        resizable=True,
        width=1280,
        height=720
    )
    WebViewController.set_window(window)
    window.events.before_show += lambda: media_controls.attach(window)
    window.events.loaded += lambda: _disable_browser_context_menu(window)
    if ENV == "dev":
        window.events.loaded += lambda: control.mark_loaded()
        control.start(api, window)
    if _DEBUG:
        # A dev window can still open DevTools from the page menu.
        webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = DEVTOOLS
    storage_path = data_dir() / "webview-data"
    storage_path.mkdir(parents=True, exist_ok=True)
    try:
        # start() returns when the window is closed, and raises instead when
        # startup fails.
        webview.start(debug=_DEBUG, private_mode=False, storage_path=str(storage_path))
    finally:
        if ENV == "dev":
            control.stop()
            vite.stop_vite()
        discord_presence.shutdown()

