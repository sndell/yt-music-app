"""The one place a cached payload's identity lives.

A family declares its name, its TTL, and the shape of the payload it stores:
the top-level fields, and for a list field the fields of each element. The
version in the key is a hash of that shape, so adding a field to a payload
changes every key of the family with no step to remember, and a writer that
emits a field the family does not declare fails loudly instead of storing a
shape nothing can invalidate.

The old rule ("change a payload's shape and raise the cache key version") was
a step in a prose list, done by hand 7 times, and it went stale in the notes.
This module is what the agent notes now point at.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import diskcache

from util.app_paths import cache_dir

logger = logging.getLogger(__name__)

WEEK = 7 * 24 * 60 * 60
DAY = 24 * 60 * 60
HALF_DAY = 12 * 60 * 60

# A shape is a tuple of field names; an entry may be a (name, subsample) pair
# for a list of objects, or a bare name for anything else.
Shape = tuple[Any, ...]

TRACK_SHAPE: Shape = (
    "videoId",
    "title",
    "artists",
    "album",
    "likeStatus",
    "inLibrary",
    "thumbnails",
    "isAvailable",
    "isExplicit",
    "videoType",
    "views",
    "duration",
    "durationSeconds",
    "setVideoId",
    "addedAt?",
    "year?",
)

# Playlist rows are ytmusicapi's own track dicts with this app's addedAt on top.
# Measured against a live read: fields come and go by row (a non-editable list
# has no setVideoId; a row with no like target has no feedbackTokens; some rows
# carry creditsBrowseId), so only the four a row cannot render without stay
# required. The UI's Track type also claims durationSeconds and year for these
# rows, which they do not carry; normalizing them is its own change.
PLAYLIST_TRACK_SHAPE: Shape = (
    "videoId",
    "title",
    "artists",
    "thumbnails",
    "addedAt?",
    "album?",
    "communityVoteStatus?",
    "duration?",
    "duration_seconds?",
    "feedbackTokens?",
    "inLibrary?",
    "isAvailable?",
    "isExplicit?",
    "likeStatus?",
    "listenAgainFeedbackTokens?",
    "pinnedToListenAgain?",
    "setVideoId?",
    "videoType?",
    "views?",
)

# A category tile carries YouTube's own color for it instead of a cover; the
# browse response has no image per category.
MOOD_CATEGORY_SHAPE: Shape = ("title", "params", "color")

MOOD_SECTION_SHAPE: Shape = ("title", ("categories", MOOD_CATEGORY_SHAPE))

MOOD_PLAYLIST_SHAPE: Shape = ("title", "playlistId", "thumbnails", "description", "owned", "count?")

# The sidebar's playlist list, as ytmusicapi reads it. Rows are YouTube's own
# dicts, so only the two the panel cannot draw without are required.
LIBRARY_PLAYLIST_SHAPE: Shape = ("playlistId", "title", "thumbnails?", "count?", "owned?", "description?", "author?")

# Chart playlist cards are the mood cards' shape without a count (a chart list
# reports none), and a chart artist carries YouTube's own rank and trend.
# ``countries`` stays a bare field: it is a list of codes, not of objects.
CHART_PLAYLIST_SHAPE: Shape = ("title", "playlistId", "thumbnails", "description", "owned")
CHART_ARTIST_SHAPE: Shape = ("browseId", "name", "subscribers", "thumbnails", "rank", "trend")
CHART_SECTION_SHAPE: Shape = ("key", "title", ("playlists", CHART_PLAYLIST_SHAPE))

HOME_ITEM_SHAPE: Shape = (
    "kind",
    "title",
    "subtitle",
    "artists",
    "thumbnails",
    "videoId",
    "playlistId",
    "browseId",
    "explicit",
    "videoType?",
)

HOME_SHELF_SHAPE: Shape = ("title", "layout", ("items", HOME_ITEM_SHAPE))

# An Explore row is the same field set as a Home item, but its kind may also be
# "video": a new-videos row is a card that plays, where Home would call the same
# row a song. Declared apart from HOME_ITEM_SHAPE so the two can drift.
EXPLORE_ITEM_SHAPE: Shape = (
    "kind",
    "title",
    "subtitle",
    "artists",
    "thumbnails",
    "videoId",
    "playlistId",
    "browseId",
    "explicit",
    "videoType?",
)

# An Explore section carries its own layout, so the UI picks the card without
# reading YouTube's carousel title. The moods section fills `categories` (tiles
# that link into /moods) and leaves `items` empty; every other section does the
# reverse.
EXPLORE_SECTION_SHAPE: Shape = (
    "key",
    "title",
    "layout",
    ("items", EXPLORE_ITEM_SHAPE),
    ("categories", MOOD_CATEGORY_SHAPE),
)

# The watch playlist's Related tab. Rows carry the same field set as a Home
# item, plus a "text" kind for the about-the-artist paragraph, which is a
# string section rather than a list. Keyed by the related browse id the watch
# playlist response carries.
RELATED_ITEM_SHAPE: Shape = (
    "kind",
    "title",
    "subtitle",
    "artists",
    "thumbnails",
    "videoId",
    "playlistId",
    "browseId",
    "explicit",
    "videoType?",
)

RELATED_SECTION_SHAPE: Shape = ("title", ("items", RELATED_ITEM_SHAPE))


@dataclass(frozen=True, slots=True)
class Family:
    """One cached payload family: its name, its TTL, its shape."""

    name: str
    ttl: int
    shape: Shape
    # A payload that carries the transport's fromCache flag; the store strips it.
    dict_payload: bool = True
    # A family whose payload is YouTube's dict with fields added cannot declare
    # every key YouTube may send. Missing declared fields still fail; extras warn.
    strict_extra: bool = True
    # Serve a payload younger than this without a background refresh. Zero means
    # every cached hit refreshes, which is right for a page whose content moves
    # under the user (the playlist they are editing). TTL is the hard expiry;
    # this is the softer "old enough to be worth a fetch" age.
    refresh_after: int = 0

    def version(self) -> str:
        """Short hash of the declared shape, stable across runs and machines."""
        canonical = json.dumps(_canonical(self.shape), separators=(",", ":"), sort_keys=True)
        return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:8]

    def key(self, ident: str) -> str:
        return f"{self.name}:{self.version()}:{ident}"

    def prefix(self) -> str:
        return f"{self.name}:{self.version()}:"

    def is_stale(self, fetched_at: float) -> bool:
        """Whether a payload written at ``fetched_at`` should be refreshed.

        A payload with no recorded write time (an entry from before the store
        kept one) counts as stale, so the first read after an upgrade refreshes
        once and the entry joins the new format.
        """
        if self.refresh_after <= 0:
            return True
        return time.time() - fetched_at >= self.refresh_after


# Fields the store adds on the way out and strips on the way back in; they are
# transport metadata, not part of any family's shape.
TRANSPORT_FIELDS = frozenset({"fromCache", "stale"})


def _canonical(shape: Shape) -> Any:
    out: list[Any] = []
    for entry in shape:
        if isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[0], str):
            out.append([entry[0], _canonical(entry[1])])
        else:
            out.append(entry)
    return out


PLAYLIST = Family(
    name="playlist",
    ttl=WEEK,
    shape=(
        "owned",
        "id",
        "privacy",
        "description",
        "views",
        "duration",
        "trackCount",
        "title",
        "thumbnails",
        "author",
        "year",
        "durationSeconds",
        "dominantColor",
        "nextToken",
        ("tracks", PLAYLIST_TRACK_SHAPE),
    ),
    strict_extra=False,
)
# The sidebar's playlist list and the Library's Playlists chip. Refreshed behind
# a painted list, so a few minutes of reuse costs nothing the user can see.
LIBRARY_PLAYLISTS = Family(
    name="playlists",
    ttl=WEEK,
    shape=(("playlists", LIBRARY_PLAYLIST_SHAPE),),
    strict_extra=False,
    refresh_after=10 * 60,
)
# Sized so a route change paints from disk and skips the network entirely. The
# background read still happens once the age passes, so the feed catches up.
HOME = Family(name="home", ttl=WEEK, shape=(("shelves", HOME_SHELF_SHAPE),), refresh_after=30 * 60)
# YouTube Music's Explore page: one family for the whole feed, keyed by a single
# id, because every section comes from the one browse request. Releases and
# trending move by the day, not by the minute.
EXPLORE = Family(
    name="explore",
    ttl=WEEK,
    shape=(("sections", EXPLORE_SECTION_SHAPE),),
    refresh_after=6 * 60 * 60,
)
# The Related tab of one watch playlist, keyed by the related browse id from
# that response. A song's related set is stable, so a week is safe.
RELATED = Family(name="related", ttl=WEEK, shape=(("sections", RELATED_SECTION_SHAPE),))
# The moods and genres page, and the one category a user opened. A category
# payload is keyed by the category's own params token, the same one the page's
# route carries.
MOODS = Family(name="moods", ttl=WEEK, shape=(("sections", MOOD_SECTION_SHAPE),))
MOOD_PLAYLISTS = Family(name="moods:playlists", ttl=WEEK, shape=(("playlists", MOOD_PLAYLIST_SHAPE),))
# Charts are a dated list, so a day-old one is stale in a way a playlist is not;
# the page paints the cached country and refreshes behind it either way.
CHARTS = Family(
    name="charts",
    ttl=DAY,
    shape=(
        "country",
        "countryName",
        "countries",
        ("sections", CHART_SECTION_SHAPE),
        ("artists", CHART_ARTIST_SHAPE),
    ),
)
LIBRARY_SONGS = Family(
    name="library:songs",
    ttl=WEEK,
    shape=(("songs", TRACK_SHAPE),),
    strict_extra=False,
    refresh_after=30 * 60,
)
LIBRARY_ALBUMS = Family(
    name="library:albums",
    ttl=WEEK,
    shape=(("albums", ("browseId", "playlistId", "title", "type", "thumbnails", "artists", "year")),),
    strict_extra=False,
    refresh_after=30 * 60,
)
LIBRARY_ARTISTS = Family(
    name="library:artists",
    ttl=WEEK,
    shape=(("artists", ("browseId", "name", "songCount", "thumbnails")),),
    strict_extra=False,
    refresh_after=30 * 60,
)
ALBUM = Family(
    name="album",
    ttl=WEEK,
    shape=(
        "browseId",
        "title",
        "type",
        "description",
        "artists",
        "year",
        "trackCount",
        "duration",
        "durationSeconds",
        "audioPlaylistId",
        "thumbnails",
        "dominantColor",
        ("tracks", TRACK_SHAPE),
        "otherVersions",
    ),
)
ARTIST = Family(
    name="artist",
    ttl=WEEK,
    shape=(
        "channelId",
        "name",
        "description",
        "views",
        "subscribers",
        "monthlyListeners",
        "thumbnails",
        "dominantColor",
        "shuffleId",
        "radioId",
        "songs",
        "albums",
        "singles",
        "shows",
        "videos",
        "related",
    ),
)
LYRICS = Family(
    name="lyrics",
    ttl=WEEK,
    shape=("lyrics", "source", "hasTimestamps", "lines"),
)
LYRICS_TRANSLATED = Family(
    name="lyrics:translated",
    ttl=WEEK,
    shape=("lyrics", "source", "hasTimestamps", "lines", "language", "translated"),
)
TUNER = Family(
    name="tuner",
    ttl=HALF_DAY,
    shape=(("chips", ("id", "text", "playlistId")),),
)
# The beat estimate the page measures from a song's opening. A recording's tempo
# does not change, so it outlives the lists. Keyed by video id; "offset" is the
# first beat in seconds, so the grid is offset + n * 60 / bpm.
TEMPO = Family(name="tempo", ttl=4 * WEEK, shape=("bpm", "offset"))
THUMB = Family(name="thumb", ttl=DAY, shape=(), dict_payload=False)


class ShapeMismatch(Exception):
    """A payload does not match the shape its family declares."""


_warned_extras: set[tuple[str, tuple[str, ...]]] = set()


def _check(value: Any, shape: Shape, path: str, strict_extra: bool = True) -> None:
    if not shape:
        return
    if not isinstance(value, dict):
        raise ShapeMismatch(f"{path}: expected an object, got {type(value).__name__}")
    entries = [entry if isinstance(entry, str) else entry[0] for entry in shape]
    # A trailing "?" marks a field a payload may leave off, like Track.addedAt.
    declared = {name.rstrip("?") for name in entries}
    required = {name for name in entries if not name.endswith("?")}
    present = set(value)
    extra = sorted(present - declared)
    missing = sorted(required - present)
    if extra and strict_extra:
        raise ShapeMismatch(f"{path}: fields no family declares: {extra}")
    if extra:
        # A pass-through payload can carry YouTube's own keys. Say so once per
        # family, not once per write.
        key = (path.split("[")[0], tuple(extra))
        if key not in _warned_extras:
            _warned_extras.add(key)
            logger.warning("%s: fields no family declares: %s", path, extra)
    if missing:
        raise ShapeMismatch(f"{path}: missing declared fields: {missing}")
    for entry in shape:
        if isinstance(entry, tuple):
            field, subsample = entry
            items = value[field]
            if not isinstance(items, list):
                raise ShapeMismatch(f"{path}.{field}: expected a list")
            for index, item in enumerate(items):
                _check(item, subsample, f"{path}.{field}[{index}]", strict_extra)


def shape_of(value: Any) -> Any:
    """The nested key structure of a payload, for reporting a mismatch."""
    if isinstance(value, dict):
        return {key: shape_of(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [shape_of(item) for item in value[:1]]
    return type(value).__name__


class PayloadStore:
    """Reads and writes cached payloads; the only user of diskcache.

    Each entry is stored as ``(fetched_at, payload)`` so the reader can say
    whether the payload is old enough to refresh. An entry from before that
    wrapper existed is read as an untimed payload and counts as stale.
    """

    def __init__(self, path: Path) -> None:
        self._cache = diskcache.Cache(str(path))

    @staticmethod
    def _split(entry: Any) -> tuple[float, Any]:
        if isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[0], (int, float)):
            return float(entry[0]), entry[1]
        return 0.0, entry

    def read(self, family: Family, ident: str) -> Any | None:
        """The cached payload, marked `fromCache` and `stale` for the UI."""
        entry = self._cache.get(family.key(ident))
        if entry is None:
            return None
        fetched_at, payload = self._split(entry)
        if family.dict_payload and isinstance(payload, dict):
            marked = dict(payload)
            marked["fromCache"] = True
            marked["stale"] = family.is_stale(fetched_at)
            return marked
        return payload

    def read_raw(self, family: Family, ident: str) -> Any | None:
        """The stored payload, without the transport flags, for mutation."""
        entry = self._cache.get(family.key(ident))
        if entry is None:
            return None
        return self._split(entry)[1]

    def write(self, family: Family, ident: str, payload: Any) -> None:
        if family.dict_payload:
            stored = {key: value for key, value in payload.items() if key not in TRANSPORT_FIELDS}
            _check(stored, family.shape, family.name, family.strict_extra)
        else:
            stored = payload
        self._cache.set(family.key(ident), (time.time(), stored), expire=family.ttl)

    def update(self, family: Family, ident: str, mutate: Callable[[Any], bool]) -> bool:
        """Read, mutate in place, write back. False when nothing is cached."""
        payload = self.read_raw(family, ident)
        if payload is None:
            return False
        if mutate(payload):
            self.write(family, ident, payload)
            return True
        return False

    def drop(self, family: Family, ident: str) -> bool:
        return bool(self._cache.delete(family.key(ident)))

    def drop_all(self, family: Family) -> int:
        """Every stored payload of a family, for invalidation and sign-out."""
        dropped = 0
        for key in self.keys(family):
            if self._cache.delete(key):
                dropped += 1
        return dropped

    def keys(self, family: Family) -> list[str]:
        prefix = family.prefix()
        return [str(key) for key in list(self._cache.iterkeys()) if str(key).startswith(prefix)]

    def entries(self, family: Family) -> Iterable[Any]:
        """Raw stored payloads of a family, for a sweep like a like-status fix."""
        for key in self.keys(family):
            entry = self._cache.get(key)
            if entry is not None:
                yield key, self._split(entry)[1]

    def clear(self) -> int:
        count = len(self._cache)
        self._cache.clear()
        return count


store = PayloadStore(cache_dir())
