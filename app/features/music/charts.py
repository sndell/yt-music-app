"""YouTube Music's charts: the daily and weekly lists, and the top artists.

``YTMusic.get_charts`` already returns most of this in a usable shape, with two
catches. Its country list is bare ISO 3166-1 alpha-2 codes and it names only the
country it served, so the picker's list comes from the payload's own options and
never from a table in this app. And its chart lists repeat a playlist id across
their shelves the way a mood category does, so the card builder keeps one row
per id in YouTube's order.
"""

from __future__ import annotations

import logging
from typing import Any

from features.music.normalize import _thumbnails

logger = logging.getLogger(__name__)

# The playlist charts, in the order YouTube itself draws them. ``videos`` is
# what a non-premium read carries where a premium one carries daily and weekly;
# ``genres`` and ``languages`` appear for some countries only.
CHART_PLAYLIST_LISTS: tuple[tuple[str, str], ...] = (
    ("daily", "Daily"),
    ("weekly", "Weekly"),
    ("videos", "Top videos"),
    ("genres", "Genres"),
    ("languages", "Languages"),
)

CHART_TRENDS = ("up", "down", "neutral")

# YouTube's own code for the global chart, the one option that is not a country.
GLOBAL_CHART_COUNTRY = "ZZ"


def _empty_charts(country: str = GLOBAL_CHART_COUNTRY) -> dict[str, Any]:
    return {"country": country, "countryName": "", "countries": [], "sections": [], "artists": []}


def _chart_country_code(country: Any) -> str:
    """YouTube's chart country: an ISO 3166-1 alpha-2 code, ``ZZ`` for global."""
    code = country.strip().upper() if isinstance(country, str) else ""
    return code if len(code) == 2 and code.isalpha() else GLOBAL_CHART_COUNTRY


def _chart_countries(payload: Any) -> tuple[list[str], str]:
    """The country codes the payload offers, and the name it shows for the one
    it served. YouTube names only the selection, so the codes are what the
    picker lists; the UI labels the rest from the platform's own region names.
    """
    if not isinstance(payload, dict):
        return [], ""
    countries = payload.get("countries")
    if not isinstance(countries, dict):
        return [], ""

    codes: list[str] = []
    seen: set[str] = set()
    options = countries.get("options")
    if isinstance(options, list):
        for option in options:
            if not isinstance(option, str) or not option.strip():
                continue
            code = option.strip().upper()
            if code in seen:
                continue
            seen.add(code)
            codes.append(code)

    selected = countries.get("selected")
    name = selected.get("text") if isinstance(selected, dict) else selected
    return codes, name.strip() if isinstance(name, str) else ""


def _chart_playlists(rows: Any) -> list[dict[str, Any]]:
    """Playlist cards for one chart, in ``PlaylistSummary`` shape.

    The rows YouTube sends are YouTube's own lists, so ``owned`` is false and
    there is no description. A chart repeats an id across its own shelves, and
    the card keys by ``playlistId``, so the first row for an id is kept.
    """
    if not isinstance(rows, list):
        return []
    playlists: list[dict[str, Any]] = []
    seen: set[str] = set()
    for playlist in rows:
        if not isinstance(playlist, dict):
            continue
        playlist_id = playlist.get("playlistId")
        title = playlist.get("title")
        if not isinstance(playlist_id, str) or not playlist_id:
            continue
        if playlist_id in seen:
            continue
        if not isinstance(title, str) or not title.strip():
            continue
        seen.add(playlist_id)
        playlists.append(
            {
                "title": title.strip(),
                "playlistId": playlist_id,
                "thumbnails": _thumbnails(playlist.get("thumbnails")),
                "description": "",
                "owned": False,
            }
        )
    return playlists


def _chart_sections(payload: Any) -> list[dict[str, Any]]:
    """The playlist charts YouTube returned, in its own order, empties dropped."""
    if not isinstance(payload, dict):
        return []
    sections: list[dict[str, Any]] = []
    for key, title in CHART_PLAYLIST_LISTS:
        playlists = _chart_playlists(payload.get(key))
        if playlists:
            sections.append({"key": key, "title": title, "playlists": playlists})
    return sections


def _chart_artists(rows: Any) -> list[dict[str, Any]]:
    """The top-artist chart in rank order, one row per channel.

    ``rank`` is the number YouTube prints beside the row and ``trend`` is its
    own arrow; an unauthenticated read drops both, so a row without them still
    lists.
    """
    if not isinstance(rows, list):
        return []
    artists: list[dict[str, Any]] = []
    seen: set[str] = set()
    for artist in rows:
        if not isinstance(artist, dict):
            continue
        browse_id = artist.get("browseId")
        title = artist.get("title")
        if not isinstance(browse_id, str) or not browse_id:
            continue
        if browse_id in seen:
            continue
        if not isinstance(title, str) or not title.strip():
            continue
        seen.add(browse_id)

        subscribers = artist.get("subscribers")
        trend = artist.get("trend")
        rank = artist.get("rank")
        artists.append(
            {
                "browseId": browse_id,
                "name": title.strip(),
                "subscribers": subscribers.strip() if isinstance(subscribers, str) and subscribers.strip() else None,
                "thumbnails": _thumbnails(artist.get("thumbnails")),
                "rank": rank.strip() if isinstance(rank, str) and rank.strip() else None,
                "trend": trend if trend in CHART_TRENDS else None,
            }
        )
    return artists


def _charts_payload(payload: Any, country: str) -> dict[str, Any]:
    """One country's charts in the shape the page reads."""
    if not isinstance(payload, dict):
        return _empty_charts(country)
    countries, country_name = _chart_countries(payload)
    return {
        "country": country,
        "countryName": country_name,
        "countries": countries,
        "sections": _chart_sections(payload),
        "artists": _chart_artists(payload.get("artists")),
    }
