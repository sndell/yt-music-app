"""Writable app data locations.

Dev keeps files under the app directory. A frozen exe writes under
%LOCALAPPDATA%\\YTMusic so the onefile extract folder is not used for state.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    """True when running from a PyInstaller build."""
    return bool(getattr(sys, "frozen", False))


def data_dir() -> Path:
    """Directory for the WebView2 profile, auth file, and cache."""
    if is_frozen():
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            local = str(Path.home() / "AppData" / "Local")
        root = Path(local) / "YTMusic"
    else:
        root = Path(__file__).resolve().parents[1]
    root.mkdir(parents=True, exist_ok=True)
    return root
