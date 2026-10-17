"""Moods and genres: the browse page the discovery pages are shaped after.

YouTube Music's Moods & Genres page is three sections of colored category
buttons. ``YTMusic.get_mood_categories`` drops the color, because the button
renderer is not a thumbnail: the tile's art is a solid ``leftStripeColor`` on
``musicNavigationButtonRenderer``. This module reads the same browse response
and keeps it, so the UI can draw the tile YouTube draws.

The playlist side has no quirk: ``get_mood_playlists`` returns rows in the same
shape as ``get_library_playlists``, which is what the library's playlist cards
already render.
"""

from __future__ import annotations

import logging
from typing import Any

from ytmusicapi.navigation import (
    CATEGORY_PARAMS,
    CATEGORY_TITLE,
    GRID,
    GRID_ITEMS,
    SECTION_LIST,
    SINGLE_COLUMN_TAB,
    TITLE_TEXT,
    nav,
)

from features.music.normalize import _thumbnails

logger = logging.getLogger(__name__)

MOODS_BROWSE_ID = "FEmusic_moods_and_genres"


def _empty_mood_categories() -> dict[str, Any]:
    return {"sections": []}


def _mood_color(value: Any) -> str | None:
    """One tile color as ``#rrggbb``.

    YouTube sends an ARGB integer with a fully opaque alpha, e.g. 4290018303
    for ``#b47bff``. A category with no color still renders; its tile just has
    no art.
    """
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return None
    return f"#{value & 0xFFFFFF:06x}"


def _mood_category(item: Any) -> dict[str, Any] | None:
    """One category button, or None for an entry this app cannot open."""
    if not isinstance(item, dict):
        return None
    button = item.get("musicNavigationButtonRenderer")
    if not isinstance(button, dict):
        return None
    title = nav(item, CATEGORY_TITLE, True)
    params = nav(item, CATEGORY_PARAMS, True)
    if not isinstance(title, str) or not title.strip():
        return None
    if not isinstance(params, str) or not params:
        return None
    solid = button.get("solid")
    color = None
    if isinstance(solid, dict):
        color = _mood_color(solid.get("leftStripeColor")) or _mood_color(solid.get("rightStripeColor"))
    return {"title": title.strip(), "params": params, "color": color}


def _mood_sections(payload: Any) -> list[dict[str, Any]]:
    """The Moods & Genres sections, in YouTube's order, with their tile colors."""
    sections: list[dict[str, Any]] = []
    rows = nav(payload, SINGLE_COLUMN_TAB + SECTION_LIST, True)
    if not isinstance(rows, list):
        return sections
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = nav(row, [*GRID, "header", "gridHeaderRenderer", *TITLE_TEXT], True)
        items = nav(row, GRID_ITEMS, True)
        if not isinstance(title, str) or not title.strip() or not isinstance(items, list):
            continue
        categories = [entry for entry in (_mood_category(item) for item in items) if entry is not None]
        if categories:
            sections.append({"title": title.strip(), "categories": categories})
    return sections


def _mood_fallback_sections(categories: Any) -> list[dict[str, Any]]:
    """``get_mood_categories``' mapping, for when the browse grid shape moves.

    Titles and params are all the public call keeps, so a section read this way
    renders without tile art instead of not at all.
    """
    if not isinstance(categories, dict):
        return []
    sections: list[dict[str, Any]] = []
    for title, entries in categories.items():
        if not isinstance(title, str) or not title.strip() or not isinstance(entries, list):
            continue
        items = [
            {"title": entry["title"].strip(), "params": entry["params"], "color": None}
            for entry in entries
            if isinstance(entry, dict)
            and isinstance(entry.get("title"), str)
            and entry["title"].strip()
            and isinstance(entry.get("params"), str)
            and entry["params"]
        ]
        if items:
            sections.append({"title": title.strip(), "categories": items})
    return sections


def _mood_playlists(playlists: Any) -> list[dict[str, Any]]:
    """Rows the playlist cards render, in ``PlaylistSummary`` shape.

    ``get_mood_playlists`` already returns this shape, so only the rows that
    cannot be opened are dropped. A category holds a few hundred rows, all of
    them YouTube's own, so ``owned`` is false for every one of them today.
    """
    if not isinstance(playlists, list):
        return []
    rows: list[dict[str, Any]] = []
    for playlist in playlists:
        if not isinstance(playlist, dict):
            continue
        playlist_id = playlist.get("playlistId")
        title = playlist.get("title")
        if not isinstance(playlist_id, str) or not playlist_id:
            continue
        if not isinstance(title, str) or not title.strip():
            continue
        description = playlist.get("description")
        row: dict[str, Any] = {
            "title": title.strip(),
            "playlistId": playlist_id,
            "thumbnails": _thumbnails(playlist.get("thumbnails")),
            "description": description if isinstance(description, str) else "",
            "owned": bool(playlist.get("owned")),
        }
        count = playlist.get("count")
        if isinstance(count, str) and count.strip():
            row["count"] = count
        rows.append(row)
    return rows
