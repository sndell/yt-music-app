"""
Music API module for interacting with YouTube Music via ytmusicapi.

This module provides a clean interface for the frontend to fetch
playlist data and manage authentication.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import diskcache
import ytmusicapi

from util.get_dominant_color import get_dominant_color_hex

logger = logging.getLogger(__name__)

# Resolve paths relative to this module
_BROWSER_JSON_PATH = Path(__file__).parent.parent / "browser.json"
_CACHE_DIR = Path(__file__).parent.parent / ".cache"

# Initialize persistent disk cache
cache = diskcache.Cache(str(_CACHE_DIR))

# Cache durations in seconds
CACHE_DURATION_PLAYLIST_ITEMS = 60 * 30  # 30 minutes

# Cache key prefixes
CACHE_KEY_PLAYLIST_PREFIX = "playlist:"


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

    @classmethod
    def _is_authenticated(cls) -> bool:
        """Check if user is authenticated by calling the API.
        
        Returns:
            True if authenticated (get_account_info succeeds), False otherwise.
        """
        try:
            ytmusic = cls._get_ytmusic()
            account_info = ytmusic.get_account_info()
            return account_info is not None
        except Exception as e:
            logger.warning("Authentication check failed: %s", e)
            return False

    def get_playlists(self) -> list[dict[str, Any]]:
        """Fetch all playlists from the user's YouTube Music library.
        
        Returns:
            A list of playlist dictionaries, or an empty list on error.
        """
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlists")
                return []
            
            logger.info("Fetching playlists from API...")
            ytmusic = self._get_ytmusic()
            playlists = ytmusic.get_library_playlists()
            
            logger.info("Playlists fetched (count: %d)", len(playlists))
            return playlists
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch playlists: %s", e)
            return []

    def get_playlist_items(self, playlist_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch all items from a specific playlist.
        
        Args:
            playlist_id: The YouTube Music playlist ID
            force_refresh: If True, bypass cache and fetch fresh data.
            
        Returns:
            A dictionary containing playlist details and tracks,
            or an empty dict on error.
        """
        cache_key = f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}"
        
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlist items")
                return {}
            
            # Check cache first (unless force refresh)
            if not force_refresh:
                cached = cache.get(cache_key)
                if cached is not None:
                    logger.info(
                        "Returning cached playlist '%s' (tracks: %d)",
                        cached.get("title", "Unknown"),
                        len(cached.get("tracks", []))
                    )
                    return cached
            
            logger.info("Fetching playlist items from API for ID: %s", playlist_id)
            ytmusic = self._get_ytmusic()
            playlist = ytmusic.get_playlist(playlist_id, limit=None)
            logger.info(
                "Playlist '%s' fetched successfully (tracks: %d)",
                playlist.get("title", "Unknown"),
                len(playlist.get("tracks", []))
            )
            
            # Extract dominant color from thumbnail
            thumbnails = playlist.get("thumbnails", [])
            if thumbnails:
                # Use the largest thumbnail for better color accuracy
                largest_thumb = max(thumbnails, key=lambda t: t.get("width", 0))
                thumbnail_url = largest_thumb.get("url")
                if thumbnail_url:
                    logger.info("Extracting dominant color from thumbnail...")
                    dominant_color = get_dominant_color_hex(thumbnail_url)
                    if dominant_color:
                        playlist["dominantColor"] = dominant_color
                        logger.info("Dominant color extracted: %s", dominant_color)
                    else:
                        playlist["dominantColor"] = None
                else:
                    playlist["dominantColor"] = None
            else:
                playlist["dominantColor"] = None
            
            # Store in cache
            cache.set(cache_key, playlist, expire=CACHE_DURATION_PLAYLIST_ITEMS)
            logger.info("Playlist cached: %s", playlist_id)
            
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
            print(headers)
            logger.info("Generating auth header from raw headers...")
            ytmusicapi.setup(filepath=str(_BROWSER_JSON_PATH), headers_raw=headers)
            # Reset cached instance to pick up new auth
            self._reset_ytmusic()
            logger.info("Auth header generated successfully at %s", _BROWSER_JSON_PATH)
        except Exception as e:
            logger.exception("Failed to generate auth header: %s", e)
            raise

    def invalidate_playlist_cache(self, playlist_ids: list[str]) -> dict[str, Any]:
        """Invalidate cache for specific playlist IDs.
        
        Args:
            playlist_ids: List of playlist IDs to invalidate from cache.
            
        Returns:
            A dict with 'invalidated' (list of IDs that were in cache)
            and 'not_found' (list of IDs that weren't cached).
        """
        invalidated = []
        not_found = []
        
        for playlist_id in playlist_ids:
            cache_key = f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}"
            if cache.delete(cache_key):
                invalidated.append(playlist_id)
                logger.info("Cache invalidated for playlist: %s", playlist_id)
            else:
                not_found.append(playlist_id)
                logger.info("Playlist not in cache: %s", playlist_id)
        
        return {"invalidated": invalidated, "not_found": not_found}

    def clear_all_cache(self) -> dict[str, Any]:
        """Clear all cached data.
        
        Returns:
            A dict with 'cleared' count of items removed.
        """
        count = len(cache)
        cache.clear()
        logger.info("All cache cleared (%d items)", count)
        return {"cleared": count}
