"""Localhost probe for the running webview.

Started when ENV=dev, and when a packaged exe is launched with DEVTOOLS=1.
Agents call it to exercise the Python API and the live window.pywebview bridge.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from dev.identity import generation, health_payload, probe_port, restarted_files

logger = logging.getLogger(__name__)


class ProbeError(Exception):
    """A bad probe request or a JavaScript error. Logged without a Python traceback."""


HOST = "127.0.0.1"
EVAL_TIMEOUT_SECONDS = 30
MAX_BODY_BYTES = 1_000_000

_lock = threading.Lock()


def _promise_script(expression: str) -> str:
    payload = json.dumps(expression)
    return (
        "Promise.resolve().then(function() {"
        f"  try {{ return eval({payload}); }}"
        "  catch (error) {"
        "    return {pywebviewProbeError: String(error && (error.stack || error.message) || error)};"
        "  }"
        "}).then(function(value) {"
        "  if (value && value.pywebviewProbeError) {"
        "    return {ok: false, error: value.pywebviewProbeError};"
        "  }"
        "  return {ok: true, value: value};"
        "}, function(error) {"
        "  return {ok: false, error: String(error && (error.stack || error.message) || error)};"
        "})"
    )


def evaluate(window: Any, expression: str) -> Any:
    done = threading.Event()
    box: dict[str, Any] = {}

    def callback(value: Any) -> None:
        box["value"] = value
        done.set()

    try:
        window.evaluate_js(_promise_script(expression), callback)
    except Exception as exc:
        raise ProbeError(str(exc)) from exc
    if not done.wait(EVAL_TIMEOUT_SECONDS):
        raise ProbeError(f"eval timed out after {EVAL_TIMEOUT_SECONDS}s")

    value = box.get("value")
    if isinstance(value, dict) and value.get("ok") is False:
        raise ProbeError(str(value.get("error")))
    if isinstance(value, dict) and value.get("ok") is True:
        return value.get("value")
    raise ProbeError(f"unexpected eval result: {value!r}")


def call_method(api: Any, method: str, args: list[Any]) -> Any:
    if not isinstance(method, str) or not method.isidentifier() or method.startswith("_"):
        raise ProbeError(f"method not allowed: {method}")
    func = getattr(api, method, None)
    if not callable(func):
        raise ProbeError(f"method not found: {method}")
    return func(*args)


class ProbeServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, api: Any, window: Any) -> None:
        self.api = api
        self.window = window
        self.probe_port = probe_port()
        super().__init__((HOST, self.probe_port), ProbeHandler)


class ProbeHandler(BaseHTTPRequestHandler):
    server: ProbeServer

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/health":
            self._send_text(404, "not found")
            return
        self._send_json(200, health_payload())

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/call":
            self._handle_call()
            return
        if path == "/eval":
            self._handle_eval()
            return
        self._send_text(404, "not found")

    def _handle_call(self) -> None:
        try:
            payload = self._read_json()
            method = payload.get("method")
            args = payload.get("args", [])
            if not isinstance(args, list):
                raise ProbeError("args must be a list")
            logger.info("call %s", method)
            with _lock:
                result = call_method(self.server.api, method, args)
            self._send_json(200, result)
        except ProbeError as exc:
            logger.error("call rejected: %s", exc)
            self._send_text(500, f"{type(exc).__name__}: {exc}")
        except Exception as exc:
            logger.exception("call failed")
            self._send_text(500, f"{type(exc).__name__}: {exc}")

    def _handle_eval(self) -> None:
        try:
            payload = self._read_json()
            expression = payload.get("expression")
            if not isinstance(expression, str) or not expression.strip():
                raise ProbeError("expression must be a non-empty string")
            logger.info("eval %s", expression[:180])
            with _lock:
                result = evaluate(self.server.window, expression)
            self._send_json(200, result)
        except ProbeError as exc:
            logger.error("eval rejected: %s", exc)
            self._send_text(500, f"{type(exc).__name__}: {exc}")
        except Exception as exc:
            logger.exception("eval failed")
            self._send_text(500, f"{type(exc).__name__}: {exc}")

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ProbeError("invalid Content-Length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ProbeError("body is too large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProbeError(f"invalid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise ProbeError("body must be a JSON object")
        return payload

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", body)

    def _send_text(self, status: int, text: str) -> None:
        self._send(status, "text/plain; charset=utf-8", text.encode("utf-8"))

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Dev-Pid", str(os.getpid()))
        self.send_header("X-Dev-Generation", str(generation()))
        files = ",".join(restarted_files()).replace("\r", " ").replace("\n", " ")
        self.send_header("X-Dev-Restart-Files", files.encode("latin-1", "replace").decode("latin-1"))
        self.end_headers()
        self.wfile.write(body)


def start_dev_probe(api: Any, window: Any) -> None:
    server: ProbeServer | None = None
    last_error: OSError | None = None
    port = probe_port()
    for _ in range(20):
        try:
            server = ProbeServer(api, window)
            break
        except OSError as exc:
            last_error = exc
            time.sleep(0.1)
    if server is None:
        logger.error("probe failed to bind http://%s:%s: %s", HOST, port, last_error)
        return

    thread = threading.Thread(target=server.serve_forever, name="dev-probe", daemon=True)
    thread.start()
    logger.info("probe listening on http://%s:%s", HOST, port)
