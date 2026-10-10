from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import webview

from dev_probe import start_dev_probe
from features.music_api import MusicApi
from util.media_controls import media_controls, prepare_webview
from util.webview_controller import WebViewController

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)

# Determine environment
if getattr(sys, "frozen", False):  # running as PyInstaller exe
    ENV = "prod"
else:
    ENV = os.getenv("ENV", "dev")


class Api(MusicApi):
    """Main API class exposed to the webview frontend."""

    def update_media_controls(
        self, title: str, artist: str, playing: bool, has_next: bool, artwork: str = ""
    ) -> None:
        """Publish the current song, including its cover, to Windows media keys."""
        media_controls.update(title or "", artist or "", bool(playing), bool(has_next), artwork or "")


def resource_path(*relative_parts: str) -> Path:
    """Get absolute path to resource, works for dev and PyInstaller builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base.joinpath(*relative_parts)


if __name__ == "__main__":
    prepare_webview()
    api = Api()
    url = "http://localhost:5173" if ENV == "dev" else str(resource_path("ui", "index.html"))
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
    if ENV == "dev":
        webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False
        start_dev_probe(api, window)
    storage_path = Path(__file__).resolve().parent / "webview-data"
    webview.start(debug=(ENV == "dev"), private_mode=False, storage_path=str(storage_path))

