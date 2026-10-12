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
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from PIL import Image

import diskcache
import ytmusicapi
from ytmusicapi.helpers import initialize_headers, sapisid_from_cookie

from util.app_paths import data_dir, is_frozen
from util.get_dominant_color import get_dominant_color_hex

logger = logging.getLogger(__name__)

_BROWSER_JSON_PATH = data_dir() / "browser.json"
_CACHE_DIR = data_dir() / ("cache" if is_frozen() else ".cache")

# Initialize persistent disk cache
cache = diskcache.Cache(str(_CACHE_DIR))

# Cache durations in seconds
CACHE_DURATION_PLAYLIST_ITEMS = 60 * 30  # 30 minutes
CACHE_DURATION_HOME = 60 * 15  # 15 minutes

# Cache key prefixes
CACHE_KEY_PLAYLIST_PREFIX = "playlist:"
CACHE_KEY_ALBUM_PREFIX = "album:"
CACHE_KEY_ARTIST_PREFIX = "artist:"
CACHE_KEY_HOME = "home:shelves:v3"
CACHE_KEY_THUMB_PREFIX = "thumb:v2:"
THUMB_CACHE_SECONDS = 60 * 60 * 24

_LIKE_STATUSES = {"LIKE", "DISLIKE", "INDIFFERENT"}
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
        from util.embed_cookies import sync_login_cookies

        sync_login_cookies()
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

    def get_home(self) -> dict[str, Any]:
        """Return Listen again, Quick picks, and Forgotten favorites from home.

        Listen again and Forgotten favorites are horizontal rows. Quick picks
        stays a vertical list. Shelves missing from the feed are omitted.
        """
        empty = _empty_home()
        try:
            if not self._is_authenticated():
                logger.warning("Not authenticated - cannot return home")
                return empty

            cached = cache.get(CACHE_KEY_HOME)
            if isinstance(cached, dict) and isinstance(cached.get("shelves"), list):
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
            cache.set(CACHE_KEY_HOME, result, expire=CACHE_DURATION_HOME)
            logger.info(
                "Home fetched (%s)",
                ", ".join(f"{shelf['title']}: {len(shelf['items'])}" for shelf in shelves),
            )
            return result
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return empty
        except Exception as e:
            logger.exception("Failed to fetch home: %s", e)
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
            
            playlist["dominantColor"] = _dominant_color(playlist.get("thumbnails", []))

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

    def get_album(self, browse_id: str) -> dict[str, Any]:
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
            cached = cache.get(cache_key)
            if isinstance(cached, dict):
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
            cache.set(cache_key, payload, expire=CACHE_DURATION_PLAYLIST_ITEMS)
            logger.info(
                "Album '%s' fetched successfully (tracks: %d)",
                payload.get("title", "Unknown"),
                len(payload.get("tracks", [])),
            )
            logger.info("Album cached: %s", browse_id)
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return {}
        except Exception as e:
            logger.exception("Failed to fetch album: %s", e)
            return {}

    def get_artist(self, channel_id: str) -> dict[str, Any]:
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
            ytmusic = self._get_ytmusic()
            cached = cache.get(cache_key)
            if isinstance(cached, dict):
                logger.info("Returning cached artist '%s'", cached.get("name", "Unknown"))
                if _fill_missing_song_durations(ytmusic, cached.get("songs")):
                    cache.set(cache_key, cached, expire=CACHE_DURATION_PLAYLIST_ITEMS)
                return cached

            logger.info("Fetching artist from API for ID: %s", channel_id)
            artist = ytmusic.get_artist(channel_id)
            if not isinstance(artist, dict):
                return {}

            payload = _normalize_artist(artist, channel_id)
            _fill_missing_song_durations(ytmusic, payload.get("songs"))
            cache.set(cache_key, payload, expire=CACHE_DURATION_PLAYLIST_ITEMS)
            logger.info("Artist '%s' fetched successfully", payload.get("name", "Unknown"))
            logger.info("Artist cached: %s", channel_id)
            return payload
        except FileNotFoundError as e:
            logger.error("Configuration error: %s", e)
            return {}
        except Exception as e:
            logger.exception("Failed to fetch artist: %s", e)
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
        cache.set(cache_key, cached, expire=CACHE_DURATION_PLAYLIST_ITEMS)

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
