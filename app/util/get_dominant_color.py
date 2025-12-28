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


def get_dominant_color_from_url(image_url: str) -> tuple[int, int, int] | None:
    """
    Fetch an image from URL and extract its dominant vibrant color.
    
    Uses ColorThief to get a color palette, then selects the color
    with the highest saturation + value score.
    
    Args:
        image_url: URL of the image to analyze
        
    Returns:
        RGB tuple (r, g, b) of the dominant color, or None on error
    """
    try:
        fd = urlopen(image_url, timeout=10)
        f = io.BytesIO(fd.read())
        color_thief = ColorThief(f)
        palette = color_thief.get_palette(color_count=20, quality=6)

        highest = 0
        highest_color: tuple[int, int, int] | None = None

        for val in palette:
            r, g, b = val

            r_dash = r / 255
            g_dash = g / 255
            b_dash = b / 255

            c_max = max(r_dash, g_dash, b_dash)
            c_min = min(r_dash, g_dash, b_dash)
            delta = c_max - c_min

            # Saturation calculation
            if c_max == 0:
                s = 0
            else:
                s = delta / c_max
            
            # Value calculation
            v = c_max
            
            # Convert to percentage
            s = s * 100
            v = v * 100

            # Score by saturation + value (most vibrant colors win)
            if (s + v) > highest:
                highest = s + v
                highest_color = (r, g, b)

        return highest_color

    except Exception as e:
        logger.warning("Failed to extract dominant color from %s: %s", image_url, e)
        return None


def rgb_to_hex(r: int, g: int, b: int) -> str:
    """Convert RGB tuple to hex string."""
    return f"#{r:02x}{g:02x}{b:02x}"


def get_dominant_color_hex(image_url: str) -> str | None:
    """
    Get the dominant color as a hex string.
    
    Args:
        image_url: URL of the image to analyze
        
    Returns:
        Hex color string (e.g., "#ff5733") or None on error
    """
    color = get_dominant_color_from_url(image_url)
    if color is None:
        return None
    return rgb_to_hex(*color)
