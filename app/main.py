from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import webview

from features.music_api import MusicApi
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
    pass


def resource_path(*relative_parts: str) -> Path:
    """Get absolute path to resource, works for dev and PyInstaller builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base.joinpath(*relative_parts)


if __name__ == "__main__":
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
    webview.start(debug=(ENV == "dev"))

