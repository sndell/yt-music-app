"""Talk to a running dev instance from the command line.

It reads `app/dev/.dev.json`, so it finds the control port with no arguments,
and it uses only the standard library, so any Python can run it (the app's venv
is not required).

    python app\\dev\\cli.py health
    python app\\dev\\cli.py wait
    python app\\dev\\cli.py call get_playlists
    python app\\dev\\cli.py call search "daft punk"
    python app\\dev\\cli.py call get_playlist_items PLxxxxxxxx
    python app\\dev\\cli.py call search --json-file args.json
    python app\\dev\\cli.py eval "document.body.innerText"
    python app\\dev\\cli.py eval "document.querySelector('a').click()"
    python app\\dev\\cli.py logs --level warning --limit 50
    python app\\dev\\cli.py screenshot
    python app\\dev\\cli.py screenshot C:\\temp\\shot.png
    python app\\dev\\cli.py stop

A read is always safe. `call` runs any public API method, which includes writes
to the signed-in account, so treat it like the app's own buttons.

Use single quotes inside a JavaScript expression. PowerShell strips double quotes
on the way to a native command, so `eval "document.title"` works but
`eval 'document.querySelector("a")'` arrives with the quotes removed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DISCOVERY_PATH = Path(__file__).resolve().parent / ".dev.json"
REPO_DIR = Path(__file__).resolve().parents[2]


def _base_url() -> str:
    if not DISCOVERY_PATH.exists():
        raise SystemExit(f"No running dev instance ({DISCOVERY_PATH}). Start one with .\\start.ps1")
    try:
        payload = json.loads(DISCOVERY_PATH.read_text(encoding="utf-8"))
        port = payload["controlPort"]
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"Could not read {DISCOVERY_PATH}: {error}") from error
    # Discovery is per checkout. Refuse to drive another worktree's window.
    checkout = payload.get("checkout")
    if checkout and os.path.normcase(str(checkout)) != os.path.normcase(str(REPO_DIR)):
        raise SystemExit(
            f"{DISCOVERY_PATH} belongs to another checkout ({checkout}). "
            f"Start this one with .\\start.ps1"
        )
    return f"http://127.0.0.1:{port}"


def _request(method: str, route: str, body: dict | None = None, timeout: float = 60.0):
    url = _base_url() + route
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Cannot reach the dev instance at {url}: {error.reason}") from error


def _print(value) -> None:
    print(json.dumps(value, indent=2, default=str))


def _cmd_health(_args) -> None:
    _print(_request("GET", "/health"))


def _cmd_wait(args) -> None:
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        try:
            health = _request("GET", "/health", timeout=2.0)
        except SystemExit:
            time.sleep(0.5)
            continue
        if health.get("loaded"):
            _print(health)
            return
        time.sleep(0.5)
    raise SystemExit(f"Page did not finish loading within {args.timeout:.0f}s")


def _cmd_call(args) -> None:
    if args.json_file:
        try:
            values = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"Could not read {args.json_file}: {error}") from error
    elif args.json:
        try:
            values = json.loads(args.json)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Arguments are not JSON: {error}") from error
    else:
        # Raw strings. PowerShell strips double quotes on the way to a native
        # command, so plain arguments avoid the quoting trap entirely.
        values = list(args.arguments)
    if not isinstance(values, list):
        raise SystemExit("Arguments must be a JSON list or plain values")
    _print(_request("POST", "/call", {"method": args.method, "args": values}))


def _cmd_eval(args) -> None:
    _print(_request("POST", "/eval", {"expression": args.expression}))


def _cmd_logs(args) -> None:
    query = f"?level={args.level}&limit={args.limit}"
    _print(_request("GET", f"/logs{query}"))


def _cmd_screenshot(args) -> None:
    query = f"?path={urllib.parse.quote(args.path)}" if args.path else ""
    _print(_request("GET", f"/screenshot{query}"))


def _cmd_stop(_args) -> None:
    """Ask the instance to close its window, which ends the process cleanly."""
    _print(_request("POST", "/stop"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dev.cli", description="Drive a running dev instance.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="pid, ports, and whether the page loaded").set_defaults(func=_cmd_health)

    wait = sub.add_parser("wait", help="block until the page has loaded")
    wait.add_argument("--timeout", type=float, default=90.0)
    wait.set_defaults(func=_cmd_wait)

    call = sub.add_parser("call", help="call a public Python API method")
    call.add_argument("method")
    call.add_argument("arguments", nargs="*", help="plain string arguments")
    call.add_argument("--json", default="", help="arguments as a JSON list")
    call.add_argument("--json-file", default="", help="path to a file holding a JSON list")
    call.set_defaults(func=_cmd_call)

    evaluate = sub.add_parser("eval", help="run JavaScript in the page")
    evaluate.add_argument("expression")
    evaluate.set_defaults(func=_cmd_eval)

    logs = sub.add_parser("logs", help="Python, renderer, and Vite logs")
    logs.add_argument("--level", default="", help="debug, info, warning, error")
    logs.add_argument("--limit", type=int, default=200)
    logs.set_defaults(func=_cmd_logs)

    shot = sub.add_parser("screenshot", help="capture the window to a PNG")
    shot.add_argument("path", nargs="?", default="")
    shot.set_defaults(func=_cmd_screenshot)

    stop = sub.add_parser("stop", help="close the running instance")
    stop.set_defaults(func=_cmd_stop)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
