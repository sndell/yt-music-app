"""Writable app data locations.

Dev keeps files under the app directory. A frozen exe writes under
%LOCALAPPDATA%\\YTMusic so the onefile extract folder is not used for state.

`YTM_DATA_DIR` and `YTM_CACHE_DIR` override either root. That is how several dev
instances in one checkout each get their own profile and sign-in without
fighting over the WebView2 folder; see `app/dev/instance.py`.
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
    override = os.environ.get("YTM_DATA_DIR", "").strip()
    if override:
        root = Path(override)
    elif is_frozen():
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            local = str(Path.home() / "AppData" / "Local")
        root = Path(local) / "YTMusic"
    else:
        root = Path(__file__).resolve().parents[1]
    root.mkdir(parents=True, exist_ok=True)
    return root


def cache_dir() -> Path:
    """Directory for the diskcache and the stream solver files.

    Dev shares one cache per checkout, so instances read the same warm data
    instead of each re-fetching the library. A named instance points here;
    `YTM_CACHE_DIR` unset under an overridden data dir means that instance keeps
    its own copy instead.
    """
    override = os.environ.get("YTM_CACHE_DIR", "").strip()
    if override:
        root = Path(override)
    else:
        root = data_dir() / ("cache" if is_frozen() else ".cache")
    root.mkdir(parents=True, exist_ok=True)
    return root
