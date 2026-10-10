"""Serve the packaged UI on localhost.

YouTube's embed player refuses file:// pages. Songs then show as unavailable,
while some music videos still play. Dev already has an http origin through Vite.
"""

from __future__ import annotations

import logging
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logger = logging.getLogger(__name__)

_server: ThreadingHTTPServer | None = None


class _UiHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        logger.debug(format, *args)


def serve_ui(directory: Path) -> str:
    """Serve directory on localhost and return the index URL.

    The browser must see localhost, not 127.0.0.1. Edge keeps the YouTube login
    cookies for an embed on localhost and drops them for an IP address, so
    age-restricted songs only play in dev.
    """
    global _server
    handler = partial(_UiHandler, directory=str(directory.resolve()))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, name="ui-server", daemon=True)
    thread.start()
    _server = server
    port = server.server_address[1]
    url = f"http://localhost:{port}/index.html"
    logger.info("Serving UI at %s", url)
    return url
