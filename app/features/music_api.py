from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ytmusicapi import YTMusic

logger = logging.getLogger(__name__)

# Resolve browser.json path relative to this module
_BROWSER_JSON_PATH = Path(__file__).parent.parent / "browser.json"


class MusicApi:
    """API class for interacting with YouTube Music via ytmusicapi."""

    _ytmusic: YTMusic | None = None

    @classmethod
    def _get_ytmusic(cls) -> YTMusic:
        """Lazily initialize and return the YTMusic instance."""
        if cls._ytmusic is None:
            if not _BROWSER_JSON_PATH.exists():
                raise FileNotFoundError(
                    f"browser.json not found at {_BROWSER_JSON_PATH}. "
                    "Please configure your authentication."
                )
            cls._ytmusic = YTMusic(str(_BROWSER_JSON_PATH))
        return cls._ytmusic

    def get_playlists(self) -> list[dict[str, Any]]:
        """Fetch all playlists from the user's YouTube Music library.
        
        Returns:
            A list of playlist dictionaries, or an empty list on error.
        """
        try:
            logger.info("Fetching playlists...")
            ytmusic = self._get_ytmusic()
            playlists = ytmusic.get_library_playlists()
            logger.info("Playlists fetched successfully (count: %d)", len(playlists))
            return playlists
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch playlists: %s", e)
            return []