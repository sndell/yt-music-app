"""A loopback HTTP surface for agents working on the app in dev.

The window exposes nothing on its own: `window.pywebview.api` exists only inside
the page. This server gives the same object an outside address, so an agent can
call an API method, run JavaScript in the page, read logs, and take a screenshot
without seeing the screen.

It binds a free port on 127.0.0.1 and writes this instance's discovery file, so
a later command can find it without touching a sibling instance. The `default`
instance also keeps `app/dev/.dev.json` in step, for notes and scripts written
before instances existed. Dev only.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from dev import instance, logs

logger = logging.getLogger(__name__)

REPO_DIR = instance.REPO_DIR

_server: ThreadingHTTPServer | None = None
_thread: threading.Thread | None = None
_port: int | None = None
_api: Any = None
_window: Any = None
_loaded = threading.Event()
_started_at = time.time()


def discovery_path() -> Path:
    return instance.discovery_path()


def control_port() -> int | None:
    return _port


def mark_loaded() -> None:
    """The page finished loading, so `eval` can run."""
    _loaded.set()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _discovery_payload() -> dict[str, Any]:
    from dev import vite

    port = vite.vite_port()
    return {
        "instance": instance.instance_id(),
        "label": instance.label(),
        "pid": os.getpid(),
        "checkout": str(REPO_DIR),
        "dataDir": str(instance.data_dir()),
        "controlPort": _port,
        "vitePort": port,
        "viteOrigin": vite.ui_origin() if port else None,
        "loaded": _loaded.is_set(),
        "startedAt": _started_at,
        "branch": instance.branch(),
        "worktree": str(instance.REPO_DIR),
    }


def _live_record(path: Path, timeout: float) -> dict[str, Any] | None:
    """The health of the instance recorded in `path`, when it still answers.

    Asking the recorded control port rules out a stale file and a pid the OS has
    since reused. A record for a different checkout is ignored.
    """
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if os.path.normcase(str(info.get("checkout", ""))) != os.path.normcase(str(REPO_DIR)):
        return None
    port = info.get("controlPort")
    if not isinstance(port, int):
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as response:
            health = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if health.get("pid") != info.get("pid"):
        return None
    return health


def existing_instance(timeout: float = 0.5) -> dict[str, Any] | None:
    """This instance's dev window, if it is already answering.

    Reads only this instance's discovery file, plus the pre-instance file that
    `default` also writes, so one instance never reports another as running.
    """
    paths = [instance.discovery_path()]
    if instance.is_default():
        paths.append(instance.legacy_discovery_path())
    for path in paths:
        health = _live_record(path, timeout)
        if health is not None:
            return health
    return None


def _write_discovery() -> None:
    payload = _discovery_payload()
    paths = [instance.discovery_path()]
    # `default` keeps the pre-instance file current, so notes and scripts that
    # read `app/dev/.dev.json` keep working. A named instance leaves it alone:
    # it belongs to `default`, and writing it would advertise the wrong window.
    if instance.is_default():
        paths.append(instance.legacy_discovery_path())
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError:
            logger.exception("Could not write %s", path)


def _remove_discovery() -> None:
    paths = [instance.discovery_path()]
    if instance.is_default():
        paths.append(instance.legacy_discovery_path())
    for path in paths:
        try:
            path.unlink()
        except OSError:
            pass


def _call(method: str, args: list[Any]) -> Any:
    if not method or method.startswith("_"):
        raise ValueError(f"Method {method!r} is not callable")
    function = getattr(_api, method, None)
    if not callable(function):
        raise ValueError(f"No API method named {method!r}")
    return function(*args)


def _eval(expression: str) -> Any:
    if _window is None:
        raise RuntimeError("No window yet")
    return _window.evaluate_js(expression)


def _capture(path: Path) -> dict[str, Any]:
    """Grab the window into a PNG with PrintWindow.

    PW_RENDERFULLCONTENT (2) makes the capture include the WebView2 content
    rather than an empty frame.
    """
    from PIL import Image  # noqa: PLC0415 - only needed for a screenshot

    if _window is None or _window.native is None:
        raise RuntimeError("No window yet")
    handle = _window.native.Handle.ToInt64()

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    rect = RECT()
    if not user32.GetWindowRect(handle, ctypes.byref(rect)):
        raise RuntimeError("GetWindowRect failed")
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    window_dc = user32.GetWindowDC(handle)
    memory_dc = gdi32.CreateCompatibleDC(window_dc)
    bitmap = gdi32.CreateCompatibleBitmap(window_dc, width, height)
    gdi32.SelectObject(memory_dc, bitmap)
    try:
        if not user32.PrintWindow(handle, memory_dc, 2):
            raise RuntimeError("PrintWindow failed")

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", ctypes.c_uint32),
                ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32),
                ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16),
                ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32),
                ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32),
                ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32),
            ]

        header = BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        header.biWidth = width
        header.biHeight = -height  # top-down
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0

        buffer = ctypes.create_string_buffer(width * height * 4)
        gdi32.GetDIBits(memory_dc, bitmap, 0, height, buffer, ctypes.byref(header), 0)
    finally:
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(memory_dc)
        user32.ReleaseDC(handle, window_dc)

    image = Image.frombuffer("RGB", (width, height), buffer, "raw", "BGRX", 0, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")
    return {"path": str(path), "width": width, "height": height}


class _Handler(BaseHTTPRequestHandler):
    server_version = "ytmusic-dev/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - base signature
        logger.debug("control %s", format % args)

    def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, default=str).encode("utf-8"))

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Body is not JSON: {error}") from error
        if not isinstance(parsed, dict):
            raise ValueError("Body must be a JSON object")
        return parsed

    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def do_GET(self) -> None:  # noqa: N802 - base signature
        route = urlparse(self.path).path
        try:
            if route == "/health":
                return self._json(200, _discovery_payload())
            if route == "/logs":
                query = self._query()
                level = (query.get("level") or [""])[0]
                limit = int((query.get("limit") or ["200"])[0])
                from dev import vite

                return self._json(
                    200,
                    {
                        "python": logs.python_entries(level, limit),
                        "renderer": logs.renderer_entries(level, limit),
                        "vite": logs.vite_tail(vite.log_path(), limit),
                    },
                )
            if route == "/screenshot":
                query = self._query()
                target = (query.get("path") or [""])[0]
                path = Path(target) if target else instance.artifacts_dir() / "screenshot.png"
                return self._json(200, _capture(path))
            if route == "/":
                return self._json(
                    200,
                    {
                        "endpoints": {
                            "GET /health": "instance, pid, checkout, ports, whether the page loaded",
                            "POST /call": '{"method": "get_playlists", "args": []}',
                            "POST /eval": '{"expression": "document.body.innerText"}',
                            "POST /stop": "close the window",
                            "GET /logs": "?level=warning&limit=200",
                            "GET /screenshot": "?path=optional.png",
                        }
                    },
                )
            return self._json(404, {"error": f"No route {route}"})
        except Exception as error:  # noqa: BLE001 - report every failure to the caller
            logger.exception("control GET %s failed", route)
            return self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def do_POST(self) -> None:  # noqa: N802 - base signature
        route = urlparse(self.path).path
        try:
            body = self._body()
            if route == "/call":
                method = str(body.get("method", ""))
                args = body.get("args") or []
                if not isinstance(args, list):
                    raise ValueError("args must be a list")
                return self._json(200, {"result": _call(method, args)})
            if route == "/eval":
                expression = body.get("expression")
                if not isinstance(expression, str) or not expression:
                    raise ValueError("expression must be a non-empty string")
                return self._json(200, {"result": _eval(expression)})
            if route == "/stop":
                # Destroying the window makes webview.start() return, so the
                # normal shutdown stops Vite and removes the discovery file.
                target = _window
                if target is None:
                    raise RuntimeError("No window yet")
                threading.Thread(target=target.destroy, name="dev-stop", daemon=True).start()
                return self._json(200, {"stopping": True, "pid": os.getpid()})
            return self._json(404, {"error": f"No route {route}"})
        except Exception as error:  # noqa: BLE001 - report every failure to the caller
            logger.exception("control POST %s failed", route)
            return self._json(500, {"error": f"{type(error).__name__}: {error}"})


def start(api: Any, window: Any, port: int | None = None) -> int:
    """Serve the control surface on a free loopback port. Returns the port."""
    global _server, _thread, _port, _api, _window
    if _server is not None:
        return _port or 0
    _api = api
    _window = window
    _port = port or _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", _port), _Handler)
    server.daemon_threads = True
    _server = server
    _thread = threading.Thread(target=server.serve_forever, name="dev-control", daemon=True)
    _thread.start()
    _write_discovery()
    logger.info("Dev control listening on http://127.0.0.1:%s", _port)
    return _port


def stop() -> None:
    """Stop the control server and remove the discovery file."""
    global _server, _thread, _port
    server = _server
    _server = None
    _remove_discovery()
    if server is None:
        return
    server.shutdown()
    server.server_close()
    _thread = None
    _port = None
