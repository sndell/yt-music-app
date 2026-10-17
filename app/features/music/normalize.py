"""Moved out of features/music_api.py; see app/features/music/__init__.py."""

from __future__ import annotations

from PIL import Image
from concurrent.futures import ThreadPoolExecutor
from contract.cache import (
    ALBUM,
    ARTIST,
    HOME,
    LIBRARY_ALBUMS,
    LIBRARY_ARTISTS,
    LIBRARY_SONGS,
    LYRICS,
    LYRICS_TRANSLATED,
    PLAYLIST,
    THUMB,
    TUNER,
    store,
)
from typing import Any
from urllib.request import Request, urlopen
from util.get_dominant_color import get_dominant_color_hex
import base64
import io
import logging
import re
import time
import ytmusicapi

logger = logging.getLogger(__name__)
MAX_INLINE_ITEMS = 150
_LIKE_STATUSES = {"LIKE", "DISLIKE", "INDIFFERENT"}
_SONG_VIDEO_TYPE = "MUSIC_VIDEO_TYPE_ATV"
MAX_THUMB_BYTES = 250_000
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

logger = logging.getLogger(__name__)

def _inline_thumbnail(url: str) -> str:
    """Fetch a cover and return a data URL the webview can show without a third-party request.

    Some yt3.googleusercontent.com covers load in a normal browser and fail in the
    desktop window, which then shows the broken-image icon.
    """
    if not url or url.startswith("data:"):
        return url

    cached = store.read(THUMB, url)
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
        store.write(THUMB, url, data_url)
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

def _upload_track(track: Any) -> dict[str, Any] | None:
    """One uploaded song, in the shared Track shape.

    An upload's row carries no ``isAvailable`` flag, so playability follows the
    video id the way an artist song list's does; the cover is the row's own.
    """
    if not isinstance(track, dict):
        return None
    video_id = track.get("videoId") if isinstance(track.get("videoId"), str) else ""
    like_status = track.get("likeStatus")
    if like_status not in _LIKE_STATUSES:
        like_status = "INDIFFERENT"
    return {
        "videoId": video_id,
        "title": track.get("title") if isinstance(track.get("title"), str) else "",
        "artists": _people(track.get("artists")),
        "album": _named_album(track.get("album"), ""),
        "likeStatus": like_status,
        "inLibrary": bool(track.get("inLibrary")),
        "thumbnails": _thumbnails(track.get("thumbnails")),
        "isAvailable": bool(video_id),
        "isExplicit": bool(track.get("isExplicit")),
        "videoType": _SONG_VIDEO_TYPE,
        "views": None,
        "duration": track.get("duration") if isinstance(track.get("duration"), str) else "",
        "durationSeconds": _as_int(track.get("duration_seconds")),
        "setVideoId": "",
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

def _home_layout(title: str) -> str:
    """Quick picks is the feed's one vertical list; every other shelf is a row.

    YouTube Music returns carousels for everything else, so a shelf no longer
    has to be named here to reach Home. Titles change between accounts and over
    time, so an allowlist would drop shelves the UI can already render.
    """
    return "list" if title.strip().lower() == "quick picks" else "row"

def _landscape_thumbnail(thumbnails: Any) -> bool:
    """True when a thumbnail is wider than tall, the video-rendition tell.

    Home's "Music videos for you" shelf reports ``MUSIC_VIDEO_TYPE_ATV`` for
    items whose art is 16:9, so the shape is the only signal that they are
    videos and not audio tracks.
    """
    if not isinstance(thumbnails, list):
        return False
    for thumb in thumbnails:
        if not isinstance(thumb, dict):
            continue
        width, height = thumb.get("width"), thumb.get("height")
        if isinstance(width, int) and isinstance(height, int) and height > 0:
            return width > height
    return False

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
        video_type = item.get("videoType")
        if video_type not in {_SONG_VIDEO_TYPE, "MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC"}:
            video_type = _SONG_VIDEO_TYPE
        # Some video shelves report ATV, so fall back to the 16:9 art.
        if video_type == _SONG_VIDEO_TYPE and _landscape_thumbnail(thumbnails):
            video_type = "MUSIC_VIDEO_TYPE_OMV"
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
            "videoType": video_type,
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
    """Every shelf the feed returns, in feed order, minus the unrenderable ones.

    A shelf is dropped when it carries no title, when its contents are not a
    list (description shelves hold a string), or when none of its items map to
    something the UI can open. Podcast shows are the common case for that last
    one: the app has no podcast page and ``get_playlist`` cannot read a show, so
    they have nowhere to go.
    """
    shelves: list[dict[str, Any]] = []
    skipped: list[str] = []
    for row in home:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        contents = row.get("contents")
        if not isinstance(contents, list):
            continue
        items = [_home_item(item) for item in contents if isinstance(item, dict)]
        shelf_items = [item for item in items if item is not None]
        if not shelf_items:
            skipped.append(title)
            continue
        _inline_thumbnail_field(shelf_items, "thumbnails")
        shelves.append({"title": title, "layout": _home_layout(title), "items": shelf_items})
    if skipped:
        logger.info("Home shelves skipped (nothing openable): %s", ", ".join(skipped))
    return shelves

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