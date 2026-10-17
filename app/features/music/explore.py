"""The Explore feed: YouTube Music's browse page of releases, charts and videos.

``YTMusic.get_explore`` walks the ``FEmusic_explore`` browse response and keys
each carousel by where it links: ``new_releases``, ``top_songs``,
``moods_and_genres``, ``trending``, ``new_videos``. It drops the carousel's own
title on the way, so the titles here are the app's own and stable across the
reshuffles the account's feed does within minutes.

The page this feeds renders each section with a layout of its own, so the
payload says which one rather than making the UI guess from a title. A row is
flattened to the same item shape the Home cards already use.
"""

from __future__ import annotations

import logging
from typing import Any

from features.music.normalize import _home_item, _inline_items

logger = logging.getLogger(__name__)

# key -> (title, layout, item kind). YouTube's own order decides where a
# section lands; this only decides how one renders.
_SECTION_SPECS: dict[str, tuple[str, str, str]] = {
    "new_releases": ("New releases", "cards", "album"),
    "top_songs": ("Top songs", "songs", "song"),
    "moods_and_genres": ("Moods & genres", "moods", ""),
    "trending": ("Trending", "songs", "song"),
    "new_videos": ("New videos", "cards", "video"),
}


def _explore_item(row: Any, kind: str) -> dict[str, Any] | None:
    """One feed row as a shared item, or None when nothing can open it.

    A chart row and a video row both carry a ``videoId`` and map to Home's song
    shape, so the section's kind is what names them. A release keeps the album
    kind its ids decide, and a row the album route cannot open is dropped rather
    than relabelled.
    """
    item = _home_item(row)
    if item is None:
        return None
    if kind == "album":
        return item if item["kind"] == "album" else None
    item["kind"] = kind
    return item


def _explore_categories(rows: Any) -> list[dict[str, Any]]:
    """The moods and genres tiles, in YouTube's order, one per params token.

    The explore carousel carries no tile color, unlike the moods page's own
    browse read, so every tile here falls back to the app's surface color.
    """
    if not isinstance(rows, list):
        return []
    categories: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        params = row.get("params")
        if not isinstance(title, str) or not title.strip():
            continue
        if not isinstance(params, str) or not params or params in seen:
            continue
        seen.add(params)
        categories.append({"title": title.strip(), "params": params, "color": None})
    return categories


def _explore_sections(explore: Any) -> list[dict[str, Any]]:
    """Every section this app can render, in the order the feed returns them.

    The feed is a mapping, so its insertion order is the page's order. A section
    the app has no card for, or one whose rows all fail to map, is dropped: the
    page should not carry an empty heading.
    """
    if not isinstance(explore, dict):
        return []
    sections: list[dict[str, Any]] = []
    skipped: list[str] = []
    for key, payload in explore.items():
        spec = _SECTION_SPECS.get(key) if isinstance(key, str) else None
        if spec is None:
            skipped.append(str(key))
            continue
        title, layout, kind = spec
        if layout == "moods":
            categories = _explore_categories(payload)
            if not categories:
                continue
            sections.append({"key": key, "title": title, "layout": layout, "items": [], "categories": categories})
            continue
        rows = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            continue
        items = [item for item in (_explore_item(row, kind) for row in rows) if item is not None]
        if not items:
            continue
        # Matches Home: a webview cannot decode some covers, and a section is
        # small enough to inline them all.
        _inline_items(items)
        sections.append({"key": key, "title": title, "layout": layout, "items": items, "categories": []})
    if skipped:
        logger.info("Explore sections skipped (no card for them): %s", ", ".join(skipped))
    return sections
