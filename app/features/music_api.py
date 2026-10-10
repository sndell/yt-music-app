"""
Music API module for interacting with YouTube Music via ytmusicapi.

This module provides a clean interface for the frontend to fetch
playlist data and manage authentication.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from PIL import Image

import diskcache
import ytmusicapi
from ytmusicapi.helpers import initialize_headers, sapisid_from_cookie

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
CACHE_KEY_THUMB_PREFIX = "thumb:v2:"
THUMB_CACHE_SECONDS = 60 * 60 * 24

_LIKE_STATUSES = {"LIKE", "DISLIKE", "INDIFFERENT"}
MAX_THUMB_BYTES = 250_000


def _like_status_in_payload(payload: Any, video_id: str) -> str | None:
    """Read likeButtonRenderer.likeStatus for one video from a next response.

    Watch-playlist likeStatus is not usable here: ytmusicapi documents that its
    INDIFFERENT value can mean either indifferent or dislike.
    """
    stack: list[Any] = [payload]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            button = node.get("likeButtonRenderer")
            if isinstance(button, dict):
                target = button.get("target")
                status = button.get("likeStatus")
                if isinstance(target, dict) and target.get("videoId") == video_id and status in _LIKE_STATUSES:
                    return status
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None


def _update_cached_like_status(video_id: str, rating: str) -> None:
    try:
        for key in list(cache.iterkeys()):
            if not str(key).startswith(CACHE_KEY_PLAYLIST_PREFIX):
                continue
            playlist = cache.get(key)
            if not isinstance(playlist, dict):
                continue
            tracks = playlist.get("tracks")
            if not isinstance(tracks, list):
                continue
            changed = False
            for track in tracks:
                if isinstance(track, dict) and track.get("videoId") == video_id and track.get("likeStatus") != rating:
                    track["likeStatus"] = rating
                    changed = True
            if changed:
                cache.set(key, playlist, expire=CACHE_DURATION_PLAYLIST_ITEMS)
    except Exception as e:
        logger.warning("Could not update cached like status: %s", e)


def _inline_thumbnail(url: str) -> str:
    """Fetch a cover and return a data URL the webview can show without a third-party request.

    Some yt3.googleusercontent.com covers load in a normal browser and fail in the
    desktop window, which then shows the broken-image icon.
    """
    if not url or url.startswith("data:"):
        return url

    cache_key = f"{CACHE_KEY_THUMB_PREFIX}{url}"
    cached = cache.get(cache_key)
    if isinstance(cached, str):
        return cached

    try:
        request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=10) as response:
            content = response.read(MAX_THUMB_BYTES + 1)
        if len(content) > MAX_THUMB_BYTES:
            return url
        # Re-encode. The webview fails to decode some of the original files and
        # shows the broken-image icon even though a normal browser can open them.
        image = Image.open(io.BytesIO(content))
        image = image.convert("RGB")
        image.thumbnail((256, 256))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=85)
        data_url = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        cache.set(cache_key, data_url, expire=THUMB_CACHE_SECONDS)
        return data_url
    except Exception as exc:
        logger.warning("Failed to load playlist thumbnail: %s", exc)
        return url


def _inline_thumbnail_field(items: list[dict[str, Any]], key: str) -> None:
    def apply(item: dict[str, Any]) -> None:
        thumbnails = item.get(key) or []
        if not thumbnails:
            return
        source = max(thumbnails, key=lambda thumb: thumb.get("width") or 0)
        url = source.get("url") or thumbnails[0].get("url")
        if isinstance(url, str) and url:
            thumbnails[0]["url"] = _inline_thumbnail(url)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(apply, items))


def _inline_playlist_thumbnails(playlists: list[dict[str, Any]]) -> None:
    _inline_thumbnail_field(playlists, "thumbnails")


def _header_value(headers: dict[str, Any], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name and isinstance(value, str):
            return value
    return None


def _browser_auth_headers(parsed: dict[str, Any]) -> dict[str, str]:
    """Keep the header set ytmusicapi documents for browser auth.

    Chrome's full DevTools copy also contains response headers and request
    metadata. Sending those makes YouTube Music return an empty body.
    """
    cookie = _header_value(parsed, "cookie")
    auth_user = _header_value(parsed, "x-goog-authuser")
    if not cookie or auth_user is None:
        raise ValueError(
            "Cookie and X-Goog-AuthUser are missing. Paste the request headers from a logged-in music.youtube.com request."
        )
    try:
        sapisid_from_cookie(cookie)
    except KeyError as exc:
        raise ValueError(
            "The cookie is missing __Secure-3PAPISID. Paste the request headers from a logged-in music.youtube.com request."
        ) from exc

    headers = {key: value for key, value in initialize_headers().items()}
    headers.update(
        {
            "cookie": cookie,
            "x-goog-authuser": auth_user,
            "x-origin": "https://music.youtube.com",
            "authorization": _header_value(parsed, "authorization") or "SAPISIDHASH",
        }
    )
    return headers


def _save_browser_json(headers: dict[str, str]) -> None:
    tmp_path = _BROWSER_JSON_PATH.with_suffix(".json.tmp")
    try:
        tmp_path.write_text(json.dumps(headers, indent=4), encoding="utf-8")
        ytmusic = ytmusicapi.YTMusic(str(tmp_path))
        try:
            account = ytmusic.get_account_info()
        except KeyError:
            # A signed-out account menu has no activeAccountHeaderRenderer.
            # ytmusicapi raises KeyError while walking that path.
            raise ValueError(
                "YouTube Music did not accept these headers. The account menu came back signed out."
            )
        if not account:
            raise ValueError("YouTube Music did not accept these headers.")
        tmp_path.replace(_BROWSER_JSON_PATH)
    finally:
        tmp_path.unlink(missing_ok=True)


def _is_music_youtube_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname == "music.youtube.com"


def _is_web_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _page_url(window: Any) -> str:
    raw = window.get_current_url()
    if not raw:
        return ""
    return str(raw).strip()


def _cookie_header(cookies: list[Any] | None) -> str | None:
    if not cookies:
        return None
    parts: list[str] = []
    found = False
    for jar in cookies:
        if jar is None or not hasattr(jar, "items"):
            continue
        for name, morsel in jar.items():
            coded = getattr(morsel, "coded_value", "")
            value = coded if coded else morsel.value
            if name == "__Secure-3PAPISID" and value:
                found = True
            parts.append(f"{name}={value}")
    if not found:
        return None
    return "; ".join(parts)


_LIBRARY_URL = "https://music.youtube.com/library"


def _is_youtubei_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    host = parsed.hostname or ""
    if host == "music.youtube.com" and parsed.path.startswith("/youtubei/"):
        return True
    return host == "youtubei.googleapis.com" and parsed.path.startswith("/youtubei/")


def _copy_headers(headers: Any) -> dict[str, str]:
    if isinstance(headers, dict):
        copied: dict[str, str] = {}
        for key, value in headers.items():
            if isinstance(value, str):
                copied[str(key)] = value
            elif isinstance(value, (int, float)):
                copied[str(key)] = str(value)
        return copied
    if isinstance(headers, list):
        copied = {}
        for item in headers:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            value = item.get("value")
            if isinstance(name, str) and isinstance(value, str):
                copied[name] = value
        return copied
    return {}


def _merge_headers(base: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    merged = dict(base)
    for key, value in extra.items():
        if not value:
            continue
        for existing in list(merged):
            if existing.lower() == key.lower() and existing != key:
                del merged[existing]
        merged[key] = value
    return merged


def _sapisid_cookie(cookie: str | None) -> str | None:
    if not cookie:
        return None
    try:
        sapisid_from_cookie(cookie)
    except KeyError:
        return None
    return cookie


def _event_json(args: Any) -> str:
    raw = getattr(args, "ParameterObjectAsJson", None)
    if raw is None and hasattr(args, "get_ParameterObjectAsJson"):
        raw = args.get_ParameterObjectAsJson()
    return str(raw or "")


class _HeaderCapture:
    """Correlate DevTools request events until a YouTube Music API call has auth headers."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, str]] = {}
        self._extras: dict[str, dict[str, str]] = {}
        self.latest: dict[str, str] | None = None
        self.latest_at = 0.0

    def add_sent(self, payload: dict[str, Any]) -> None:
        request = payload.get("request")
        if not isinstance(request, dict):
            return
        url = request.get("url")
        request_id = payload.get("requestId")
        if not isinstance(url, str) or not isinstance(request_id, str) or not _is_youtubei_url(url):
            return
        headers = _copy_headers(request.get("headers"))
        extra = self._extras.pop(request_id, None)
        if extra:
            headers = _merge_headers(headers, extra)
        self._pending[request_id] = headers
        self._trim(self._pending)
        self._publish(headers)

    def add_extra(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("requestId")
        if not isinstance(request_id, str):
            return
        headers = _copy_headers(payload.get("headers"))
        cookie = _header_value(headers, "cookie") or ""
        if _header_value(headers, "x-goog-authuser") is None and "__Secure-3PAPISID" not in cookie:
            return
        base = self._pending.get(request_id)
        if base is None:
            self._extras[request_id] = headers
            self._trim(self._extras)
            return
        merged = _merge_headers(base, headers)
        self._pending[request_id] = merged
        self._publish(merged)

    def add_webview_request(self, headers: dict[str, str]) -> None:
        latest_cookie = _header_value(self.latest, "cookie") if self.latest else None
        if self.latest and _sapisid_cookie(latest_cookie) and not _header_value(headers, "cookie"):
            auth_user = _header_value(headers, "x-goog-authuser")
            if auth_user is None:
                return
            self._publish(_merge_headers(self.latest, {"x-goog-authuser": auth_user}))
            return
        self._publish(headers)

    def _publish(self, headers: dict[str, str]) -> None:
        if _header_value(headers, "x-goog-authuser") is None:
            return
        self.latest = headers
        self.latest_at = time.monotonic()

    @staticmethod
    def _trim(bucket: dict[str, dict[str, str]]) -> None:
        while len(bucket) > 30:
            bucket.pop(next(iter(bucket)))


def _headers_from_capture(captured: dict[str, str], jar_cookie: str | None) -> dict[str, str] | None:
    auth_user = _header_value(captured, "x-goog-authuser")
    if auth_user is None:
        return None
    cookie = _sapisid_cookie(_header_value(captured, "cookie")) or _sapisid_cookie(jar_cookie)
    if cookie is None:
        return None
    return _browser_auth_headers(
        {
            "cookie": cookie,
            "x-goog-authuser": auth_user,
            "authorization": _header_value(captured, "authorization") or "SAPISIDHASH",
        }
    )


def _clear_webview_profile() -> None:
    """Drop cookies, cache, and site data from the shared WebView2 profile."""
    from System import Action, Func, Type
    from System.Threading.Tasks import Task
    from Microsoft.Web.WebView2.Core import CoreWebView2BrowsingDataKinds

    from util.webview_controller import WebViewController

    window = WebViewController._window
    if window is None or window.native is None:
        raise RuntimeError("The app window is not open, so its data could not be cleared.")

    finished = threading.Event()
    error: dict[str, BaseException] = {}
    kinds = (
        CoreWebView2BrowsingDataKinds.Cookies
        | CoreWebView2BrowsingDataKinds.DiskCache
        | CoreWebView2BrowsingDataKinds.AllDomStorage
        | CoreWebView2BrowsingDataKinds.ServiceWorkers
    )

    def finish(task: Task) -> None:
        if task.IsFaulted and task.Exception is not None:
            error["error"] = Exception(str(task.Exception.GetBaseException().Message))
        finished.set()

    def clear() -> None:
        core = window.native.webview.CoreWebView2
        task = core.Profile.ClearBrowsingDataAsync(kinds)
        task.ContinueWith(Action[Task](finish))

    native = window.native
    if native.InvokeRequired:
        native.Invoke(Func[Type](clear))
    else:
        clear()
    if not finished.wait(20):
        raise TimeoutError("Timed out clearing the app window data.")
    if "error" in error:
        raise error["error"]


def _attach_cdp(window: Any, on_sent: Any, on_extra: Any) -> list[Any]:
    """Subscribe to WebView2 network events. Cookie is missing from request_sent."""
    from System import Func, Type

    receivers: list[Any] = []

    def attach() -> None:
        core = window.native.webview.CoreWebView2
        for name, handler in (
            ("Network.requestWillBeSent", on_sent),
            ("Network.requestWillBeSentExtraInfo", on_extra),
        ):
            receiver = core.GetDevToolsProtocolEventReceiver(name)
            receiver.DevToolsProtocolEventReceived += handler
            receivers.append(receiver)
        core.CallDevToolsProtocolMethodAsync("Network.enable", "{}")

    native = window.native
    if native is None:
        raise RuntimeError("Sign-in window is not ready")
    if native.InvokeRequired:
        native.Invoke(Func[Type](attach))
    else:
        attach()
    return receivers


class _SignInClosed(Exception):
    pass


def _read_cookies(window: Any) -> list[Any]:
    box: dict[str, Any] = {}
    finished = threading.Event()

    def read() -> None:
        try:
            box["cookies"] = window.get_cookies()
        except Exception as exc:
            box["error"] = exc
        finally:
            finished.set()

    threading.Thread(target=read, name="ytmusic-cookies", daemon=True).start()
    while not finished.wait(0.2):
        if window.events.closed.is_set():
            raise _SignInClosed()
    if window.events.closed.is_set():
        raise _SignInClosed()
    if "error" in box:
        raise box["error"]
    cookies = box.get("cookies")
    return cookies if isinstance(cookies, list) else []


def _destroy_sign_in_window(window: Any) -> None:
    try:
        if window.events.closed.is_set():
            return
        window.destroy()
    except Exception as exc:
        logger.warning("Could not close the sign-in window: %s", exc)


_auth_lock = threading.Lock()


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
            _inline_playlist_thumbnails(playlists)
            
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

            _inline_playlist_thumbnails([playlist])

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

    def get_watch_playlist(self, video_id: str | None = None, playlist_id: str | None = None, radio: bool = False, shuffle: bool = False) -> dict[str, Any]:
        """Get a watch playlist for a specific video or playlist.
        
        Args:
            video_id: The YouTube Music video ID
            playlist_id: The YouTube Music playlist ID
            radio: Whether to fetch a radio playlist
            shuffle: Whether to shuffle the playlist
        """
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return watch playlist")
                return {}
            
            # Convert empty strings to None (bridge sends "" for undefined values)
            video_id = video_id or None
            playlist_id = playlist_id or None
            
            data = self._get_ytmusic().get_watch_playlist(
                videoId=video_id,
                playlistId=playlist_id,
                radio=radio,
                shuffle=shuffle,
            )
            if not isinstance(data, dict):
                return {}

            tracks = data.get("tracks")
            if isinstance(tracks, list):
                _inline_thumbnail_field(tracks, "thumbnail")
            return data
        except Exception as e:
            logger.exception("Failed to fetch watch playlist: %s", e)
            return {}

    def get_song_rating(self, video_id: str) -> dict[str, str]:
        """Return the signed-in user's like status for a song.

        Args:
            video_id: YouTube video id of the song.

        Returns:
            A dict with likeStatus set to LIKE, DISLIKE, or INDIFFERENT.
        """
        if not video_id:
            raise ValueError("video id is required")

        body = {
            "enablePersistentPlaylistPanel": True,
            "isAudioOnly": True,
            "videoId": video_id,
            "playlistId": "RDAMVM" + video_id,
        }
        response = self._get_ytmusic()._send_request("next", body)
        status = _like_status_in_payload(response, video_id)
        if status is None:
            raise RuntimeError("YouTube Music did not return a like status for this song")
        return {"likeStatus": status}

    def rate_song(self, video_id: str, rating: str) -> dict[str, str]:
        """Set the signed-in user's rating for a song.

        Args:
            video_id: YouTube video id of the song.
            rating: LIKE, DISLIKE, or INDIFFERENT.

        Returns:
            A dict with the likeStatus that was saved.
        """
        if not video_id:
            raise ValueError("video id is required")
        if rating not in _LIKE_STATUSES:
            raise ValueError(f"Invalid rating: {rating}")

        self._get_ytmusic().rate_song(video_id, rating)
        _update_cached_like_status(video_id, rating)
        logger.info("Rated %s as %s", video_id, rating)
        return {"likeStatus": rating}

    def sign_in(self) -> None:
        """Open YouTube Music, follow the signed-in page, and store its API headers.

        The window stays hidden when a session is already available. It is shown
        only so the user can log in. Closing it cancels.
        """
        if not _auth_lock.acquire(blocking=False):
            raise ValueError("Authentication is already being updated.")

        import webview

        state: dict[str, Any] = {
            "settled": False,
            "saved": False,
            "wake": 0,
            "revealed": False,
            "rejected": None,
            "last_error": None,
            "error": None,
            "cdp_events": [],
            "watching": False,
            "watch_logged": False,
            "saw_signed_out": False,
            "session_at": None,
            "pushed": False,
            "pushed_at": 0.0,
            "loaded_at": None,
            "jar": None,
            "jar_at": 0.0,
        }
        cond = threading.Condition()
        capture = _HeaderCapture()
        capture_lock = threading.Lock()
        window = None
        previous_external = webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"]
        # Login popups have to stay in this WebView2. The system browser would
        # keep the session out of the cookie jar we read.
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
        try:
            window = webview.create_window(
                "Sign in to YouTube Music",
                _LIBRARY_URL,
                width=1024,
                height=768,
                hidden=True,
                text_select=True,
            )
            if window is None:
                raise ValueError("Could not open the YouTube Music sign-in window.")

            logger.info("Opened YouTube Music sign-in window")
            started = time.monotonic()

            def settle(error: str | None) -> None:
                with cond:
                    if state["settled"]:
                        return
                    state["settled"] = True
                    state["error"] = error
                    cond.notify_all()

            def reveal() -> None:
                with cond:
                    if state["settled"] or state["revealed"]:
                        return
                try:
                    window.show()
                except Exception as exc:
                    logger.warning("Could not show the sign-in window: %s", exc)
                    settle("Could not show the sign-in window.")
                    return
                with cond:
                    state["revealed"] = True
                logger.info("Showing YouTube Music sign-in window")

            def wake() -> None:
                with cond:
                    state["wake"] += 1
                    cond.notify_all()

            def on_sent(_sender: Any, args: Any) -> None:
                raw = _event_json(args)
                if "youtubei" not in raw:
                    return
                with cond:
                    state["cdp_events"].append(("sent", raw))
                    cond.notify_all()

            def on_extra(_sender: Any, args: Any) -> None:
                raw = _event_json(args)
                lowered = raw.lower()
                if "x-goog-authuser" not in lowered and "__secure-3papisid" not in lowered:
                    return
                with cond:
                    state["cdp_events"].append(("extra", raw))
                    cond.notify_all()

            def on_request(request: Any) -> None:
                url = str(getattr(request, "url", "") or "")
                if not _is_youtubei_url(url):
                    return
                headers = _copy_headers(getattr(request, "headers", None))
                with capture_lock:
                    capture.add_webview_request(headers)
                wake()

            def on_closed() -> None:
                with cond:
                    if state["settled"]:
                        return
                    state["settled"] = True
                    if state["saved"]:
                        state["error"] = None
                    else:
                        state["error"] = state["last_error"] or "Sign-in was cancelled."
                    cond.notify_all()

            def snapshot() -> tuple[dict[str, str] | None, float]:
                with capture_lock:
                    if capture.latest is None:
                        return None, 0.0
                    return dict(capture.latest), capture.latest_at

            def try_save(headers: dict[str, str], jar_cookie: str | None) -> bool:
                try:
                    built = _headers_from_capture(headers, jar_cookie)
                except ValueError:
                    return False
                if built is None:
                    return False
                cookie = built["cookie"]
                digest = hashlib.sha256(cookie.encode("utf-8")).hexdigest()
                with cond:
                    if state["settled"] or digest == state["rejected"]:
                        return False
                names = ", ".join(sorted({key.lower() for key in headers}))
                logger.info("Captured YouTube Music API headers (%s)", names)
                try:
                    _save_browser_json(built)
                except Exception as exc:
                    message = str(exc)
                    if isinstance(exc, ValueError):
                        logger.warning("Sign-in headers were rejected: %s", message)
                    else:
                        logger.exception("Sign-in headers were rejected")
                    with cond:
                        state["rejected"] = digest
                        state["last_error"] = message
                        already_settled = state["settled"]
                    if not already_settled:
                        reveal()
                    return False

                self._reset_ytmusic()
                with cond:
                    state["saved"] = True
                    state["settled"] = True
                    state["error"] = None
                    cond.notify_all()
                logger.info("YouTube Music sign-in saved to %s", _BROWSER_JSON_PATH)
                return True

            def jar_cookie() -> str | None:
                now = time.monotonic()
                if now - float(state["jar_at"]) < 1:
                    cached = state["jar"]
                    return cached if isinstance(cached, str) or cached is None else None
                try:
                    cookies = _read_cookies(window)
                except _SignInClosed:
                    raise
                except Exception as exc:
                    if window.events.closed.is_set():
                        raise _SignInClosed() from exc
                    logger.warning("Could not read sign-in cookies: %s", exc)
                    return None
                header = _cookie_header(cookies)
                state["jar"] = header
                state["jar_at"] = now
                return header

            def consider() -> None:
                if window.events.closed.is_set():
                    return
                headers, captured_at = snapshot()
                if headers and _sapisid_cookie(_header_value(headers, "cookie")):
                    try_save(headers, None)
                    return

                loaded = window.events.loaded.is_set()
                if not loaded:
                    if time.monotonic() - started >= 20:
                        reveal()
                    return

                try:
                    url = _page_url(window)
                except Exception as exc:
                    if window.events.closed.is_set():
                        return
                    logger.warning("Could not read the sign-in page URL: %s", exc)
                    return

                if not _is_music_youtube_url(url):
                    if _is_web_url(url):
                        state["saw_signed_out"] = True
                        reveal()
                    return

                try:
                    jar = jar_cookie()
                    still_music = _is_music_youtube_url(_page_url(window))
                except _SignInClosed:
                    return
                except Exception:
                    return
                if not still_music:
                    return
                if not jar:
                    state["saw_signed_out"] = True
                    state["session_at"] = None
                    state["pushed"] = False
                    reveal()
                    return

                if state["session_at"] is None:
                    state["session_at"] = time.monotonic() if state["saw_signed_out"] else started
                    if state["saw_signed_out"]:
                        state["pushed"] = False

                session_at = float(state["session_at"])
                fresh = headers is not None and captured_at >= session_at
                if fresh and headers is not None:
                    try_save(headers, jar)
                    return

                # The window already opened the library. Give that page a moment
                # to emit its API calls before navigating again. After a login,
                # navigate immediately so the user does not have to click around.
                if not state["saw_signed_out"] and not state["pushed"]:
                    if state["loaded_at"] is None:
                        state["loaded_at"] = time.monotonic()
                    if time.monotonic() - float(state["loaded_at"]) < 2:
                        return

                if state["pushed"]:
                    if not window.events.loaded.is_set():
                        return
                    if time.monotonic() - float(state["pushed_at"]) < 8:
                        return
                    fallback = {
                        "x-goog-authuser": "0",
                        "authorization": "SAPISIDHASH",
                    }
                    if headers:
                        fallback = _merge_headers(fallback, headers)
                    logger.warning("YouTube Music API request had no account header; using account 0")
                    try_save(fallback, jar)
                    return

                state["pushed"] = True
                state["pushed_at"] = time.monotonic()
                state["loaded_at"] = None
                logger.info("Opening YouTube Music library to capture API request headers")
                try:
                    window.load_url(_LIBRARY_URL)
                except Exception as exc:
                    logger.warning("Could not open YouTube Music library: %s", exc)
                    reveal()

            window.events.loaded += wake
            window.events.closed += on_closed
            window.events.request_sent += on_request
            state["on_sent"] = on_sent
            state["on_extra"] = on_extra

            while True:
                with cond:
                    if state["settled"]:
                        break
                    batch = state["cdp_events"]
                    state["cdp_events"] = []
                    if not batch and state["wake"] == 0:
                        cond.wait(timeout=0.4)
                        if state["settled"]:
                            break
                        batch = state["cdp_events"]
                        state["cdp_events"] = []
                    state["wake"] = 0

                if not state["watching"]:
                    try:
                        state["receivers"] = _attach_cdp(window, on_sent, on_extra)
                        state["watching"] = True
                        logger.info("Watching YouTube Music network requests")
                    except Exception as exc:
                        if window.events.loaded.is_set() and not state["watch_logged"]:
                            state["watch_logged"] = True
                            logger.warning("Could not watch network requests: %s", exc)

                for kind, raw in batch:
                    try:
                        payload = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    with capture_lock:
                        if kind == "sent":
                            capture.add_sent(payload)
                        else:
                            capture.add_extra(payload)

                consider()
        finally:
            webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = previous_external
            if window is not None:
                _destroy_sign_in_window(window)
            _auth_lock.release()

        if state["error"]:
            raise ValueError(state["error"])

    def is_signed_in(self) -> dict[str, bool]:
        """Return whether saved YouTube Music headers are on disk."""
        return {"signedIn": _BROWSER_JSON_PATH.is_file()}

    def sign_out(self) -> None:
        """Remove saved headers and clear the WebView profile."""
        if not _auth_lock.acquire(blocking=False):
            raise ValueError("Authentication is already being updated.")
        try:
            _clear_webview_profile()
            _BROWSER_JSON_PATH.unlink(missing_ok=True)
            _BROWSER_JSON_PATH.with_suffix(".json.tmp").unlink(missing_ok=True)
            self._reset_ytmusic()
            cleared = len(cache)
            cache.clear()
            logger.info("Signed out and cleared %d cached items", cleared)
        except Exception as exc:
            logger.exception("Sign-out failed")
            raise exc
        finally:
            _auth_lock.release()

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
