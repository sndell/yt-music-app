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
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from PIL import Image

import diskcache
import ytmusicapi
from ytmusicapi.helpers import initialize_headers, sapisid_from_cookie

from util.app_paths import data_dir, is_frozen
from util.audio_stream import audio_stream
from util.get_dominant_color import get_dominant_color_hex

logger = logging.getLogger(__name__)

_BROWSER_JSON_PATH = data_dir() / "browser.json"
_CACHE_DIR = data_dir() / ("cache" if is_frozen() else ".cache")

# Initialize persistent disk cache
cache = diskcache.Cache(str(_CACHE_DIR))

# Cached home, playlist, album, and artist payloads. Callers show this copy
# immediately and fetch again with force_refresh once a newer copy is ready.
CACHE_DURATION = 7 * 24 * 60 * 60  # 7 days

# Cache key prefixes
CACHE_KEY_PLAYLIST_PREFIX = "playlist:v3:"
CACHE_KEY_ALBUM_PREFIX = "album:"
CACHE_KEY_ARTIST_PREFIX = "artist:"
CACHE_KEY_HOME = "home:shelves:v3"
CACHE_KEY_THUMB_PREFIX = "thumb:v2:"
THUMB_CACHE_SECONDS = 60 * 60 * 24
# Genre tuner chips for a song's automix. Stable for hours, so cache the
# network call; empty results are not cached so a transient miss can retry.
CACHE_KEY_TUNER_PREFIX = "tuner:v1:"
TUNER_CACHE_SECONDS = 60 * 60 * 12
# Covers are inlined inline with a request. Past this many items the request is
# left with remote URLs and the frontend inlines failures on demand.
MAX_INLINE_ITEMS = 150

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


def _cached_hit(key: str) -> dict[str, Any] | None:
    """Return a shallow copy of a cached payload marked for a background refresh."""
    cached = cache.get(key)
    if not isinstance(cached, dict):
        return None
    payload = dict(cached)
    payload["fromCache"] = True
    return payload


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
                cache.set(key, playlist, expire=CACHE_DURATION)
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


def _walk_playlist_item_data(response: Any):
    """Yield every ``playlistItemData`` in a browse response, in page order.

    Each playlist item carries its add time here. The dict sits under
    ``musicResponsiveListItemRenderer``, but that wrapper moves between app
    versions, so walk the whole response rather than hard-code the path.
    """
    if isinstance(response, dict):
        data = response.get("playlistItemData")
        if isinstance(data, dict):
            yield data
        for value in response.values():
            yield from _walk_playlist_item_data(value)
    elif isinstance(response, list):
        for value in response:
            yield from _walk_playlist_item_data(value)


# Sinks the recorder writes into, one per thread and stack-shaped. A list at
# the top means "a playlist fetch is running on this thread, collect its items".
_date_sinks = threading.local()


def _date_sink() -> list[dict[str, Any]] | None:
    stack = getattr(_date_sinks, "stack", None)
    return stack[-1] if stack else None


def _install_date_recorder(ytmusic: Any) -> None:
    """Route this client's browse responses through the add-time recorder.

    Installed once per client. The wrapper only forwards and writes to the
    calling thread's sink, so a fetch cannot leave the client patched or
    unpatched for another, and overlapping fetches keep their own items.
    """
    if getattr(ytmusic, "_date_recorder", None) is not None:
        return
    original = ytmusic._send_request

    def send(endpoint: str, body: Any, additional_params: Any = "") -> Any:
        response = original(endpoint, body, additional_params)
        sink = _date_sink()
        if sink is not None:
            sink.extend(_walk_playlist_item_data(response))
        return response

    ytmusic._send_request = send
    ytmusic._date_recorder = send


class _PlaylistDateCapture:
    """Collects each item's add time while a single playlist is fetched.

    The playlist browse response carries ``playlistItemData.voteSortValue``,
    the Unix second a track was added, which is the value YouTube Music's own
    "Date added" sort orders by. ytmusicapi parses that same response but drops
    the field, so recording it while ``get_playlist`` runs keeps the timestamps
    without a second request.
    """

    def __init__(self, ytmusic: Any) -> None:
        _install_date_recorder(ytmusic)
        self.items: list[dict[str, Any]] = []

    def __enter__(self) -> "_PlaylistDateCapture":
        stack = getattr(_date_sinks, "stack", None)
        if stack is None:
            stack = _date_sinks.stack = []
        stack.append(self.items)
        return self

    def __exit__(self, *_exc: Any) -> None:
        stack = getattr(_date_sinks, "stack", None)
        if stack:
            stack.pop()


def _apply_added_dates(tracks: Any, items: list[dict[str, Any]]) -> int:
    """Stamp ``addedAt`` (Unix seconds) onto parsed playlist tracks.

    Owned playlists keep a ``setVideoId`` per track, which matches the raw item
    exactly. Playlists owned by anyone else come back without one, so those
    tracks take the remaining raw items in the order both lists share. Returns
    how many tracks got an add time.
    """
    if not isinstance(tracks, list):
        return 0

    by_set_video: dict[str, int] = {}
    by_video: dict[str, list[int]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get("voteSortValue")
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            continue
        set_video_id = item.get("playlistSetVideoId")
        if isinstance(set_video_id, str) and set_video_id:
            by_set_video[set_video_id] = value
        video_id = item.get("videoId")
        if isinstance(video_id, str) and video_id:
            by_video.setdefault(video_id, []).append(value)

    stamped = 0
    for track in tracks:
        if not isinstance(track, dict):
            continue
        set_video_id = track.get("setVideoId")
        value = by_set_video.get(set_video_id) if isinstance(set_video_id, str) and set_video_id else None
        if value is None:
            queue = by_video.get(track.get("videoId"))
            if queue:
                value = queue.pop(0)
        if value is not None:
            track["addedAt"] = value
            stamped += 1
    return stamped


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


def _load_playlist_stats() -> dict[str, dict[str, list[float]]]:
    try:
        with _PLAYLIST_STATS_PATH.open(encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return {kind: {} for kind in _PLAYLIST_STAT_KINDS}
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Playlist stats unreadable, starting fresh: %s", e)
        return {kind: {} for kind in _PLAYLIST_STAT_KINDS}
    if not isinstance(raw, dict):
        return {kind: {} for kind in _PLAYLIST_STAT_KINDS}
    stats: dict[str, dict[str, list[float]]] = {}
    for kind in _PLAYLIST_STAT_KINDS:
        entries = raw.get(kind)
        if not isinstance(entries, dict):
            entries = {}
        stats[kind] = {}
        for playlist_id, events in entries.items():
            if not isinstance(playlist_id, str) or not isinstance(events, list):
                continue
            timestamps = [float(ts) for ts in events if isinstance(ts, (int, float)) and ts > 0]
            if timestamps:
                stats[kind][playlist_id] = timestamps
    return stats


def _save_playlist_stats(stats: dict[str, dict[str, list[float]]]) -> None:
    tmp_path = _PLAYLIST_STATS_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(stats), encoding="utf-8")
    tmp_path.replace(_PLAYLIST_STATS_PATH)


def _record_playlist_stat(playlist_id: str, kind: str) -> None:
    """Append one usage event for a playlist. Best effort; never fails the caller."""
    if not playlist_id or kind not in _PLAYLIST_STAT_KINDS:
        return
    try:
        with _PLAYLIST_STATS_LOCK:
            stats = _load_playlist_stats()
            events = stats.setdefault(kind, {}).setdefault(playlist_id, [])
            events.append(time.time())
            stats[kind][playlist_id] = events[-_PLAYLIST_STAT_MAX_EVENTS:]
            if len(stats[kind]) > 500:
                cutoff = time.time() - 60 * 60 * 24 * 30
                stats[kind] = {
                    pid: kept for pid, kept in stats[kind].items() if kept and kept[-1] >= cutoff
                }
            _save_playlist_stats(stats)
    except Exception as e:
        logger.warning("Could not record playlist stat: %s", e)


def _forget_playlist_stat(playlist_id: str) -> None:
    try:
        with _PLAYLIST_STATS_LOCK:
            stats = _load_playlist_stats()
            changed = False
            for kind in _PLAYLIST_STAT_KINDS:
                if playlist_id in stats.get(kind, {}):
                    stats[kind].pop(playlist_id, None)
                    changed = True
            if changed:
                _save_playlist_stats(stats)
    except Exception as e:
        logger.warning("Could not forget playlist stat: %s", e)


def _playlist_stat_score(stats: dict[str, dict[str, list[float]]], playlist_id: str) -> float:
    """Blend recent adds (dominant) and plays with exponential time decay."""
    now = time.time()
    decay = 86400.0 * _PLAYLIST_STAT_HALF_LIFE_DAYS
    score = 0.0
    for kind, weight in _PLAYLIST_STAT_WEIGHTS.items():
        for ts in stats.get(kind, {}).get(playlist_id, []):
            score += weight * 2 ** (-(now - ts) / decay)
    return score


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
        # A cover that cannot be fetched keeps its remote URL. This is expected
        # for expired links and on a throttled network, so keep it out of the log.
        logger.debug("Could not inline cover %s: %s", url, exc)
        return url


def _inline_thumbnail_field(items: list[dict[str, Any]], key: str) -> None:
    """Replace the first thumbnail with a re-encoded cover the webview can decode.

    The largest file is tried first. If it is too big or cannot be re-encoded,
    the next smaller one is used. A failed attempt does not overwrite a URL.

    A list longer than ``MAX_INLINE_ITEMS`` is skipped. Fetching and re-encoding
    hundreds of covers inline stalls the request for minutes on a slow or
    throttled network. Those covers stay as remote URLs, and the frontend calls
    ``inline_thumbnail`` for the ones the webview cannot decode.
    """
    if len(items) > MAX_INLINE_ITEMS:
        return

    def apply(item: dict[str, Any]) -> None:
        if not isinstance(item, dict):
            return
        thumbnails = item.get(key)
        if not isinstance(thumbnails, list) or not thumbnails:
            return
        ordered = sorted(
            (thumb for thumb in thumbnails if isinstance(thumb, dict)),
            key=lambda thumb: thumb.get("width") or 0,
            reverse=True,
        )
        target = thumbnails[0] if isinstance(thumbnails[0], dict) else None
        if target is None:
            return
        for thumb in ordered:
            url = thumb.get("url")
            if not isinstance(url, str) or not url:
                continue
            inlined = _inline_thumbnail(url)
            if inlined.startswith("data:"):
                target["url"] = inlined
                return

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(apply, items))


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


def _inline_playlist_thumbnails(playlists: list[dict[str, Any]]) -> None:
    _inline_thumbnail_field(playlists, "thumbnails")


def _empty_quick_picks() -> dict[str, Any]:
    return {"title": "Quick picks", "tracks": []}


def _empty_home() -> dict[str, Any]:
    return {"shelves": []}


def _people(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    people: list[dict[str, str]] = []
    for person in value:
        if not isinstance(person, dict):
            continue
        name = person.get("name")
        if not isinstance(name, str) or not name:
            continue
        person_id = person.get("id")
        people.append({"name": name, "id": person_id if isinstance(person_id, str) else ""})
    return people


def _joined_names(people: Any) -> str:
    return ", ".join(person["name"] for person in _people(people))


def _song_subtitle(item: dict[str, Any]) -> str:
    album = item.get("album")
    album_name = album.get("name") if isinstance(album, dict) and isinstance(album.get("name"), str) else ""
    views = item.get("views") if isinstance(item.get("views"), str) else ""
    parts = [_joined_names(item.get("artists"))]
    if views:
        parts.append(f"{views} plays")
    if album_name:
        parts.append(album_name)
    return " • ".join(part for part in parts if part)


def _playlist_subtitle(item: dict[str, Any]) -> str:
    count = item.get("count")
    count_label = ""
    if isinstance(count, str) and count.strip():
        digits = count.replace(",", "").strip()
        count_label = "1 song" if digits == "1" else f"{count} songs"
    subtitle = " • ".join(part for part in (_joined_names(item.get("author")), count_label) if part)
    if subtitle:
        return subtitle
    description = item.get("description")
    return description if isinstance(description, str) else ""


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return ""


def _as_int(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return 0


def _thumbnails(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    return [dict(thumb) if isinstance(thumb, dict) else thumb for thumb in value]


_cover_color_cache: dict[str, str | None] = {}
_cover_color_lock = threading.Lock()


def _dominant_color(thumbnails: Any) -> str | None:
    if not isinstance(thumbnails, list) or not thumbnails:
        return None
    largest_thumb = max(thumbnails, key=lambda thumb: thumb.get("width", 0) if isinstance(thumb, dict) else 0)
    if not isinstance(largest_thumb, dict):
        return None
    thumbnail_url = largest_thumb.get("url")
    if not thumbnail_url:
        return None
    logger.info("Extracting dominant color from thumbnail...")
    dominant_color = get_dominant_color_hex(thumbnail_url)
    if dominant_color:
        logger.info("Dominant color extracted: %s", dominant_color)
        return dominant_color
    return None


def _inline_items(items: list[dict[str, Any]]) -> None:
    if items:
        _inline_thumbnail_field(items, "thumbnails")


def _album_home_subtitle(item: dict[str, Any], artists: list[dict[str, str]]) -> str:
    album_type = item.get("type") if isinstance(item.get("type"), str) and item["type"] else "Album"
    return " • ".join(part for part in (album_type, _joined_names(artists)) if part)


def _named_album(album: Any, string_id: str) -> dict[str, str] | None:
    if isinstance(album, str):
        return {"name": album, "id": string_id} if album else None
    if isinstance(album, dict):
        name = album.get("name")
        if isinstance(name, str) and name:
            album_id = album.get("id")
            return {"name": name, "id": album_id if isinstance(album_id, str) else ""}
    return None


def _album_track(
    track: Any,
    album_title: str,
    album_browse_id: str,
    album_thumbnails: list[Any],
) -> dict[str, Any] | None:
    if not isinstance(track, dict):
        return None
    video_id = track.get("videoId") if isinstance(track.get("videoId"), str) else ""
    album = _named_album(track.get("album"), album_browse_id)
    if album is None and album_title:
        album = {"name": album_title, "id": album_browse_id}
    like_status = track.get("likeStatus")
    if like_status not in _LIKE_STATUSES:
        like_status = "INDIFFERENT"
    own_thumbnails = track.get("thumbnails")
    if isinstance(own_thumbnails, list) and own_thumbnails:
        thumbnails = _thumbnails(own_thumbnails)
    else:
        thumbnails = _thumbnails(album_thumbnails)
    video_type = track.get("videoType")
    if video_type not in {_SONG_VIDEO_TYPE, "MUSIC_VIDEO_TYPE_OMV"}:
        video_type = _SONG_VIDEO_TYPE
    set_video_id = track.get("setVideoId") if isinstance(track.get("setVideoId"), str) else ""
    return {
        "videoId": video_id,
        "title": track.get("title") if isinstance(track.get("title"), str) else "",
        "artists": _people(track.get("artists")),
        "album": album,
        "likeStatus": like_status,
        "inLibrary": bool(track.get("inLibrary")),
        "thumbnails": thumbnails,
        "isAvailable": bool(track.get("isAvailable")),
        "isExplicit": bool(track.get("isExplicit")),
        "videoType": video_type,
        "views": None,
        "duration": track.get("duration") if isinstance(track.get("duration"), str) else "",
        "durationSeconds": _as_int(track.get("duration_seconds")),
        "setVideoId": set_video_id,
    }


def _artist_track(track: Any, channel_id: str) -> dict[str, Any] | None:
    if not isinstance(track, dict):
        return None
    video_id = track.get("videoId") if isinstance(track.get("videoId"), str) else ""
    artists = _people(track.get("artists"))
    if not artists:
        artist = track.get("artist")
        if isinstance(artist, str) and artist:
            artists = [{"name": artist, "id": channel_id}]
        elif isinstance(artist, dict):
            artists = _people([artist])
            if len(artists) == 1 and not artists[0]["id"]:
                artists[0]["id"] = channel_id
    set_video_id = track.get("setVideoId") if isinstance(track.get("setVideoId"), str) else ""
    return {
        "videoId": video_id,
        "title": track.get("title") if isinstance(track.get("title"), str) else "",
        "artists": artists,
        "album": _named_album(track.get("album"), ""),
        "likeStatus": "INDIFFERENT",
        "inLibrary": bool(track.get("inLibrary")),
        "thumbnails": _thumbnails(track.get("thumbnails")),
        "isAvailable": bool(video_id),
        "isExplicit": bool(track.get("isExplicit")),
        "videoType": _SONG_VIDEO_TYPE,
        "views": None,
        "duration": track.get("duration") if isinstance(track.get("duration"), str) else "",
        "durationSeconds": _as_int(track.get("duration_seconds")),
        "setVideoId": set_video_id,
    }


def _other_version(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    browse_id = item.get("browseId")
    if not isinstance(browse_id, str) or not browse_id:
        return None
    return {
        "title": item.get("title") if isinstance(item.get("title"), str) else "",
        "year": _as_text(item.get("year")),
        "browseId": browse_id,
        "thumbnails": _thumbnails(item.get("thumbnails")),
        "explicit": bool(item.get("isExplicit")),
    }


def _release_item(item: Any, default_type: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    browse_id = item.get("browseId")
    if not isinstance(browse_id, str) or not browse_id.startswith("MPRE"):
        return None
    item_type = item.get("type")
    if not isinstance(item_type, str) or not item_type:
        item_type = default_type
    return {
        "title": item.get("title") if isinstance(item.get("title"), str) else "",
        "year": _as_text(item.get("year")),
        "type": item_type,
        "browseId": browse_id,
        "thumbnails": _thumbnails(item.get("thumbnails")),
        "explicit": bool(item.get("isExplicit")),
    }


def _release_shelf(shelf: Any, default_type: str) -> dict[str, Any] | None:
    if not isinstance(shelf, dict) or not isinstance(shelf.get("results"), list):
        return None
    items: list[dict[str, Any]] = []
    for result in shelf["results"]:
        item = _release_item(result, default_type)
        if item is not None:
            items.append(item)
    return {
        "browseId": _optional_str(shelf.get("browseId")),
        "params": _optional_str(shelf.get("params")),
        "items": items,
    }


def _fill_missing_song_durations(ytmusic: Any, songs: Any) -> bool:
    """Copy durations onto an artist song shelf from its Top songs playlist.

    The artist browse shelf lists title and album only. Duration is on the
    playlist that shelf links to, and the shelf items are that playlist's
    first tracks.
    """
    if not isinstance(songs, dict):
        return False
    items = songs.get("items")
    browse_id = songs.get("browseId")
    if not isinstance(items, list) or not items or not isinstance(browse_id, str) or not browse_id:
        return False
    missing = [
        item
        for item in items
        if isinstance(item, dict) and item.get("videoId") and not item.get("duration")
    ]
    if not missing:
        return False
    try:
        playlist = ytmusic.get_playlist(browse_id, limit=len(items))
    except Exception:
        logger.exception("Failed to fetch top song durations for %s", browse_id)
        return False
    tracks = playlist.get("tracks") if isinstance(playlist, dict) else None
    if not isinstance(tracks, list):
        return False
    by_id: dict[str, tuple[str, int]] = {}
    for track in tracks:
        if not isinstance(track, dict):
            continue
        video_id = track.get("videoId")
        duration = track.get("duration")
        if not isinstance(video_id, str) or not video_id:
            continue
        if not isinstance(duration, str) or not duration.strip():
            continue
        by_id[video_id] = (duration, _as_int(track.get("duration_seconds")))
    filled = 0
    for item in missing:
        found = by_id.get(item["videoId"])
        if not found:
            continue
        item["duration"] = found[0]
        item["durationSeconds"] = found[1]
        filled += 1
    if filled:
        logger.info("Filled durations for %d top songs from %s", filled, browse_id)
    return filled > 0


def _songs_shelf(shelf: Any, channel_id: str) -> dict[str, Any] | None:
    if not isinstance(shelf, dict) or not isinstance(shelf.get("results"), list):
        return None
    items: list[dict[str, Any]] = []
    for result in shelf["results"]:
        track = _artist_track(result, channel_id)
        if track is not None:
            items.append(track)
    return {
        "browseId": _optional_str(shelf.get("browseId")),
        "params": None,
        "items": items,
    }


def _videos_shelf(shelf: Any) -> dict[str, Any] | None:
    if not isinstance(shelf, dict) or not isinstance(shelf.get("results"), list):
        return None
    items: list[dict[str, Any]] = []
    for result in shelf["results"]:
        if not isinstance(result, dict):
            continue
        video_id = result.get("videoId")
        if not isinstance(video_id, str) or not video_id:
            continue
        views = result.get("views")
        items.append(
            {
                "title": result.get("title") if isinstance(result.get("title"), str) else "",
                "videoId": video_id,
                "views": views if isinstance(views, str) else "",
                "thumbnails": _thumbnails(result.get("thumbnails")),
                "playlistId": _optional_str(result.get("playlistId")),
            }
        )
    return {
        "browseId": _optional_str(shelf.get("browseId")),
        "params": None,
        "items": items,
    }


def _related_artists(shelf: Any) -> list[dict[str, Any]]:
    results = shelf.get("results") if isinstance(shelf, dict) else None
    if not isinstance(results, list):
        return []
    items: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        browse_id = result.get("browseId")
        if not isinstance(browse_id, str) or not browse_id.startswith("UC"):
            continue
        subscribers = result.get("subscribers")
        items.append(
            {
                "title": result.get("title") if isinstance(result.get("title"), str) else "",
                "browseId": browse_id,
                "subscribers": subscribers if isinstance(subscribers, str) else "",
                "thumbnails": _thumbnails(result.get("thumbnails")),
            }
        )
    return items


def _normalize_album(raw: dict[str, Any], browse_id: str) -> dict[str, Any]:
    title = raw.get("title") if isinstance(raw.get("title"), str) else ""
    album_type = raw.get("type") if isinstance(raw.get("type"), str) and raw["type"] else "Album"
    description = raw.get("description") if isinstance(raw.get("description"), str) else None
    thumbnails = _thumbnails(raw.get("thumbnails"))
    tracks_raw = raw.get("tracks") if isinstance(raw.get("tracks"), list) else []
    tracks: list[dict[str, Any]] = []
    for track in tracks_raw:
        normalized = _album_track(track, title, browse_id, thumbnails)
        if normalized is not None:
            tracks.append(normalized)
    versions_raw = raw.get("other_versions") if isinstance(raw.get("other_versions"), list) else []
    other_versions: list[dict[str, Any]] = []
    for version in versions_raw:
        normalized = _other_version(version)
        if normalized is not None:
            other_versions.append(normalized)
    duration = raw.get("duration") if isinstance(raw.get("duration"), str) else ""
    payload = {
        "browseId": browse_id,
        "title": title,
        "type": album_type,
        "description": description,
        "artists": _people(raw.get("artists")),
        "year": _as_text(raw.get("year")),
        "trackCount": _as_int(raw.get("trackCount")),
        "duration": duration,
        "durationSeconds": _as_int(raw.get("duration_seconds")),
        "audioPlaylistId": _optional_str(raw.get("audioPlaylistId")),
        "thumbnails": thumbnails,
        "dominantColor": _dominant_color(thumbnails),
        "tracks": tracks,
        "otherVersions": other_versions,
    }
    _inline_items([payload])
    _inline_items(tracks)
    _inline_items(other_versions)
    return payload


def _normalize_artist(raw: dict[str, Any], channel_id: str) -> dict[str, Any]:
    thumbnails = _thumbnails(raw.get("thumbnails"))
    songs = _songs_shelf(raw.get("songs"), channel_id)
    albums = _release_shelf(raw.get("albums"), "Album")
    singles = _release_shelf(raw.get("singles"), "Single")
    shows = _release_shelf(raw.get("shows"), "Show")
    videos = _videos_shelf(raw.get("videos"))
    related = _related_artists(raw.get("related"))
    description = raw.get("description") if isinstance(raw.get("description"), str) else None
    views = raw.get("views") if isinstance(raw.get("views"), str) else ""
    subscribers = raw.get("subscribers") if isinstance(raw.get("subscribers"), str) else ""
    monthly_listeners = raw.get("monthlyListeners") if isinstance(raw.get("monthlyListeners"), str) else ""
    payload = {
        "channelId": channel_id,
        "name": raw.get("name") if isinstance(raw.get("name"), str) else "",
        "description": description,
        "views": views,
        "subscribers": subscribers,
        "monthlyListeners": monthly_listeners,
        "thumbnails": thumbnails,
        "dominantColor": _dominant_color(thumbnails),
        "shuffleId": _optional_str(raw.get("shuffleId")),
        "radioId": _optional_str(raw.get("radioId")),
        "songs": songs,
        "albums": albums,
        "singles": singles,
        "shows": shows,
        "videos": videos,
        "related": related,
    }
    _inline_items([payload])
    for shelf in (songs, albums, singles, shows, videos):
        if shelf is not None:
            _inline_items(shelf["items"])
    _inline_items(related)
    return payload


def _home_layout(title: str) -> str | None:
    key = title.strip().lower()
    if key == "quick picks":
        return "list"
    if key in {"listen again", "forgotten favorites", "forgotten favourites"}:
        return "row"
    return None


def _home_item(item: dict[str, Any]) -> dict[str, Any] | None:
    title = item.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    thumbnails = item.get("thumbnails") if isinstance(item.get("thumbnails"), list) else []
    explicit = bool(item.get("isExplicit"))
    video_id = _optional_str(item.get("videoId"))
    browse_id = _optional_str(item.get("browseId"))
    audio_playlist_id = _optional_str(item.get("audioPlaylistId"))
    playlist_id = _optional_str(item.get("playlistId"))
    if video_id:
        return {
            "kind": "song",
            "title": title,
            "subtitle": _song_subtitle(item),
            "artists": _people(item.get("artists")),
            "thumbnails": thumbnails,
            "videoId": video_id,
            "playlistId": None,
            "browseId": browse_id,
            "explicit": explicit,
        }

    if browse_id and browse_id.startswith("MPRE"):
        artists = _people(item.get("artists"))
        return {
            "kind": "album",
            "title": title,
            "subtitle": _album_home_subtitle(item, artists),
            "artists": artists,
            "thumbnails": thumbnails,
            "videoId": None,
            "playlistId": audio_playlist_id,
            "browseId": browse_id,
            "explicit": explicit,
        }
    if browse_id and browse_id.startswith("UC"):
        subscribers = item.get("subscribers")
        return {
            "kind": "artist",
            "title": title,
            "subtitle": subscribers if isinstance(subscribers, str) else "",
            "artists": _people(item.get("artists")),
            "thumbnails": thumbnails,
            "videoId": None,
            "playlistId": None,
            "browseId": browse_id,
            "explicit": explicit,
        }
    if audio_playlist_id and audio_playlist_id.startswith("OLAK5uy_"):
        artists = _people(item.get("artists"))
        return {
            "kind": "album",
            "title": title,
            "subtitle": _album_home_subtitle(item, artists),
            "artists": artists,
            "thumbnails": thumbnails,
            "videoId": None,
            "playlistId": audio_playlist_id,
            "browseId": None,
            "explicit": explicit,
        }
    if playlist_id:
        return {
            "kind": "playlist",
            "title": title,
            "subtitle": _playlist_subtitle(item),
            "artists": _people(item.get("author")),
            "thumbnails": thumbnails,
            "videoId": None,
            "playlistId": playlist_id,
            "browseId": None,
            "explicit": explicit,
        }
    return None


def _home_shelves(home: list[Any]) -> list[dict[str, Any]]:
    shelves: list[dict[str, Any]] = []
    for row in home:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        if not isinstance(title, str):
            continue
        layout = _home_layout(title)
        if layout is None:
            continue
        contents = row.get("contents")
        if not isinstance(contents, list):
            continue
        items = [_home_item(item) for item in contents if isinstance(item, dict)]
        shelf_items = [item for item in items if item is not None]
        if not shelf_items:
            continue
        _inline_thumbnail_field(shelf_items, "thumbnails")
        shelves.append({"title": title, "layout": layout, "items": shelf_items})
    return shelves


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


def _search_people(item: dict[str, Any]) -> list[dict[str, str]]:
    """Search artists, falling back to the single ``artist`` string some filters use."""
    artists = _people(item.get("artists"))
    if artists:
        return artists
    single = item.get("artist")
    if isinstance(single, str) and single:
        return [{"name": single, "id": ""}]
    return []


def _search_playlist_id(browse_id: str | None) -> str | None:
    """A playlist browse id is ``VL`` prefixed; the app routes on the bare id."""
    if not isinstance(browse_id, str) or not browse_id:
        return None
    return browse_id[2:] if browse_id.startswith("VL") else browse_id


def _search_count_label(item_count: Any) -> str:
    if isinstance(item_count, int):
        return "1 song" if item_count == 1 else f"{item_count} songs"
    if isinstance(item_count, str) and item_count.strip():
        digits = item_count.replace(",", "").strip()
        if digits.isdigit():
            return "1 song" if digits == "1" else f"{item_count} songs"
    return ""


def _search_result(item: Any) -> dict[str, Any] | None:
    """Flatten one ytmusicapi search row into the shared shape the UI renders."""
    if not isinstance(item, dict):
        return None

    raw_type = item.get("resultType")
    kind = _SEARCH_KINDS.get(raw_type if isinstance(raw_type, str) else "", "unknown")
    browse_id = _optional_str(item.get("browseId"))
    video_id = _optional_str(item.get("videoId"))
    if kind == "unknown":
        if video_id:
            kind = "song"
        elif isinstance(browse_id, str) and browse_id.startswith("MPRE"):
            kind = "album"
        elif isinstance(browse_id, str) and browse_id.startswith(("UC", "MPLA")):
            kind = "artist"
        elif isinstance(browse_id, str) and browse_id.startswith(("VL", "PL", "RD", "VM")):
            kind = "playlist"
        else:
            return None

    title = _optional_str(item.get("title"))
    if not title and kind == "artist":
        title = _optional_str(item.get("artist"))
    if not title:
        return None

    artists = _search_people(item)
    album = _named_album(item.get("album"), "")
    year = _optional_str(item.get("year"))
    video_type = item.get("videoType")
    if video_type not in {_SONG_VIDEO_TYPE, "MUSIC_VIDEO_TYPE_OMV"}:
        video_type = "MUSIC_VIDEO_TYPE_OMV" if kind == "video" else _SONG_VIDEO_TYPE

    if kind in {"song", "video"}:
        subtitle = _song_subtitle(item) or _joined_names(artists)
    elif kind == "album":
        album_type = _optional_str(item.get("type")) or "Album"
        subtitle = " • ".join(part for part in (album_type, _joined_names(artists), year) if part)
    elif kind == "artist":
        subtitle = _optional_str(item.get("subscribers")) or ""
    elif kind == "playlist":
        author = item.get("author") if isinstance(item.get("author"), str) else ""
        subtitle = " • ".join(part for part in (author, _search_count_label(item.get("itemCount"))) if part)
    else:
        subtitle = _optional_str(item.get("name")) or ""

    return {
        "kind": kind,
        "title": title,
        "subtitle": subtitle,
        "artists": artists,
        "album": album,
        "thumbnails": _thumbnails(item.get("thumbnails")),
        "videoId": video_id,
        "browseId": browse_id,
        "playlistId": _search_playlist_id(browse_id) if kind == "playlist" else None,
        "duration": item.get("duration") if isinstance(item.get("duration"), str) else "",
        "durationSeconds": _as_int(item.get("duration_seconds")),
        "views": item.get("views") if isinstance(item.get("views"), str) else None,
        "explicit": bool(item.get("isExplicit")),
        "inLibrary": bool(item.get("inLibrary")),
        "year": year,
        "itemCount": item.get("itemCount") if isinstance(item.get("itemCount"), int) else None,
        "videoType": video_type,
        "category": _optional_str(item.get("category")),
        "resultType": raw_type if isinstance(raw_type, str) else "",
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

    def get_library_albums(self, limit: int = 500) -> list[dict[str, Any]]:
        """Fetch the albums saved to the user's YouTube Music library.

        Args:
            limit: Maximum number of albums to return.

        Returns:
            A list of album dictionaries, or an empty list on error.
        """
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library albums")
                return []

            logger.info("Fetching library albums from API...")
            ytmusic = self._get_ytmusic()
            albums = ytmusic.get_library_albums(limit=limit)
            _inline_playlist_thumbnails(albums)

            logger.info("Library albums fetched (count: %d)", len(albums))
            return albums
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch library albums: %s", e)
            return []

    def get_library_songs(self, limit: int = 5000) -> list[dict[str, Any]]:
        """Fetch the songs saved to the user's YouTube Music library.

        Normalized to the shared Track shape. Covers are left as remote URLs so
        a large library does not inline hundreds of images on every load.

        Args:
            limit: Maximum number of songs to return.

        Returns:
            A list of track dictionaries, or an empty list on error.
        """
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library songs")
                return []

            logger.info("Fetching library songs from API...")
            ytmusic = self._get_ytmusic()
            raw = ytmusic.get_library_songs(limit=limit)

            songs: list[dict[str, Any]] = []
            for item in raw if isinstance(raw, list) else []:
                normalized = _album_track(item, "", "", [])
                if normalized is not None and normalized["videoId"]:
                    songs.append(normalized)

            logger.info("Library songs fetched (count: %d)", len(songs))
            return songs
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch library songs: %s", e)
            return []

    def get_library_artists(self, limit: int = 5000) -> list[dict[str, Any]]:
        """Fetch the artists saved to the user's YouTube Music library.

        ytmusicapi returns each artist with an "MPLAUC..." browse id; the
        channel id the artist page expects is that value without the "MPLA"
        prefix. Covers are left as remote URLs.

        Args:
            limit: Maximum number of artists to return.

        Returns:
            A list of artist dictionaries, or an empty list on error.
        """
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return library artists")
                return []

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
                artists.append(
                    {
                        "browseId": channel_id,
                        "name": _as_text(item.get("artist")),
                        "subscribers": _as_text(item.get("subscribers")),
                        "thumbnails": _thumbnails(item.get("thumbnails")),
                    }
                )

            logger.info("Library artists fetched (count: %d)", len(artists))
            return artists
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return []
        except Exception as e:
            logger.exception("Failed to fetch library artists: %s", e)
            return []

    def get_home(self, force_refresh: bool = False) -> dict[str, Any]:
        """Return Listen again, Quick picks, and Forgotten favorites from home.

        Listen again and Forgotten favorites are horizontal rows. Quick picks
        stays a vertical list. Shelves missing from the feed are omitted.
        A saved feed is returned as-is. Pass force_refresh to fetch a new one.
        """
        empty = _empty_home()
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return home")
                return empty

            if not force_refresh:
                cached = _cached_hit(CACHE_KEY_HOME)
                if cached is not None and isinstance(cached.get("shelves"), list):
                    logger.info("Returning cached home (shelves: %d)", len(cached["shelves"]))
                    return cached

            logger.info("Fetching home from API...")
            home = self._get_ytmusic().get_home(limit=16)
            if not isinstance(home, list):
                return empty

            shelves = _home_shelves(home)
            if not shelves:
                titles = [row.get("title") for row in home if isinstance(row, dict)]
                logger.warning("Home feed had none of the requested shelves: %s", titles)
                return empty

            result = {"shelves": shelves}
            cache.set(CACHE_KEY_HOME, result, expire=CACHE_DURATION)
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
            
            if not force_refresh:
                cached = _cached_hit(cache_key)
                if cached is not None:
                    logger.info(
                        "Returning cached playlist '%s' (tracks: %d)",
                        cached.get("title", "Unknown"),
                        len(cached.get("tracks", []))
                    )
                    return cached
            
            logger.info("Fetching playlist items from API for ID: %s", playlist_id)
            ytmusic = self._get_ytmusic()
            with _PlaylistDateCapture(ytmusic) as item_dates:
                playlist = ytmusic.get_playlist(playlist_id, limit=None)
            added = _apply_added_dates(playlist.get("tracks"), item_dates.items)
            logger.info(
                "Playlist '%s' fetched successfully (tracks: %d, dated: %d)",
                playlist.get("title", "Unknown"),
                len(playlist.get("tracks", [])),
                added
            )
            
            playlist["dominantColor"] = _dominant_color(playlist.get("thumbnails", []))

            # Only the playlist cover is inlined. Track covers stay as remote
            # URLs: a large playlist has thousands, and fetching them inline
            # blocks the request until every one resolves or times out. The
            # frontend inlines the ones the webview cannot decode on demand.
            _inline_playlist_thumbnails([playlist])

            # Store in cache
            cache.set(cache_key, playlist, expire=CACHE_DURATION)
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

    def get_album(self, browse_id: str, force_refresh: bool = False) -> dict[str, Any]:
        """Fetch an album by browse id.

        An ``OLAK5uy_`` audio playlist id is resolved to its ``MPREb_`` browse
        id first. The normalized album is cached under that browse id.
        """
        try:
            if not isinstance(browse_id, str) or not browse_id:
                logger.warning("Album browse id is required")
                return {}
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

            cache_key = f"{CACHE_KEY_ALBUM_PREFIX}{browse_id}"
            if not force_refresh:
                cached = _cached_hit(cache_key)
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
            cache.set(cache_key, payload, expire=CACHE_DURATION)
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
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return artist")
                return {}

            cache_key = f"{CACHE_KEY_ARTIST_PREFIX}{channel_id}"
            if not force_refresh:
                cached = _cached_hit(cache_key)
                if cached is not None:
                    logger.info("Returning cached artist '%s'", cached.get("name", "Unknown"))
                    return cached

            logger.info("Fetching artist from API for ID: %s", channel_id)
            ytmusic = self._get_ytmusic()
            artist = ytmusic.get_artist(channel_id)
            if not isinstance(artist, dict):
                return {}

            payload = _normalize_artist(artist, channel_id)
            _fill_missing_song_durations(ytmusic, payload.get("songs"))
            cache.set(cache_key, payload, expire=CACHE_DURATION)
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
        cache_key = f"{CACHE_KEY_TUNER_PREFIX}{vid}"
        cached = cache.get(cache_key)
        if isinstance(cached, list):
            return cached
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
            cache.set(cache_key, chips, expire=TUNER_CACHE_SECONDS)
        return chips

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
            # Music videos and other non-song videos do not expose a like status
            # in the next response. Report indifferent instead of failing.
            logger.debug("No like status returned for %s", video_id)
            return {"likeStatus": "INDIFFERENT"}
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
        cache_key = f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}"
        cached = cache.get(cache_key)
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
        cache.set(cache_key, cached, expire=CACHE_DURATION)

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
        cache.delete(f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}")
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
        cached = cache.get(f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}")
        if _playlist_contains_videos(cached, video_ids) is True:
            return True
        try:
            fresh = self.get_playlist_items(playlist_id, force_refresh=True)
        except Exception:
            logger.warning("Could not check whether %s is in %s", video_ids, playlist_id, exc_info=True)
            return False
        return _playlist_contains_videos(fresh, video_ids) is True

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
        cache.delete(f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}")
        return {"status": status}

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
            details = self.get_playlist_items(playlist_id)
            tracks = details.get("tracks", []) if isinstance(details, dict) else []
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

    def rename_playlist(self, playlist_id: str, title: str) -> dict[str, str]:
        """Rename one of the user's playlists."""
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title is required")
        return self._edit_playlist(playlist_id, title=title.strip())

    def set_playlist_privacy(self, playlist_id: str, privacy: str) -> dict[str, str]:
        """Change the visibility of one of the user's playlists."""
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        value = privacy.upper() if isinstance(privacy, str) else ""
        if value not in _PRIVACY_STATUSES:
            raise ValueError("privacy must be PUBLIC, PRIVATE or UNLISTED")
        return self._edit_playlist(playlist_id, privacy=value)

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
        cache.delete(f"{CACHE_KEY_PLAYLIST_PREFIX}{playlist_id}")
        return {"status": status}

    def delete_playlist(self, playlist_id: str) -> dict[str, str]:
        """Delete one of the user's playlists and forget its usage score."""
        if not isinstance(playlist_id, str) or not playlist_id:
            raise ValueError("playlist id is required")
        ytmusic = self._get_ytmusic()
        status = _delete_status(ytmusic.delete_playlist(playlist_id))
        _forget_playlist_stat(playlist_id)
        return {"status": status}

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
        logger.info("Created playlist %s (%d songs)", playlist_id, len(ids))
        return {"playlistId": playlist_id}

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
        logger.info("Rated playlist %s as %s", playlist_id, rating)
        return {"status": "OK"}

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
        playlists = self.get_playlists()
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
