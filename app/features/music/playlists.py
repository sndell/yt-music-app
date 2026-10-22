"""Moved out of features/music_api.py; see app/features/music/__init__.py."""

from __future__ import annotations

from typing import Any
from util.app_paths import data_dir
from ytmusicapi.continuations import CONTINUATION_ITEMS, get_continuation_token
from ytmusicapi.navigation import nav
from ytmusicapi.parsers.playlists import parse_playlist_items
import json
import logging
import re
import threading
import time
import ytmusicapi

logger = logging.getLogger(__name__)
_date_sinks = threading.local()
_PLAYLIST_STATS_PATH = data_dir() / "playlist_stats.json"
_PLAYLIST_STATS_LOCK = threading.Lock()
_PLAYLIST_STAT_KINDS = ("add", "play")
_PLAYLIST_STAT_MAX_EVENTS = 40
_PLAYLIST_STAT_WEIGHTS = {"add": 1.5, "play": 1.0}
_PLAYLIST_STAT_HALF_LIFE_DAYS = 3.0

logger = logging.getLogger(__name__)

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

def _find_playlist_shelf(response: Any) -> dict[str, Any] | None:
    """The first ``musicPlaylistShelfRenderer`` in a browse response.

    A playlist page keeps its first tracks and its continuation token here. The
    wrapper that holds it moves between app versions, so walk the response
    rather than hard-code the path.
    """
    stack: list[Any] = [response]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            shelf = node.get("musicPlaylistShelfRenderer")
            if isinstance(shelf, dict):
                return shelf
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None

def _date_sink() -> list[dict[str, Any]] | None:
    stack = getattr(_date_sinks, "stack", None)
    return stack[-1] if stack else None

def _token_sink() -> list[str] | None:
    stack = getattr(_date_sinks, "tokens", None)
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
        tokens = _token_sink()
        if tokens is not None and not tokens:
            shelf = _find_playlist_shelf(response)
            contents = shelf.get("contents") if isinstance(shelf, dict) else None
            if isinstance(contents, list) and contents:
                token = get_continuation_token(contents)
                if token:
                    tokens.append(token)
        return response

    ytmusic._send_request = send
    ytmusic._date_recorder = send

class _PlaylistDateCapture:
    """Collects add times and the next-page token while a playlist is fetched.

    The playlist browse response carries ``playlistItemData.voteSortValue``,
    the Unix second a track was added, which is the value YouTube Music's own
    "Date added" sort orders by. ytmusicapi parses that same response but drops
    the field, so recording it while ``get_playlist`` runs keeps the timestamps
    without a second request. The response also carries the continuation token
    for the page after the first, which ytmusicapi drops too.
    """

    def __init__(self, ytmusic: Any) -> None:
        _install_date_recorder(ytmusic)
        self.items: list[dict[str, Any]] = []
        self.tokens: list[str] = []

    @property
    def next_token(self) -> str | None:
        return self.tokens[0] if self.tokens else None

    def __enter__(self) -> "_PlaylistDateCapture":
        stack = getattr(_date_sinks, "stack", None)
        if stack is None:
            stack = _date_sinks.stack = []
        stack.append(self.items)
        tokens = getattr(_date_sinks, "tokens", None)
        if tokens is None:
            tokens = _date_sinks.tokens = []
        tokens.append(self.tokens)
        return self

    def __exit__(self, *_exc: Any) -> None:
        stack = getattr(_date_sinks, "stack", None)
        if stack:
            stack.pop()
        tokens = getattr(_date_sinks, "tokens", None)
        if tokens:
            tokens.pop()

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

def _playlist_first_page(ytmusic: Any, playlist_id: str) -> tuple[dict[str, Any], str | None]:
    """Read a playlist header and its first page of tracks, plus the next token.

    ``limit=0`` stops ytmusicapi from following continuations, so one request
    returns the header, about a hundred tracks, and the token for the page
    after them. That token is not in the parsed result, so the recorder picks
    it out of the same response.
    """
    with _PlaylistDateCapture(ytmusic) as capture:
        playlist = ytmusic.get_playlist(playlist_id, limit=0)
    if not isinstance(playlist, dict):
        return {}, None
    _apply_added_dates(playlist.get("tracks"), capture.items)
    return playlist, capture.next_token

def _playlist_track_page(
    ytmusic: Any, page_token: str, is_collaborative: bool
) -> tuple[list[dict[str, Any]], str | None]:
    """Read one page of playlist tracks from a continuation token.

    Returns the page and the token after it, or ``None`` when this was the last
    page. The response carries the page's playlist item data, so the caller can
    stamp add times from the same request.
    """
    response = ytmusic._send_request("browse", {"continuation": page_token})
    items = nav(response, CONTINUATION_ITEMS, True)
    if not isinstance(items, list) or not items:
        return [], None
    return parse_playlist_items(items, is_collaborative=is_collaborative), get_continuation_token(items)

def _read_playlist_whole(
    ytmusic: Any, playlist_id: str
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """A playlist header and every track, in one call.

    A list whose header reports no size is a generated mix that never ends, so
    it is left at its first page, the same guard `get_playlist_items` uses.
    """
    playlist, token = _playlist_first_page(ytmusic, playlist_id)
    if not isinstance(playlist, dict):
        return {}, []
    tracks = list(playlist.get("tracks") or [])
    if playlist.get("trackCount") is None:
        return playlist, tracks
    is_collaborative = bool(playlist.get("collaborators"))
    seen: set[str] = set()
    while token and token not in seen:
        seen.add(token)
        with _PlaylistDateCapture(ytmusic) as capture:
            page, token = _playlist_track_page(ytmusic, token, is_collaborative)
        if not page:
            break
        _apply_added_dates(page, capture.items)
        tracks.extend(page)
    return playlist, tracks

def _fetch_all_playlist_tracks(ytmusic: Any, playlist_id: str) -> list[dict[str, Any]]:
    """Every track of a playlist, in one call.

    Used by the callers that cannot work from a page: the duplicate check on an
    add, a row lookup on a removal, and queueing. It always reads from YouTube,
    because an add or a removal acts on the rows it is about to change.
    """
    return _read_playlist_whole(ytmusic, playlist_id)[1]

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