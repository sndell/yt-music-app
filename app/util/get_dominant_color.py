"""
Dominant color extraction utility.

Uses ColorThief to extract a color palette, then selects
the most vibrant color based on saturation + value scoring.
"""

from __future__ import annotations

import io
import logging
from urllib.request import urlopen

from colorthief import ColorThief

logger = logging.getLogger(__name__)


def _saturation_value(r: int, g: int, b: int) -> tuple[float, float]:
    r_dash = r / 255
    g_dash = g / 255
    b_dash = b / 255
    c_max = max(r_dash, g_dash, b_dash)
    c_min = min(r_dash, g_dash, b_dash)
    delta = c_max - c_min
    saturation = 0 if c_max == 0 else delta / c_max
    return saturation * 100, c_max * 100


def get_dominant_color_from_url(image_url: str, prefer_vibrancy: bool = False) -> tuple[int, int, int] | None:
    """
    Fetch an image from URL and extract its dominant vibrant color.

    Uses ColorThief to get a color palette, then selects the color
    with the highest saturation + value score. prefer_vibrancy weights
    saturation higher and skips near-gray swatches, falling back to the
    usual score when the cover has no real color.
    """
    try:
        fd = urlopen(image_url, timeout=10)
        f = io.BytesIO(fd.read())
        color_thief = ColorThief(f)
        palette = color_thief.get_palette(color_count=20, quality=6)

        highest = 0.0
        highest_color: tuple[int, int, int] | None = None
        vibrant_score = 0.0
        vibrant_color: tuple[int, int, int] | None = None

        for val in palette:
            r, g, b = val
            saturation, value = _saturation_value(r, g, b)

            # Playlist pages score saturation + value, and the first winner stays on a tie.
            score = saturation + value
            if score > highest:
                highest = score
                highest_color = (r, g, b)

            # Saturation on a near-black pixel is usually compression noise
            # (a black-and-white cover can score as #041008). Require a real
            # channel gap and some light before calling a swatch vibrant.
            chroma = max(r, g, b) - min(r, g, b)
            if prefer_vibrancy and saturation >= 18 and chroma >= 24 and max(r, g, b) >= 40:
                weighted = saturation * 1.8 + value * 0.55
                if weighted > vibrant_score:
                    vibrant_score = weighted
                    vibrant_color = (r, g, b)

        if prefer_vibrancy and vibrant_color is not None:
            return vibrant_color
        return highest_color

    except Exception as e:
        logger.warning("Failed to extract dominant color from %s: %s", image_url, e)
        return None


def rgb_to_hex(r: int, g: int, b: int) -> str:
    """Convert RGB tuple to hex string."""
    return f"#{r:02x}{g:02x}{b:02x}"


def get_dominant_color_hex(image_url: str, prefer_vibrancy: bool = False) -> str | None:
    """
    Get the dominant color as a hex string.

    Args:
        image_url: URL of the image to analyze
        prefer_vibrancy: Weight saturated palette colors above the playlist-page score.

    Returns:
        Hex color string (e.g., "#ff5733") or None on error
    """
    color = get_dominant_color_from_url(image_url, prefer_vibrancy=prefer_vibrancy)
    if color is None:
        return None
    return rgb_to_hex(*color)
