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

    def version(self) -> str:
        """Short hash of the declared shape, stable across runs and machines."""
        canonical = json.dumps(_canonical(self.shape), separators=(",", ":"), sort_keys=True)
        return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:8]

    def key(self, ident: str) -> str:
        return f"{self.name}:{self.version()}:{ident}"

    def prefix(self) -> str:
        return f"{self.name}:{self.version()}:"


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
HOME = Family(name="home", ttl=WEEK, shape=(("shelves", HOME_SHELF_SHAPE),))
LIBRARY_SONGS = Family(name="library:songs", ttl=WEEK, shape=(("songs", TRACK_SHAPE),), strict_extra=False)
LIBRARY_ALBUMS = Family(
    name="library:albums",
    ttl=WEEK,
    shape=(("albums", ("browseId", "playlistId", "title", "type", "thumbnails", "artists", "year")),),
    strict_extra=False,
)
LIBRARY_ARTISTS = Family(
    name="library:artists",
    ttl=WEEK,
    shape=(("artists", ("browseId", "name", "songCount", "thumbnails")),),
    strict_extra=False,
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
    """Reads and writes cached payloads; the only user of diskcache."""

    def __init__(self, path: Path) -> None:
        self._cache = diskcache.Cache(str(path))

    def read(self, family: Family, ident: str) -> Any | None:
        """The cached payload, marked `fromCache` so the UI can paint then refresh."""
        payload = self._cache.get(family.key(ident))
        if payload is None:
            return None
        if family.dict_payload and isinstance(payload, dict):
            marked = dict(payload)
            marked["fromCache"] = True
            return marked
        return payload

    def read_raw(self, family: Family, ident: str) -> Any | None:
        """The stored payload, without the transport flag, for mutation."""
        return self._cache.get(family.key(ident))

    def write(self, family: Family, ident: str, payload: Any) -> None:
        if family.dict_payload:
            stored = {key: value for key, value in payload.items() if key != "fromCache"}
            _check(stored, family.shape, family.name, family.strict_extra)
        else:
            stored = payload
        self._cache.set(family.key(ident), stored, expire=family.ttl)

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
            payload = self._cache.get(key)
            if payload is not None:
                yield key, payload

    def clear(self) -> int:
        count = len(self._cache)
        self._cache.clear()
        return count


store = PayloadStore(cache_dir())
