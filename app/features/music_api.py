"""
Music API module for interacting with YouTube Music via ytmusicapi.

This module provides a clean interface for the frontend to fetch
playlist data and manage authentication.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import ytmusicapi

logger = logging.getLogger(__name__)

# Resolve browser.json path relative to this module
_BROWSER_JSON_PATH = Path(__file__).parent.parent / "browser.json"


class MusicApi:
    """API class for interacting with YouTube Music via ytmusicapi.
    
    This class is exposed to the webview frontend via the js_api parameter.
    All public methods are callable from JavaScript.
    """

    _ytmusic: ytmusicapi.YTMusic | None = None

    @classmethod
    def _get_ytmusic(cls) -> ytmusicapi.YTMusic:
        """Lazily initialize and return the YTMusic instance.
        
        Raises:
            FileNotFoundError: If browser.json doesn't exist
        """
        if cls._ytmusic is None:
            if not _BROWSER_JSON_PATH.exists():
                raise FileNotFoundError(
                    f"browser.json not found at {_BROWSER_JSON_PATH}. "
                    "Please configure your authentication."
                )
            cls._ytmusic = ytmusicapi.YTMusic(str(_BROWSER_JSON_PATH))
        return cls._ytmusic

    @classmethod
    def _reset_ytmusic(cls) -> None:
        """Reset the YTMusic instance to force re-initialization."""
        cls._ytmusic = None

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

    def get_playlist_items(self, playlist_id: str) -> dict[str, Any]:
        """Fetch all items from a specific playlist.
        
        Args:
            playlist_id: The YouTube Music playlist ID
            
        Returns:
            A dictionary containing playlist details and tracks,
            or an empty dict on error.
        """
        try:
            logger.info("Fetching playlist items for ID: %s", playlist_id)
            ytmusic = self._get_ytmusic()
            playlist = ytmusic.get_playlist(playlist_id)
            logger.info(
                "Playlist '%s' fetched successfully (tracks: %d)",
                playlist.get("title", "Unknown"),
                len(playlist.get("tracks", []))
            )
            return playlist
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return {}
        except Exception as e:
            logger.exception("Failed to fetch playlist items: %s", e)
            return {}

    def generate_auth_header(self, headers: str) -> None:
        """Generate browser.json from raw request headers.
        
        This should be called with the raw headers copied from a YouTube Music
        request in the browser's network tab.
        
        Args:
            headers: Raw HTTP headers string from browser
        """
        try:
            logger.info("Generating auth header from raw headers...")
            ytmusicapi.setup(filepath=str(_BROWSER_JSON_PATH), headers_raw=headers)
            # Reset cached instance to pick up new auth
            self._reset_ytmusic()
            logger.info("Auth header generated successfully at %s", _BROWSER_JSON_PATH)
        except Exception as e:
            logger.exception("Failed to generate auth header: %s", e)
            raise
