from __future__ import annotations

import logging
import os
import sys
import threading
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

from features import updates
from features.music_api import MusicApi
from util import audio_stream
from util.discord_presence import discord_presence
from util.media_controls import media_controls, prepare_webview
from util.popout import popout
from util.preferences import preferences
from util.ui_server import serve_ui
from util.webview_controller import WebViewController
from contract.registry import api


class Api(MusicApi):
    """Main API class exposed to the webview frontend."""

    @api.read(returns="void")
    def update_media_controls(
        self, title: str, artist: str, playing: bool, has_next: bool, artwork: str = ""
    ) -> None:
        """Publish the current song, including its cover, to Windows media keys."""
        media_controls.update(title or "", artist or "", bool(playing), bool(has_next), artwork or "")

    @api.read(returns="DiscordPresenceStatus")
    def get_discord_presence(self) -> dict:
        """Whether Discord rich presence is on, and if the desktop app is connected."""
        return discord_presence.status()

    @api.read(returns="DiscordPresenceStatus")
    def set_discord_presence(self, enabled: bool) -> dict:
        """Turn Discord rich presence on or off."""
        return discord_presence.configure(enabled)

    @api.read(returns="void")
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

    @api.read(returns="number")
    def get_volume(self) -> int:
        """Saved player volume, 0-100 on the slider scale."""
        return preferences.volume()

    @api.read(returns="boolean")
    def get_horizontal_nav(self) -> bool:
        """Whether the experimental horizontal icon nav is on."""
        return preferences.horizontal_nav()

    @api.read(returns="boolean")
    def set_horizontal_nav(self, enabled: bool) -> bool:
        """Save the horizontal icon nav choice and return the stored value."""
        return preferences.set_horizontal_nav(enabled)

    @api.read(returns="number")
    def set_volume(self, volume: int) -> int:
        """Save the player volume and return the stored value."""
        return preferences.set_volume(volume)

    @api.read(returns="EqualizerSettings")
    def get_equalizer(self) -> dict:
        """The saved equalizer: on/off, preamp, bass, treble, and each band's gain."""
        return preferences.equalizer()

    @api.read(returns="EqualizerSettings", params={"settings": "EqualizerSettings | null"})
    def set_equalizer(self, settings: dict[str, Any] | None = None) -> dict:
        """Save the equalizer settings and return the stored value."""
        return preferences.set_equalizer(settings)

    @api.read(returns="number")
    def get_crossfade_seconds(self) -> int:
        """How many seconds the next song fades in before this one ends. 0 is off."""
        return preferences.crossfade_seconds()

    @api.read(returns="number")
    def set_crossfade_seconds(self, seconds: int) -> int:
        """Save the crossfade length and return the stored value."""
        return preferences.set_crossfade_seconds(seconds)

    @api.read(returns="boolean")
    def get_automix(self) -> bool:
        """Whether a blend waits for the beat of the song that is ending.

        Stored so the choice survives, but the UI keeps it off for now; the
        honest answer lives in ``ui/src/lib/automix.ts``.
        """
        return preferences.automix()

    @api.read(returns="boolean")
    def set_automix(self, enabled: bool) -> bool:
        """Save the beat-aligned blend choice and return the stored value."""
        return preferences.set_automix(enabled)

    @api.read(returns="PopoutPrefs")
    def get_popout(self) -> dict:
        """Whether the always-on-top player is enabled, open, pinned or collapsed."""
        return _popout_state()

    @api.read(returns="PopoutPrefs")
    def set_popout(self, enabled: bool) -> dict:
        """Turn the always-on-top player on or off, opening or closing its window."""
        preferences.set_popout(enabled=enabled)
        if preferences.popout()["enabled"]:
            popout.open()
        else:
            popout.close()
        return _popout_state()

    @api.read(returns="PopoutPrefs")
    def open_popout(self) -> dict:
        """Show the always-on-top player window."""
        popout.open()
        return _popout_state()

    @api.read(returns="PopoutPrefs")
    def close_popout(self) -> dict:
        """Hide the always-on-top player window."""
        popout.close()
        return _popout_state()

    @api.read(returns="PopoutPrefs")
    def set_popout_pinned(self, pinned: bool) -> dict:
        """Keep the always-on-top player above other windows, or let it sit."""
        popout.set_pinned(pinned)
        return _popout_state()

    @api.read(returns="PopoutPrefs")
    def set_popout_collapsed(self, collapsed: bool) -> dict:
        """Shrink the always-on-top player to its strip, or expand it again."""
        popout.set_collapsed(collapsed)
        return _popout_state()

    @api.read(returns="void")
    def focus_main(self) -> None:
        """Bring the main window forward, after a click in the popout."""
        WebViewController.focus()

    @api.read(returns="UpdateStatus")
    def get_update_status(self) -> dict:
        """The running version and the newest published release."""
        return updates.status()

    @api.read(returns="UpdateInstall")
    def install_update(self) -> dict:
        """Download the newest release, replace this exe with it, and restart."""
        result = updates.install()
        # Let the answer reach the page so it can say it is restarting.
        timer = threading.Timer(updates.RESTART_DELAY, WebViewController.close)
        timer.daemon = True
        timer.start()
        return result

    @api.internal(reason="dev renderer log forwarding", dev_only=True, returns="void", params={"entry": "DevLogEntry | null"})
    def dev_log(self, entry: dict | None = None) -> None:
        """Dev only: the page forwards renderer console output here.

        The dev control server reads it, so an agent can see page errors without
        watching the screen. Does nothing outside dev.
        """
        if ENV == "dev":
            from dev import logs

            logs.add_renderer_entry(entry)


def _close_popout() -> None:
    """Close the popout with the main window.

    A surviving second window keeps the WinForms loop alive after the main
    window is destroyed, which leaves the process running with no player. The
    popout posts its destroy to the UI thread, which is the thread closing this
    window, so hand it to a worker instead of re-entering it.
    """
    threading.Thread(target=popout.close, name="popout-close", daemon=True).start()


def _popout_state() -> dict:
    """The saved popout settings plus whether its window is up right now."""
    settings = preferences.popout()
    return {
        "enabled": settings["enabled"],
        "open": popout.is_open,
        "pinned": settings["pinned"],
        "collapsed": settings["collapsed"],
    }


def resource_path(*relative_parts: str) -> Path:
    """Get absolute path to resource, works for dev and PyInstaller builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base.joinpath(*relative_parts)


_WARM_DELAY_SECONDS = 2.0


def _warm_audio_stream() -> None:
    """Arm the audio solver once the window has painted.

    The first song of a session is the one that waits: until it asks, the player
    script is neither downloaded nor parsed and the solver process is not up.
    That work is the same for every song, so it runs here while the user is
    still browsing instead of on the first press.
    """

    def run() -> None:
        try:
            ytmusic = MusicApi._get_ytmusic()
        except Exception:  # noqa: BLE001 - signed out; the sign-in flow owns that
            return
        audio_stream.warm(ytmusic)

    timer = threading.Timer(_WARM_DELAY_SECONDS, run)
    timer.daemon = True
    timer.start()


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
    # A build that has opened a window is the proof the previous swap worked,
    # so the exe it replaced can go. The check runs before Settings asks for it.
    updates.cleanup()
    updates.warm()
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
    # The popout loads the same page, so it has to know the URL this process
    # serves or the Vite origin it was handed. The ready hook turns off
    # WebView2's own context menu there too, so a row's right-click menu is the
    # only one that opens.
    popout.configure(api, url, _disable_browser_context_menu)
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
    window.events.loaded += _warm_audio_stream
    window.events.closing += _close_popout
    # Restore runs off the UI thread: pywebview only creates a window after
    # `start()` from a worker, and `loaded` fires on the UI thread.
    window.events.loaded += lambda: threading.Thread(
        target=popout.restore, name="popout-restore", daemon=True
    ).start()
    if ENV == "dev":
        window.events.loaded += lambda: control.mark_loaded()
        control.start(api, window)
    if _DEBUG:
        # A dev window can still open DevTools from the page menu.
        webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = DEVTOOLS
    storage_path = data_dir() / "webview-data"
    storage_path.mkdir(parents=True, exist_ok=True)
    # A frozen build takes its window icon from the exe's embedded resource.
    # Dev runs under python.exe, so the ico has to be passed explicitly.
    app_icon = None if is_frozen() else Path(__file__).resolve().parents[1] / "build" / "icon.ico"
    try:
        # start() returns when the window is closed, and raises instead when
        # startup fails.
        webview.start(
            debug=_DEBUG,
            private_mode=False,
            storage_path=str(storage_path),
            icon=str(app_icon) if app_icon else None,
        )
    finally:
        if ENV == "dev":
            control.stop()
            vite.stop_vite()
        discord_presence.shutdown()

