"""Moved out of features/music_api.py; see app/features/music/__init__.py."""

from __future__ import annotations

from contract.registry import api
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import json
import logging
import re
import threading
import time
import ytmusicapi

logger = logging.getLogger(__name__)
_lyrics_lock = threading.Lock()
_signed_out_ytmusic: ytmusicapi.YTMusic | None = None
_TRANSLATE_BLOCK_ENDPOINT = "https://translate.googleapis.com/translate_a/single"
_TRANSLATE_LINES_ENDPOINT = "https://translate.googleapis.com/translate_a/t"
_TRANSLATE_TIMEOUT = 15
_TRANSLATE_BLOCK_CHARS = 4000
_TRANSLATE_QUERY_CHARS = 4000

logger = logging.getLogger(__name__)

def _lyrics_browse_id(ytmusic: Any, video_id: str) -> str | None:
    """The ``MPLYt...`` lyrics id for a video, or ``None`` when it has none.

    ytmusicapi resolves lyrics only from that browse id, and a track the queue
    carries has no lyrics id of its own, so read it from the watch-playlist
    response, which exposes it next to the tracks. A request that fails raises,
    so the caller can tell "no lyrics" from "could not ask".
    """
    data = ytmusic.get_watch_playlist(videoId=video_id, limit=1)
    browse_id = data.get("lyrics") if isinstance(data, dict) else None
    return browse_id if isinstance(browse_id, str) and browse_id else None

def _signed_out_client() -> ytmusicapi.YTMusic:
    """A second client that never signs in, for the timed lyrics request.

    YouTube Music serves timed lyrics only to its mobile client, and that client
    answers a request carrying both the web cookie and its SAPISIDHASH with HTTP
    400 ("Request contains an invalid argument"). The identical request without
    either header returns the timed lines, so this client carries no account at
    all. It is used for nothing else, which also keeps `as_mobile()`'s in-place
    client swap off the signed-in client every other call shares.
    """
    global _signed_out_ytmusic
    if _signed_out_ytmusic is None:
        _signed_out_ytmusic = ytmusicapi.YTMusic()
    return _signed_out_ytmusic

def _timed_lyrics(browse_id: str) -> dict[str, Any] | None:
    """Timed lyrics for a lyrics browse id, read signed out.

    Returns the normalized payload, or ``None`` when the song has no timings.
    The client is shared, so the read holds a lock for the length of the call.
    """
    with _lyrics_lock:
        try:
            result = _signed_out_client().get_lyrics(browse_id, timestamps=True)
        except Exception:
            logger.warning("Timed lyrics read failed for %s", browse_id, exc_info=True)
            return None
    payload = _normalize_lyrics(result)
    return payload if payload["hasTimestamps"] else None

def _normalize_lyrics(result: Any) -> dict[str, Any]:
    """Flatten a ytmusicapi ``get_lyrics`` result into the UI's shape.

    Timed lyrics arrive as ``LyricLine`` dataclasses with millisecond cue
    ranges; plain lyrics are one string. Both share the payload, so the UI can
    highlight against ``lines`` when they are there and fall back to the text.
    """
    payload: dict[str, Any] = {"lyrics": None, "source": None, "hasTimestamps": False, "lines": []}
    if not isinstance(result, dict):
        return payload
    attribution = result.get("source")
    payload["source"] = attribution if isinstance(attribution, str) and attribution.strip() else None

    raw = result.get("lyrics")
    if result.get("hasTimestamps") and isinstance(raw, list):
        lines: list[dict[str, Any]] = []
        for line in raw:
            text = line.get("text") if isinstance(line, dict) else getattr(line, "text", None)
            if not isinstance(text, str):
                continue
            start = line.get("start_time") if isinstance(line, dict) else getattr(line, "start_time", 0)
            end = line.get("end_time") if isinstance(line, dict) else getattr(line, "end_time", 0)
            lines.append(
                {
                    "text": text,
                    "startMs": int(start) if isinstance(start, (int, float)) else 0,
                    "endMs": int(end) if isinstance(end, (int, float)) else 0,
                }
            )
        if lines:
            payload["hasTimestamps"] = True
            payload["lines"] = lines
            payload["lyrics"] = "\n".join(line["text"] for line in lines)
        return payload

    payload["lyrics"] = raw if isinstance(raw, str) and raw.strip() else None
    return payload

def _translate_request(url: str, fields: list[tuple[str, str]], post: bool = True) -> Any | None:
    """Send ``fields`` and parse the JSON reply.

    ``None`` means the request or the parse failed, which the caller reports as
    a failed translation instead of caching one that never happened. ``post`` is
    false for the endpoint that answers a POST with a redirect and then refuses
    the GET it is followed by; the same fields as a query string are answered.
    """
    body = urlencode(fields)
    request = (
        Request(url, data=body.encode("utf-8"), headers={"User-Agent": "Mozilla/5.0"})
        if post
        else Request(f"{url}?{body}", headers={"User-Agent": "Mozilla/5.0"})
    )
    try:
        with urlopen(request, timeout=_TRANSLATE_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        logger.warning("Lyrics translation request failed", exc_info=True)
        return None

def _translate_block(text: str, target: str) -> tuple[str, str, str | None] | None:
    """Translate one block into ``target``.

    Returns ``(translated, original, language)``. The original text comes back
    echoed beside each translation, which is what lets the caller check that the
    reply is still split at the same line breaks it sent.
    """
    data = _translate_request(
        _TRANSLATE_BLOCK_ENDPOINT,
        [("client", "gtx"), ("sl", "auto"), ("tl", target), ("dt", "t"), ("q", text)],
    )
    if not isinstance(data, list) or not isinstance(data[0], list):
        return None
    segments = [segment for segment in data[0] if isinstance(segment, list)]
    translated = "".join(
        segment[0] for segment in segments if segment and isinstance(segment[0], str)
    )
    original = "".join(
        segment[1] for segment in segments if len(segment) > 1 and isinstance(segment[1], str)
    )
    language = data[2] if len(data) > 2 and isinstance(data[2], str) else None
    return translated, original, language

def _translate_lines_individually(lines: list[str], target: str) -> list[str] | None:
    """Translate lines one at a time, which cannot fall out of step.

    Each line is its own ``q`` field and the reply carries one entry per ``q``,
    so the count always matches. A line read without its neighbours translates
    blunter than the same line inside the block, which is why this is only the
    fallback for a block that came back split differently.
    """
    translated: list[str] = []
    for batch in _query_batches(lines):
        data = _translate_request(
            _TRANSLATE_LINES_ENDPOINT,
            [("client", "gtx"), ("sl", "auto"), ("tl", target)] + [("q", line) for line in batch],
            post=False,
        )
        if not isinstance(data, list) or len(data) != len(batch):
            return None
        for entry in data:
            text = entry[0] if isinstance(entry, list) and entry and isinstance(entry[0], str) else None
            translated.append(text if text is not None else "")
    return translated

def _split_blocks(lines: list[str]) -> list[list[str]]:
    """Group lines into blocks that fit one translate request each."""
    blocks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if current and size + len(line) + 1 > _TRANSLATE_BLOCK_CHARS:
            blocks.append(current)
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        blocks.append(current)
    return blocks

def _query_batches(lines: list[str]) -> list[list[str]]:
    """Group lines into batches whose encoded query stays a sane URL length.

    A line of CJK encodes to nine times its own length, so the measure is the
    encoded field rather than the lyric.
    """
    batches: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        encoded = len(urlencode({"q": line}))
        if current and size + encoded + 1 > _TRANSLATE_QUERY_CHARS:
            batches.append(current)
            current, size = [], 0
        current.append(line)
        size += encoded + 1
    if current:
        batches.append(current)
    return batches

def _translate_lyric_lines(lines: list[str], target: str) -> tuple[list[str], str | None] | None:
    """Translate lyric lines into ``target``, one translation per line.

    Returns the translations and the detected source language, or ``None`` when
    the request failed. Each block is sent joined at the line breaks it came
    with, because Google splits its reply back at those breaks. The echoed
    original is checked line for line, and a block that came back split
    differently is translated a line at a time instead, so a timing highlight
    cannot end up on the wrong words.
    """
    translated: list[str] = []
    language: str | None = None
    for block in _split_blocks(lines):
        result = _translate_block("\n".join(block), target)
        if result is None:
            return None
        text, original, detected = result
        language = language or detected
        split = text.split("\n")
        if len(original.split("\n")) == len(block) == len(split):
            translated.extend(split)
            continue
        fallback = _translate_lines_individually(block, target)
        if fallback is None:
            return None
        translated.extend(fallback)
    return translated, language