"""Capture the app window to PNG with the Windows GDI.

No extra dependency and no DevTools port: an agent can see the real window
in any dev session. ``PrintWindow`` is tried first (works while the window is
behind others), and a screen blit is the fallback for windows that render
blank through it.

Everything is stdlib: the DIB comes back through ctypes, and the PNG is
encoded by hand with ``zlib``.
"""

from __future__ import annotations

import ctypes
import json
import os
import struct
import time
import zlib
from ctypes import wintypes
from pathlib import Path
from typing import Any

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

PW_RENDERFULLCONTENT = 0x00000002  # ask WebView2 to render into the DC, not just the frame
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
WINDOW_TITLE = "YTMusic"


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def _set_dpi_aware() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass


def find_window(title: str = WINDOW_TITLE) -> int:
    """Return this process's window titled ``title``.

    ``FindWindowW`` hands back the first match on title alone, so with two
    YTMusic windows open it can return another checkout's window. A worktree
    names its window after its branch, so match the exact title first, then any
    own window whose title starts with ``title``, and always keep the owning
    pid. Falls back to ``FindWindowW`` when nothing matches.
    """
    pid = os.getpid()
    exact: list[int] = []
    prefixed: list[int] = []

    def _visit(hwnd: int, _lparam: int) -> bool:
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            text = buf.value
            if text == title or text.startswith(title):
                owner = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                if owner.value == pid:
                    if text == title:
                        exact.append(hwnd)
                        return False  # exact, ours, stop walking
                    prefixed.append(hwnd)
        return True

    user32.EnumWindows(_WNDENUMPROC(_visit), 0)
    if exact:
        return exact[0]
    if prefixed:
        return prefixed[0]

    hwnd = user32.FindWindowW(None, title)
    if not hwnd:
        raise RuntimeError(f"window {title!r} not found")
    return hwnd


def _read_bits(memdc: int, bmp: int, width: int, height: int) -> bytes:
    bmi = _BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
    bmi.biWidth = width
    bmi.biHeight = -height  # negative: top-down rows
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0  # BI_RGB
    buf = ctypes.create_string_buffer(width * height * 4)
    got = gdi32.GetDIBits(memdc, bmp, 0, height, buf, ctypes.byref(bmi), DIB_RGB_COLORS)
    if got == 0:
        raise RuntimeError("GetDIBits returned nothing")
    return bytes(buf)


def _blit(hwnd: int, width: int, height: int, left: int, top: int, mode: str) -> bytes:
    screen = user32.GetDC(0)
    memdc = gdi32.CreateCompatibleDC(screen)
    bmp = gdi32.CreateCompatibleBitmap(screen, width, height)
    gdi32.SelectObject(memdc, bmp)
    try:
        if mode == "print":
            ok = user32.PrintWindow(hwnd, memdc, PW_RENDERFULLCONTENT)
        else:
            ok = gdi32.BitBlt(memdc, 0, 0, width, height, screen, left, top, SRCCOPY)
        if not ok:
            raise RuntimeError(f"{mode} capture failed")
        return _read_bits(memdc, bmp, width, height)
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(0, screen)


def _is_blank(rgba: bytes) -> bool:
    """True when the frame is a single flat colour (a failed WebView2 capture)."""
    if not rgba:
        return True
    step = max(4, (len(rgba) // 4 // 997) * 4)  # ~1000 samples
    sample = rgba[0:len(rgba):step]
    return len(set(sample)) <= 1


def _bgra_to_rgb(data: bytes) -> bytes:
    out = bytearray(len(data) // 4 * 3)
    out[0::3] = data[2::4]
    out[1::3] = data[1::4]
    out[2::3] = data[0::4]
    return bytes(out)


def capture(title: str = WINDOW_TITLE) -> tuple[int, int, bytes]:
    """Return ``(width, height, rgb)`` for the window, or raise."""
    _set_dpi_aware()
    hwnd = find_window(title)
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("GetWindowRect failed")
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise RuntimeError(f"window has no size ({width}x{height})")

    rgba = _blit(hwnd, width, height, rect.left, rect.top, "print")
    if _is_blank(rgba):
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.15)
        rgba = _blit(hwnd, width, height, rect.left, rect.top, "screen")
    return width, height, _bgra_to_rgb(rgba)


def encode_png(width: int, height: int, rgb: bytes) -> bytes:
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        raw += rgb[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


def _diff_png(width: int, height: int, base: bytes, current: bytes) -> tuple[bytes, int]:
    """Base frame flattened, pixels that moved drawn red. Returns (png, changed)."""
    out = bytearray(width * height * 3)
    out[0::3] = base[0::3]
    out[1::3] = base[1::3]
    out[2::3] = base[2::3]
    changed = 0
    for pixel in range(width * height):
        o = pixel * 3
        if base[o] != current[o] or base[o + 1] != current[o + 1] or base[o + 2] != current[o + 2]:
            out[o] = 255
            out[o + 1] = 0
            out[o + 2] = 0
            changed += 1
    return encode_png(width, height, bytes(out)), changed


def _meta_path(directory: Path, name: str) -> Path:
    return directory / f"{name}.meta.json"


def capture_to_artifacts(
    directory: Path,
    *,
    diff: bool = False,
    accept: bool = False,
    title: str = WINDOW_TITLE,
) -> dict[str, Any]:
    """Capture, store under ``directory``, and optionally diff against baseline."""
    directory.mkdir(parents=True, exist_ok=True)
    width, height, rgb = capture(title)

    (directory / "current.png").write_bytes(encode_png(width, height, rgb))
    (directory / "current.raw").write_bytes(rgb)
    _meta_path(directory, "current").write_text(
        json.dumps({"width": width, "height": height, "at": time.time()}), encoding="utf-8"
    )

    baseline_meta = _meta_path(directory, "baseline")
    baseline_raw_path = directory / "baseline.raw"

    result: dict[str, Any] = {
        "width": width,
        "height": height,
        "path": str(directory / "current.png"),
        "rawPath": str(directory / "current.raw"),
    }
    if width < 400 or height < 300:
        # A 160x28 frame is a minimized window, not a layout bug. Say so.
        result["warning"] = f"captured frame is only {width}x{height}; the window is probably minimized"

    if accept or not baseline_raw_path.exists():
        (directory / "baseline.png").write_bytes(encode_png(width, height, rgb))
        baseline_raw_path.write_bytes(rgb)
        baseline_meta.write_text(
            json.dumps({"width": width, "height": height, "at": time.time()}), encoding="utf-8"
        )
        result["baselineUpdated"] = True
        if accept:
            return result

    if diff and baseline_raw_path.exists():
        try:
            meta = json.loads(baseline_meta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        if meta.get("width") == width and meta.get("height") == height:
            base = baseline_raw_path.read_bytes()
            png, changed = _diff_png(width, height, base, rgb)
            diff_path = directory / "diff.png"
            diff_path.write_bytes(png)
            result["changedPixels"] = changed
            result["diffPath"] = str(diff_path)
        else:
            result["diffSkipped"] = "baseline size differs"
    return result
