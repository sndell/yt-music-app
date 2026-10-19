"""The Related tab of a watch playlist: YouTube's own "You might also like".

The ``related`` browse id that opens the tab already comes back on the watch
playlist response the queue is built from, so no extra lookup is needed to
obtain it. The browse answer is a list of sections: a title and either rows or,
for the about-the-artist block, one paragraph.

``YTMusic.get_song_related`` reads ``contents.sectionListRenderer`` without a
fallback, so a song whose tab has nothing to offer (YouTube answers with a
``messageRenderer``, "No extra content available") raises ``KeyError`` instead
of returning an empty list. Reading the same browse response here keeps that
answer empty, and parsing one section at a time keeps a row shape ytmusicapi
cannot map from taking the whole tab down with it.

Sections keep YouTube's order and titles. Rows are flattened to the same item
shape the Home cards already use, so a song plays and an album, playlist or
artist opens the route that already exists. YouTube repeats rows within a
section, so the rows are deduplicated by their primary id, in YouTube's order.
"""

from __future__ import annotations

import logging
from typing import Any

from ytmusicapi.navigation import SECTION_LIST, nav
from ytmusicapi.parsers.browsing import parse_mixed_content

from features.music.normalize import _home_item, _inline_items

logger = logging.getLogger(__name__)


def _row_key(item: dict[str, Any]) -> str | None:
    """The id a row is deduplicated by, or None when it has no id to compare."""
    for field in ("videoId", "playlistId", "browseId"):
        value = item.get(field)
        if isinstance(value, str) and value:
            return f"{field}:{value}"
    return None


def _text_item(text: str) -> dict[str, Any]:
    """One description section as a row, so every section has the same shape."""
    return {
        "kind": "text",
        "title": text.strip(),
        "subtitle": "",
        "artists": [],
        "thumbnails": [],
        "videoId": None,
        "playlistId": None,
        "browseId": None,
        "explicit": False,
    }


def _section_rows(ytmusic: Any, browse_id: str) -> list[Any]:
    """The Related tab's section rows, or [] when YouTube has none to show."""
    response = ytmusic._send_request("browse", {"browseId": browse_id})
    rows = nav(response, ["contents", *SECTION_LIST], True)
    return rows if isinstance(rows, list) else []


def _parsed_sections(rows: list[Any]) -> list[dict[str, Any]]:
    """ytmusicapi's own section parse, one row at a time.

    A carousel whose row shape moved raises while being mapped; that costs the
    section it belongs to and leaves every other one in the tab.
    """
    sections: list[dict[str, Any]] = []
    for row in rows:
        try:
            sections.extend(parse_mixed_content([row]))
        except Exception as e:
            logger.warning("Skipping a Related section that did not parse: %s", e)
    return sections


def _song_related_sections(ytmusic: Any, browse_id: str) -> list[dict[str, Any]]:
    """Every Related section this app can render for one browse id."""
    return _related_sections(_parsed_sections(_section_rows(ytmusic, browse_id)))


def _related_sections(rows: Any) -> list[dict[str, Any]]:
    """Every Related section this app can render, in YouTube's own order.

    A section without a title, without contents, or whose rows all fail to map
    is dropped rather than shown as an empty heading.
    """
    if not isinstance(rows, list):
        return []
    sections: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        contents = row.get("contents")
        items: list[dict[str, Any]] = []
        if isinstance(contents, str):
            if contents.strip():
                items.append(_text_item(contents))
        elif isinstance(contents, list):
            seen: set[str] = set()
            for entry in contents:
                if not isinstance(entry, dict):
                    continue
                item = _home_item(entry)
                if item is None:
                    continue
                key = _row_key(item)
                if key is not None:
                    if key in seen:
                        continue
                    seen.add(key)
                items.append(item)
        if not items:
            continue
        _inline_items(items)
        sections.append({"title": title.strip(), "items": items})
    return sections
