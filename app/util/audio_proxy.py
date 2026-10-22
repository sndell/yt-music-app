"""Serve a resolved audio URL from loopback so the page can filter it.

Web Audio can only process a media element whose bytes are CORS-clean, and
googlevideo authorizes one origin (https://www.youtube.com) and no other, so an
element pointed straight at it feeds the graph silence. Re-serving the same
bytes from localhost keeps the element same-machine, which is what lets the
equalizer in the UI run in Chromium instead of a second audio stack in Python.

Only token-tagged streams can be fetched, so this is not a general proxy: a
token is minted when a stream is resolved and the upstream URL never leaves
Python.
"""

from __future__ import annotations

import logging
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

_CHUNK_BYTES = 64 * 1024
_MAX_TOKENS = 64
_CONNECT_TIMEOUT = 15
_READ_TIMEOUT = 30
_PASSED_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Content-Encoding")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        logger.debug(fmt, *args)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        self._serve(head_only=True)

    def do_GET(self) -> None:
        self._serve(head_only=False)

    def _serve(self, head_only: bool) -> None:
        entry = _lookup(urlparse(self.path).path)
        if entry is None:
            self.send_response(404)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        url, user_agent = entry
        headers = {"User-Agent": user_agent}
        requested = self.headers.get("Range")
        if requested:
            headers["Range"] = requested

        try:
            upstream = requests.get(url, headers=headers, stream=True, timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT))
        except requests.RequestException as exc:
            logger.warning("Audio proxy could not reach the stream: %s", exc)
            self.send_response(502)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        try:
            self.send_response(upstream.status_code)
            self._cors()
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            for name in _PASSED_HEADERS:
                value = upstream.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.end_headers()
            if head_only:
                return
            for chunk in upstream.iter_content(_CHUNK_BYTES):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # The player seeked away or moved on; nothing is owed to the page.
            pass
        except requests.RequestException as exc:
            logger.warning("Audio proxy stream ended early: %s", exc)
        finally:
            upstream.close()
            self.close_connection = True


# Reentrant because url_for holds it while starting the server on first use.
_lock = threading.RLock()
_server: ThreadingHTTPServer | None = None
_port = 0
_streams: dict[str, tuple[str, str]] = {}
_tokens: dict[str, str] = {}


def _lookup(path: str) -> tuple[str, str] | None:
    token = path.rsplit("/", 1)[-1]
    with _lock:
        return _streams.get(token)


def _start() -> int:
    """Start the loopback server once and remember its port."""
    global _server, _port
    if _server is not None:
        return _port
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="audio-proxy", daemon=True)
    thread.start()
    _server = server
    _port = server.server_address[1]
    logger.info("Audio proxy on http://127.0.0.1:%s", _port)
    return _port


def url_for(url: str, user_agent: str) -> str:
    """The loopback URL for one resolved stream, minting a token on first use.

    Tokens are keyed by the upstream URL so a cached stream keeps one token for
    as long as the URL is valid.
    """
    port = _start()
    with _lock:
        token = _tokens.get(url)
        if token is None:
            token = secrets.token_urlsafe(16)
            _tokens[url] = token
            _streams[token] = (url, user_agent)
            while len(_streams) > _MAX_TOKENS:
                stale_token, (stale_url, _) = next(iter(_streams.items()))
                _streams.pop(stale_token, None)
                if _tokens.get(stale_url) == stale_token:
                    _tokens.pop(stale_url, None)
    return f"http://127.0.0.1:{port}/audio/{token}"
