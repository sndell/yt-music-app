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
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from PIL import Image

import ytmusicapi
from ytmusicapi.continuations import CONTINUATION_ITEMS, get_continuation_token
from ytmusicapi.exceptions import YTMusicUserError
from ytmusicapi.helpers import initialize_headers, sapisid_from_cookie
from ytmusicapi.navigation import nav
from ytmusicapi.parsers.playlists import parse_playlist_items
from ytmusicapi.parsers.songs import parse_song_runs

from util.app_paths import data_dir
from util.audio_stream import audio_stream
from util.get_dominant_color import get_dominant_color_hex
from contract.registry import api
from contract.cache import (
    ALBUM,
    ARTIST,
    CHARTS,
    EXPLORE,
    HOME,
    LIBRARY_ALBUMS,
    LIBRARY_ARTISTS,
    LIBRARY_PLAYLISTS,
    LIBRARY_SONGS,
    LYRICS,
    LYRICS_TRANSLATED,
    MOOD_PLAYLISTS,
    MOODS,
    PLAYLIST,
    RELATED,
    THUMB,
    TUNER,
    store,
)

from features.music.normalize import _album_home_subtitle, _album_track, _artist_track, _as_int, _as_text, _dominant_color, _empty_home, _empty_quick_picks, _fill_missing_song_durations, _home_item, _home_layout, _home_shelves, _inline_items, _inline_thumbnail, _inline_thumbnail_field, _joined_names, _landscape_thumbnail, _named_album, _normalize_album, _normalize_artist, _optional_str, _other_version, _people, _playlist_subtitle, _related_artists, _release_item, _release_shelf, _search_count_label, _search_people, _search_playlist_id, _search_result, _song_subtitle, _songs_shelf, _thumbnails, _videos_shelf  # moved out of this module
from features.music.charts import _chart_country_code, _charts_payload, _empty_charts  # the charts browse page
from features.music.lyrics import _lyrics_browse_id, _normalize_lyrics, _query_batches, _signed_out_client, _split_blocks, _timed_lyrics, _translate_block, _translate_lines_individually, _translate_lyric_lines, _translate_request  # moved out of this module
from features.music.moods import _empty_mood_categories, _mood_fallback_sections, _mood_playlists, _mood_sections, MOODS_BROWSE_ID  # the moods and genres browse page
from features.music.explore import _explore_sections  # the explore feed
from features.music.related import _song_related_sections  # the watch playlist's Related tab
from features.music.playlists import _PlaylistDateCapture, _apply_added_dates, _date_sink, _fetch_all_playlist_tracks, _find_playlist_shelf, _forget_playlist_stat, _install_date_recorder, _load_playlist_stats, _playlist_first_page, _playlist_stat_score, _playlist_track_page, _read_playlist_whole, _record_playlist_stat, _save_playlist_stats, _token_sink, _walk_playlist_item_data  # moved out of this module

logger = logging.getLogger(__name__)

_BROWSER_JSON_PATH = data_dir() / "browser.json"

# Cached payloads live behind app/contract/cache.py: one family per payload
# kind, each with its TTL and the shape whose hash becomes the version in its
# key. Adding a field to a payload is one edit there, not a version bump here.
# YouTube Music has no offset for these lists, only a limit, and paging
# re-fetches from the top. One large page plus virtualization beats repeated
# refetches.
LIBRARY_SONGS_LIMIT = 5000
LIBRARY_ALBUMS_LIMIT = 1000
LIBRARY_ARTISTS_LIMIT = 2000
# Covers are inlined inline with a request. Past this many items the request is
# left with remote URLs and the frontend inlines failures on demand.
MAX_INLINE_ITEMS = 150

# Playlist tracks arrive a page at a time. The first page comes with the
# header, and every later page comes from the continuation token the previous
# response carried, so the view paints the top while the rest loads and caches.
# A generated mix reports no track count and never runs out, so it is left with
# one page and no token.

# Search is not cached: results move, and library scope depends on the session.
_SEARCH_FILTERS = (
    "songs",
    "videos",
    "albums",
    "artists",
    "playlists",
    "community_playlists",
    "featured_playlists",
    "profiles",
    "podcasts",
    "episodes",
)
_SEARCH_SCOPES = ("library", "uploads")
_MAX_SEARCH_LIMIT = 100


_LIKE_STATUSES = {"LIKE", "DISLIKE", "INDIFFERENT"}
_PRIVACY_STATUSES = {"PUBLIC", "PRIVATE", "UNLISTED"}
_SONG_VIDEO_TYPE = "MUSIC_VIDEO_TYPE_ATV"
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


def _year_in_payload(payload: Any, video_id: str) -> str | None:
    """Read the release year YouTube Music shows for one video from a next response.

    A song's panel entry carries the same byline the watch playlist shows
    ("artist • album • year"), and the year is a bare four-digit run. Music
    videos, uploads and mixes put views or likes there instead, so those have
    no year to report.
    """
    stack: list[Any] = [payload]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            panel = node.get("playlistPanelVideoRenderer")
            if isinstance(panel, dict) and panel.get("videoId") == video_id:
                byline = panel.get("longBylineText")
                runs = byline.get("runs") if isinstance(byline, dict) else None
                if isinstance(runs, list):
                    year = parse_song_runs(runs).get("year")
                    if isinstance(year, str) and year:
                        return year
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None


def _update_cached_like_status(video_id: str, rating: str) -> None:
    """Keep every cached playlist copy's like state in step with a rating."""
    try:
        for ident, playlist in store.entries(PLAYLIST):
            tracks = playlist.get("tracks")
            if not isinstance(tracks, list):
                continue
            changed = False
            for track in tracks:
                if isinstance(track, dict) and track.get("videoId") == video_id and track.get("likeStatus") != rating:
                    track["likeStatus"] = rating
                    changed = True
            if changed:
                store.write(PLAYLIST, ident, playlist)
    except Exception as e:
        logger.warning("Could not update cached like status: %s", e)


def _edit_status(result: Any, fallback: str) -> str:
    """Read the ``STATUS_*`` string out of an ``edit_playlist`` style response.

    Raises ``RuntimeError`` with whatever YouTube Music returned when the edit
    did not succeed.
    """
    if isinstance(result, str):
        text = result
    elif isinstance(result, dict):
        text = str(result.get("status", ""))
    else:
        text = str(result)
    if "SUCCEEDED" not in text:
        raise RuntimeError(text or fallback)
    return text


def _playlist_contains_videos(playlist: Any, video_ids: list[str]) -> bool | None:
    """Whether a ``get_playlist`` payload lists every given id as a track.

    Returns ``None`` when the payload cannot answer (missing, or not shaped
    like a playlist), so the caller can fetch a fresh copy rather than trust a
    stale one. An empty ``video_ids`` is trivially contained.
    """
    if not isinstance(playlist, dict):
        return None
    tracks = playlist.get("tracks")
    if not isinstance(tracks, list):
        return None
    present = {track.get("videoId") for track in tracks if isinstance(track, dict)}
    return all(video_id in present for video_id in video_ids)






# Sinks the recorder writes into, one per thread and stack-shaped. A list at
# the top means "a playlist fetch is running on this thread, collect its items".
# A second stack collects the continuation token the first page carried.
_date_sinks = threading.local()


















def _cache_created_playlist(playlist_id: str, title: str, description: str, privacy: str) -> None:
    """Cache the empty playlist ``create_playlist`` just made.

    YouTube Music answers with a stub browse page while a new playlist is still
    being prepared, and ytmusicapi cannot parse that page, so the first read
    would fail and the playlist view would sit on its loader. The creation call
    already knows the header, so cache it here and let the next successful
    fetch replace it.
    """
    store.write(
        PLAYLIST,
        playlist_id,
        {
            "owned": True,
            "id": playlist_id,
            "privacy": privacy,
            "description": description or None,
            "views": None,
            "duration": "",
            "trackCount": 0,
            "title": title,
            "thumbnails": [],
            "author": {"name": "", "id": None},
            "year": "",
            "durationSeconds": 0,
            "tracks": [],
            "nextToken": None,
            "dominantColor": None,
        },
    )


def _forget_playlist_list() -> None:
    """Drop the sidebar's saved list after a write that moves it.

    The list is painted on launch from disk, so a deleted or retitled row would
    otherwise stay on screen until its refresh window elapsed. The next read
    fetches the account's list again.
    """
    store.drop(LIBRARY_PLAYLISTS, "all")


def _delete_status(result: Any) -> str:
    """Decide the outcome of a ``delete_playlist`` call.

    A successful delete answers with the raw command response, which carries no
    ``status`` field; the library only returns a status *string* when the
    endpoint reports one. So a dict means success, and only a string without
    ``SUCCEEDED`` means the playlist is still there.
    """
    if isinstance(result, str) and "SUCCEEDED" not in result:
        raise RuntimeError(result or "Could not delete the playlist")
    return "SUCCEEDED"


# Per-playlist usage events for the "Add to playlist" recommendations row.
# Recent adds weigh more than plays, and both fade over time, so the top
# playlists track what the user actually reaches for lately rather than
# all-time favorites.
_PLAYLIST_STATS_PATH = data_dir() / "playlist_stats.json"
_PLAYLIST_STATS_LOCK = threading.Lock()
_PLAYLIST_STAT_KINDS = ("add", "play")
_PLAYLIST_STAT_MAX_EVENTS = 40
_PLAYLIST_STAT_WEIGHTS = {"add": 1.5, "play": 1.0}
_PLAYLIST_STAT_HALF_LIFE_DAYS = 3.0
















def _radio_playlist_id(playlist_id: str) -> str:
    """Playlist radio id. A plain library id plays the playlist back in order."""
    bare = playlist_id[2:] if playlist_id.startswith("VL") else playlist_id
    if bare.startswith("RDAMPL"):
        return bare
    return "RDAMPL" + bare


def _chip_text(renderer: dict[str, Any]) -> str:
    """Read the label runs of one chipCloudChipRenderer."""
    text = renderer.get("text")
    runs = text.get("runs") if isinstance(text, dict) else None
    if not isinstance(runs, list):
        return ""
    return "".join(run.get("text", "") for run in runs if isinstance(run, dict))


def _queue_tuner_chips(ytmusic: "ytmusicapi.YTMusic", video_id: str) -> list[dict[str, str]]:
    """Read the genre tuner chips YouTube Music shows for a song's mix.

    The chips live in ``musicQueueRenderer.subHeaderChipCloud`` of the ``next``
    response, which ytmusicapi does not expose. Each chip carries the playlist
    id that swaps the queue, so the frontend can reload the mix with it.
    """
    body = {
        "enablePersistentPlaylistPanel": True,
        "isAudioOnly": True,
        "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
        "videoId": video_id,
        "playlistId": "RDAMVM" + video_id,
        "params": "wAEB",
    }
    response = ytmusic._send_request("next", body)
    queue = (
        response.get("contents", {})
        .get("singleColumnMusicWatchNextResultsRenderer", {})
        .get("tabbedRenderer", {})
        .get("watchNextTabbedResultsRenderer", {})
        .get("tabs", [{}])[0]
        .get("tabRenderer", {})
        .get("content", {})
        .get("musicQueueRenderer", {})
    )
    cloud = queue.get("subHeaderChipCloud") if isinstance(queue, dict) else None
    chips_renderer = cloud.get("chipCloudRenderer") if isinstance(cloud, dict) else None
    chips: list[dict[str, str]] = []
    for chip in chips_renderer.get("chips", []) if isinstance(chips_renderer, dict) else []:
        renderer = chip.get("chipCloudChipRenderer") if isinstance(chip, dict) else None
        if not isinstance(renderer, dict):
            continue
        text = _chip_text(renderer)
        if not text or text == "Save":
            continue
        endpoint = (
            renderer.get("navigationEndpoint", {})
            .get("queueUpdateCommand", {})
            .get("fetchContentsCommand", {})
            .get("watchEndpoint", {})
        )
        playlist_id = endpoint.get("playlistId") if isinstance(endpoint, dict) else None
        if not isinstance(playlist_id, str) or not playlist_id:
            continue
        chips.append({"id": text, "text": text, "playlistId": playlist_id})
    return chips




_lyrics_lock = threading.Lock()
_signed_out_ytmusic: ytmusicapi.YTMusic | None = None








# Google's public translate endpoints take form fields and answer JSON. No key,
# no client library, and nothing to install, which is the whole reason lyrics
# translation does not need one. ``single`` reads a block, ``t`` reads one entry
# per ``q`` field; the second one is the fallback the first one's split can need.
_TRANSLATE_BLOCK_ENDPOINT = "https://translate.googleapis.com/translate_a/single"
_TRANSLATE_LINES_ENDPOINT = "https://translate.googleapis.com/translate_a/t"
_TRANSLATE_TIMEOUT = 15
# A block goes in as one request. Past this many characters it is split at a
# line break, so a long lyric is a few requests rather than one oversized one.
_TRANSLATE_BLOCK_CHARS = 4000
# The per-line endpoint takes its lines as a query string, so its batches are
# measured as encoded query text and not as characters of lyric.
_TRANSLATE_QUERY_CHARS = 4000














def _inline_playlist_thumbnails(playlists: list[dict[str, Any]]) -> None:
    _inline_thumbnail_field(playlists, "thumbnails")






















_cover_color_cache: dict[str, str | None] = {}
_cover_color_lock = threading.Lock()








































_SEARCH_KINDS = {
    "song": "song",
    "video": "video",
    "album": "album",
    "artist": "artist",
    "playlist": "playlist",
    "profile": "profile",
    "podcast": "podcast",
    "episode": "episode",
}










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

# `_is_authenticated` asks YouTube for the account, which is a network round
# trip. A cached read must not pay it before serving from disk, and a burst of
# calls should ask once. Signing in or out resets the answer.
_AUTH_CHECK_TTL = 60.0


class MusicApi:
    """API class for interacting with YouTube Music via ytmusicapi.
    
    This class is exposed to the webview frontend via the js_api parameter.
    All public methods are callable from JavaScript.
    """

    _ytmusic: ytmusicapi.YTMusic | None = None
    _auth_ok: bool | None = None
    _auth_checked_at: float = 0.0

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
        cls._auth_ok = None
        cls._auth_checked_at = 0.0

    @classmethod
    def _is_authenticated(cls) -> bool:
        """Check if user is authenticated by asking YouTube Music for the account.

        The answer is kept for ``_AUTH_CHECK_TTL`` so a page that reads several
        lists does not pay a round trip per call. A cache hit is served before
        this is ever asked, so a warm disk cache works with the network down.

        Returns:
            True if authenticated (get_account_info succeeds), False otherwise.
        """
        now = time.monotonic()
        if cls._auth_ok is not None and now - cls._auth_checked_at < _AUTH_CHECK_TTL:
            return cls._auth_ok
        try:
            account_info = cls._get_ytmusic().get_account_info()
            ok = account_info is not None
        except Exception as e:
            logger.warning("Authentication check failed: %s", e)
            ok = False
        cls._auth_ok = ok
        cls._auth_checked_at = now
        return ok

    @api.read(returns="string | null")
    def get_cover_color(self, image_url: str) -> str | None:
        """Vibrant cover color for the queue wash.

        Uses the playlist palette pick, weighted toward saturation.
        """
        if not isinstance(image_url, str) or not image_url.startswith(("http://", "https://")):
            return None
        with _cover_color_lock:
            if image_url in _cover_color_cache:
                return _cover_color_cache[image_url]
        color = get_dominant_color_hex(image_url, prefer_vibrancy=True)
        with _cover_color_lock:
            if len(_cover_color_cache) > 64:
                _cover_color_cache.pop(next(iter(_cover_color_cache)))
            _cover_color_cache[image_url] = color
        return color

    @api.read(returns="string | null", cache="thumb")
    def inline_thumbnail(self, image_url: str) -> str | None:
        """Return a data URL for a cover the webview cannot decode directly.

        The frontend calls this from an image error handler, so a page can paint
        its covers immediately and only pay to re-encode the ones that fail.
        Results are cached, and None means the cover could not be fetched.
        """
        if not isinstance(image_url, str) or not image_url.startswith(("http://", "https://")):
            return None
        result = _inline_thumbnail(image_url)
        return result if result.startswith("data:") else None

    @api.read(returns="LibraryPlaylists", cache="playlists")
    def get_playlists(self, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch all playlists from the user's YouTube Music library.

        The list is cached whole, so the sidebar and the Library's Playlists
        chip paint from disk on the next launch and a background read replaces
        them when the payload is older than the family's refresh window.

        Args:
            force_refresh: Skip the cached payload and fetch again.

        Returns:
            ``{"playlists": [...], "fromCache": bool, "stale": bool}``, empty
            on error.
        """
        empty: dict[str, Any] = {"playlists": []}
        try:
            if not force_refresh:
                cached = store.read(LIBRARY_PLAYLISTS, "all")
                if cached is not None and isinstance(cached.get("playlists"), list):
                    logger.info("Returning cached playlists (count: %d)", len(cached["playlists"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlists")
                return empty

            logger.info("Fetching playlists from API...")
            ytmusic = self._get_ytmusic()
            playlists = ytmusic.get_library_playlists()
            _inline_playlist_thumbnails(playlists)

            payload: dict[str, Any] = {"playlists": playlists}
            store.write(LIBRARY_PLAYLISTS, "all", payload)
            logger.info("Playlists fetched (count: %d)", len(playlists))
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return empty
        except Exception as e:
            logger.exception("Failed to fetch playlists: %s", e)
            if force_refresh:
                raise
            return empty

    @api.read(returns="LibraryAlbums", cache="library_albums")
    def get_library_albums(
        self, limit: int = LIBRARY_ALBUMS_LIMIT, force_refresh: bool = False
    ) -> dict[str, Any]:
        """Fetch the albums saved to the user's YouTube Music library.

        The list is cached whole; a later call with a smaller limit slices it.
        Pass force_refresh to fetch a new copy instead of the cached one.

        Args:
            limit: Maximum number of albums to return.
            force_refresh: Skip the cached payload and fetch again.

        Returns:
            ``{"albums": [...], "fromCache": bool}``, empty on error.
        """
        empty: dict[str, Any] = {"albums": []}
        try:
            if not force_refresh:
                cached = store.read(LIBRARY_ALBUMS, "all")
                albums = cached.get("albums") if cached else None
                if isinstance(albums, list):
                    logger.info("Returning cached library albums (count: %d)", len(albums))
                    return {**cached, "albums": albums[:limit] if limit else albums}

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library albums")
                return empty

            logger.info("Fetching library albums from API...")
            ytmusic = self._get_ytmusic()
            albums = ytmusic.get_library_albums(limit=limit)
            _inline_playlist_thumbnails(albums)

            payload: dict[str, Any] = {"albums": albums}
            store.write(LIBRARY_ALBUMS, "all", payload)
            logger.info("Library albums fetched (count: %d)", len(albums))
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return empty
        except Exception as e:
            logger.exception("Failed to fetch library albums: %s", e)
            if force_refresh:
                raise
            return empty

    @api.read(returns="LibrarySongs", cache="library_songs")
    def get_library_songs(
        self, limit: int = LIBRARY_SONGS_LIMIT, force_refresh: bool = False
    ) -> dict[str, Any]:
        """Fetch the songs saved to the user's YouTube Music library.

        Normalized to the shared Track shape. Covers are left as remote URLs so
        a large library does not inline hundreds of images; the frontend inlines
        the ones it cannot decode. The list is cached whole for the next launch.

        Args:
            limit: Maximum number of songs to return.
            force_refresh: Skip the cached payload and fetch again.

        Returns:
            ``{"songs": [...], "fromCache": bool}``, empty on error.
        """
        empty: dict[str, Any] = {"songs": []}
        try:
            if not force_refresh:
                cached = store.read(LIBRARY_SONGS, "all")
                songs = cached.get("songs") if cached else None
                if isinstance(songs, list):
                    logger.info("Returning cached library songs (count: %d)", len(songs))
                    return {**cached, "songs": songs[:limit] if limit else songs}

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library songs")
                return empty

            logger.info("Fetching library songs from API...")
            ytmusic = self._get_ytmusic()
            raw = ytmusic.get_library_songs(limit=limit)

            songs: list[dict[str, Any]] = []
            for item in raw if isinstance(raw, list) else []:
                normalized = _album_track(item, "", "", [])
                if normalized is not None and normalized["videoId"]:
                    songs.append(normalized)

            payload: dict[str, Any] = {"songs": songs}
            store.write(LIBRARY_SONGS, "all", payload)
            logger.info("Library songs fetched (count: %d)", len(songs))
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return empty
        except Exception as e:
            logger.exception("Failed to fetch library songs: %s", e)
            if force_refresh:
                raise
            return empty

    @api.read(returns="LibraryArtists", cache="library_artists")
    def get_library_artists(
        self, limit: int = LIBRARY_ARTISTS_LIMIT, force_refresh: bool = False
    ) -> dict[str, Any]:
        """Fetch the artists saved to the user's YouTube Music library.

        ytmusicapi returns each artist with an "MPLAUC..." browse id; the
        channel id the artist page expects is that value without the "MPLA"
        prefix. Covers are left as remote URLs. The list is cached whole.

        Args:
            limit: Maximum number of artists to return.
            force_refresh: Skip the cached payload and fetch again.

        Returns:
            ``{"artists": [...], "fromCache": bool}``, empty on error.
        """
        empty: dict[str, Any] = {"artists": []}
        try:
            if not force_refresh:
                cached = store.read(LIBRARY_ARTISTS, "all")
                artists = cached.get("artists") if cached else None
                if isinstance(artists, list):
                    logger.info("Returning cached library artists (count: %d)", len(artists))
                    return {**cached, "artists": artists[:limit] if limit else artists}

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library artists")
                return empty

            logger.info("Fetching library artists from API...")
            ytmusic = self._get_ytmusic()
            raw = ytmusic.get_library_artists(limit=limit)

            artists: list[dict[str, Any]] = []
            for item in raw if isinstance(raw, list) else []:
                if not isinstance(item, dict):
                    continue
                browse_id = item.get("browseId")
                if not isinstance(browse_id, str) or not browse_id:
                    continue
                channel_id = browse_id[4:] if browse_id.startswith("MPLAUC") else browse_id
                # ytmusicapi reads these rows' subtitle as "subscribers", but for a
                # library artist it is the number of that artist's songs saved here
                # ("25 songs" -> "25"). The real subscriber count only comes from
                # the artist page.
                songs_text = _as_text(item.get("subscribers")).replace(",", "")
                artists.append(
                    {
                        "browseId": channel_id,
                        "name": _as_text(item.get("artist")),
                        "songCount": int(songs_text) if songs_text.isdigit() else 0,
                        "thumbnails": _thumbnails(item.get("thumbnails")),
                    }
                )

            _inline_items(artists)
            payload: dict[str, Any] = {"artists": artists}
            store.write(LIBRARY_ARTISTS, "all", payload)
            logger.info("Library artists fetched (count: %d)", len(artists))
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return empty
        except Exception as e:
            logger.exception("Failed to fetch library artists: %s", e)
            if force_refresh:
                raise
            return empty

    @api.read(returns="{ songs: Track[] }")
    def get_history(self) -> dict[str, Any]:
        """Return the songs the account played recently, newest first.

        Not cached: every play appends to the history, so a stored page would
        leave out the song the user just heard. A failure raises instead of
        returning an empty list, because an empty history is a real state the
        page has to tell apart from a read that did not happen.

        Returns:
            ``{"songs": [...]}`` in the shared Track shape.
        """
        try:
            ytmusic = self._get_ytmusic()
        except FileNotFoundError as exc:
            raise RuntimeError("Sign in from Settings to see your history.") from exc

        try:
            logger.info("Fetching history from API...")
            raw = ytmusic.get_history()
            songs: list[dict[str, Any]] = []
            for item in raw if isinstance(raw, list) else []:
                normalized = _album_track(item, "", "", [])
                if normalized is not None and normalized["videoId"]:
                    songs.append(normalized)
        except Exception as exc:
            logger.exception("Failed to fetch history: %s", exc)
            raise RuntimeError("Could not read your history.") from exc

        logger.info("History fetched (count: %d)", len(songs))
        return {"songs": songs}

    @api.read(returns="HomeFeed", cache="home")
    def get_home(self, force_refresh: bool = False) -> dict[str, Any]:
        """Return every shelf YouTube Music puts on the home feed.

        Quick picks stays a vertical list and every other shelf is a horizontal
        row. A shelf whose items have no page to open is left out. A saved feed
        is returned as-is. Pass force_refresh to fetch a new one.
        """
        empty = _empty_home()
        try:
            if not force_refresh:
                cached = store.read(HOME, "feed")
                if cached is not None and isinstance(cached.get("shelves"), list):
                    logger.info("Returning cached home (shelves: %d)", len(cached["shelves"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return home")
                return empty

            logger.info("Fetching home from API...")
            home = self._get_ytmusic().get_home(limit=16)
            if not isinstance(home, list):
                return empty

            shelves = _home_shelves(home)
            if not shelves:
                titles = [row.get("title") for row in home if isinstance(row, dict)]
                logger.warning("Home feed had no shelf this app can show: %s", titles)
                return empty

            result = {"shelves": shelves}
            store.write(HOME, "feed", result)
            logger.info(
                "Home fetched (%s)",
                ", ".join(f"{shelf['title']}: {len(shelf['items'])}" for shelf in shelves),
            )
            return result
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return empty
        except Exception as e:
            logger.exception("Failed to fetch home: %s", e)
            if force_refresh:
                raise
            return empty

    @api.read(returns="QuickPicks", cache="home")
    def get_quick_picks(self) -> dict[str, Any]:
        """Return the Quick picks shelf in the older title-and-tracks shape."""
        home = self.get_home()
        for shelf in home.get("shelves", []):
            if not isinstance(shelf, dict) or shelf.get("layout") != "list":
                continue
            tracks = []
            for item in shelf.get("items", []):
                if not isinstance(item, dict) or item.get("kind") != "song" or not item.get("videoId"):
                    continue
                artists = item.get("artists") if isinstance(item.get("artists"), list) else []
                tracks.append(
                    {
                        "videoId": item["videoId"],
                        "title": item.get("title") or "",
                        "artists": artists,
                        "album": None,
                        "thumbnails": item.get("thumbnails") or [],
                        "duration": "",
                        "durationSeconds": 0,
                        "isExplicit": bool(item.get("explicit")),
                    }
                )
            return {"title": shelf.get("title") or "Quick picks", "tracks": tracks}
        return _empty_quick_picks()

    @api.read(returns="ExploreFeed", cache="explore")
    def get_explore(self, force_refresh: bool = False) -> dict[str, Any]:
        """Return YouTube Music's Explore feed as the sections the page renders.

        Each section says which layout it uses, so the page draws releases and
        videos as cards, charts as song rows, and moods as tiles into the
        existing moods and genres page. A section the feed omits, or one whose
        rows all fail to map, is left out rather than shown as an empty heading.
        A saved feed is returned as-is; pass force_refresh to fetch a new one.

        Returns:
            ``{"sections": [...], "fromCache": bool}``. Raises when the read
            fails and nothing is cached to serve.
        """
        empty: dict[str, Any] = {"sections": []}
        try:
            if not force_refresh:
                cached = store.read(EXPLORE, "feed")
                if cached is not None and isinstance(cached.get("sections"), list):
                    logger.info("Returning cached explore (sections: %d)", len(cached["sections"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return explore")
                return empty

            logger.info("Fetching explore from API...")
            sections = _explore_sections(self._get_ytmusic().get_explore())
            if not sections:
                logger.warning("Explore feed had no section this app can show")
                return empty

            payload: dict[str, Any] = {"sections": sections}
            store.write(EXPLORE, "feed", payload)
            logger.info(
                "Explore fetched (%s)",
                ", ".join(
                    f"{section['title']}: {len(section['items']) or len(section['categories'])}" for section in sections
                ),
            )
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            raise
        except Exception as e:
            # A cached payload is returned above, so reaching here means there
            # is nothing to serve. Returning empty would paint the UI's honest
            # empty state over a failed read; raise so the page shows the error.
            logger.exception("Failed to fetch explore: %s", e)
            raise

    @api.read(returns="MoodCategories", cache="moods")
    def get_mood_categories(self, force_refresh: bool = False) -> dict[str, Any]:
        """Return YouTube Music's mood and genre sections and their categories.

        A section is YouTube's own grouping (``For you``, ``Moods & moments``,
        ``Genres``). A category carries the params its playlists are read with
        and the color YouTube draws its tile in; the page has no cover image per
        category, so the color is what the UI can show. Pass force_refresh to
        fetch a new copy instead of the cached one.

        Returns:
            ``{"sections": [...], "fromCache": bool}``. Raises when the read
            fails and nothing is cached to serve.
        """
        empty = _empty_mood_categories()
        try:
            if not force_refresh:
                cached = store.read(MOODS, "all")
                if cached is not None and isinstance(cached.get("sections"), list):
                    logger.info("Returning cached mood categories (sections: %d)", len(cached["sections"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return mood categories")
                return empty

            logger.info("Fetching moods and genres from API...")
            ytmusic = self._get_ytmusic()
            try:
                # _send_request is ytmusicapi's own browse seam, used because
                # get_mood_categories drops the renderer that carries the tile
                # color. A shape YouTube renames falls through to the public
                # call, which still lists every category.
                raw = ytmusic._send_request("browse", {"browseId": MOODS_BROWSE_ID})
                sections = _mood_sections(raw)
            except Exception as exc:
                logger.warning("Moods browse parse failed (%s); falling back to get_mood_categories", exc)
                sections = []
            if not sections:
                sections = _mood_fallback_sections(ytmusic.get_mood_categories())
            if not sections:
                logger.warning("Moods and genres returned no section this app can show")
                return empty

            payload: dict[str, Any] = {"sections": sections}
            store.write(MOODS, "all", payload)
            logger.info(
                "Mood categories fetched (%s)",
                ", ".join(f"{section['title']}: {len(section['categories'])}" for section in sections),
            )
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            raise
        except Exception as e:
            # A cached payload is returned above, so reaching here means there
            # is nothing to serve. Returning empty would paint the UI's honest
            # empty state over a failed read; raise so the page shows the error.
            logger.exception("Failed to fetch mood categories: %s", e)
            raise

    @api.read(returns="MoodPlaylists", cache="mood_playlists")
    def get_mood_playlists(self, params: str, force_refresh: bool = False) -> dict[str, Any]:
        """Return the playlists YouTube Music groups under one mood or genre.

        ``params`` is a category's own token, from ``get_mood_categories``.
        Rows share the library's playlist shape, so the same card renders them
        and the playlist route opens them; a category is usually a few hundred
        rows, all YouTube's own. Pass force_refresh to fetch a new copy.

        Returns:
            ``{"playlists": [...], "fromCache": bool}``. Raises when the read
            fails and nothing is cached to serve.
        """
        empty: dict[str, Any] = {"playlists": []}
        token = params.strip() if isinstance(params, str) else ""
        if not token:
            return empty
        try:
            if not force_refresh:
                cached = store.read(MOOD_PLAYLISTS, token)
                if cached is not None and isinstance(cached.get("playlists"), list):
                    logger.info("Returning cached mood playlists (count: %d)", len(cached["playlists"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return mood playlists")
                return empty

            logger.info("Fetching mood playlists from API...")
            playlists = self._get_ytmusic().get_mood_playlists(token)
            rows = _mood_playlists(playlists)
            # Above MAX_INLINE_ITEMS this is a no-op, and a category is usually
            # that big: its covers stay remote and the card inlines a failure.
            _inline_playlist_thumbnails(rows)

            payload: dict[str, Any] = {"playlists": rows}
            store.write(MOOD_PLAYLISTS, token, payload)
            logger.info("Mood playlists fetched (count: %d)", len(rows))
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            raise
        except Exception as e:
            # A cached payload is returned above, so reaching here means there
            # is nothing to serve. Returning empty would paint the UI's honest
            # empty state over a failed read; raise so the page shows the error.
            logger.exception("Failed to fetch mood playlists: %s", e)
            raise

    @api.read(returns="Charts", cache="charts")
    def get_charts(self, country: str = "ZZ", force_refresh: bool = False) -> dict[str, Any]:
        """Return YouTube Music's charts for one country.

        ``country`` is an ISO 3166-1 alpha-2 code from the payload's own country
        list; ``ZZ`` is YouTube's global chart. A section is one of YouTube's
        playlist charts (daily, weekly, and for some countries its own genres or
        languages), each drawn as playlist cards; ``artists`` is the top-artist
        chart with each artist's rank. Pass force_refresh to fetch a new copy
        instead of the cached one.

        Returns:
            ``{"country", "countryName", "countries", "sections", "artists",
            "fromCache"}``. Raises when the read fails and nothing is cached.
        """
        code = _chart_country_code(country)
        try:
            if not force_refresh:
                cached = store.read(CHARTS, code)
                if cached is not None and isinstance(cached.get("sections"), list):
                    logger.info("Returning cached charts for %s (sections: %d)", code, len(cached["sections"]))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return charts")
                return _empty_charts(code)

            logger.info("Fetching charts from API (%s)...", code)
            payload = _charts_payload(self._get_ytmusic().get_charts(code), code)
            store.write(CHARTS, code, payload)
            logger.info(
                "Charts fetched (%s: %d sections, %d artists)",
                code,
                len(payload["sections"]),
                len(payload["artists"]),
            )
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            raise
        except Exception as e:
            # A cached payload is returned above, so reaching here means there
            # is nothing to serve. Returning empty would paint the UI's honest
            # empty state over a failed read; raise so the page shows the error.
            logger.exception("Failed to fetch charts: %s", e)
            raise

    @api.read(returns="SearchResult[]", params={"filter": 'SearchFilter | ""', "scope": 'SearchScope | ""'})
    def search(self, query: str, filter: str = "", scope: str = "", limit: int = 30) -> list[dict[str, Any]]:
        """Search YouTube Music.

        ``filter`` narrows to one result type (``songs``, ``albums``,
        ``artists``, ...). ``scope`` of ``library`` searches only what the user
        saved; ``uploads`` searches their uploads. Both default to the mixed
        public search when empty. Results share the shape the UI renders; covers
        stay as remote URLs and the UI inlines the ones the webview cannot load.
        """
        try:
            text = query.strip() if isinstance(query, str) else ""
            if not text:
                return []
            if not isinstance(limit, int) or limit <= 0:
                limit = 30
            limit = min(limit, _MAX_SEARCH_LIMIT)

            active_filter = filter if isinstance(filter, str) and filter in _SEARCH_FILTERS else None
            active_scope = scope if isinstance(scope, str) and scope in _SEARCH_SCOPES else None
            # ytmusicapi rejects these pairings; drop the filter rather than fail.
            if active_scope == "uploads" and active_filter:
                active_filter = None
            if active_scope == "library" and active_filter in {"community_playlists", "featured_playlists"}:
                active_filter = None

            logger.info("Search '%s' (filter=%s, scope=%s, limit=%d)", text, active_filter, active_scope, limit)
            raw = self._get_ytmusic().search(text, filter=active_filter, scope=active_scope, limit=limit)
            if not isinstance(raw, list):
                return []

            results = [result for result in (_search_result(item) for item in raw) if result is not None]
            logger.info("Search '%s' returned %d results", text, len(results))
            return results
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Search failed: %s", e)
            return []

    @api.read(returns="SearchSuggestion[]")
    def get_search_suggestions(self, query: str) -> list[str]:
        """YouTube Music's own completions for a partially typed query.

        Plain strings: ytmusicapi's detailed runs also carry a history flag and
        a feedback token, and neither changes what the flyout renders, so they
        stop here. YouTube has nothing to complete for an empty query, and a
        failed request answers with an empty list rather than an error, so the
        field keeps accepting typing and the search below it still runs.
        """
        try:
            text = query.strip() if isinstance(query, str) else ""
            if not text:
                return []
            raw = self._get_ytmusic().get_search_suggestions(text)
            if not isinstance(raw, list):
                return []
            return [item for item in raw if isinstance(item, str) and item]
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Search suggestions failed: %s", e)
            return []

    @api.read(returns="string[]")
    def shuffle_tracks(self, video_ids: list[str]) -> list[str]:
        """Return the given track ids in a true-random order.

        ``random.SystemRandom`` draws from the OS CSPRNG, and its ``shuffle``
        is an unbiased Fisher-Yates permutation. That is the point: the order
        is not derived from a predictable, time-seeded Mersenne Twister, so
        every ordering of the list is equally likely.
        """
        ids = [video_id for video_id in video_ids if isinstance(video_id, str) and video_id]
        random.SystemRandom().shuffle(ids)
        return ids

    @api.read(returns="PlaylistDetails", cache="playlist")
    def get_playlist_items(self, playlist_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Read a playlist's header and its first page of tracks.

        The header carries the true track count, so the view can say how many
        songs the playlist has while the rest loads. The payload's ``nextToken``
        is the cursor for :meth:`get_playlist_page`, or ``None`` when every
        track is already here. A generated mix never ends, so it gets one page
        and no cursor.

        Args:
            playlist_id: The YouTube Music playlist ID
            force_refresh: If True, bypass cache and fetch fresh data.

        Returns:
            A dictionary containing playlist details and the first tracks,
            or an empty dict on error.
        """

        try:
            if not force_refresh:
                cached = store.read(PLAYLIST, playlist_id)
                if cached is not None:
                    logger.info(
                        "Returning cached playlist '%s' (tracks: %d)",
                        cached.get("title", "Unknown"),
                        len(cached.get("tracks", []))
                    )
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlist items")
                return {}

            logger.info("Fetching playlist items from API for ID: %s", playlist_id)
            ytmusic = self._get_ytmusic()
            playlist, next_token = _playlist_first_page(ytmusic, playlist_id)
            if not playlist:
                return {}
            # ytmusicapi reports the header length as ``duration_seconds``; the
            # contract the UI reads says ``durationSeconds``.
            if playlist.get("durationSeconds") is None:
                playlist["durationSeconds"] = _as_int(playlist.get("duration_seconds"))
            if playlist.get("trackCount") is None:
                tracks = playlist.get("tracks")
                playlist["trackCount"] = len(tracks) if isinstance(tracks, list) else 0
                next_token = None
            playlist["nextToken"] = next_token

            logger.info(
                "Playlist '%s' fetched successfully (tracks: %d, more: %s)",
                playlist.get("title", "Unknown"),
                len(playlist.get("tracks", [])),
                bool(next_token),
            )

            playlist["dominantColor"] = _dominant_color(playlist.get("thumbnails", []))

            # Only the playlist cover is inlined. Track covers stay as remote
            # URLs: a large playlist has thousands, and fetching them inline
            # blocks the request until every one resolves or times out. The
            # frontend inlines the ones the webview cannot decode on demand.
            _inline_playlist_thumbnails([playlist])

            # Store in cache
            store.write(PLAYLIST, playlist_id, playlist)
            logger.info("Playlist cached: %s", playlist_id)

            return playlist
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return {}
        except Exception as e:
            logger.exception("Failed to fetch playlist items: %s", e)
            if force_refresh:
                raise
            return {}

    @api.read(returns="PlaylistPage", cache="playlist")
    def get_playlist_page(self, playlist_id: str, page_token: str) -> dict[str, Any]:
        """Read the page of playlist tracks after the one already loaded.

        ``page_token`` is the ``nextToken`` from the last response for this
        playlist. The rows are appended to the cached playlist, so the next
        open starts from everything loaded so far, and the returned
        ``nextToken`` is the cursor after them, or ``None`` at the end.

        Returns:
            ``{"tracks": [...], "nextToken": str | None}``. A failure comes back
            as an empty page with no cursor, so the caller stops.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(page_token, str) or not page_token:
            raise ValueError("page token is required")

        result: dict[str, Any] = {"tracks": [], "nextToken": None}
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlist page")
                return result

            ytmusic = self._get_ytmusic()
            cached = store.read_raw(PLAYLIST, playlist_id)
            is_collaborative = bool(cached.get("collaborators")) if isinstance(cached, dict) else False

            with _PlaylistDateCapture(ytmusic) as capture:
                tracks, next_token = _playlist_track_page(ytmusic, page_token, is_collaborative)
            _apply_added_dates(tracks, capture.items)
            logger.info(
                "Playlist '%s' page fetched (tracks: %d, more: %s)",
                playlist_id,
                len(tracks),
                bool(next_token),
            )

            # Append only when this page still follows the cached one. A second
            # loader replaying the same token would otherwise duplicate rows,
            # and a cache that a refresh already replaced would be corrupted.
            if isinstance(cached, dict) and cached.get("nextToken") == page_token:
                cached["tracks"] = list(cached.get("tracks") or []) + tracks
                cached["nextToken"] = next_token
                store.write(PLAYLIST, playlist_id, cached)

            return {"tracks": tracks, "nextToken": next_token}
        except Exception as e:
            logger.exception("Failed to fetch playlist page: %s", e)
            return result

    @api.read(returns="{ tracks: Track[] }")
    def get_playlist_all_tracks(self, playlist_id: str) -> dict[str, Any]:
        """Every track of a playlist, in order.

        Queueing and a write's row lookup need the rows as they are on YouTube
        now, so this always reads them; true shuffle uses
        :meth:`get_playlist_shuffle_tracks` instead, which may answer from the
        cache.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlist tracks")
                return {"tracks": []}
            tracks = _fetch_all_playlist_tracks(self._get_ytmusic(), playlist_id)
            logger.info("Playlist '%s' read whole (tracks: %d)", playlist_id, len(tracks))
            return {"tracks": tracks}
        except Exception as e:
            logger.exception("Failed to read playlist whole: %s", e)
            return {"tracks": []}

    @api.read(returns="{ tracks: Track[] }", cache="playlist")
    def get_playlist_shuffle_tracks(self, playlist_id: str) -> dict[str, Any]:
        """Every track of a playlist, for a true shuffle.

        The cached playlist is used when it already holds every page, so a list
        the user has opened shuffles without a network read. A partial cache is
        answered by reading the whole playlist once and storing it, so the next
        shuffle and the playlist view's warm open both start from it. A
        generated mix never ends, so it stays at one page.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return playlist tracks")
                return {"tracks": []}

            cached = store.read(PLAYLIST, playlist_id)
            cached_tracks = cached.get("tracks") if isinstance(cached, dict) else None
            if isinstance(cached_tracks, list) and cached.get("nextToken") is None:
                logger.info(
                    "Playlist '%s' shuffled from cache (tracks: %d)", playlist_id, len(cached_tracks)
                )
                return {"tracks": cached_tracks}

            playlist, tracks = _read_playlist_whole(self._get_ytmusic(), playlist_id)
            if not playlist:
                return {"tracks": []}
            if playlist.get("durationSeconds") is None:
                playlist["durationSeconds"] = _as_int(playlist.get("duration_seconds"))
            if playlist.get("trackCount") is None:
                playlist["trackCount"] = len(tracks)
            playlist["tracks"] = tracks
            playlist["nextToken"] = None
            playlist["dominantColor"] = _dominant_color(playlist.get("thumbnails", []))
            _inline_playlist_thumbnails([playlist])
            store.write(PLAYLIST, playlist_id, playlist)
            logger.info("Playlist '%s' read whole for shuffle (tracks: %d)", playlist_id, len(tracks))
            return {"tracks": tracks}
        except Exception as e:
            logger.exception("Failed to read a playlist for shuffle: %s", e)
            return {"tracks": []}

    @api.read(returns="AlbumDetails", cache="album")
    def get_album(self, browse_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch an album by browse id.

        An ``OLAK5uy_`` audio playlist id is resolved to its ``MPREb_`` browse
        id first. The normalized album is cached under that browse id.
        """
        try:
            if not isinstance(browse_id, str) or not browse_id:
                logger.warning("Album browse id is required")
                return {}
            # A cached album is served before the network is touched. An
            # ``OLAK5uy_`` alias has no cache key until it is resolved, so that
            # path resolves first and reads the cache under the browse id.
            if not force_refresh and not browse_id.startswith("OLAK5uy_"):
                cached = store.read(ALBUM, browse_id)
                if cached is not None:
                    logger.info(
                        "Returning cached album '%s' (tracks: %d)",
                        cached.get("title", "Unknown"),
                        len(cached.get("tracks", [])),
                    )
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return album")
                return {}

            ytmusic = self._get_ytmusic()
            if browse_id.startswith("OLAK5uy_"):
                resolved = ytmusic.get_album_browse_id(browse_id)
                if not isinstance(resolved, str) or not resolved:
                    logger.warning("Could not resolve album browse id for %s", browse_id)
                    return {}
                logger.info("Resolved album %s to %s", browse_id, resolved)
                browse_id = resolved
                if not force_refresh:
                    cached = store.read(ALBUM, browse_id)
                    if cached is not None:
                        logger.info(
                            "Returning cached album '%s' (tracks: %d)",
                            cached.get("title", "Unknown"),
                            len(cached.get("tracks", [])),
                        )
                        return cached

            logger.info("Fetching album from API for ID: %s", browse_id)
            album = ytmusic.get_album(browse_id)
            if not isinstance(album, dict):
                return {}

            payload = _normalize_album(album, browse_id)
            store.write(ALBUM, browse_id, payload)
            logger.info(
                "Album '%s' fetched successfully (tracks: %d)",
                payload.get("title", "Unknown"),
                len(payload.get("tracks", [])),
            )
            logger.info("Album cached: %s", browse_id)
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return {}
        except Exception as e:
            logger.exception("Failed to fetch album: %s", e)
            if force_refresh:
                raise
            return {}

    @api.read(returns="ArtistDetails", cache="artist")
    def get_artist(self, channel_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch an artist page: header plus songs, releases, videos, and related artists.

        A leading ``MPLA`` is removed so the cache key matches the channel id
        passed to ytmusicapi. ``channelId`` in the result is that requested id.
        """
        try:
            if not isinstance(channel_id, str) or not channel_id:
                logger.warning("Artist channel id is required")
                return {}
            if channel_id.startswith("MPLA"):
                channel_id = channel_id.removeprefix("MPLA")
            if not channel_id:
                logger.warning("Artist channel id is required")
                return {}
            if not force_refresh:
                cached = store.read(ARTIST, channel_id)
                if cached is not None:
                    logger.info("Returning cached artist '%s'", cached.get("name", "Unknown"))
                    return cached

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return artist")
                return {}

            logger.info("Fetching artist from API for ID: %s", channel_id)
            ytmusic = self._get_ytmusic()
            artist = ytmusic.get_artist(channel_id)
            if not isinstance(artist, dict):
                return {}

            payload = _normalize_artist(artist, channel_id)
            _fill_missing_song_durations(ytmusic, payload.get("songs"))
            store.write(ARTIST, channel_id, payload)
            logger.info("Artist '%s' fetched successfully", payload.get("name", "Unknown"))
            logger.info("Artist cached: %s", channel_id)
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            if force_refresh:
                raise
            return {}
        except Exception as e:
            logger.exception("Failed to fetch artist: %s", e)
            if force_refresh:
                raise
            return {}

    @api.read(returns="ArtistRelease[]")
    def get_artist_albums(self, channel_id: str, params: str) -> list[dict[str, Any]]:
        """Fetch the rest of an artist release shelf.

        ``channel_id`` and ``params`` are the shelf browse id and params from
        :meth:`get_artist`, not the subscribe channel id. The list is not cached.
        """
        try:
            if not isinstance(channel_id, str) or not channel_id or not isinstance(params, str) or not params:
                logger.warning("Artist albums require a shelf browse id and params")
                return []
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return artist albums")
                return []

            logger.info("Fetching artist albums for %s", channel_id)
            albums = self._get_ytmusic().get_artist_albums(channel_id, params, limit=None)
            if not isinstance(albums, list):
                return []

            items: list[dict[str, Any]] = []
            for album in albums:
                item = _release_item(album, "Album")
                if item is not None:
                    items.append(item)
            _inline_items(items)
            logger.info("Artist albums fetched (count: %d)", len(items))
            return items
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch artist albums: %s", e)
            return []

    @api.read(returns="WatchPlaylist", params={"radio": "boolean", "shuffle": "boolean"})
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
            # radio=True alone still returns the library playlist in order.
            # RDAMPL is the playlist mix.
            if radio and playlist_id and not video_id:
                playlist_id = _radio_playlist_id(playlist_id)
            # Playing a library playlist (not one of YouTube's mixes) scores it
            # for the add-to-playlist recommendations.
            if playlist_id and not playlist_id.startswith(("RD", "LM")):
                _record_playlist_stat(playlist_id, "play")

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

    @api.read(returns="WatchTunerChip[]", cache="tuner")
    def get_queue_tuner(self, video_id: str) -> list[dict[str, str]]:
        """Genre chips that retune the mix around one song.

        Returns an empty list when YouTube Music shows no tuner for this song
        (playlists and albums have none). ``playlistId`` is safe to pass back to
        :meth:`get_watch_playlist` to load the chosen genre. Non-empty results
        are cached per video id, so a song mix is one request, not one per play.
        """
        if not isinstance(video_id, str) or not video_id.strip():
            return []
        vid = video_id.strip()
        cached = store.read(TUNER, vid)
        if isinstance(cached, dict) and isinstance(cached.get("chips"), list):
            return cached["chips"]
        try:
            ytmusic = self._get_ytmusic()
        except FileNotFoundError:
            return []
        try:
            chips = _queue_tuner_chips(ytmusic, vid)
        except Exception as e:
            logger.exception("Failed to fetch queue tuner: %s", e)
            return []
        if chips:
            store.write(TUNER, vid, {"chips": chips})
        return chips

    @api.read(returns="RelatedSection[]", cache="related")
    def get_song_related(self, related_id: str) -> list[dict[str, Any]]:
        """YouTube Music's Related tab for the song that started the queue.

        ``related_id`` is the ``related`` browse id that already comes back on
        the watch playlist response the queue is built from, so obtaining the id
        costs no extra lookup. The answer is YouTube's sections in its own
        order, each a title with the rows under it: a song plays, an album,
        playlist or artist opens its own page, and an about-the-artist block is
        one text row.

        Returns:
            The sections, or an empty list when YouTube Music shows none for
            this song. Raises when the read fails and nothing is cached.
        """
        ident = related_id.strip() if isinstance(related_id, str) else ""
        if not ident:
            return []
        try:
            cached = store.read(RELATED, ident)
            if cached is not None and isinstance(cached.get("sections"), list):
                logger.info("Returning cached related songs (%s)", ident)
                return cached["sections"]

            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return related songs")
                return []

            logger.info("Fetching related songs for %s...", ident)
            sections = _song_related_sections(self._get_ytmusic(), ident)
            # An answer of no sections is an answer, and a stable one, so it is
            # cached; a failed read is raised below and left uncached.
            store.write(RELATED, ident, {"sections": sections})
            logger.info("Related songs fetched (%s: %d sections)", ident, len(sections))
            return sections
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            raise
        except Exception as e:
            logger.exception("Failed to fetch related songs: %s", e)
            raise

    @api.read(returns="Lyrics", cache="lyrics")
    def get_lyrics(self, video_id: str) -> dict[str, Any]:
        """Lyrics for a song, with per-line timings when YouTube Music has them.

        Takes the playing song's video id. ytmusicapi reads lyrics from a
        ``MPLYt...`` browse id instead, so the id is resolved from the watch
        playlist first. The timed read is mobile-only and can come back with no
        text at all, so an empty one falls back to the plain read. The answer is
        cached per video id, including a song that has no lyrics.

        Returns:
            ``{"lyrics", "source", "hasTimestamps", "lines"}``. ``lyrics`` is
            ``None`` when the song has none; ``lines`` is empty unless the
            lyrics came back timed.
        """
        if not isinstance(video_id, str) or not video_id.strip():
            raise ValueError("video id is required")
        ident = video_id.strip()
        cached = store.read(LYRICS, ident)
        if isinstance(cached, dict):
            return cached

        try:
            ytmusic = self._get_ytmusic()
        except FileNotFoundError:
            logger.warning("Not authenticated - cannot return lyrics")
            return {"lyrics": None, "source": None, "hasTimestamps": False, "lines": []}

        browse_id = ident if ident.startswith("MPLYt") else _lyrics_browse_id(ytmusic, ident)
        # A lookup that failed (network, throttling) is not an answer, so only a
        # response YouTube Music actually gave is cached as "no lyrics".
        payload: dict[str, Any] = {"lyrics": None, "source": None, "hasTimestamps": False, "lines": []}
        if browse_id:
            try:
                result = ytmusic.get_lyrics(browse_id)
            except YTMusicUserError:
                result = None
            payload = _normalize_lyrics(result)
            # Timings come from the signed-out client, and only once there are
            # words to time.
            if payload["lyrics"]:
                timed = _timed_lyrics(browse_id)
                if timed:
                    payload["hasTimestamps"] = True
                    payload["lines"] = timed["lines"]
                    payload["source"] = payload["source"] or timed["source"]

        store.write(LYRICS, ident, payload)
        logger.info(
            "Lyrics for %s: %s",
            ident,
            "timed" if payload["hasTimestamps"] else "text" if payload["lyrics"] else "none",
        )
        return payload

    @api.read(returns="TranslatedLyrics", cache="lyrics_translated")
    def translate_lyrics(self, video_id: str, language: str = "en") -> dict[str, Any]:
        """Lyrics for a song in another language, split like the original.

        Takes the playing song's video id and a target language code, English by
        default. Reads the original from the lyrics cache and translates it
        through Google's public endpoint, which needs no key and no client
        library. Timed lyrics keep their lines, so the panel goes on
        highlighting the playing line; a song already in the target language
        comes back with ``translated`` false rather than a copy of itself.

        Returns:
            ``{"language", "translated", "lyrics", "source", "hasTimestamps",
            "lines"}``. ``language`` is the detected source language.
        """
        if not isinstance(video_id, str) or not video_id.strip():
            raise ValueError("video id is required")
        ident = video_id.strip()
        if not isinstance(language, str) or not re.fullmatch(r"[a-zA-Z]{2}(-[a-zA-Z]{2,4})?", language.strip()):
            language = "en"
        language = language.strip()
        cached = store.read(LYRICS_TRANSLATED, f"{ident}:{language}")
        if isinstance(cached, dict):
            return cached

        original = self.get_lyrics(ident)
        payload: dict[str, Any] = {
            "language": None,
            "translated": False,
            "lyrics": None,
            "source": None,
            "hasTimestamps": False,
            "lines": [],
        }
        original_lines = [line for line in original.get("lines", []) if isinstance(line, dict)]
        text = original.get("lyrics")
        lines = (
            [line.get("text", "") for line in original_lines]
            if original_lines
            else (text.split("\n") if isinstance(text, str) and text.strip() else [])
        )
        if lines:
            result = _translate_lyric_lines(lines, language)
            if result is not None:
                translated, detected = result
                payload["language"] = detected
                payload["translated"] = detected != language
                if payload["translated"]:
                    payload["lyrics"] = "\n".join(translated).strip() or None
                    payload["source"] = original.get("source")
                    # The timings are the original's, and they only fit the
                    # translation when it carries the same lines back.
                    if original_lines and len(translated) == len(original_lines):
                        payload["hasTimestamps"] = True
                        payload["lines"] = [
                            {**line, "text": line_text}
                            for line, line_text in zip(original_lines, translated)
                        ]

        # A request that failed is not an answer, so it is left uncached and the
        # next press can try again. A song already in the target language is an
        # answer, and one that will not change.
        if payload["translated"] or payload["language"]:
            store.write(LYRICS_TRANSLATED, f"{ident}:{language}", payload)
        logger.info("Lyrics translation for %s: %s -> %s", ident, payload["language"], language)
        return payload

    @api.read(returns="AudioStream")
    def get_audio_stream(self, video_id: str, refresh: bool = False) -> dict[str, Any]:
        """Direct audio URL for a song on the signed-in account.

        The highest bitrate is used. A Premium account receives YouTube
        Music's high-quality stream, about 256 kbps, when that file is offered.
        """
        if not isinstance(video_id, str) or not video_id.strip():
            raise ValueError("video id is required")
        try:
            ytmusic = self._get_ytmusic()
        except FileNotFoundError as exc:
            raise RuntimeError("Sign in to play music.") from exc
        return audio_stream(ytmusic, video_id.strip(), refresh=bool(refresh))

    @api.read(returns="{ likeStatus: LikeStatus; year: string | null }")
    def get_song_info(self, video_id: str) -> dict[str, Any]:
        """Return the signed-in user's like status and the release year of a song.

        Both come from the one ``next`` request the player already makes when a
        song starts, so the year costs nothing extra.

        Args:
            video_id: YouTube video id of the song.

        Returns:
            A dict with likeStatus set to LIKE, DISLIKE, or INDIFFERENT, and
            year set to the year YouTube Music shows, or None when the song has
            none to show.
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
            # Music videos and other non-song videos do not expose a like status
            # in the next response. Report indifferent instead of failing.
            logger.debug("No like status returned for %s", video_id)
            status = "INDIFFERENT"
        return {"likeStatus": status, "year": _year_in_payload(response, video_id)}

    @api.write(returns="{ likeStatus: LikeStatus }", params={"rating": "LikeStatus"})
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

    @api.write(returns="{ added: boolean }")
    def add_song_to_history(self, video_id: str) -> dict[str, bool]:
        """Register one played song in the account history.

        Uses the playback URL from ``get_song`` on the same client. Music
        videos and other non-song videos are not added.

        Args:
            video_id: YouTube video id of the track that started playing.

        Returns:
            A dict with added set when YouTube Music accepted the song.
        """
        if not video_id:
            return {"added": False}
        if not self._is_authenticated():
            logger.warning("Not authenticated - cannot add song to history")
            return {"added": False}

        try:
            ytmusic = self._get_ytmusic()
            song = ytmusic.get_song(video_id)
            details = song.get("videoDetails") if isinstance(song, dict) else None
            video_type = details.get("musicVideoType") if isinstance(details, dict) else None
            if video_type != _SONG_VIDEO_TYPE:
                logger.info("Skipped history for %s (%s)", video_id, video_type)
                return {"added": False}
            response = ytmusic.add_history_item(song)
            added = getattr(response, "status_code", None) == 204
            if added:
                logger.info("Added %s to history", video_id)
            else:
                logger.warning(
                    "History update for %s returned %s",
                    video_id,
                    getattr(response, "status_code", None),
                )
            return {"added": added}
        except Exception as e:
            logger.exception("Failed to add %s to history: %s", video_id, e)
            return {"added": False}

    @api.write(returns="void")
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

    @api.read(returns="{ signedIn: boolean }")
    def is_signed_in(self) -> dict[str, bool]:
        """Return whether saved YouTube Music headers are on disk."""
        return {"signedIn": _BROWSER_JSON_PATH.is_file()}

    @api.write(returns="void")
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
            store.clear()
            logger.info("Signed out and cleared %d cached items", cleared)
        except Exception as exc:
            logger.exception("Sign-out failed")
            raise exc
        finally:
            _auth_lock.release()

    @api.write(returns="{ status: string }")
    def move_playlist_item(self, playlist_id: str, set_video_id: str, before_set_video_id: str = "") -> dict[str, str]:
        """Move one playlist row with YouTube Music's edit_playlist action.

        ``before_set_video_id`` is the row that should end up after the moved
        one. An empty string moves the row to the end.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(set_video_id, str) or not set_video_id:
            raise ValueError("setVideoId is required")
        before = before_set_video_id if isinstance(before_set_video_id, str) and before_set_video_id else None
        ytmusic = self._get_ytmusic()
        move_item: str | tuple[str, str] = (set_video_id, before) if before else set_video_id
        status = ytmusic.edit_playlist(playlist_id, moveItem=move_item)
        text = status if isinstance(status, str) else str(status.get("status", "")) if isinstance(status, dict) else str(status)
        if "SUCCEEDED" not in text:
            raise RuntimeError(text or "Could not reorder the playlist")
        self._reorder_cached_playlist(playlist_id, set_video_id, before)
        return {"status": text}

    def _reorder_cached_playlist(self, playlist_id: str, set_video_id: str, before: str | None) -> None:
        cached = store.read_raw(PLAYLIST, playlist_id)
        if not isinstance(cached, dict):
            return
        tracks = cached.get("tracks")
        if not isinstance(tracks, list):
            return
        from_index = next(
            (index for index, track in enumerate(tracks) if isinstance(track, dict) and track.get("setVideoId") == set_video_id),
            -1,
        )
        if from_index < 0:
            return
        item = tracks.pop(from_index)
        if before:
            to_index = next(
                (index for index, track in enumerate(tracks) if isinstance(track, dict) and track.get("setVideoId") == before),
                len(tracks),
            )
        else:
            to_index = len(tracks)
        tracks.insert(to_index, item)
        cached["tracks"] = tracks
        store.write(PLAYLIST, playlist_id, cached)

    @api.write(returns="{ status: string; /** New setVideoId per added video, for position-restoring undo. */ setVideoIds: Record<string, string>; /** True when YouTube rejected the edit because the songs were already there. */ duplicate?: boolean; }")
    def add_playlist_items(
        self,
        playlist_id: str,
        video_ids: list[str],
        duplicates: bool = False,
    ) -> dict[str, Any]:
        """Add songs to one of the user's playlists.

        Adding changes the cached track list, so the entry is dropped and the
        next read fetches the playlist again.

        Returns the ``setVideoId`` YouTube Music assigned to each added video,
        so "Undo" on a later removal can move the row back to its position.

        By default YouTube Music rejects an edit whose songs are already in the
        playlist. That rejection is not a failure: it comes back as
        ``duplicate`` so the picker can confirm the songs are already there
        instead of showing an error. Pass ``duplicates=True`` to add the songs
        again anyway, which the picker offers after that confirmation.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(video_ids, list):
            raise ValueError("video ids are required")
        ids = [video_id for video_id in video_ids if isinstance(video_id, str) and video_id]
        if not ids:
            raise ValueError("at least one video id is required")
        ytmusic = self._get_ytmusic()
        result = ytmusic.add_playlist_items(playlist_id, videoIds=ids, duplicates=bool(duplicates))
        try:
            status = _edit_status(result, "Could not add to the playlist")
        except RuntimeError:
            if not duplicates and self._playlist_contains(playlist_id, ids):
                logger.info("Playlist %s already has %s", playlist_id, ids)
                return {"status": "DUPLICATE", "setVideoIds": {}, "duplicate": True}
            raise
        store.drop(PLAYLIST, playlist_id)
        _forget_playlist_list()
        _record_playlist_stat(playlist_id, "add")
        results: dict[str, str] = {}
        if isinstance(result, dict):
            for entry in result.get("playlistEditResults") or []:
                if not isinstance(entry, dict):
                    continue
                video_id = entry.get("videoId")
                set_video_id = entry.get("setVideoId")
                if isinstance(video_id, str) and isinstance(set_video_id, str):
                    results[video_id] = set_video_id
        return {"status": status, "setVideoIds": results, "duplicate": False}

    def _playlist_contains(self, playlist_id: str, video_ids: list[str]) -> bool:
        """Whether every id already sits in the playlist.

        The cached track list answers for free when it can; otherwise the
        playlist is fetched fresh rather than trusting a stale miss.
        """
        cached = store.read_raw(PLAYLIST, playlist_id)
        if _playlist_contains_videos(cached, video_ids) is True:
            return True
        try:
            # The cache can hold only the pages that loaded, so a miss there is
            # not an answer; read the whole list before deciding.
            fresh = {"tracks": _fetch_all_playlist_tracks(self._get_ytmusic(), playlist_id)}
        except Exception:
            logger.warning("Could not check whether %s is in %s", video_ids, playlist_id, exc_info=True)
            return False
        return _playlist_contains_videos(fresh, video_ids) is True

    @api.write(returns="{ status: string }", params={"items": "PlaylistItemRef[]"})
    def remove_playlist_items(self, playlist_id: str, items: list[dict[str, str]]) -> dict[str, str]:
        """Remove rows from one of the user's playlists.

        Args:
            playlist_id: The playlist to edit.
            items: Rows to remove, each with ``videoId`` and ``setVideoId``
                (both come from get_playlist_items on owned playlists).
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(items, list):
            raise ValueError("playlist items are required")
        rows = [
            {"videoId": item["videoId"], "setVideoId": item["setVideoId"]}
            for item in items
            if isinstance(item, dict)
            and isinstance(item.get("videoId"), str)
            and isinstance(item.get("setVideoId"), str)
        ]
        if not rows:
            raise ValueError("each item needs videoId and setVideoId")
        ytmusic = self._get_ytmusic()
        result = ytmusic.remove_playlist_items(playlist_id, rows)
        status = _edit_status(result, "Could not remove from the playlist")
        store.drop(PLAYLIST, playlist_id)
        _forget_playlist_list()
        return {"status": status}

    @api.write(returns="{ status: string; removed: number }")
    def remove_playlist_videos(
        self,
        playlist_id: str,
        video_ids: list[str],
        set_video_ids: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Remove one row per video id, for the picker's add/remove toggle.

        ``set_video_ids`` are the ids YouTube Music returned when this session
        added the songs; any the caller does not know are looked up in the
        playlist first. Removing one row per id keeps the toggle from wiping
        out duplicate copies the user meant to keep.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(video_ids, list):
            raise ValueError("video ids are required")
        ids = [video_id for video_id in video_ids if isinstance(video_id, str) and video_id]
        if not ids:
            raise ValueError("at least one video id is required")
        known = {
            video_id: set_video_id
            for video_id, set_video_id in (set_video_ids or {}).items()
            if isinstance(video_id, str) and isinstance(set_video_id, str) and set_video_id
        }
        missing = [video_id for video_id in ids if video_id not in known]
        if missing:
            # The cache can hold only the pages that loaded, so read the whole
            # playlist rather than miss a row that sits on a later page.
            try:
                tracks = _fetch_all_playlist_tracks(self._get_ytmusic(), playlist_id)
            except Exception:
                tracks = []
            for video_id in missing:
                matches = [
                    track.get("setVideoId")
                    for track in tracks
                    if isinstance(track, dict)
                    and track.get("videoId") == video_id
                    and isinstance(track.get("setVideoId"), str)
                ]
                if matches:
                    # The last copy is the most recently added one.
                    known[video_id] = matches[-1]
        items = [{"videoId": video_id, "setVideoId": known[video_id]} for video_id in ids if video_id in known]
        if not items:
            raise ValueError("That song is not in the playlist")
        result = self.remove_playlist_items(playlist_id, items)
        return {"status": result.get("status", "SUCCEEDED"), "removed": len(items)}

    @api.write(returns="{ status: string }", params={"patch": "PlaylistPatch | null"})
    def edit_playlist(self, playlist_id: str, patch: dict[str, Any] | None = None) -> dict[str, str]:
        """Apply any mix of title, description and privacy changes at once.

        The frontend sends one ``patch`` object with the fields to change;
        pywebview passes arguments positionally, so separate ``title`` /
        ``description`` / ``privacy`` parameters would be fed the whole dict
        (and store its repr as the playlist name).

        Fields left out of the patch are untouched.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if patch is None:
            patch = {}
        if not isinstance(patch, dict):
            raise ValueError("patch must be an object with title, description or privacy")
        title = patch.get("title")
        description = patch.get("description")
        privacy = patch.get("privacy")
        if title is not None:
            if not isinstance(title, str) or not title.strip():
                raise ValueError("title cannot be empty")
            title = title.strip()
        if description is not None and not isinstance(description, str):
            raise ValueError("description must be text")
        privacy_value: str | None = None
        if privacy is not None:
            privacy_value = privacy.upper() if isinstance(privacy, str) else ""
            if privacy_value not in _PRIVACY_STATUSES:
                raise ValueError("privacy must be PUBLIC, PRIVATE or UNLISTED")
        if title is None and description is None and privacy_value is None:
            raise ValueError("at least one of title, description or privacy is required")
        return self._edit_playlist(
            playlist_id,
            title=title,
            description=description,
            privacy=privacy_value,
        )

    def _edit_playlist(
        self,
        playlist_id: str,
        *,
        title: str | None = None,
        description: str | None = None,
        privacy: str | None = None,
    ) -> dict[str, str]:
        """Run one ``edit_playlist`` action for title, description or privacy."""
        ytmusic = self._get_ytmusic()
        result = ytmusic.edit_playlist(playlist_id, title=title, description=description, privacyStatus=privacy)
        status = _edit_status(result, "Could not update the playlist")
        store.drop(PLAYLIST, playlist_id)
        _forget_playlist_list()
        return {"status": status}

    @api.write(returns="{ status: string }")
    def delete_playlist(self, playlist_id: str) -> dict[str, str]:
        """Delete one of the user's playlists and forget its usage score."""
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        ytmusic = self._get_ytmusic()
        status = _delete_status(ytmusic.delete_playlist(playlist_id))
        _forget_playlist_stat(playlist_id)
        _forget_playlist_list()
        return {"status": status}

    @api.write(returns="{ playlistId: string }", params={"description": "string", "privacy": "PlaylistPrivacy", "videoIds": "string[]"})
    def create_playlist(
        self,
        title: str,
        description: str = "",
        privacy: str = "PRIVATE",
        video_ids: list[str] | None = None,
    ) -> dict[str, str]:
        """Create a new playlist holding up to the given songs.

        Returns its ``playlistId`` so the sidebar can jump straight to it.
        """
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title is required")
        if isinstance(privacy, str):
            privacy_value = privacy.upper()
        else:
            privacy_value = "PRIVATE"
        if privacy_value not in _PRIVACY_STATUSES:
            raise ValueError("privacy must be PUBLIC, PRIVATE or UNLISTED")
        description = description.strip() if isinstance(description, str) else ""
        ids = [video_id for video_id in (video_ids or []) if isinstance(video_id, str) and video_id]
        ytmusic = self._get_ytmusic()
        playlist_id = ytmusic.create_playlist(
            title.strip(),
            description,
            privacy_status=privacy_value,
            video_ids=ids or None,
        )
        if not isinstance(playlist_id, str) or not playlist_id:
            raise RuntimeError("Could not create the playlist")
        if not ids:
            # Only an empty playlist can be described without reading it back.
            _cache_created_playlist(playlist_id, title.strip(), description, privacy_value)
        _forget_playlist_list()
        logger.info("Created playlist %s (%d songs)", playlist_id, len(ids))
        return {"playlistId": playlist_id}

    @api.write(returns="{ status: string }", params={"rating": "LikeStatus"})
    def rate_playlist(self, playlist_id: str, rating: str) -> dict[str, str]:
        """Like, remove from library, or dislike a playlist.

        Like adds the playlist to the account library, the way the heart on
        YouTube Music's playlist page does.
        """
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if rating not in _LIKE_STATUSES:
            raise ValueError(f"Invalid rating: {rating}")
        self._get_ytmusic().rate_playlist(playlist_id, rating)
        _forget_playlist_list()
        logger.info("Rated playlist %s as %s", playlist_id, rating)
        return {"status": "OK"}

    @api.read(returns="{ playlistIds: string[] }")
    def get_recommended_playlists(self, limit: int = 4) -> dict[str, Any]:
        """Playlist ids for the add-to-playlist flyout's recommended row, best first.

        Scores the user's own playlists by recent add-to events (weighted
        highest), then recent plays, both with exponential time decay, so the
        row reacts to what they reached for lately. The frontend maps the ids
        onto the playlist list it already shows.
        """
        try:
            limit = max(0, min(int(limit), 8))
        except (TypeError, ValueError):
            limit = 4
        if limit == 0:
            return {"playlistIds": []}
        playlists = self.get_playlists().get("playlists", [])
        candidates = [
            playlist
            for playlist in playlists
            if playlist.get("owned") is not False and playlist.get("playlistId") not in (None, "", "LM")
        ]
        if not candidates:
            return {"playlistIds": []}
        stats = _load_playlist_stats()
        scored = sorted(
            ((_playlist_stat_score(stats, playlist.get("playlistId", "")), playlist.get("playlistId", "")) for playlist in candidates),
            key=lambda entry: entry[0],
            reverse=True,
        )
        ranked = [playlist_id for score, playlist_id in scored if score > 0]
        # Nothing recorded yet: the recently touched library playlists keep the
        # row useful while the user's habits fill in.
        if not ranked:
            ranked = [playlist.get("playlistId", "") for playlist in candidates]
        return {"playlistIds": [playlist_id for playlist_id in ranked[:limit] if playlist_id]}

    @api.read(returns="{ invalidated: string[]; not_found: string[] }")
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
            if store.drop(PLAYLIST, playlist_id):
                invalidated.append(playlist_id)
                logger.info("Cache invalidated for playlist: %s", playlist_id)
            else:
                not_found.append(playlist_id)
                logger.info("Playlist not in cache: %s", playlist_id)
        
        return {"invalidated": invalidated, "not_found": not_found}

    @api.read(returns="{ cleared: number }")
    def clear_all_cache(self) -> dict[str, Any]:
        """Clear all cached data.
        
        Returns:
            A dict with 'cleared' count of items removed.
        """
        count = len(cache)
        store.clear()
        logger.info("All cache cleared (%d items)", count)
        return {"cleared": count}
